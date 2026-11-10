//! Onchain proof feed for the SlipNope hook.
//!
//! Every settled guarded swap emits `GuardAllowed(poolId, trader, adverseBps,
//! bandBps, fee, poolPrice, fairPrice, warn)`. Counting those logs gives a
//! number nobody can fake: how many swaps the guard actually adjudicated, and
//! how often it was already in the WARN tier.
//!
//! Blocked swaps revert, so they leave no log — that is the point of a block.
//! Blocked attempts are surfaced from the app ledger instead, and the manual
//! verification transactions are public on BaseScan.

use crate::AppState;
use serde::Serialize;

/// Block the mainnet hook was deployed in (tx 0x1efae265…).
pub const HOOK_DEPLOY_BLOCK: u64 = 55_358_722;
/// RPCs cap `eth_getLogs` ranges; 50k works on public Base endpoints.
const CHUNK: u64 = 50_000;
pub const TOPIC_GUARD_ALLOWED: &str =
    "0xe1618070e45174bdd40142cd83142c80a452cba47639beb6c81892b3f3cd082c";

#[derive(Serialize, Clone)]
pub struct GuardEvent {
    pub tx: String,
    pub block: u64,
    pub trader: String,
    pub adverse_bps: u64,
    pub fee: u64,
    pub warn: bool,
}

#[derive(Serialize, Clone, Default)]
pub struct Proof {
    pub hook: String,
    pub guarded_swaps: u64,
    pub warn_swaps: u64,
    pub recent: Vec<GuardEvent>,
    pub scanned_from_block: u64,
    pub head_block: u64,
    pub scanned_ok: bool,
}

fn word(hex: &str, i: usize) -> Option<u64> {
    u64::from_str_radix(hex.get(i * 64..(i + 1) * 64)?, 16).ok()
}

pub async fn build(state: &AppState, hook: &str) -> Proof {
    let mut proof = Proof {
        hook: hook.to_string(),
        scanned_from_block: HOOK_DEPLOY_BLOCK,
        ..Default::default()
    };

    let head = match state.block_number().await {
        Ok(h) => h,
        Err(_) => return proof,
    };
    proof.head_block = head;

    let mut from = HOOK_DEPLOY_BLOCK;
    let mut recent: Vec<GuardEvent> = Vec::new();
    while from <= head {
        let to = (from + CHUNK - 1).min(head);
        match state.get_logs(hook, TOPIC_GUARD_ALLOWED, from, to).await {
            Ok(logs) => {
                for log in logs {
                    proof.guarded_swaps += 1;
                    let data = log.data.trim_start_matches("0x");
                    let adverse = word(data, 0).unwrap_or(0);
                    let fee = word(data, 2).unwrap_or(0);
                    let warn = word(data, 5).unwrap_or(0) != 0;
                    if warn {
                        proof.warn_swaps += 1;
                    }
                    let trader = log
                        .topics
                        .get(2)
                        .map(|t| format!("0x{}", &t.trim_start_matches("0x")[24..]))
                        .unwrap_or_default();
                    recent.push(GuardEvent {
                        tx: log.transaction_hash,
                        block: u64::from_str_radix(log.block_number.trim_start_matches("0x"), 16)
                            .unwrap_or(0),
                        trader,
                        adverse_bps: adverse,
                        fee,
                        warn,
                    });
                }
                proof.scanned_ok = true;
            }
            Err(_) => return proof,
        }
        from = to + 1;
    }

    recent.sort_by(|a, b| b.block.cmp(&a.block));
    recent.truncate(10);
    proof.recent = recent;
    proof
}
