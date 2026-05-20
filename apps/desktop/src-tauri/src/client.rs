use reqwest::Url;
use serde::Serialize;
use types::{
    AdminApplyPricesCmd, AdminAuthCmd, AdminAuthResponse, AdminCatalog, AdminChangePinCmd,
    AdminPriceEntry, AdminSettingsSnapshot, AdminShiftScheduleCmd, AdminUpdateOperatorCmd,
    SavePositionNozzlesCmd, SaveProductsCmd,
    AuthorizeCmd, CloseStoppedTxCmd, ContinueFillCmd, CreateOperatorCmd, EndShiftCmd, FpState,
    HandoverCmd, Operator, PriceChange, ResumeFillCmd, Shift, SiteSnapshot, StartShiftCmd,
    StopCmd, Transaction, UpdateAllPricesCmd, UpdatePriceCmd,
};

#[derive(Clone)]
pub struct ServiceClient {
    base: Url,
    http: reqwest::Client,
}

impl ServiceClient {
    pub fn new(base: Option<String>) -> Self {
        let raw = base
            .or_else(|| std::env::var("AZS_SERVICE_URL").ok())
            .unwrap_or_else(|| "http://127.0.0.1:3001".into());
        let base = Url::parse(raw.trim_end_matches('/')).unwrap_or_else(|_| {
            Url::parse("http://127.0.0.1:3001").expect("default url")
        });
        Self {
            base,
            http: reqwest::Client::new(),
        }
    }

    pub fn ws_url(&self) -> String {
        let mut u = self.base.clone();
        u.set_scheme(if u.scheme() == "https" { "wss" } else { "ws" })
            .ok();
        u.set_path("/ws");
        u.to_string()
    }

