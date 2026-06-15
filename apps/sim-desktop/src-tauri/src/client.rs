use reqwest::Url;
use serde::{Deserialize, Serialize};

#[derive(Clone)]
pub struct SimClient {
    base: Url,
    http: reqwest::Client,
}

#[derive(Clone)]
pub struct ServiceClient {
    base: Url,
    http: reqwest::Client,
}

#[derive(Serialize)]
struct FpBody {
    fp_id: String,
}

#[derive(Serialize)]
struct NozzleUpBody {
    fp_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    nozzle: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    product: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    product_name: Option<String>,
}

#[derive(Serialize)]
struct OfflineBody {
    fp_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    flush: Option<bool>,
}

#[derive(Serialize)]
struct ScenarioBody {
    name: String,
}

#[derive(Serialize)]
struct PreauthBody {
    fp_id: String,
    nozzle: u8,
    product: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    product_name: Option<String>,
}

#[derive(Serialize)]
struct SetFillRateBody {
    fp_id: String,
    fill_rate_lps: f64,
}

#[derive(Deserialize)]
struct ApiResponse {
    #[serde(default)]
    ok: bool,
    message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SimDispenserInfo {
    pub fp_id: String,
    pub addr: u8,
    pub label: String,
    pub status: String,
    pub volume: f64,
    pub amount: u64,
    pub respond: bool,
    pub fill_rate_lps: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NozzleSnapshot {
    pub index: u8,
    pub product_id: u8,
    pub product_name: String,
    pub product_color: String,
    pub price: u32,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FpSnapshot {
    pub fp_id: String,
    pub label: String,
    pub active: bool,
    pub nozzles: Vec<NozzleSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SiteLayout {
    pub site_name: String,
    pub positions: Vec<FpSnapshot>,
}

impl SimClient {
    pub fn new() -> Self {
        let raw = std::env::var("AZS_SIM_URL").unwrap_or_else(|_| "http://127.0.0.1:3002".into());
        let base = Url::parse(raw.trim_end_matches('/'))
            .unwrap_or_else(|_| Url::parse("http://127.0.0.1:3002").expect("default sim url"));
        Self {
            base,
            http: reqwest::Client::new(),
        }
    }

    pub async fn probe(&self) -> bool {
        let Ok(url) = self.base.join("sim/state") else {
            return false;
        };
        matches!(self.http.get(url).send().await, Ok(r) if r.status().is_success())
    }

    pub async fn get_state(&self) -> Result<Vec<SimDispenserInfo>, String> {
        let url = self.base.join("sim/state").map_err(|e| e.to_string())?;
        self.http
            .get(url)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())
    }

    async fn post_empty(&self, path: &str) -> Result<(), String> {
        let url = self.base.join(path).map_err(|e| e.to_string())?;
        self.http
            .post(url)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    async fn post_json<T: Serialize>(&self, path: &str, body: &T) -> Result<(), String> {
        let url = self.base.join(path).map_err(|e| e.to_string())?;
        let resp = self
            .http
            .post(url)
            .json(body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if resp.status().is_success() {
            return Ok(());
        }
        let status = resp.status();
        let detail = resp
            .json::<ApiResponse>()
            .await
            .ok()
            .and_then(|r| r.message)
            .unwrap_or_else(|| status.to_string());
        Err(detail)
    }

    pub async fn nozzle_up(
        &self,
        fp_id: String,
        nozzle: Option<u8>,
        product: Option<u8>,
        product_name: Option<String>,
    ) -> Result<(), String> {
        self.post_json(
            "sim/nozzle-up",
            &NozzleUpBody {
                fp_id,
                nozzle,
                product,
                product_name,
            },
        )
        .await
    }

    pub async fn nozzle_down(&self, fp_id: String) -> Result<(), String> {
        self.post_json("sim/nozzle-down", &FpBody { fp_id }).await
    }

    pub async fn go_offline(&self, fp_id: String) -> Result<(), String> {
        self.post_json("sim/go-offline", &OfflineBody { fp_id, flush: None })
            .await
    }

    pub async fn go_online(&self, fp_id: String, flush: bool) -> Result<(), String> {
        self.post_json(
            "sim/go-online",
            &OfflineBody {
                fp_id,
                flush: Some(flush),
            },
        )
        .await
    }

    pub async fn prepare_preauth(
        &self,
        fp_id: String,
        nozzle: u8,
        product: u8,
        product_name: Option<String>,
    ) -> Result<(), String> {
        self.post_json(
            "sim/prepare-preauth",
            &PreauthBody {
                fp_id,
                nozzle,
                product,
                product_name,
            },
        )
        .await
    }

    pub async fn set_fill_rate(&self, fp_id: String, fill_rate_lps: f64) -> Result<(), String> {
        self.post_json(
            "sim/set-fill-rate",
            &SetFillRateBody {
                fp_id,
                fill_rate_lps,
            },
        )
        .await
    }

    pub async fn estop_all(&self) -> Result<(), String> {
        self.post_empty("sim/estop").await
    }

    pub async fn reset_all(&self) -> Result<(), String> {
        self.post_empty("sim/reset").await
    }

    pub async fn run_scenario(&self, name: String) -> Result<String, String> {
        let url = self.base.join("sim/scenario").map_err(|e| e.to_string())?;
        let resp = self
            .http
            .post(url)
            .json(&ScenarioBody { name })
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if resp.status().is_success() {
            let body = resp.json::<ApiResponse>().await.ok();
            return Ok(body
                .and_then(|b| b.message)
                .unwrap_or_else(|| "Scenario started".into()));
        }
        Err(resp.status().to_string())
    }
}

impl Default for SimClient {
    fn default() -> Self {
        Self::new()
    }
}

impl ServiceClient {
    pub fn new() -> Self {
        let raw =
            std::env::var("AZS_SERVICE_URL").unwrap_or_else(|_| "http://127.0.0.1:3001".into());
        let base = Url::parse(raw.trim_end_matches('/'))
            .unwrap_or_else(|_| Url::parse("http://127.0.0.1:3001").expect("default service url"));
        Self {
            base,
            http: reqwest::Client::new(),
        }
    }

    pub async fn get_site_layout(&self) -> Result<SiteLayout, String> {
        #[derive(Deserialize)]
        struct RawNozzle {
            index: u8,
            product_id: u8,
            product_name: String,
            product_color: String,
            price: u32,
            active: bool,
        }
        #[derive(Deserialize)]
        struct RawFp {
            fp_id: String,
            label: String,
            active: bool,
            nozzles: Vec<RawNozzle>,
        }
        #[derive(Deserialize)]
        struct RawSite {
            site_name: String,
            positions: Vec<RawFp>,
        }

        let url = self.base.join("config").map_err(|e| e.to_string())?;
        let raw: RawSite = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;

        Ok(SiteLayout {
            site_name: raw.site_name,
            positions: raw
                .positions
                .into_iter()
                .map(|p| FpSnapshot {
                    fp_id: p.fp_id,
                    label: p.label,
                    active: p.active,
                    nozzles: p
                        .nozzles
                        .into_iter()
                        .map(|n| NozzleSnapshot {
                            index: n.index,
                            product_id: n.product_id,
                            product_name: n.product_name,
                            product_color: n.product_color,
                            price: n.price,
                            active: n.active,
                        })
                        .collect(),
                })
                .collect(),
        })
    }
}

impl Default for ServiceClient {
    fn default() -> Self {
        Self::new()
    }
}
