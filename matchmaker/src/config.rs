use std::time::Duration;

/// Tunables for latency vs. match quality.
#[derive(Debug, Clone)]
pub struct MatchmakerConfig {
    pub team_size: usize,
    pub worker_count: usize,
    pub scan_interval: Duration,
    /// Initial max |MMR difference| from anchor when searching for candidates.
    pub initial_mmr_window: i32,
    /// MMR window added per second in queue (time-based relaxation).
    pub mmr_relax_per_second: f64,
    pub max_mmr_window: i32,
    /// Skill buckets width for indexing (reduces scan set).
    pub mmr_bucket_size: i32,
    /// Max candidates considered per anchor before giving up this tick.
    pub max_candidates_per_anchor: usize,
}

impl Default for MatchmakerConfig {
    fn default() -> Self {
        Self {
            team_size: 5,
            worker_count: num_cpus(),
            scan_interval: Duration::from_millis(5),
            initial_mmr_window: 75,
            mmr_relax_per_second: 12.0,
            max_mmr_window: 600,
            mmr_bucket_size: 100,
            max_candidates_per_anchor: 64,
        }
    }
}

fn num_cpus() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(2, 32)
}

impl MatchmakerConfig {
    pub fn players_per_match(&self) -> usize {
        self.team_size * 2
    }
}
