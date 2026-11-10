//! Minimal ABI encoding/decoding for the SlipNope view functions we need.
//!
//! A `PoolKey` is five static words (address, address, uint24, int24, address),
//! so the calldata is fixed-size and hand-encoding it here avoids pulling a
//! whole ABI codec into the service.

/// SlipNope v2 hook, shared by all guarded pools.
pub const GUARDED_POOL_HOOK: &str = "0xee7344d34b3ec4f2ad24a668bc0d84e55de640c0";
pub const GUARDED_QUOTE: &str = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/// v4 dynamic-fee flag (0x800000).
pub const DYNAMIC_FEE: u32 = 8_388_608;

#[derive(Clone, Copy)]
pub struct GuardedPool {
    pub stock: &'static str,
    pub tick_spacing: i32,
}

/// The three pools configured on the v2 hook.
pub const GUARDED_POOLS: &[GuardedPool] = &[
    GuardedPool {
        stock: "0xb20000000000000000000078ee7ce2fE4908108C", // NVDAc
        tick_spacing: 10,
    },
    GuardedPool {
        stock: "0xb200000000000000000000C2e324d24d7eEcd1fb", // AAPLc
        tick_spacing: 40,
    },
    GuardedPool {
        stock: "0xb2000000000000000000001e800a7f5189430cD0", // TSLAc
        tick_spacing: 60,
    },
];

pub fn pool_for_stock(stock: &str) -> Option<&'static GuardedPool> {
    GUARDED_POOLS
        .iter()
        .find(|pool| pool.stock.eq_ignore_ascii_case(stock))
}

const SEL_PREVIEW_GUARD: &str = "c91322b3";
const SEL_POOL_PRICE: &str = "281e862a";
const SEL_FAIR_PRICE: &str = "1e1b2b52";

fn addr_word(a: &str) -> String {
    format!("{:0>64}", a.trim_start_matches("0x").to_ascii_lowercase())
}

fn u256_word(v: u128) -> String {
    format!("{v:064x}")
}

fn pool_key_words(pool: &GuardedPool) -> String {
    // currency0 < currency1 by address, so USDC (0x8335…) sorts before the stock (0xb200…)
    let mut out = String::new();
    out.push_str(&addr_word(GUARDED_QUOTE));
    out.push_str(&addr_word(pool.stock));
    out.push_str(&u256_word(DYNAMIC_FEE as u128));
    out.push_str(&u256_word(pool.tick_spacing as i128 as u128)); // sign-extended int24
    out.push_str(&addr_word(GUARDED_POOL_HOOK));
    out
}

/// `fairPriceE18(PoolKey)` calldata.
pub fn fair_price_calldata(pool: &GuardedPool) -> String {
    format!("0x{SEL_FAIR_PRICE}{}", pool_key_words(pool))
}

/// `poolPriceE18(PoolKey)` calldata.
pub fn pool_price_calldata(pool: &GuardedPool) -> String {
    format!("0x{SEL_POOL_PRICE}{}", pool_key_words(pool))
}

/// `previewGuard(PoolKey, bool zeroForOne, address trader)` calldata.
pub fn preview_guard_calldata(pool: &GuardedPool, zero_for_one: bool, trader: &str) -> String {
    format!(
        "0x{SEL_PREVIEW_GUARD}{}{}{}",
        pool_key_words(pool),
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
