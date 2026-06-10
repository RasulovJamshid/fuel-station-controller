//! HTTP POST with Bearer token auth and exponential-backoff retries.
//!
//! Auth priority: api_token > cached login token > attempt without auth.
//! On HTTP 401, invalidates the cached token and re-logins once.

use std::time::Duration;
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::Mutex;
use tracing::{error, info, warn};

use site_config::AtgAuth;

const MAX_ATTEMPTS: u32 = 4;
const BACKOFF_BASE: f64 = 2.0;

struct TokenCache {
    token: Option<String>,
    valid_until: f64, // unix seconds
}

pub struct Poster {
    api_url: String,
    auth: Option<AtgAuth>,
    client: reqwest::Client,
    cache: Arc<Mutex<TokenCache>>,
}

impl Poster {
    pub fn new(api_url: String, auth: Option<AtgAuth>) -> Self {
        Self {
            api_url,
            auth,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .expect("build reqwest client"),
            cache: Arc::new(Mutex::new(TokenCache {
                token: None,
                valid_until: 0.0,
            })),
        }
    }

    /// Returns a Bearer token string, or None if no auth is configured.
    async fn bearer(&self) -> Option<String> {
        let auth = self.auth.as_ref()?;

        // Static API token wins immediately.
        if !auth.api_token.is_empty() {
            return Some(auth.api_token.clone());
        }

        // No login credentials = no auth.
        if auth.username.is_empty() || auth.password.is_empty() {
            return None;
        }

        // Return cached token if still valid.
        {
            let c = self.cache.lock().await;
            if c.token.is_some() && unix_now() < c.valid_until {
                return c.token.clone();
            }
        }

        self.login(auth).await
    }

    async fn invalidate(&self) {
        let mut c = self.cache.lock().await;
        c.token = None;
        c.valid_until = 0.0;
    }

    async fn login(&self, auth: &AtgAuth) -> Option<String> {
        let login_url = if !auth.login_url.is_empty() {
            auth.login_url.clone()
        } else {
            derive_login_url(&self.api_url)?
        };

        let resp = match self
            .client
            .post(&login_url)
            .json(&serde_json::json!({
                "username": auth.username,
                "password": auth.password,
            }))
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                error!(?e, "ATG auth login request failed");
                return None;
            }
        };

        if !resp.status().is_success() {
            error!(status = %resp.status(), "ATG auth login failed");
            return None;
        }

        let data: Value = match resp.json().await {
            Ok(v) => v,
            Err(e) => {
                error!(?e, "ATG auth login response not JSON");
                return None;
            }
        };

        let token = data
            .get("accessToken")
            .or_else(|| data.get("access_token"))
            .or_else(|| data.get("token"))
            .and_then(|v| v.as_str())
            .map(str::to_string)?;

        // Cache until JWT exp - 120 s margin, or for 1 hour if no JWT.
        let valid_until = jwt_exp(&token)
            .map(|exp| exp - 120.0)
            .unwrap_or_else(|| unix_now() + 3480.0); // 3600 - 120

        {
            let mut c = self.cache.lock().await;
            c.token = Some(token.clone());
            c.valid_until = valid_until;
        }

        info!("ATG auth login ok");
        Some(token)
    }

    pub async fn post(&self, payload: Value) {
        if self.api_url.is_empty() {
            return;
        }

        let mut auth_retried = false;

        let mut attempt = 0u32;
        while attempt < MAX_ATTEMPTS {
            attempt += 1;

            let tok = self.bearer().await;
            let req = {
                let mut b = self.client.post(&self.api_url).json(&payload);
                if let Some(ref t) = tok {
                    b = b.header("Authorization", format!("Bearer {}", t));
                }
                b
            };

            match req.send().await {
                Ok(resp) => {
                    let status = resp.status();
                    if status.is_success() {
                        info!(status = %status, "ATG POST ok");
                        return;
                    }
                    if status == reqwest::StatusCode::UNAUTHORIZED && tok.is_some() && !auth_retried {
                        auth_retried = true;
                        self.invalidate().await;
                        attempt -= 1; // don't count the 401 as a normal attempt
                        continue;
                    }
                    if status.is_server_error() && attempt < MAX_ATTEMPTS {
                        warn!(status = %status, attempt, "ATG POST server error, retrying");
                        tokio::time::sleep(backoff(attempt)).await;
                        continue;
                    }
                    error!(status = %status, "ATG POST failed permanently");
                    return;
                }
                Err(e) => {
                    warn!(?e, attempt, "ATG POST request error");
                    if attempt < MAX_ATTEMPTS {
                        tokio::time::sleep(backoff(attempt)).await;
                    }
                }
            }
        }
        error!("ATG POST gave up after {} attempts", MAX_ATTEMPTS);
    }
}

fn backoff(attempt: u32) -> Duration {
    Duration::from_secs_f64(BACKOFF_BASE * attempt as f64)
}

fn unix_now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}

/// Derive a login URL from the API URL, e.g. https://host/api/integration/… → https://host/api/auth/login.
fn derive_login_url(api_url: &str) -> Option<String> {
    let trimmed = api_url.trim();
    let scheme_end = trimmed.find("://")?;
    let rest = &trimmed[scheme_end + 3..];
    let host_end = rest.find('/').unwrap_or(rest.len());
    Some(format!(
        "{}://{}/api/auth/login",
        &trimmed[..scheme_end],
        &rest[..host_end]
    ))
}

/// Read `exp` from a JWT payload without verifying the signature.
/// Returns unix timestamp as f64, or None if not parseable.
fn jwt_exp(token: &str) -> Option<f64> {
    let parts: Vec<&str> = token.splitn(3, '.').collect();
    if parts.len() != 3 {
        return None;
    }
    let decoded = decode_base64url(parts[1])?;
    let data: Value = serde_json::from_slice(&decoded).ok()?;
    data.get("exp")?.as_f64()
}

fn decode_base64url(s: &str) -> Option<Vec<u8>> {
    // Map base64url → standard base64
    let std_b64: String = s
        .chars()
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            c => c,
        })
        .collect();

    let padded = match std_b64.len() % 4 {
        2 => format!("{}==", std_b64),
        3 => format!("{}=", std_b64),
        0 => std_b64,
        _ => return None,
    };

    let mut out = Vec::with_capacity(padded.len() * 3 / 4);
    let bytes = padded.as_bytes();
    for chunk in bytes.chunks(4) {
        if chunk.len() < 4 {
            return None;
        }
        let v: Vec<u8> = chunk
            .iter()
            .map(|&b| match b {
                b'A'..=b'Z' => b - b'A',
                b'a'..=b'z' => b - b'a' + 26,
                b'0'..=b'9' => b - b'0' + 52,
                b'+' => 62,
                b'/' => 63,
                b'=' => 64,
                _ => 255,
            })
            .collect();
        if v.iter().any(|&x| x == 255) {
            return None;
        }
        out.push((v[0] << 2) | (v[1] >> 4));
        if v[2] != 64 {
            out.push((v[1] << 4) | (v[2] >> 2));
        }
        if v[3] != 64 {
            out.push((v[2] << 6) | v[3]);
        }
    }
    Some(out)
}
