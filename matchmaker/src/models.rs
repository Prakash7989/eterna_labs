use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub type PlayerId = Uuid;
pub type MatchId = Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlayerState {
    Waiting,
    Matched,
    Left,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JoinQueueRequest {
    pub player_id: Option<PlayerId>,
    pub mmr: i32,
    pub region: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueStatus {
    pub player_id: PlayerId,
    pub state: PlayerState,
    pub mmr: i32,
    pub region: String,
    pub wait_seconds: f64,
    pub current_mmr_window: i32,
    pub match_id: Option<MatchId>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatchResult {
    pub match_id: MatchId,
    pub region: String,
    pub team_a: Vec<PlayerId>,
    pub team_b: Vec<PlayerId>,
    pub team_a_mmr: f64,
    pub team_b_mmr: f64,
    pub mmr_spread: i32,
    pub formed_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct WaitingPlayer {
    pub id: PlayerId,
    pub mmr: i32,
    pub region: String,
    pub joined_at: DateTime<Utc>,
    /// Monotonic generation; bumped on re-queue to invalidate stale claims.
    pub generation: u64,
}

impl WaitingPlayer {
    pub fn wait_seconds(&self) -> f64 {
        let elapsed = Utc::now().signed_duration_since(self.joined_at);
        elapsed.num_milliseconds().max(0) as f64 / 1000.0
    }
}
