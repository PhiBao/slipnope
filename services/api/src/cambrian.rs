//! Cambrian market-data client (market prices + hourly history).
//!
//! Role separation matters: Chainlink is the *onchain* fair price the hook
//! enforces. Cambrian is *offchain market evidence* — what the wider Base
//! market is actually trading at, per Uniswap v3 pools. A hook can never read
//! Cambrian; the app can. That is the point: two independent sources so a
//! dislocation is visible, not asserted.
//!
//! Quota discipline: the free tier allows ~1000 calls/month. We therefore
//! cache aggressively (market price 10 min, history 6 h) and never fan out
//! more than the tracked universe per refresh.

use serde::Deserialize;
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

const BASE: &str = "https://api.cambrian.org/evm";
const CHAIN_ID: u32 = 8453;

#[derive(Debug, Deserialize)]
struct Column {
    name: String,
}

#[derive(Debug, Deserialize)]
struct Table {
    #[serde(default)]
    columns: Vec<Column>,
    #[serde(default)]
    data: Vec<Vec<serde_json::Value>>,
    #[serde(default)]
    rows: usize,
}

/// One cached payload plus the time it was fetched.
struct Cached<T> {
    value: T,
    at: Instant,
}

#[derive(Clone)]
pub struct Cambrian {
    http: reqwest::Client,
    api_key: String,
    prices: Arc<tokio::sync::Mutex<HashMap<String, Cached<Option<f64>>>>>,
    history: Arc<tokio::sync::Mutex<HashMap<String, Cached<Vec<(i64, f64)>>>>>,
}

impl Cambrian {
    pub fn new(api_key: String) -> Self {
        Self {
            http: reqwest::Client::new(),
            api_key,
            prices: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            history: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        }
    }

    pub fn is_configured(&self) -> bool {
        !self.api_key.is_empty()
    }

    fn col(&self, t: &Table, name: &str) -> Option<usize> {
        t.columns.iter().position(|c| c.name == name)
    }

    /// Current USD market price for a Base token (Cambrian, Uniswap v3 based).
    /// Cached for `ttl`.
    pub async fn price_current(&self, token: &str, ttl: Duration) -> Option<f64> {
        {
            let prices = self.prices.lock().await;
            if let Some(c) = prices.get(token) {
                if c.at.elapsed() < ttl {
                    return c.value;
                }
            }
        }
        let value = self.fetch_price_current(token).await;
        let mut prices = self.prices.lock().await;
        prices.insert(token.to_ascii_lowercase(), Cached { value, at: Instant::now() });
        value
    }

    async fn fetch_price_current(&self, token: &str) -> Option<f64> {
        let url = format!("{BASE}/price-current?chain_id={CHAIN_ID}&token_address={token}");
        let table: Table = self.get(&url).await.ok()?;
        let sym = self.col(&table, "priceUsd")?;
        let row = table.data.first()?;
        row.get(sym)?.as_f64()
    }

    /// Hourly market history for a Base token, newest first from the API.
    /// Returns (unix_ts, price) ascending by time. Cached for `ttl`.
    pub async fn price_hour(&self, token: &str, limit: usize, ttl: Duration) -> Vec<(i64, f64)> {
        {
            let history = self.history.lock().await;
            if let Some(c) = history.get(token) {
                if c.at.elapsed() < ttl {
                    return c.value.clone();
                }
            }
        }
        let value = self.fetch_price_hour(token, limit).await.unwrap_or_default();
        let mut history = self.history.lock().await;
        history.insert(token.to_ascii_lowercase(), Cached { value: value.clone(), at: Instant::now() });
        value
    }

    async fn fetch_price_hour(&self, token: &str, limit: usize) -> Option<Vec<(i64, f64)>> {
        let url = format!("{BASE}/price-hour?chain_id={CHAIN_ID}&token_address={token}&limit={limit}");
        let table: Table = self.get(&url).await.ok()?;
        let ts = self.col(&table, "blockHour")?;
        let px = self.col(&table, "priceUsd")?;
        let mut out = Vec::new();
        for row in table.data.iter() {
            let t = row.get(ts)?.as_str()?;
            let p = row.get(px)?.as_f64()?;
            // "2026-11-09T02:00:00+00:00" -> unix seconds
            let unix = parse_iso_hour(t)?;
            out.push((unix, p));
        }
        out.sort_by_key(|(t, _)| *t);
        Some(out)
    }

    async fn get(&self, url: &str) -> Result<Table, String> {
        // The free tier enforces a per-path RPS limit; space calls out.
        tokio::time::sleep(std::time::Duration::from_millis(220)).await;
        let resp = self
            .http
            .get(url)
            .header("X-API-Key", &self.api_key)
            .header("Content-Type", "application/json")
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        let body = resp.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("cambrian {status}: {body}"));
        }
        // The API returns an array of tables.
        let mut tables: Vec<Table> = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        if tables.is_empty() {
            return Err("cambrian: empty table".into());
        }
        Ok(tables.remove(0))
    }
}

/// Minimal ISO-8601 hour parser: "2026-11-09T02:00:00+00:00" -> unix seconds.
fn parse_iso_hour(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let num = |a: usize, z: usize| -> Option<i64> { s.get(a..z)?.parse::<i64>().ok() };
    let year = num(0, 4)?;
    let month = num(5, 7)?;
    let day = num(8, 10)?;
    let hour = num(11, 13)?;
    let minute = num(14, 16)?;
    let second = num(17, 19)?;
    // days since epoch (Howard Hinnant's civil_from_days, inverted)
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hour * 3600 + minute * 60 + second)
}
