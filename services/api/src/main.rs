//! SlipNope API — Rust (Axum) support service.
//!
//! Responsibilities (deliberately thin; the hook is the product):
//!   GET  /health            liveness + Base RPC / feed reachability
//!   GET  /tape              the Dislocation Tape: market-wide Chainlink-vs-market
//!                           premium for tracked tokenized stocks, with a
//!                           "would SlipNope block this?" verdict
//!   GET  /board             Chainlink fair prices only (no third-party dependency)
//!   POST /ledger            record an Overpay Ledger entry (fill or block)
//!   GET  /ledger/:wallet    entries for a wallet + saved-$ total
//!   GET  /stats             aggregate proof counters
//!
//! Trust boundary: enforcement is onchain (Chainlink), never this service.
//! Cambrian data is market *evidence*, clearly labelled as such.

mod cambrian;
mod onchain;
mod proof;
mod tape;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::RwLock;
use tower_http::cors::CorsLayer;

const DEFAULT_RPC: &str = "https://base-rpc.publicnode.com";

/// SlipNope hook on Base mainnet (v2: beforeSwap + afterSwap).
const HOOK: &str = "0xee7344d34b3ec4f2ad24a668bc0d84e55de640c0";

// Chainlink tokenized-equity feeds (Base mainnet, verified onchain 2026-11-10)
const FEEDS: [(&str, &str); 3] = [
    ("NVDAc", "0x04689a41629776563E6822F76f2e57D148d28513"),
    ("AAPLc", "0x787f13dEa48Db0897CbCDD985de77809D837F988"),
    ("TSLAc", "0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4"),
];

// ---------------------------------------------------------------- types

#[derive(Clone, Serialize, Deserialize)]
struct LedgerEntry {
    id: String,
    ts: u64,
    wallet: String,
    symbol: String,
    side: String,
    #[serde(rename = "amountUsd")]
    amount_usd: f64,
    #[serde(rename = "poolPrice")]
    pool_price: f64,
    #[serde(rename = "fairPrice")]
    fair_price: f64,
    #[serde(rename = "adverseBps")]
    adverse_bps: i64,
    #[serde(rename = "bandBps")]
    band_bps: i64,
    decision: String, // OK | WARN | BLOCK
    #[serde(rename = "savedUsd")]
    saved_usd: f64,
    #[serde(rename = "txHash", default)]
    tx_hash: Option<String>,
}

#[derive(Serialize)]
struct BoardRow {
    symbol: String,
    fair_usd: Option<f64>,
    feed_age_secs: Option<u64>,
    feed: String,
}

#[derive(Serialize)]
struct Stats {
    entries: usize,
    blocks: usize,
    fills: usize,
    saved_usd_total: f64,
}

#[derive(Clone)]
pub struct AppState {
    rpc: String,
    http: reqwest::Client,
    ledger: Arc<RwLock<Vec<LedgerEntry>>>,
    ledger_file: String,
    cambrian: cambrian::Cambrian,
    /// Snapshot of the Dislocation Tape, rebuilt by a background warmer so the
    /// public endpoint answers in milliseconds and Cambrian quota stays bounded.
    tape_cache: Arc<RwLock<Option<(u64, serde_json::Value)>>>,
    /// Snapshot of the onchain proof counters (GuardAllowed logs).
    proof_cache: Arc<RwLock<Option<(u64, serde_json::Value)>>>,
}

// ---------------------------------------------------------------- rpc

impl AppState {
    pub async fn eth_call(&self, to: &str, data: &str) -> Result<String, String> {
        let body = serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "eth_call",
            "params": [{ "to": to, "data": data }, "latest"]
        });
        let resp: serde_json::Value = self
            .http
            .post(&self.rpc)
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        resp["result"]
            .as_str()
            .map(|s| s.trim_start_matches("0x").to_string())
            .ok_or_else(|| format!("rpc error: {resp}"))
    }

    pub async fn block_number(&self) -> Result<u64, String> {
        let body = serde_json::json!({"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]});
        let resp: serde_json::Value = self
            .http
            .post(&self.rpc)
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        u64::from_str_radix(
            resp["result"].as_str().unwrap_or("0x0").trim_start_matches("0x"),
            16,
        )
        .map_err(|e| e.to_string())
    }

    pub async fn get_logs(
        &self,
        address: &str,
        topic0: &str,
        from: u64,
        to: u64,
    ) -> Result<Vec<LogEntry>, String> {
        let body = serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "eth_getLogs",
            "params": [{
                "address": address,
                "fromBlock": format!("0x{from:x}"),
                "toBlock": format!("0x{to:x}"),
                "topics": [topic0]
            }]
        });
        let resp: serde_json::Value = self
            .http
            .post(&self.rpc)
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        let arr = resp["result"].as_array().ok_or_else(|| format!("rpc error: {resp}"))?;
        Ok(arr
            .iter()
            .map(|l| LogEntry {
                transaction_hash: l["transactionHash"].as_str().unwrap_or_default().to_string(),
                block_number: l["blockNumber"].as_str().unwrap_or("0x0").to_string(),
                data: l["data"].as_str().unwrap_or_default().to_string(),
                topics: l["topics"]
                    .as_array()
                    .map(|t| t.iter().map(|x| x.as_str().unwrap_or_default().to_string()).collect())
                    .unwrap_or_default(),
            })
            .collect())
    }
}

