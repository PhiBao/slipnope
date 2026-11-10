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
mod guard_abi;
mod jev;
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
    jev: jev::Jev,
    /// Snapshot of the Dislocation Tape, rebuilt by a background warmer so the
    /// public endpoint answers in milliseconds and Cambrian quota stays bounded.
    tape_cache: Arc<RwLock<Option<(u64, serde_json::Value)>>>,
    /// Snapshot of the onchain proof counters (GuardAllowed logs).
    proof_cache: Arc<RwLock<Option<(u64, serde_json::Value)>>>,
    /// Where the tape snapshot persists across machine restarts.
    tape_file: String,
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
        "typesafe": state.jev.is_configured(),
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

/// A ready-to-post digest of the worst dislocations — build-in-public fuel that
/// is generated from measured data, not written by hand.
async fn get_digest(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let cached = state.tape_cache.read().await.clone();
    let Some((at, value)) = cached else {
        return Json(serde_json::json!({ "ready": false, "reason": "tape warming" }));
    };
    let mut rows: Vec<&serde_json::Value> = value["rows"]
        .as_array()
        .map(|a| a.iter().filter(|r| r["premium_bps"].as_i64().is_some()).collect())
        .unwrap_or_default();
    rows.sort_by_key(|r| -r["premium_bps"].as_i64().unwrap_or(0).abs());

    let band = value["bandBps"].as_i64().unwrap_or(300);
    let mut lines = Vec::new();
    for r in rows.iter().take(5) {
        let sym = r["symbol"].as_str().unwrap_or("?");
        let prem = r["premium_bps"].as_i64().unwrap_or(0);
        let blocked = r["would_block"].as_bool().unwrap_or(false);
        let conf = r["quote_confidence"].as_str().unwrap_or("unknown");
        let mark = if blocked { "BLOCK" } else { "ok" };
        lines.push(format!(
            "{} {:+.2}% vs Chainlink fair [{}] ({})",
            sym,
            prem as f64 / 100.0,
            mark,
            conf
        ));
    }
    let dislocated = value["dislocated"].as_i64().unwrap_or(0);
    let tracked = value["tracked"].as_i64().unwrap_or(0);
    let text = format!(
        "SlipNope tape · {} of {} tokenized stocks on Base are priced above fair right now (guard band ±{:.2}%):\n{}\n\nFair = Chainlink (onchain). Market = Cambrian. A buy past the band cannot settle in a guarded pool.",
        dislocated,
        tracked,
        band as f64 / 100.0,
        lines.iter().map(|l| format!("· {l}")).collect::<Vec<_>>().join("\n")
    );

    Json(serde_json::json!({
        "ready": true,
        "generatedAt": at,
        "dislocated": dislocated,
        "tracked": tracked,
        "bandBps": band,
        "text": text,
        "rows": rows.iter().take(5).collect::<Vec<_>>(),
    }))
}

