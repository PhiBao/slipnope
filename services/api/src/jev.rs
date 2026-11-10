//! TypeSafe (Jev) advisory layer.
//!
//! Hard rule: the guard is deterministic Solidity. This module never decides
//! whether a swap is allowed — it annotates the *context* around a verdict so a
//! human (and the Overpay Ledger autopsy) gets a calibrated read on how
//! trustworthy tonight's market is.
//!
//! Contract: if TypeSafe is slow, erroring, or unconfigured, the API returns the
//! deterministic verdict alone. Advisory failure must never degrade the product.

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

const ENDPOINT: &str = "https://api.typesafe.ai/v1/systemone";
const MODEL: &str = "jev-latest";

#[derive(Serialize, Clone, Debug)]
pub struct Advisory {
    /// 0 = fair and deep, 1 = elevated but executable, 2 = would overpay badly
    pub execution_quality: f64,
    pub confidence: f64,
    /// normal | thin_book | stale_reference | dislocated
    pub regime: String,
    pub regime_confidence: f64,
    pub model: String,
}

#[derive(Clone)]
pub struct Jev {
    http: reqwest::Client,
    key: String,
    cache: Arc<Mutex<HashMap<String, (Instant, Option<Advisory>)>>>,
}

impl Jev {
    pub fn new(key: String) -> Self {
        Self {
            http: reqwest::Client::new(),
            key,
            cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn is_configured(&self) -> bool {
        !self.key.is_empty()
    }

    /// Advisory for one market snapshot. Cached per symbol for 15 minutes.
    pub async fn assess(&self, symbol: &str, state: serde_json::Value) -> Option<Advisory> {
        if !self.is_configured() {
            return None;
        }
        {
            let cache = self.cache.lock().await;
            if let Some((at, value)) = cache.get(symbol) {
                if at.elapsed() < Duration::from_secs(900) {
                    return value.clone();
                }
            }
        }
        let value = self.call(state).await;
        let mut cache = self.cache.lock().await;
        cache.insert(symbol.to_string(), (Instant::now(), value.clone()));
        value
    }

    async fn call(&self, state: serde_json::Value) -> Option<Advisory> {
        let body = json!({
            "model": MODEL,
            "state": state,
            "questions": {
                "execution_quality": {
                    "type": "score",
                    "instructions": "How costly would it be for a buyer to execute at this market quote instead of the reference price, given the book conditions described?",
                    "criteria": [
                        "Quote is at or below the reference price; the book is deep enough that size fills near fair",
                        "Quote is above the reference price by a modest amount, or the quote moved sharply in the last day",
                        "Quote is far above the reference price, or the reference is stale or frozen so no reliable fair price exists"
                    ]
                },
                "regime": {
                    "type": "choice",
                    "instructions": "Which description best fits the current conditions for this tokenized stock on Base?",
                    "criteria": {
                        "normal": "Market and reference agree closely and the reference is fresh",
                        "thin_book": "Large spread between market and reference, or the quote range over 24h is wide, suggesting thin liquidity",
                        "stale_reference": "The Chainlink reference has not updated recently, so the fair price is frozen",
                        "dislocated": "Market trades well above reference, so buying here would overpay materially"
                    }
                }
            }
        });

        let resp = self
            .http
            .post(ENDPOINT)
            .bearer_auth(&self.key)
            .json(&body)
            .timeout(Duration::from_secs(6))
            .send()
            .await
            .ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let parsed: ApiResponse = resp.json().await.ok()?;
        let eq = parsed.answers.get("execution_quality")?;
        let rg = parsed.answers.get("regime")?;
        Some(Advisory {
            execution_quality: eq.score.unwrap_or(0.0),
            confidence: eq.confidence.unwrap_or(0.0),
            regime: rg.choice.clone().unwrap_or_else(|| "unknown".into()),
            regime_confidence: rg.confidence.unwrap_or(0.0),
            model: parsed.model,
        })
    }
}

#[derive(Deserialize)]
struct ApiResponse {
    model: String,
    answers: HashMap<String, Answer>,
}

#[derive(Deserialize)]
struct Answer {
    #[serde(default)]
    score: Option<f64>,
    #[serde(default)]
    choice: Option<String>,
    #[serde(default)]
    confidence: Option<f64>,
}
