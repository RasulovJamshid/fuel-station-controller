//! HTTP POST with Bearer token auth and exponential-backoff retries.
//!
//! Auth priority: api_token > cached login token > attempt without auth.
//! On HTTP 401, invalidates the cached token and re-logins once.

use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::Mutex;
use tracing::{error, info};

use site_config::AtgAuth;

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
        let api_url = std::env::var("API_URL")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or(api_url);
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
        if let Some(token) = std::env::var("API_TOKEN")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
        {
            return Some(token);
        }

        let empty = AtgAuth {
            api_token: String::new(),
            username: String::new(),
            password: String::new(),
            login_url: String::new(),
        };
        let auth = self.auth.as_ref().unwrap_or(&empty);

        // Static API token wins immediately.
        if !auth.api_token.is_empty() {
            return Some(auth.api_token.clone());
        }

        let username = std::env::var("AUTH_USERNAME")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| auth.username.clone());
        let password = std::env::var("AUTH_PASSWORD")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| auth.password.clone());
        let login_url = std::env::var("AUTH_LOGIN_URL")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| auth.login_url.clone());

        // No login credentials = no auth.
        if username.is_empty() || password.is_empty() {
            return None;
        }

        // Return cached token if still valid.
        {
            let c = self.cache.lock().await;
            if c.token.is_some() && unix_now() < c.valid_until {
                return c.token.clone();
            }
        }

        let effective_auth = AtgAuth {
            api_token: String::new(),
            username,
            password,
            login_url,
        };
        self.login(&effective_auth).await
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
                error!(error = %e.without_url(), "ATG auth login request failed");
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

        let data = data.get("data").unwrap_or(&data);
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

    /// One delivery attempt. The durable outbox owns retries and ordering.
    pub async fn post(&self, payload: Value) -> Result<(), String> {
        if self.api_url.is_empty() {
            return Err("ATG export URL is empty".into());
        }
        let expects_auth = self
            .auth
            .as_ref()
            .is_some_and(|a| !a.api_token.is_empty() || !a.username.is_empty())
            || ["API_TOKEN", "AUTH_USERNAME"]
                .iter()
                .any(|key| std::env::var(key).is_ok_and(|v| !v.is_empty()));
        for attempt in 0..2 {
            let token = self.bearer().await;
            if expects_auth && token.is_none() {
                return Err("ATG authentication failed".into());
            }
            let mut request = self.client.post(&self.api_url).json(&payload);
            if let Some(token) = token {
                let token = token
                    .strip_prefix("Bearer ")
                    .or_else(|| token.strip_prefix("bearer "))
                    .unwrap_or(&token);
                request = request.bearer_auth(token);
            }
            let response = request
                .send()
                .await
                .map_err(|e| format!("ATG HTTP request failed: {}", e.without_url()))?;
            if response.status().is_success() {
                return Ok(());
            }
            if response.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
                self.invalidate().await;
                continue;
            }
            return Err(format!("ATG HTTP status {}", response.status()));
        }
        Err("ATG authentication rejected".into())
    }
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