/// Rebuilds the tape snapshot; the only writer of `tape_cache`.
async fn refresh_tape(state: Arc<AppState>) -> serde_json::Value {
    let tape_file_path = state.tape_file.clone();
    let rows = tape::build(&state).await;
    let all_failed = rows.iter().all(|r| r.fair_usd.is_none());
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
    // Cold-start resilience: a scale-to-zero machine must not answer "warming"
    // to the first visitor. Persist the last good snapshot and reload it on boot.
    if !all_failed {
        if let Ok(json) = serde_json::to_string(&value) {
            let _ = tokio::fs::write(&tape_file_path, json).await;
        }
        *state.tape_cache.write().await = Some((now_secs(), value.clone()));
    }
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

/// Public guard verdict for one symbol.
///
/// For the guarded pool this reports exactly what the hook would do, read from
/// `previewGuard` onchain (the same function the app renders before signing).
/// The market premium from the tape is attached as context, never as the verdict.
async fn get_guard(
    State(state): State<Arc<AppState>>,
    Path(symbol): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let stock = tape::UNIVERSE
        .iter()
        .find(|s| s.symbol.eq_ignore_ascii_case(&symbol))
        .ok_or(StatusCode::NOT_FOUND)?;

    let guarded_pool = guard_abi::pool_for_stock(stock.token);
    let guarded = guarded_pool.is_some();

    // Onchain truth, straight from the hook's own view.
    let onchain = if let Some(pool) = guarded_pool {
        let zero = "0x0000000000000000000000000000000000000000";
        let buy = state
            .eth_call(
                guard_abi::GUARDED_POOL_HOOK,
                &guard_abi::preview_guard_calldata(pool, true, zero),
            )
            .await
            .ok()
            .and_then(|h| guard_abi::decode_preview_guard(&h));
        let sell = state
            .eth_call(
                guard_abi::GUARDED_POOL_HOOK,
                &guard_abi::preview_guard_calldata(pool, false, zero),
            )
            .await
            .ok()
            .and_then(|h| guard_abi::decode_preview_guard(&h));
        buy.zip(sell)
    } else {
        None
    };

    // Context: market quote vs Chainlink fair (the tape's numbers).
    let fair_usd = state
        .eth_call(stock.feed, onchain::SEL_LATEST_ROUND)
        .await
        .ok()
        .and_then(|h| onchain::decode_round(&h))
        .map(|(p, u)| (p, u));
    let market = if state.cambrian.is_configured() {
        let live = state.cambrian.price_current(stock.token, std::time::Duration::from_secs(600)).await;
        match live {
            Some(p) => Some(p),
            None => state
                .cambrian
                .price_hour(stock.token, 24, std::time::Duration::from_secs(6 * 3600))
                .await
                .last()
                .map(|(_, p)| *p),
        }
    } else {
        None
    };
    let premium_bps = match (fair_usd.map(|(p, _)| p), market) {
        (Some(f), Some(m)) if f > 0.0 => Some((((m - f) / f) * 10_000.0).round() as i64),
        _ => None,
    };

    let (verdict, buy_blocked, sell_blocked, pool_price, hook_fair, band) = match &onchain {
        Some((b, s)) => {
            let v = if b.blocked {
                "BUY_BLOCKED"
            } else if s.blocked {
                "SELL_BLOCKED"
            } else if b.adverse_bps > b.band_bps / 2 {
                "WARN"
            } else {
                "OK"
            };
            (
                v,
                b.blocked,
                s.blocked,
                Some(b.pool_price_e18 as f64 / 1e18),
                Some(b.fair_price_e18 as f64 / 1e18),
                Some(b.band_bps as i64),
            )
        }
        None => (
            if premium_bps.map(|p| p > tape::BAND_BPS).unwrap_or(false) {
                "NO_GUARDED_POOL_DISLOCATED"
            } else {
                "NO_GUARDED_POOL"
            },
            false,
            false,
            None,
            fair_usd.map(|(p, _)| p),
            None,
        ),
    };

    // Deterministic staleness first; the advisory gets the rule, not a guess.
    let feed_age = fair_usd.map(|(_, u)| now_secs().saturating_sub(u));
    let max_age = 4 * 24 * 3600u64;
    let reference_stale = feed_age.map(|a| a > max_age).unwrap_or(true);

    let advisory = state
        .jev
        .assess(
            stock.symbol,
            serde_json::json!({
                "symbol": stock.symbol,
                "guardedPool": guarded,
                "marketPremiumBps": premium_bps,
                "adverseBpsAtGuard": onchain.as_ref().map(|(b, _)| b.adverse_bps),
                "bandBps": band.unwrap_or(tape::BAND_BPS as i64),
                "referenceAgeSecs": feed_age,
                "referenceMaxAgeSecs": max_age,
                "referenceIsStaleByRule": reference_stale,
                "referencePolicy": "Tokenized-equity Chainlink feeds update 24/5 and deliberately hold their last value overnight and at weekends. A hold shorter than the maximum age below is normal operation, NOT staleness. Only a hold longer than the maximum, or a frozen feed during a corporate action, counts as stale.",
                "marketSource": "Cambrian Uniswap v3 quote on Base (offchain, evidence only)",
                "referenceSource": "Chainlink tokenized-equity feed read onchain (the only value the hook uses)"
            }),
        )
        .await;

    Ok(Json(serde_json::json!({
        "symbol": stock.symbol,
        "name": stock.name,
        "token": stock.token,
        "feed": stock.feed,
        "guardedPool": guarded,
        "verdict": verdict,
        "buyBlocked": buy_blocked,
        "sellBlocked": sell_blocked,
        "bandBps": band,
        "poolPriceUsd": pool_price,
        "hookFairUsd": hook_fair,
        "fairUsd": fair_usd.map(|(p, _)| p),
        "marketUsd": market,
        "premiumBps": premium_bps,
        "feedAgeSecs": fair_usd.map(|(_, u)| now_secs().saturating_sub(u)),
        "advisory": advisory,
        "advisoryDegraded": advisory.is_none(),
        "enforcement": "onchain (SlipNope hook) — this endpoint reports it, it does not decide",
        "generatedAt": now_secs(),
    })))
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
    let tape_file = std::env::var("TAPE_FILE").unwrap_or_else(|_| "/tmp/tape.json".to_string());
    let cambrian_key = std::env::var("CAMBRIAN_API_KEY").unwrap_or_default();
    let typesafe_key = std::env::var("TYPESAFE_API_KEY").unwrap_or_default();

    let mut entries: Vec<LedgerEntry> = Vec::new();
    if let Ok(content) = tokio::fs::read_to_string(&ledger_file).await {
        for line in content.lines() {
            if let Ok(e) = serde_json::from_str::<LedgerEntry>(line) {
                entries.push(e);
            }
        }
    }
    println!("slipnope-api: loaded {} ledger entries from {ledger_file}", entries.len());

    // Restore the previous tape snapshot so a cold start is never empty.
    let restored: Option<(u64, serde_json::Value)> = match tokio::fs::read_to_string(&tape_file).await {
        Ok(body) => serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .map(|v| (v["generatedAt"].as_u64().unwrap_or(0), v)),
        Err(_) => None,
    };
    let restored_at = restored.as_ref().map(|(a, _)| *a);
    println!("tape snapshot restored: {:?}", restored_at);

    let state = Arc::new(AppState {
        rpc,
        http: reqwest::Client::new(),
        ledger: Arc::new(RwLock::new(entries)),
        ledger_file,
        cambrian: cambrian::Cambrian::new(cambrian_key),
        jev: jev::Jev::new(typesafe_key),
        tape_cache: Arc::new(RwLock::new(restored)),
        proof_cache: Arc::new(RwLock::new(None)),
        tape_file,
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
        .route("/tape/digest", get(get_digest))
        .route("/proof", get(get_proof))
        .route("/guard/:symbol", get(get_guard))
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