    pub async fn health(&self) -> Result<serde_json::Value, String> {
        let url = self.base.join("health").map_err(|e| e.to_string())?;
        self.http
            .get(url)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn get_all_status(&self) -> Result<Vec<FpState>, String> {
        let url = self.base.join("status").map_err(|e| e.to_string())?;
        self.http
            .get(url)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn get_site_config(&self) -> Result<SiteSnapshot, String> {
        let url = self.base.join("config").map_err(|e| e.to_string())?;
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

    pub async fn authorize(&self, cmd: AuthorizeCmd) -> Result<(), String> {
        let url = self.base.join("authorize").map_err(|e| e.to_string())?;
        self.http
            .post(url)
            .json(&cmd)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn preauthorize(&self, cmd: AuthorizeCmd) -> Result<(), String> {
        let path = format!("dispenser/{}/preauthorize", cmd.fp_id);
        let url = self.base.join(&path).map_err(|e| e.to_string())?;
        self.http
            .post(url)
            .json(&cmd)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn cancel_preauth(&self, fp_id: String) -> Result<(), String> {
        let path = format!("dispenser/{fp_id}/cancel-preauth");
        let url = self.base.join(&path).map_err(|e| e.to_string())?;
        self.http
            .post(url)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn continue_fill(&self, fp_id: String, stopped_tx_id: String) -> Result<(), String> {
        let path = format!("dispenser/{fp_id}/continue");
        let url = self.base.join(&path).map_err(|e| e.to_string())?;
        let body = ContinueFillCmd { stopped_tx_id };
        let resp = self
            .http
            .post(url)
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if resp.status().is_success() {
            return Ok(());
        }
        let status = resp.status();
        let detail = resp
            .text()
            .await
            .unwrap_or_else(|_| status.to_string());
        Err(detail)
    }

    pub async fn resume_fill(&self, fp_id: String, stopped_tx_id: String) -> Result<(), String> {
        let path = format!("dispenser/{fp_id}/resume");
        let url = self.base.join(&path).map_err(|e| e.to_string())?;
        let body = ResumeFillCmd { stopped_tx_id };
        let resp = self
            .http
            .post(url)
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if resp.status().is_success() {
            return Ok(());
        }
        let status = resp.status();
        let detail = resp
            .text()
            .await
            .unwrap_or_else(|_| status.to_string());
        Err(detail)
    }

    pub async fn close_stopped_transaction(
        &self,
        fp_id: String,
        stopped_tx_id: String,
    ) -> Result<(), String> {
        let path = format!("dispenser/{fp_id}/close");
        let url = self.base.join(&path).map_err(|e| e.to_string())?;
        let body = CloseStoppedTxCmd { stopped_tx_id };
        self.http
            .post(url)
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn stop_dispenser(&self, fp_id: String) -> Result<(), String> {
        let url = self.base.join("stop").map_err(|e| e.to_string())?;
        let body = StopCmd { fp_id };
        self.http
            .post(url)
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn emergency_stop_all(&self) -> Result<(), String> {
        let url = self.base.join("estop").map_err(|e| e.to_string())?;
        self.http
            .post(url)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn reset_all(&self) -> Result<(), String> {
        let url = self.base.join("reset").map_err(|e| e.to_string())?;
        self.http
            .post(url)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn dismiss_sale(&self, fp_id: String) -> Result<types::FpState, String> {
        let path = format!("dispenser/{fp_id}/dismiss");
        let url = self.base.join(&path).map_err(|e| e.to_string())?;
        self.http
            .post(url)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn update_prices(&self, updates: Vec<UpdatePriceCmd>) -> Result<(), String> {
        let url = self.base.join("prices").map_err(|e| e.to_string())?;
        let body = UpdateAllPricesCmd { updates };
        self.http
            .post(url)
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn get_transactions(
        &self,
        limit: Option<i64>,
        offset: Option<i64>,
        fp_id: Option<String>,
    ) -> Result<Vec<Transaction>, String> {
        let url = self.base.join("transactions").map_err(|e| e.to_string())?;
        let mut req = self.http.get(url);
        if let Some(l) = limit {
            req = req.query(&[("limit", l)]);
        }
        if let Some(o) = offset {
            req = req.query(&[("offset", o)]);
        }
        if let Some(ref id) = fp_id {
            req = req.query(&[("fp_id", id.as_str())]);
        }
        req.send()
            .await
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn get_current_shift(&self) -> Result<Option<Shift>, String> {
        let url = self.base.join("shifts/current").map_err(|e| e.to_string())?;
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

    pub async fn start_shift(&self, cmd: StartShiftCmd) -> Result<Shift, String> {
        let url = self.base.join("shifts/start").map_err(|e| e.to_string())?;
        self.http
            .post(url)
            .json(&cmd)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn end_shift(&self, cmd: EndShiftCmd) -> Result<Shift, String> {
        let url = self.base.join("shifts/end").map_err(|e| e.to_string())?;
        self.http
            .post(url)
            .json(&cmd)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn handover_shift(&self, cmd: HandoverCmd) -> Result<serde_json::Value, String> {
        let url = self.base.join("shifts/handover").map_err(|e| e.to_string())?;
        self.http
            .post(url)
            .json(&cmd)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn list_shifts(
        &self,
        limit: Option<i64>,
        offset: Option<i64>,
        status: Option<String>,
    ) -> Result<Vec<Shift>, String> {
        let url = self.base.join("shifts").map_err(|e| e.to_string())?;
        let mut req = self.http.get(url);
        if let Some(l) = limit {
            req = req.query(&[("limit", l)]);
        }
        if let Some(o) = offset {
            req = req.query(&[("offset", o)]);
        }
        if let Some(ref st) = status {
            req = req.query(&[("status", st.as_str())]);
        }
        req.send()
            .await
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())
    }

    fn auth_headers(token: &str) -> reqwest::header::HeaderMap {
        let mut h = reqwest::header::HeaderMap::new();
        h.insert(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {token}")
                .parse()
                .unwrap_or_else(|_| "Bearer invalid".parse().unwrap()),
        );
        h
    }

    pub async fn admin_login(&self, pin: String) -> Result<AdminAuthResponse, String> {
        let url = self.base.join("admin/auth").map_err(|e| e.to_string())?;
        self.http
            .post(url)
            .json(&AdminAuthCmd { pin })
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn admin_get_prices(&self, token: String) -> Result<Vec<AdminPriceEntry>, String> {
        let url = self.base.join("admin/prices").map_err(|e| e.to_string())?;
        self.http
            .get(url)
            .headers(Self::auth_headers(&token))
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn admin_update_prices(
        &self,
        token: String,
        updates: Vec<UpdatePriceCmd>,
    ) -> Result<serde_json::Value, String> {
        let url = self.base.join("admin/prices").map_err(|e| e.to_string())?;
        self.http
            .post(url)
            .headers(Self::auth_headers(&token))
            .json(&UpdateAllPricesCmd { updates })
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn admin_apply_prices_now(
        &self,
        token: String,
        fp_id: String,
    ) -> Result<(), String> {
        let url = self
            .base
            .join("admin/prices/apply-now")
            .map_err(|e| e.to_string())?;
        self.http
            .post(url)
            .headers(Self::auth_headers(&token))
            .json(&AdminApplyPricesCmd { fp_id })
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn admin_price_history(
        &self,
        token: String,
        limit: Option<i64>,
    ) -> Result<Vec<PriceChange>, String> {
        let url = self
            .base
            .join("admin/prices/history")
            .map_err(|e| e.to_string())?;
        let mut req = self.http.get(url).headers(Self::auth_headers(&token));
        if let Some(l) = limit {
            req = req.query(&[("limit", l)]);
        }
        req.send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn admin_list_operators(&self, token: String) -> Result<Vec<Operator>, String> {
        let url = self.base.join("admin/operators").map_err(|e| e.to_string())?;
        self.http
            .get(url)
            .headers(Self::auth_headers(&token))
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn admin_create_operator(
        &self,
        token: String,
        cmd: CreateOperatorCmd,
    ) -> Result<Operator, String> {
        let url = self.base.join("admin/operators").map_err(|e| e.to_string())?;
        self.http
            .post(url)
            .headers(Self::auth_headers(&token))
            .json(&cmd)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn admin_update_operator(
        &self,
        token: String,
        id: String,
        cmd: AdminUpdateOperatorCmd,
    ) -> Result<Operator, String> {
        let url = self
            .base
            .join(&format!("admin/operators/{id}"))
            .map_err(|e| e.to_string())?;
        self.http
            .post(url)
            .headers(Self::auth_headers(&token))
            .json(&cmd)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn admin_delete_operator(&self, token: String, id: String) -> Result<(), String> {
        let url = self
            .base
            .join(&format!("admin/operators/{id}"))
            .map_err(|e| e.to_string())?;
        self.http
            .delete(url)
            .headers(Self::auth_headers(&token))
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn admin_get_settings(
        &self,
        token: String,
    ) -> Result<AdminSettingsSnapshot, String> {
        let url = self.base.join("admin/settings").map_err(|e| e.to_string())?;
        self.http
            .get(url)
            .headers(Self::auth_headers(&token))
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn admin_save_settings(
        &self,
        token: String,
        body: serde_json::Value,
    ) -> Result<(), String> {
        let url = self.base.join("admin/settings").map_err(|e| e.to_string())?;
        self.http
            .post(url)
            .headers(Self::auth_headers(&token))
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn admin_shift_schedule(
        &self,
        token: String,
        cmd: AdminShiftScheduleCmd,
    ) -> Result<(), String> {
        let url = self
            .base
            .join("admin/shift-schedule")
            .map_err(|e| e.to_string())?;
        self.http
            .post(url)
            .headers(Self::auth_headers(&token))
            .json(&cmd)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn admin_get_catalog(&self, token: String) -> Result<AdminCatalog, String> {
        let url = self.base.join("admin/catalog").map_err(|e| e.to_string())?;
        self.http
            .get(url)
            .headers(Self::auth_headers(&token))
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn admin_save_products(
        &self,
        token: String,
        cmd: SaveProductsCmd,
    ) -> Result<(), String> {
        let url = self.base.join("admin/products").map_err(|e| e.to_string())?;
        self.http
            .post(url)
            .headers(Self::auth_headers(&token))
            .json(&cmd)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn admin_save_position_nozzles(
        &self,
        token: String,
        fp_id: String,
        cmd: SavePositionNozzlesCmd,
    ) -> Result<(), String> {
        let url = self
            .base
            .join(&format!("admin/positions/{fp_id}/nozzles"))
            .map_err(|e| e.to_string())?;
        self.http
            .post(url)
            .headers(Self::auth_headers(&token))
            .json(&cmd)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn admin_change_pin(
        &self,
        token: Option<String>,
        cmd: AdminChangePinCmd,
    ) -> Result<(), String> {
        let url = self.base.join("admin/change-pin").map_err(|e| e.to_string())?;
        let mut req = self.http.post(url).json(&cmd);
        if let Some(t) = token {
            req = req.headers(Self::auth_headers(&t));
        }
        req.send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn get_shift_report(&self, id: String) -> Result<Shift, String> {
        let url = self
            .base
            .join(&format!("shifts/{id}/report"))
            .map_err(|e| e.to_string())?;
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
}

impl Default for ServiceClient {
    fn default() -> Self {
        Self::new(None)
    }
}

/// HTTP control plane for `wayne-sim` (see `POST /sim/nozzle-up` in tools/simulators/wayne-sim).
#[derive(Clone)]
pub struct SimClient {
    base: Url,
    http: reqwest::Client,
}

#[derive(Serialize)]
struct SimNozzleUpBody {
    fp_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    nozzle: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    product: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    product_name: Option<String>,
}

#[derive(Serialize)]
struct SimFpBody {
    fp_id: String,
}

#[derive(Serialize)]
struct SimPreauthExpectationBody {
    fp_id: String,
    nozzle: u8,
    product: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    product_name: Option<String>,
}

#[derive(serde::Deserialize)]
struct SimApiResponse {
    message: Option<String>,
}

impl SimClient {
    pub fn new() -> Self {
        let raw = std::env::var("AZS_SIM_URL").unwrap_or_else(|_| "http://127.0.0.1:3002".into());
        let base = Url::parse(raw.trim_end_matches('/')).unwrap_or_else(|_| {
            Url::parse("http://127.0.0.1:3002").expect("default sim url")
        });
        Self {
            base,
            http: reqwest::Client::new(),
        }
    }

    pub async fn probe(&self) -> bool {
        let Ok(url) = self.base.join("sim/state") else {
            return false;
        };
        match self.http.get(url).send().await {
            Ok(r) => r.status().is_success(),
            Err(_) => false,
        }
    }

    pub async fn nozzle_up(
        &self,
        fp_id: String,
        nozzle: Option<u8>,
        product: Option<u8>,
        product_name: Option<String>,
    ) -> Result<(), String> {
        let url = self.base.join("sim/nozzle-up").map_err(|e| e.to_string())?;
        let body = SimNozzleUpBody {
            fp_id,
            nozzle,
            product,
            product_name,
        };
        let resp = self
            .http
            .post(url)
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if resp.status().is_success() {
            return Ok(());
        }
        let status = resp.status();
        let detail = resp
            .json::<SimApiResponse>()
            .await
            .ok()
            .and_then(|r| r.message)
            .unwrap_or_else(|| status.to_string());
        Err(detail)
    }

    pub async fn set_preauth_expectation(
        &self,
        fp_id: String,
        nozzle: u8,
        product: u8,
        product_name: Option<String>,
    ) -> Result<(), String> {
        let url = self
            .base
            .join("sim/preauth-expectation")
            .map_err(|e| e.to_string())?;
        let body = SimPreauthExpectationBody {
            fp_id,
            nozzle,
            product,
            product_name,
        };
        self.http
            .post(url)
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn prepare_preauth_lane(
        &self,
        fp_id: String,
        nozzle: u8,
        product: u8,
        product_name: Option<String>,
    ) -> Result<(), String> {
        let url = self
            .base
            .join("sim/prepare-preauth")
            .map_err(|e| e.to_string())?;
        let body = SimPreauthExpectationBody {
            fp_id,
            nozzle,
            product,
            product_name,
        };
        self.http
            .post(url)
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn nozzle_down(&self, fp_id: String) -> Result<(), String> {
        let url = self.base.join("sim/nozzle-down").map_err(|e| e.to_string())?;
        let body = SimFpBody { fp_id };
        self.http
            .post(url)
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Matches `POST /sim/reset` on wayne-sim (clears all simulated lanes).
    pub async fn reset_all(&self) -> Result<(), String> {
        let url = self.base.join("sim/reset").map_err(|e| e.to_string())?;
        self.http
            .post(url)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

impl Default for SimClient {
    fn default() -> Self {
        Self::new()
    }
}
