use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Instant;

use chrono::Utc;
use crossbeam_channel::{bounded, Receiver, Sender};
use uuid::Uuid;

use crate::balance::{optimal_team_split, SkillPlayer};
use crate::config::MatchmakerConfig;
use crate::metrics::MatchmakerMetrics;
use crate::models::{MatchResult, PlayerId};
use crate::pool::{MatchStore, PlayerPool};
use crate::relaxation::mmr_window;

/// Central matchmaking service: pool + worker threads + match notifications.
#[derive(Debug)]
pub struct MatchmakerEngine {
    pub config: std::sync::Arc<parking_lot::RwLock<MatchmakerConfig>>,
    pub pool: Arc<PlayerPool>,
    pub metrics: Arc<MatchmakerMetrics>,
    pub matches: Arc<MatchStore>,
    match_tx: Sender<MatchResult>,
    match_rx: Receiver<MatchResult>,
    workers: Vec<JoinHandle<()>>,
}

impl MatchmakerEngine {
    pub fn new(config: std::sync::Arc<parking_lot::RwLock<MatchmakerConfig>>) -> Self {
        let pool = Arc::new(PlayerPool::new(config.clone()));
        let metrics = Arc::new(MatchmakerMetrics::new());
        let matches = Arc::new(MatchStore::new());
        let (match_tx, match_rx) = bounded(10_000);

        Self {
            config,
            pool,
            metrics,
            matches,
            match_tx,
            match_rx,
            workers: Vec::new(),
        }
    }

    pub fn start(&mut self) {
        let worker_count = self.config.read().worker_count as usize;
        for worker_id in 0..worker_count {
            let pool = Arc::clone(&self.pool);
            let metrics = Arc::clone(&self.metrics);
            let tx = self.match_tx.clone();
            let config = self.config.clone();
            let handle = thread::Builder::new()
                .name(format!("matcher-{worker_id}"))
                .spawn(move || worker_loop(worker_id, worker_count, pool, metrics, tx, config))
                .expect("spawn matcher worker");
            self.workers.push(handle);
        }
    }

    pub fn join_queue(
        &self,
        player_id: PlayerId,
        mmr: i32,
        region: String,
    ) -> crate::models::WaitingPlayer {
        self.metrics.inc_join();
        self.pool.join(player_id, mmr, region)
    }

    pub fn leave_queue(&self, player_id: PlayerId) -> bool {
        if self.pool.leave(player_id) {
            self.metrics.inc_leave();
            true
        } else {
            false
        }
    }

    /// Non-blocking drain of newly formed matches (for websockets / sim).
    pub fn poll_matches(&self) -> Vec<MatchResult> {
        let mut out = Vec::new();
        while let Ok(m) = self.match_rx.try_recv() {
            out.push(m);
        }
        out
    }

    pub fn try_recv_match(&self) -> Option<MatchResult> {
        self.match_rx.try_recv().ok()
    }
}

fn worker_loop(
    worker_id: usize,
    worker_count: usize,
    pool: Arc<PlayerPool>,
    metrics: Arc<MatchmakerMetrics>,
    match_tx: Sender<MatchResult>,
    config: std::sync::Arc<parking_lot::RwLock<MatchmakerConfig>>,
) {
    loop {
        metrics.inc_scan();
        
        // Read config snapshot for this tick
        let cfg = config.read().clone();
        let needed = cfg.players_per_match();
        let anchors = pool.anchors_for_shard(worker_id, worker_count);

        for (region, anchor_id) in anchors {
            try_form_match(
                &pool,
                &metrics,
                &match_tx,
                &cfg,
                &region,
                anchor_id,
                needed,
            );
        }

        thread::sleep(cfg.scan_interval());
    }
}