/// Minimal eth_getLogs entry.
pub struct LogEntry {
    pub transaction_hash: String,
    pub block_number: String,
    pub data: String,
    pub topics: Vec<String>,
}

pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

// ---------------------------------------------------------------- handlers

async fn health(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let chain = state.eth_call(FEEDS[0].1, onchain::SEL_LATEST_ROUND).await;
    Json(serde_json::json!({
        "ok": chain.is_ok(),
        "service": "slipnope-api",
        "chainId": 8453,
        "rpc": state.rpc,
        "feedReachable": chain.is_ok(),
        "cambrian": state.cambrian.is_configured(),
        "bandBps": tape::BAND_BPS,
    }))
}

/// The Dislocation Tape — market vs Chainlink fair across the tracked universe.
/// Served from a snapshot refreshed by the background warmer.
async fn get_tape(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let cached = state.tape_cache.read().await.clone();
    match cached {
        Some((at, mut value)) => {
            if let Some(obj) = value.as_object_mut() {
                obj.insert("cachedAt".into(), serde_json::json!(at));
                obj.insert("staleSecs".into(), serde_json::json!(now_secs().saturating_sub(at)));
            }
            Json(value)
        }
        None => Json(serde_json::json!({
            "generatedAt": now_secs(),
            "bandBps": tape::BAND_BPS,
            "rows": [],
            "warming": true,
        })),
    }
}

/// Rebuilds the tape snapshot; the only writer of `tape_cache`.
async fn refresh_tape(state: Arc<AppState>) -> serde_json::Value {
    let rows = tape::build(&state).await;
    let dislocated = rows.iter().filter(|r| r.would_block).count();
    let value = serde_json::json!({
        "generatedAt": now_secs(),
        "bandBps": tape::BAND_BPS,
        "dislocated": dislocated,
        "tracked": rows.len(),
        "rows": rows,
        "sources": {
            "fair": "Chainlink tokenized-equity feed, read onchain (same value the hook enforces)",
            "market": "Cambrian API, Uniswap v3 derived USD price on Base",
        },
    });
    *state.tape_cache.write().await = Some((now_secs(), value.clone()));
    value
}

/// Onchain proof: how many swaps the guard actually adjudicated.
async fn get_proof(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let cached = state.proof_cache.read().await.clone();
    match cached {
        Some((at, value)) => Json(serde_json::json!({
            "cachedAt": at,
            "staleSecs": now_secs().saturating_sub(at),
            "proof": value,
        })),
        None => Json(serde_json::json!({ "proof": null, "warming": true })),
    }
}

async fn refresh_proof(state: Arc<AppState>) -> serde_json::Value {
    let p = proof::build(&state, HOOK).await;
    let value = serde_json::to_value(&p).unwrap_or(serde_json::Value::Null);
    *state.proof_cache.write().await = Some((now_secs(), value.clone()));
    value
}

async fn board(State(state): State<Arc<AppState>>) -> Result<Json<Vec<BoardRow>>, StatusCode> {
    let mut rows = Vec::new();
    for (symbol, feed) in FEEDS.iter() {
        let hex = state
            .eth_call(feed, onchain::SEL_LATEST_ROUND)
            .await
            .map_err(|_| StatusCode::BAD_GATEWAY)?;
        let (fair, updated) = onchain::decode_round(&hex).ok_or(StatusCode::BAD_GATEWAY)?;
        rows.push(BoardRow {
            symbol: symbol.to_string(),
            fair_usd: Some(fair),
            feed_age_secs: Some(now_secs().saturating_sub(updated)),
            feed: feed.to_string(),
        });
    }
    Ok(Json(rows))
}

