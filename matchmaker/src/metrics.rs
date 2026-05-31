use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;

/// Lock-free counters — hot path only does relaxed atomics.
#[derive(Debug)]
pub struct MatchmakerMetrics {
    pub players_joined: AtomicU64,
    pub players_left: AtomicU64,
    pub matches_formed: AtomicU64,
    pub match_attempts: AtomicU64,
    pub failed_claims: AtomicU64,
    pub scan_ticks: AtomicU64,
    /// Rolling sum of match formation latency in microseconds (divide by matches for avg).
    pub match_latency_us_sum: AtomicU64,
    pub started_at: Instant,
}

#[derive(Debug, Clone, Serialize)]
pub struct MetricsSnapshot {
    pub players_in_queue: usize,
    pub players_joined: u64,
    pub players_left: u64,
    pub matches_formed: u64,
    pub match_attempts: u64,
    pub failed_claims: u64,
    pub scan_ticks: u64,
    pub avg_match_latency_ms: f64,
    pub uptime_seconds: f64,
    pub matches_per_second: f64,
}

impl MatchmakerMetrics {
    pub fn new() -> Self {
        Self {
            players_joined: AtomicU64::new(0),
            players_left: AtomicU64::new(0),
            matches_formed: AtomicU64::new(0),
            match_attempts: AtomicU64::new(0),
            failed_claims: AtomicU64::new(0),
            scan_ticks: AtomicU64::new(0),
            match_latency_us_sum: AtomicU64::new(0),
            started_at: Instant::now(),
        }
    }

    #[inline]
    pub fn inc_join(&self) {
        self.players_joined.fetch_add(1, Ordering::Relaxed);
    }

    #[inline]
    pub fn inc_leave(&self) {
        self.players_left.fetch_add(1, Ordering::Relaxed);
    }

    #[inline]
    pub fn inc_match(&self, latency: Duration) {
        self.matches_formed.fetch_add(1, Ordering::Relaxed);
        self.match_latency_us_sum.fetch_add(
            latency.as_micros().min(u64::MAX as u128) as u64,
            Ordering::Relaxed,
        );
    }

    #[inline]
    pub fn inc_attempt(&self) {
        self.match_attempts.fetch_add(1, Ordering::Relaxed);
    }

    #[inline]
    pub fn inc_failed_claim(&self) {
        self.failed_claims.fetch_add(1, Ordering::Relaxed);
    }

    #[inline]
    pub fn inc_scan(&self) {
        self.scan_ticks.fetch_add(1, Ordering::Relaxed);
    }

    pub fn snapshot(&self, queue_size: usize) -> MetricsSnapshot {
        let matches = self.matches_formed.load(Ordering::Relaxed);
        let latency_sum = self.match_latency_us_sum.load(Ordering::Relaxed);
        let uptime = self.started_at.elapsed().as_secs_f64();
        let avg_match_latency_ms = if matches > 0 {
            (latency_sum as f64 / matches as f64) / 1000.0
        } else {
            0.0
        };

        MetricsSnapshot {
            players_in_queue: queue_size,
            players_joined: self.players_joined.load(Ordering::Relaxed),
            players_left: self.players_left.load(Ordering::Relaxed),
            matches_formed: matches,
            match_attempts: self.match_attempts.load(Ordering::Relaxed),
            failed_claims: self.failed_claims.load(Ordering::Relaxed),
            scan_ticks: self.scan_ticks.load(Ordering::Relaxed),
            avg_match_latency_ms,
            uptime_seconds: uptime,
            matches_per_second: if uptime > 0.0 {
                matches as f64 / uptime
            } else {
                0.0
            },
        }
    }
}