fn try_form_match(
    pool: &PlayerPool,
    metrics: &MatchmakerMetrics,
    match_tx: &Sender<MatchResult>,
    config: &MatchmakerConfig,
    region: &str,
    anchor_id: PlayerId,
    needed: usize,
) {
    let Some((anchor_player, anchor_state, _)) = pool.get_status(anchor_id) else {
        return;
    };
    if anchor_state != crate::models::PlayerState::Waiting {
        return;
    }

    let anchor = anchor_player;
    let window = mmr_window(config, anchor.wait_seconds());
    metrics.inc_attempt();

    let mut candidates = pool.candidates_near(
        region,
        anchor.mmr,
        window,
        config.max_candidates_per_anchor as usize,
        anchor.id,
    );

    if candidates.len() + 1 < needed {
        return;
    }

    // Anchor is always in the match
    let mut group: Vec<(SkillPlayer, u64)> = vec![(
        SkillPlayer {
            id: anchor.id,
            mmr: anchor.mmr,
        },
        anchor.generation,
    )];

    // Greedy fill: closest MMR first for quality, then balance split validates fairness
    candidates.sort_by_key(|(p, _)| (p.mmr - anchor.mmr).abs());
    for (p, gen) in candidates {
        if group.len() >= needed {
            break;
        }
        group.push((SkillPlayer { id: p.id, mmr: p.mmr }, gen));
    }

    if group.len() < needed {
        return;
    }

    // Try best subset of size `needed` from gathered candidates (anchor + nearby)
    let players: Vec<SkillPlayer> = group.iter().map(|(s, _)| *s).collect();
    let best_match = find_best_roster(&players, needed, config.team_size as usize);
    let Some((roster, team_a, team_b)) = best_match else {
        return;
    };

    let ids: Vec<PlayerId> = roster.iter().map(|p| p.id).collect();
    let gens: Vec<u64> = ids
        .iter()
        .filter_map(|id| {
            pool.get_status(*id)
                .map(|(p, state, _)| {
                    if state == crate::models::PlayerState::Waiting {
                        p.generation
                    } else {
                        0
                    }
                })
        })
        .collect();

    if gens.len() != ids.len() || gens.iter().any(|&g| g == 0) {
        return;
    }

    let match_id = Uuid::new_v4();
    let claim_start = Instant::now();

    if !pool.try_claim(&ids, &gens, match_id) {
        metrics.inc_failed_claim();
        return;
    }

    let team_a_mmr = average_mmr(&roster, &team_a);
    let team_b_mmr = average_mmr(&roster, &team_b);
    let mmr_spread = roster
        .iter()
        .map(|p| p.mmr)
        .max()
        .unwrap_or(0)
        - roster.iter().map(|p| p.mmr).min().unwrap_or(0);

    let result = MatchResult {
        match_id,
        region: region.to_string(),
        team_a,
        team_b,
        team_a_mmr,
        team_b_mmr,
        mmr_spread,
        formed_at: Utc::now(),
    };

    metrics.inc_match(claim_start.elapsed());
    let _ = match_tx.send(result.clone());
}

/// From a candidate set, pick `needed` players via sliding MMR window, then optimal 5v5 split.
fn find_best_roster(
    players: &[SkillPlayer],
    needed: usize,
    team_size: usize,
) -> Option<(Vec<SkillPlayer>, Vec<PlayerId>, Vec<PlayerId>)> {
    if players.len() < needed {
        return None;
    }

    if players.len() == needed {
        let (a, b) = optimal_team_split(players, team_size)?;
        return Some((players.to_vec(), a, b));
    }

    let mut sorted = players.to_vec();
    sorted.sort_by_key(|p| p.mmr);

    let mut best: Option<(Vec<SkillPlayer>, Vec<PlayerId>, Vec<PlayerId>, i32)> = None;

    for start in 0..=sorted.len() - needed {
        let roster: Vec<SkillPlayer> = sorted[start..start + needed].to_vec();
        let spread = roster.last().unwrap().mmr - roster.first().unwrap().mmr;
        let Some((team_a, team_b)) = optimal_team_split(&roster, team_size) else {
            continue;
        };
        let skill_gap = team_skill_gap(&roster, &team_a, &team_b);
        let score = spread * 1000 + skill_gap;
        if best.as_ref().map_or(true, |(_, _, _, s)| score < *s) {
            best = Some((roster, team_a, team_b, score));
        }
    }

    best.map(|(r, a, b, _)| (r, a, b))
}

fn team_skill_gap(roster: &[SkillPlayer], team_a: &[PlayerId], team_b: &[PlayerId]) -> i32 {
    let avg = |ids: &[PlayerId]| {
        let sum: i32 = ids
            .iter()
            .map(|id| roster.iter().find(|p| p.id == *id).unwrap().mmr)
            .sum();
        sum as f64 / ids.len() as f64
    };
    (avg(team_a) - avg(team_b)).abs() as i32
}

fn average_mmr(roster: &[SkillPlayer], team: &[PlayerId]) -> f64 {
    let sum: i32 = team
        .iter()
        .map(|id| roster.iter().find(|p| p.id == *id).unwrap().mmr)
        .sum();
    sum as f64 / team.len() as f64
}

