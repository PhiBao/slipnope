//! Chainlink reference-price reads for Base tokenized stocks.
//!
//! The onchain truth is Chainlink: the SlipNope hook reads the same feeds
//! directly. This module exists so the API can show the *same* fair value the
//! hook enforces, without asking a third party.

/// Chainlink AggregatorV3 `latestRoundData()` selector.
pub const SEL_LATEST_ROUND: &str = "0xfeaf968c";

/// Decode a `latestRoundData()` return blob into (price, updatedAt).
/// The blob is 5 x 32-byte words: roundId, answer, startedAt, updatedAt, answeredInRound.
/// `answer` is int256; prices are positive so we read the magnitude.
pub fn decode_round(hex: &str) -> Option<(f64, u64)> {
    let hex = hex.trim_start_matches("0x");
    if hex.len() < 320 {
        return None;
    }
    let word = |i: usize| &hex[i * 64..(i + 1) * 64];
    let answer = u128::from_str_radix(&word(1)[32..], 16).ok()? as f64 / 1e8;
    let updated = u64::from_str_radix(word(3), 16).ok()?;
    Some((answer, updated))
}
