use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize)]
pub struct SimConfig {
    pub virtual_port: String,
    pub baud_rate: u32,
    pub parity: String,
    pub api_port: u16,
    pub log_frames: bool,
    #[serde(default)]
    pub site_config_path: Option<String>,
    #[serde(default = "default_fill")]
    pub default_fill_rate_lps: f64,
}

fn default_fill() -> f64 {
    1.2
}

impl SimConfig {
    pub fn load(path: &str) -> anyhow::Result<Self> {
        let text = std::fs::read_to_string(path)?;
        Ok(serde_json::from_str(&text)?)
    }

    pub fn resolve_site_config_path(&self, sim_config_path: &str) -> Option<PathBuf> {
        let rel = self.site_config_path.as_ref()?;
        let dir = Path::new(sim_config_path)
            .parent()
            .unwrap_or_else(|| Path::new("."));
        Some(dir.join(rel))
    }
}
