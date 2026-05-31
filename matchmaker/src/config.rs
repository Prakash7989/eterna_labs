use std::time::Duration;

/// Tunables for latency vs. match quality.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct MatchmakerConfig {
    pub team_size: i32,
    pub worker_count: i32,
    pub scan_interval_ms: i32,
    /// Initial max |MMR difference| from anchor when searching for candidates.
    pub initial_mmr_window: i32,
    /// MMR window added per second in queue (time-based relaxation).
    pub mmr_relax_per_second: f64,
    pub max_mmr_window: i32,
    /// Skill buckets width for indexing (reduces scan set).
    pub mmr_bucket_size: i32,
    /// Max candidates considered per anchor before giving up this tick.
    pub max_candidates_per_anchor: i32,
}

impl Default for MatchmakerConfig {
    fn default() -> Self {
        Self {
            team_size: 5,
            worker_count: num_cpus() as i32,
            scan_interval_ms: 5,
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
        (self.team_size * 2) as usize
    }

    pub fn scan_interval(&self) -> Duration {
        Duration::from_millis(self.scan_interval_ms as u64)
    }

    pub async fn fetch_from_db(pool: &sqlx::MySqlPool) -> Result<Self, sqlx::Error> {
        let row = sqlx::query_as::<_, Self>(
            "SELECT team_size, worker_count, scan_interval_ms, initial_mmr_window, mmr_relax_per_second, max_mmr_window, mmr_bucket_size, max_candidates_per_anchor FROM engine_config WHERE id = 1"
        )
        .fetch_one(pool)
        .await?;
        Ok(row)
    }
}