async fn post_ledger(
    State(state): State<Arc<AppState>>,
    Json(entry): Json<LedgerEntry>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if entry.decision != "OK" && entry.decision != "WARN" && entry.decision != "BLOCK" {
        return Err(StatusCode::BAD_REQUEST);
    }
    {
        let mut guard = state.ledger.write().await;
        guard.push(entry.clone());
    }
    if let Ok(line) = serde_json::to_string(&entry) {
        let file = state.ledger_file.clone();
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            if let Ok(mut f) = tokio::fs::OpenOptions::new().create(true).append(true).open(&file).await {
                let _ = f.write_all(format!("{line}\n").as_bytes()).await;
            }
        });
    }
    Ok(Json(serde_json::json!({ "recorded": true, "id": entry.id })))
}

async fn get_ledger(
    State(state): State<Arc<AppState>>,
    Path(wallet): Path<String>,
) -> Json<serde_json::Value> {
    let guard = state.ledger.read().await;
    let mine: Vec<&LedgerEntry> = guard
        .iter()
        .filter(|e| e.wallet.eq_ignore_ascii_case(&wallet))
        .collect();
    let saved: f64 = mine.iter().filter(|e| e.decision == "BLOCK").map(|e| e.saved_usd).sum();
    Json(serde_json::json!({
        "wallet": wallet,
        "count": mine.len(),
        "savedUsdTotal": (saved * 100.0).round() / 100.0,
        "entries": mine,
    }))
}

async fn stats(State(state): State<Arc<AppState>>) -> Json<Stats> {
    let guard = state.ledger.read().await;
    let blocks = guard.iter().filter(|e| e.decision == "BLOCK").count();
    Json(Stats {
        entries: guard.len(),
        blocks,
        fills: guard.len() - blocks,
        saved_usd_total: 0.0
            + (guard
                .iter()
                .filter(|e| e.decision == "BLOCK")
                .map(|e| e.saved_usd)
                .sum::<f64>()
                * 100.0)
                .round()
                / 100.0,
    })
}

// ---------------------------------------------------------------- main

#[tokio::main]
async fn main() {
    let rpc = std::env::var("RH_RPC_URL").unwrap_or_else(|_| DEFAULT_RPC.to_string());
    let port: u16 = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8787);
    let ledger_file = std::env::var("LEDGER_FILE").unwrap_or_else(|_| "ledger.jsonl".to_string());
    let cambrian_key = std::env::var("CAMBRIAN_API_KEY").unwrap_or_default();

    let mut entries: Vec<LedgerEntry> = Vec::new();
    if let Ok(content) = tokio::fs::read_to_string(&ledger_file).await {
        for line in content.lines() {
            if let Ok(e) = serde_json::from_str::<LedgerEntry>(line) {
                entries.push(e);
            }
        }
    }
    println!("slipnope-api: loaded {} ledger entries from {ledger_file}", entries.len());

    let state = Arc::new(AppState {
        rpc,
        http: reqwest::Client::new(),
        ledger: Arc::new(RwLock::new(entries)),
        ledger_file,
        cambrian: cambrian::Cambrian::new(cambrian_key),
        tape_cache: Arc::new(RwLock::new(None)),
        proof_cache: Arc::new(RwLock::new(None)),
    });

    // Background warmer: keeps the tape hot so public reads are instant and
    // Cambrian calls stay bounded (one full sweep every 10 minutes).
    {
        let warmer = state.clone();
        tokio::spawn(async move {
            loop {
                let started = std::time::Instant::now();
                let tape = refresh_tape(warmer.clone()).await;
                let rows = tape["tracked"].as_u64().unwrap_or(0);
                let dislocated = tape["dislocated"].as_u64().unwrap_or(0);
                println!(
                    "tape refreshed: {rows} tracked, {dislocated} dislocated, {:?}",
                    started.elapsed()
                );
                tokio::time::sleep(std::time::Duration::from_secs(600)).await;
            }
        });
    }

    // Proof warmer: log scan every 5 minutes (chunked eth_getLogs).
    {
        let warmer = state.clone();
        tokio::spawn(async move {
            loop {
                let value = refresh_proof(warmer.clone()).await;
                println!(
                    "proof refreshed: {} guarded swaps, {} warn",
                    value["guarded_swaps"], value["warn_swaps"]
                );
                tokio::time::sleep(std::time::Duration::from_secs(300)).await;
            }
        });
    }

    let app = Router::new()
        .route("/health", get(health))
        .route("/tape", get(get_tape))
        .route("/proof", get(get_proof))
        .route("/board", get(board))
        .route("/ledger", post(post_ledger))
        .route("/ledger/:wallet", get(get_ledger))
        .route("/stats", get(stats))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await.expect("bind");
    println!("slipnope-api listening on :{port}");
    axum::serve(listener, app).await.expect("serve");
}
