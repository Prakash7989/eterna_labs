use std::sync::atomic::{AtomicU64, Ordering};

use chrono::Utc;
use dashmap::DashMap;
use parking_lot::RwLock;
use crate::config::MatchmakerConfig;
use crate::models::{MatchId, PlayerId, PlayerState, WaitingPlayer};

/// Per-region skill buckets for O(bucket neighbors) scans instead of full pool.
#[derive(Debug)]
struct RegionIndex {
    /// bucket_key -> player ids in that MMR bucket
    buckets: DashMap<i32, Vec<PlayerId>>,
}

impl RegionIndex {
    fn new() -> Self {
        Self {
            buckets: DashMap::new(),
        }
    }

    fn bucket_key(mmr: i32, bucket_size: i32) -> i32 {
        mmr.div_euclid(bucket_size) * bucket_size
    }

    fn insert(&self, player: &WaitingPlayer, bucket_size: i32) {
        let key = Self::bucket_key(player.mmr, bucket_size);
        self.buckets
            .entry(key)
            .or_default()
            .push(player.id);
    }

    fn remove(&self, mmr: i32, id: PlayerId, bucket_size: i32) {
        let key = Self::bucket_key(mmr, bucket_size);
        if let Some(mut list) = self.buckets.get_mut(&key) {
            list.retain(|&pid| pid != id);
            if list.is_empty() {
                drop(list);
                self.buckets.remove(&key);
            }
        }
    }
}

#[derive(Debug, Clone)]
struct PoolEntry {
    player: WaitingPlayer,
    state: PlayerState,
    match_id: Option<MatchId>,
}

/// Thread-safe waiting pool with atomic generation for claim validation.
#[derive(Debug)]
pub struct PlayerPool {
    entries: DashMap<PlayerId, PoolEntry>,
    regions: DashMap<String, RegionIndex>,
    generation: AtomicU64,
    config: MatchmakerConfig,
    /// Sharded anchor cursor per region to spread worker work.
    anchor_cursors: DashMap<String, AtomicU64>,
}

