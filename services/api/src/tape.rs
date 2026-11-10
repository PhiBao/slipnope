//! The Dislocation Tape: market-wide proof that overpaying is a live, measurable
//! problem on Base — and what SlipNope would do about it.
//!
//! For each tracked Coinbase stock token:
//!   fair   = Chainlink total-return feed (the number the hook enforces, read onchain)
//!   market = Cambrian's Uniswap-v3-derived USD price (the wider Base market)
//!   premium = (market - fair) / fair  -> the dislocation
//!   wouldBlock = premium beyond the guard band (a buy at that premium is blocked)
//!
//! Both sources are independent. The hook only ever sees the Chainlink number;
//! the tape exists to show the gap is real and to size it.

use crate::{onchain, AppState};
use serde::Serialize;
use std::time::Duration;

/// Guard band used for the "would SlipNope block this?" badge (bps).
pub const BAND_BPS: i64 = 300;

/// Cache TTLs — quota discipline on the Cambrian free tier (1000 calls/month).
const PRICE_TTL: Duration = Duration::from_secs(600);
const HISTORY_TTL: Duration = Duration::from_secs(6 * 3600);

pub struct Stock {
    pub symbol: &'static str,
    pub name: &'static str,
    pub token: &'static str,
    pub feed: &'static str,
}

/// Coinbase tokenized stocks (B20) + their Chainlink feeds on Base.
/// Token addresses and feed addresses verified against the Coinbase
/// Tokenized Stocks API and docs.base.org on 2026-11-10.
pub const UNIVERSE: &[Stock] = &[
    Stock { symbol: "NVDAc", name: "NVIDIA", token: "0xb20000000000000000000078ee7ce2fE4908108C", feed: "0x04689a41629776563E6822F76f2e57D148d28513" },
    Stock { symbol: "AAPLc", name: "Apple", token: "0xb200000000000000000000C2e324d24d7eEcd1fb", feed: "0x787f13dEa48Db0897CbCDD985de77809D837F988" },
    Stock { symbol: "TSLAc", name: "Tesla", token: "0xb2000000000000000000001e800a7f5189430cD0", feed: "0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4" },
    Stock { symbol: "MSFTc", name: "Microsoft", token: "0xB200000000000000000000Ab99cFa739E253872B", feed: "0xeB10A6c9aa7E537aEd766C08c35Dae35B321b18c" },
    Stock { symbol: "METAc", name: "Meta", token: "0xb2000000000000000000008bC8786B856E61707C", feed: "0x6526aE6797A76123638b863AeE4dD27Ba4E4b27D" },
    Stock { symbol: "GOOGLc", name: "Alphabet", token: "0xb2000000000000000000002D0BA3164cc74f58B7", feed: "0x5bF49E0ffA937CE2FfF033c739aD7C634c4D34F2" },
    Stock { symbol: "AMZNc", name: "Amazon", token: "0xb200000000000000000000d9192b6B456483C2E8", feed: "0x06A8E4b3aBB3B7543d8396FB2B763d22820cB295" },
    Stock { symbol: "MSTRc", name: "Strategy", token: "0xb2000000000000000000004884b426556b92883d", feed: "0xB3cE282CD188b35DA0E38D8Bc7d58e33173D202a" },
    Stock { symbol: "SPCXc", name: "SpaceX", token: "0xb2000000000000000000007b9fcbd005511aCBd5", feed: "0x6A634B235903C4ad6376892180d6fF8612e3Fa68" },
    Stock { symbol: "SNDKc", name: "SanDisk", token: "0xb200000000000000000000397293Cb8cda9a10c5", feed: "0x388b0dC46C0Fb05A74BeE0994fa5b02c6Fcca2eA" },
];

#[derive(Serialize)]
pub struct TapeRow {
    pub symbol: &'static str,
    pub name: &'static str,
    pub token: &'static str,
    pub feed: &'static str,
    pub fair_usd: Option<f64>,
    pub market_usd: Option<f64>,
    pub premium_bps: Option<i64>,
    pub would_block: bool,
    pub feed_age_secs: Option<u64>,
    /// 24h market history as (unix ts, price) — drives the sparkline.
    pub history: Vec<(i64, f64)>,
    /// 24h market range, so the quote can be judged as firm or thin.
    pub history_min: Option<f64>,
    pub history_max: Option<f64>,
    pub change_24h_pct: Option<f64>,
    /// How much to trust this quote as a *market* price:
    ///   firm    — 24h range within ±3%, quote is stable
    ///   thin    — 24h range wider than ±3%; likely a thin-pool quote
    ///   unknown — no history
    pub quote_confidence: &'static str,
}

fn summarise(history: &[(i64, f64)], market: Option<f64>) -> (Option<f64>, Option<f64>, Option<f64>, &'static str) {
    if history.is_empty() {
        return (None, None, None, "unknown");
    }
    let lo = history.iter().map(|(_, p)| *p).fold(f64::INFINITY, f64::min);
    let hi = history.iter().map(|(_, p)| *p).fold(f64::NEG_INFINITY, f64::max);
    let first = history.first().map(|(_, p)| *p).unwrap_or(0.0);
    let last = market.unwrap_or_else(|| history.last().map(|(_, p)| *p).unwrap_or(0.0));
    let change = if first > 0.0 { Some(((last - first) / first) * 100.0) } else { None };
    let span_pct = if lo > 0.0 { (hi - lo) / lo * 100.0 } else { 0.0 };
    let confidence = if span_pct > 6.0 {
        "thin"
    } else if span_pct > 2.0 {
        "fair"
    } else {
        "firm"
    };
    (Some(lo), Some(hi), change, confidence)
}

pub async fn build(state: &AppState) -> Vec<TapeRow> {
    let mut rows = Vec::with_capacity(UNIVERSE.len());
    for s in UNIVERSE {
        // Fair: the onchain Chainlink reference the hook enforces.
        let (fair, updated) = match state.eth_call(s.feed, onchain::SEL_LATEST_ROUND).await {
            Ok(hex) => match onchain::decode_round(&hex) {
                Some(v) => (Some(v.0), Some(v.1)),
                None => (None, None),
            },
            Err(_) => (None, None),
        };

        // Market: independent offchain view of what Base is trading at.
        // If the live quote is rate-limited or missing, fall back to the most
        // recent hourly close so the tape degrades instead of going blank.
        let history = if state.cambrian.is_configured() {
            state.cambrian.price_hour(s.token, 24, HISTORY_TTL).await
        } else {
            Vec::new()
        };
        let market = if state.cambrian.is_configured() {
            let live = state.cambrian.price_current(s.token, PRICE_TTL).await;
            live.or_else(|| history.last().map(|(_, p)| *p))
        } else {
            None
        };

        let premium_bps = match (fair, market) {
            (Some(f), Some(m)) if f > 0.0 => Some((((m - f) / f) * 10_000.0).round() as i64),
            _ => None,
        };
        // A buy at this premium is what the hook refuses (adverse deviation).
        let would_block = premium_bps.map(|p| p > BAND_BPS).unwrap_or(false);
        let (history_min, history_max, change_24h_pct, quote_confidence) = summarise(&history, market);

        rows.push(TapeRow {
            symbol: s.symbol,
            name: s.name,
            token: s.token,
            feed: s.feed,
            fair_usd: fair,
            market_usd: market,
            premium_bps,
            would_block,
            feed_age_secs: updated.map(|u| crate::now_secs().saturating_sub(u)),
            history_min,
            history_max,
            change_24h_pct,
            quote_confidence,
            history,
        });
    }
    rows
}
