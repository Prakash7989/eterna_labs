use crate::config::MatchmakerConfig;

/// Time-based constraint relaxation: widen acceptable MMR spread as wait grows.
#[inline]
pub fn mmr_window(config: &MatchmakerConfig, wait_seconds: f64) -> i32 {
    let relaxed = config.initial_mmr_window as f64 + wait_seconds * config.mmr_relax_per_second;
    relaxed
        .round()
        .clamp(config.initial_mmr_window as f64, config.max_mmr_window as f64) as i32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::MatchmakerConfig;

    #[test]
    fn window_grows_with_wait() {
        let cfg = MatchmakerConfig::default();
        assert!(mmr_window(&cfg, 0.0) <= mmr_window(&cfg, 30.0));
        assert_eq!(mmr_window(&cfg, 10_000.0), cfg.max_mmr_window);
    }
}
