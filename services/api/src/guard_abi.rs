//! Minimal ABI encoding/decoding for the two SlipNope view functions we need.
//!
//! A `PoolKey` is five static words (address, address, uint24, int24, address),
//! so the calldata is fixed-size and hand-encoding it here avoids pulling a
//! whole ABI codec into the service.

/// The guarded pool: NVDAc/USDC, dynamic fee, tickSpacing 10, SlipNope v2 hook.
pub const GUARDED_POOL_HOOK: &str = "0xee7344d34b3ec4f2ad24a668bc0d84e55de640c0";
pub const GUARDED_STOCK: &str = "0xb20000000000000000000078ee7ce2fE4908108C";
pub const GUARDED_QUOTE: &str = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
pub const GUARDED_TICK_SPACING: i32 = 10;
/// v4 dynamic-fee flag (0x800000).
pub const DYNAMIC_FEE: u32 = 8_388_608;

const SEL_PREVIEW_GUARD: &str = "c91322b3";
const SEL_POOL_PRICE: &str = "281e862a";
const SEL_FAIR_PRICE: &str = "1e1b2b52";

fn addr_word(a: &str) -> String {
    format!("{:0>64}", a.trim_start_matches("0x").to_ascii_lowercase())
}

fn u256_word(v: u128) -> String {
    format!("{v:064x}")
}

fn pool_key_words() -> String {
    // currency0 < currency1 by address, so USDC (0x8335…) sorts before NVDAc (0xb200…)
    let mut out = String::new();
    out.push_str(&addr_word(GUARDED_QUOTE));
    out.push_str(&addr_word(GUARDED_STOCK));
    out.push_str(&u256_word(DYNAMIC_FEE as u128));
    out.push_str(&u256_word(GUARDED_TICK_SPACING as i128 as u128)); // sign-extended int24
    out.push_str(&addr_word(GUARDED_POOL_HOOK));
    out
}

/// `fairPriceE18(PoolKey)` calldata.
pub fn fair_price_calldata() -> String {
    format!("0x{SEL_FAIR_PRICE}{}", pool_key_words())
}

/// `poolPriceE18(PoolKey)` calldata.
pub fn pool_price_calldata() -> String {
    format!("0x{SEL_POOL_PRICE}{}", pool_key_words())
}

/// `previewGuard(PoolKey, bool zeroForOne, address trader)` calldata.
pub fn preview_guard_calldata(zero_for_one: bool, trader: &str) -> String {
    format!(
        "0x{SEL_PREVIEW_GUARD}{}{}{}",
        pool_key_words(),
        u256_word(if zero_for_one { 1 } else { 0 }),
        addr_word(trader)
    )
}

fn take_word<'a>(hex: &'a str, i: usize) -> Option<&'a str> {
    hex.get(i * 64..(i + 1) * 64)
}

fn as_u128(word: &str) -> Option<u128> {
    u128::from_str_radix(word, 16).ok()
}

/// Decode `previewGuard` returns:
/// (uint256 adverseBps, uint24 bandBps, uint24 fee, bool blocked, uint256 poolPrice, uint256 fairPrice)
pub struct GuardPreview {
    pub adverse_bps: u128,
    pub band_bps: u128,
    pub fee: u128,
    pub blocked: bool,
    pub pool_price_e18: u128,
    pub fair_price_e18: u128,
}

pub fn decode_preview_guard(hex: &str) -> Option<GuardPreview> {
    let h = hex.trim_start_matches("0x");
    Some(GuardPreview {
        adverse_bps: as_u128(take_word(h, 0)?)?,
        band_bps: as_u128(take_word(h, 1)?)?,
        fee: as_u128(take_word(h, 2)?)?,
        blocked: as_u128(take_word(h, 3)?)? != 0,
        pool_price_e18: as_u128(take_word(h, 4)?)?,
        fair_price_e18: as_u128(take_word(h, 5)?)?,
    })
}

/// Decode a single uint256 return.
pub fn decode_u256(hex: &str) -> Option<u128> {
    as_u128(take_word(hex.trim_start_matches("0x"), 0)?)
}
