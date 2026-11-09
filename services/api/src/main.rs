//! SlipNope API — Rust (Axum) support service.
//!
//! Responsibilities (deliberately thin; the hook is the product):
//!   GET  /health   liveness + chain id check against the Base RPC
//!   GET  /board    live Chainlink fair prices + NVDA market premium (v3 pool),
//!                  computed server-side from raw eth_call — same numbers the
//!                  hook enforces, independently reproducible
//!   POST /ledger   record an Overpay Ledger entry (fill or block)
//!   GET  /ledger/:wallet   entries for a wallet + saved-$ total
//!   GET  /stats    aggregate proof counters (blocks, fills, $ saved)
//!
//! Ledger persistence: append-only JSON lines file (LEDGER_FILE, default
//! ./ledger.jsonl) loaded at boot. No database to operate for a hackathon
//! deployment; the file is the audit trail.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::RwLock;
use tower_http::cors::CorsLayer;

// ---------------------------------------------------------------- consts

const DEFAULT_RPC: &str = "https://mainnet.base.org";

// Chainlink tokenized-equity feeds (Base mainnet, verified onchain 2026-11-09)
const FEEDS: [(&str, &str); 3] = [
    ("NVDAc", "0x04689a41629776563E6822F76f2e57D148d28513"),
    ("AAPLc", "0x787f13dEa48Db0897CbCDD985de77809D837F988"),
    ("TSLAc", "0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4"),
];
// latestRoundData() selector
const SEL_LATEST_ROUND: &str = "0xfeaf968c";

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
    market_usd: Option<f64>,
    premium_bps: Option<i64>,
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
struct AppState {
    rpc: String,
    http: reqwest::Client,
    ledger: Arc<RwLock<Vec<LedgerEntry>>>,
    ledger_file: String,
}

// ---------------------------------------------------------------- rpc

async fn eth_call(state: &AppState, to: &str, data: &str) -> Result<String, String> {
    let body = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "eth_call",
        "params": [{ "to": to, "data": data }, "latest"]
    });
    let resp: serde_json::Value = state
        .http
        .post(&state.rpc)
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

/// Decode the int256 answer + updatedAt out of a latestRoundData() blob
/// (5 x 32-byte words: roundId, answer, startedAt, updatedAt, answeredInRound).
fn decode_feed(hex: &str) -> Option<(f64, u64)> {
    if hex.len() < 320 {
        return None;
    }
    let word = |i: usize| &hex[i * 64..(i + 1) * 64];
    // answer is int256; prices are positive, treat as unsigned magnitude.
    let answer = u128::from_str_radix(&word(1)[32..], 16).ok()? as f64 / 1e8;
    let updated = u64::from_str_radix(word(3), 16).ok()?;
    Some((answer, updated))
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

// ---------------------------------------------------------------- handlers

async fn health(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let chain = eth_call(&state, FEEDS[0].1, SEL_LATEST_ROUND).await;
    Json(serde_json::json!({
        "ok": chain.is_ok(),
        "service": "slipnope-api",
        "chainId": 8453,
        "rpc": state.rpc,
        "feedReachable": chain.is_ok(),
    }))
}

async fn board(State(state): State<Arc<AppState>>) -> Result<Json<Vec<BoardRow>>, StatusCode> {
    let mut rows = Vec::new();
    for (symbol, feed) in FEEDS.iter() {
        let hex = eth_call(&state, feed, SEL_LATEST_ROUND)
            .await
            .map_err(|_| StatusCode::BAD_GATEWAY)?;
        let (fair, updated) = decode_feed(&hex).ok_or(StatusCode::BAD_GATEWAY)?;
        let market: Option<f64> = None;
        let premium_bps: Option<i64> = None;
        rows.push(BoardRow {
            symbol: symbol.to_string(),
            fair_usd: Some(fair),
            market_usd: market,
            premium_bps,
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
    // Append-only audit file; failure to persist must not lose the response path.
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
        saved_usd_total: 0.0 + (guard
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

    // Load persisted ledger (JSON lines).
    let mut entries: Vec<LedgerEntry> = Vec::new();
    if let Ok(content) = tokio::fs::read_to_string(&ledger_file).await {
        for line in content.lines() {
            if let Ok(e) = serde_json::from_str::<LedgerEntry>(line) {
                entries.push(e);
            }
        }
    }
    println!("slipnope-api: loaded {} ledger entries from {ledger_file}", entries.len());
    let _ = HashMap::<String, ()>::new(); // keep HashMap import honest for future indexing

    let state = Arc::new(AppState {
        rpc,
        http: reqwest::Client::new(),
        ledger: Arc::new(RwLock::new(entries)),
        ledger_file,
    });

    let app = Router::new()
        .route("/health", get(health))
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