impl PlayerPool {
    pub fn new(config: MatchmakerConfig) -> Self {
        Self {
            entries: DashMap::new(),
            regions: DashMap::new(),
            generation: AtomicU64::new(1),
            config,
            anchor_cursors: DashMap::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.entries
            .iter()
            .filter(|e| e.state == PlayerState::Waiting)
            .count()
    }

    pub fn join(
        &self,
        id: PlayerId,
        mmr: i32,
        region: String,
    ) -> WaitingPlayer {
        let gen = self.generation.fetch_add(1, Ordering::Relaxed);
        let player = WaitingPlayer {
            id,
            mmr,
            region: region.clone(),
            joined_at: Utc::now(),
            generation: gen,
        };

        if let Some(mut old) = self.entries.get_mut(&id) {
            if old.state == PlayerState::Waiting {
                self.index_remove(&old.player);
            }
            old.player = player.clone();
            old.state = PlayerState::Waiting;
            old.match_id = None;
        } else {
            self.entries.insert(
                id,
                PoolEntry {
                    player: player.clone(),
                    state: PlayerState::Waiting,
                    match_id: None,
                },
            );
        }

        self.index_insert(&player);
        self.anchor_cursors
            .entry(region)
            .or_insert_with(|| AtomicU64::new(0));
        player
    }

    pub fn leave(&self, id: PlayerId) -> bool {
        let Some(mut entry) = self.entries.get_mut(&id) else {
            return false;
        };
        if entry.state == PlayerState::Waiting {
            self.index_remove(&entry.player);
        }
        entry.state = PlayerState::Left;
        true
    }

    pub fn get_status(&self, id: PlayerId) -> Option<(WaitingPlayer, PlayerState, Option<MatchId>)> {
        self.entries.get(&id).map(|e| {
            (
                e.player.clone(),
                e.state,
                e.match_id,
            )
        })
    }

    /// Try to atomically claim `ids` for a match. Fails if any player left, matched, or generation changed.
    pub fn try_claim(
        &self,
        ids: &[PlayerId],
        expected_gens: &[u64],
        match_id: MatchId,
    ) -> bool {
        if ids.len() != expected_gens.len() {
            return false;
        }

        // Phase 1: validate all entries
        for (id, &gen) in ids.iter().zip(expected_gens.iter()) {
            let Some(entry) = self.entries.get(id) else {
                return false;
            };
            if entry.state != PlayerState::Waiting || entry.player.generation != gen {
                return false;
            }
        }

        // Phase 2: claim one-by-one; rollback if a competitor wins the race.
        let mut claimed: Vec<PlayerId> = Vec::with_capacity(ids.len());
        for (id, &gen) in ids.iter().zip(expected_gens.iter()) {
            let Some(mut entry) = self.entries.get_mut(id) else {
                rollback_claim(self, &claimed);
                return false;
            };
            if entry.state != PlayerState::Waiting || entry.player.generation != gen {
                rollback_claim(self, &claimed);
                return false;
            }
            self.index_remove(&entry.player);
            entry.state = PlayerState::Matched;
            entry.match_id = Some(match_id);
            claimed.push(*id);
        }

        true
    }

    fn index_insert(&self, player: &WaitingPlayer) {
        let idx = self
            .regions
            .entry(player.region.clone())
            .or_insert_with(RegionIndex::new);
        idx.insert(player, self.config.mmr_bucket_size);
    }

    fn index_remove(&self, player: &WaitingPlayer) {
        if let Some(idx) = self.regions.get(&player.region) {
            idx.remove(player.mmr, player.id, self.config.mmr_bucket_size);
        }
    }

    /// Collect waiting players in region within mmr range of anchor, up to limit.
    pub fn candidates_near(
        &self,
        region: &str,
        anchor_mmr: i32,
        window: i32,
        limit: usize,
        exclude: PlayerId,
    ) -> Vec<(WaitingPlayer, u64)> {
        let Some(region_idx) = self.regions.get(region) else {
            return Vec::new();
        };

        let bucket_size = self.config.mmr_bucket_size;
        let min_mmr = anchor_mmr - window;
        let max_mmr = anchor_mmr + window;
        let min_bucket = RegionIndex::bucket_key(min_mmr, bucket_size);
        let max_bucket = RegionIndex::bucket_key(max_mmr, bucket_size);

        let mut out = Vec::with_capacity(limit);
        let mut bucket = min_bucket;
        while bucket <= max_bucket && out.len() < limit {
            if let Some(ids) = region_idx.buckets.get(&bucket) {
                for &id in ids.iter() {
                    if id == exclude {
                        continue;
                    }
                    let Some(entry) = self.entries.get(&id) else {
                        continue;
                    };
                    if entry.state != PlayerState::Waiting {
                        continue;
                    }
                    let p = &entry.player;
                    if p.mmr >= min_mmr && p.mmr <= max_mmr {
                        out.push((p.clone(), p.generation));
                    }
                    if out.len() >= limit {
                        break;
                    }
                }
            }
            bucket += bucket_size;
        }
        out
    }

    /// Pick next anchor player id in region (round-robin over waiting set).
    pub fn next_anchor(&self, region: &str) -> Option<PlayerId> {
        let waiting: Vec<PlayerId> = self
            .entries
            .iter()
            .filter(|e| e.state == PlayerState::Waiting && e.player.region == region)
            .map(|e| *e.key())
            .collect();

        if waiting.is_empty() {
            return None;
        }

        let cursor = self
            .anchor_cursors
            .entry(region.to_string())
            .or_insert_with(|| AtomicU64::new(0));
        let idx = cursor.fetch_add(1, Ordering::Relaxed) as usize % waiting.len();
        Some(waiting[idx])
    }

    pub fn regions_with_waiters(&self) -> Vec<String> {
        self.regions.iter().map(|r| r.key().clone()).collect()
    }

    /// Snapshot waiting players for a worker shard (by region hash % workers).
    pub fn anchors_for_shard(&self, worker_id: usize, worker_count: usize) -> Vec<(String, PlayerId)> {
        let mut anchors = Vec::new();
        for region in self.regions_with_waiters() {
            if shard_for_region(&region, worker_count) != worker_id {
                continue;
            }
            if let Some(id) = self.next_anchor(&region) {
                anchors.push((region, id));
            }
        }
        anchors
    }
}

fn rollback_claim(pool: &PlayerPool, ids: &[PlayerId]) {
    for id in ids {
        if let Some(mut entry) = pool.entries.get_mut(id) {
            if entry.state == PlayerState::Matched {
                entry.state = PlayerState::Waiting;
                entry.match_id = None;
                pool.index_insert(&entry.player);
            }
        }
    }
}

pub fn shard_for_region(region: &str, worker_count: usize) -> usize {
    let mut hash: u64 = 0;
    for b in region.bytes() {
        hash = hash.wrapping_mul(31).wrapping_add(b as u64);
    }
    (hash as usize) % worker_count
}

/// Match results broadcast to waiting clients / simulation.
#[derive(Debug)]
pub struct MatchStore {
    matches: RwLock<std::collections::HashMap<MatchId, crate::models::MatchResult>>,
}

impl MatchStore {
    pub fn new() -> Self {
        Self {
            matches: RwLock::new(std::collections::HashMap::new()),
        }
    }

    pub fn insert(&self, m: crate::models::MatchResult) {
        self.matches.write().insert(m.match_id, m);
    }

    pub fn get(&self, id: MatchId) -> Option<crate::models::MatchResult> {
        self.matches.read().get(&id).cloned()
    }
}
