use anyhow::{Context, Result};
use site_config::SiteConfig;
use std::path::{Path, PathBuf};

pub fn load(path: Option<PathBuf>) -> Result<(SiteConfig, PathBuf)> {
    let p = path.unwrap_or_else(|| PathBuf::from("site.config.json"));
    let s = p.to_str().context("config path is not valid UTF-8")?;
    let cfg = SiteConfig::load(s).with_context(|| format!("loading {}", p.display()))?;
    Ok((cfg, p))
}

pub fn save(cfg: &SiteConfig, path: &Path) -> Result<()> {
    let s = path.to_str().context("config path is not valid UTF-8")?;
    cfg.save(s).with_context(|| format!("saving {}", path.display()))
}
