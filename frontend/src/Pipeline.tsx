import { useEffect, useRef, useState } from "react";
import { HealthResponse } from "./api";

/* ── stage data ─────────────────────────────────────────────────────────── */

interface Stage {
  id: string;
  label: string;
  icon: string;
  color: string;
  glow: string;
  summary: string;
  detail: Detail;
}

interface Detail {
  what: string;
  how: string[];
  code: string;
  complexity: string;
  file: string;
}

const STAGES: Stage[] = [
  {
    id: "enqueue",
    label: "Enqueue player",
    icon: "⬆",
    color: "#7c6af7",
    glow: "#7c6af733",
    summary: "Player joins the waiting pool",
    detail: {
      what:
        "A POST /queue/join request arrives with the player's MMR (0–10 000) and region. The engine validates the payload, mints a UUID if none is provided, and atomically inserts the player into the DashMap pool.",
      how: [
        "Input validation: region must be non-empty, MMR in [0, 10 000]",
        "Monotonic generation counter bumped via AtomicU64::fetch_add(Relaxed)",
        "Player is written into entries DashMap with state = Waiting",
        "Player's MMR bucket index is updated in the per-region RegionIndex",
        "A per-region anchor cursor is initialised if the region is new",
        "Async DB upsert fires in the background (non-blocking to the caller)",
      ],
      code: `// pool.rs — join()
let gen = self.generation.fetch_add(1, Ordering::Relaxed);
let player = WaitingPlayer { id, mmr, region, joined_at: Utc::now(), generation: gen };
self.entries.insert(id, PoolEntry { player, state: Waiting, match_id: None });
self.index_insert(&player);`,
      complexity: "O(1) amortized — single DashMap shard insert",
      file: "pool.rs · main.rs",
    },
  },
  {
    id: "pool",
    label: "Player pool",
    icon: "⬛",
    color: "#3b82f6",
    glow: "#3b82f633",
    summary: "In-memory concurrent store",
    detail: {
      what:
        "All waiting players live in a DashMap<PlayerId, PoolEntry>. A parallel RegionIndex shards players into 100-MMR buckets per region so candidate scans never touch the full pool — only nearby buckets.",
      how: [
        "DashMap: 64 internal shards, each with its own RwLock — no global lock",
        "RegionIndex: per-region DashMap<bucket_key, Vec<PlayerId>>",
        "bucket_key = (mmr / 100) * 100  →  players with mmr 1480–1499 share bucket 1400",
        "MMR window → bucket range is computed per scan tick, not stored",
        "Leave evicts the player from both entries and the bucket index instantly",
        "pool.len() counts only Waiting entries (used by health metrics)",
      ],
      code: `// pool.rs — RegionIndex
fn bucket_key(mmr: i32, bucket_size: i32) -> i32 {
    mmr.div_euclid(bucket_size) * bucket_size
}

// candidates_near: only walk buckets inside [anchor_mmr - window, anchor_mmr + window]
let min_bucket = bucket_key(anchor_mmr - window, bucket_size);
let max_bucket = bucket_key(anchor_mmr + window, bucket_size);`,
      complexity: "O(B × bucket_size) scan, B = buckets in window, capped at 64 candidates",
      file: "pool.rs",
    },
  },
  {
    id: "workers",
    label: "Worker threads",
    icon: "⚡",
    color: "#f59e0b",
    glow: "#f59e0b33",
    summary: "N parallel scanners, region-sharded",
    detail: {
      what:
        "At startup the engine spawns N OS threads (N = logical CPUs, clamped 2–32). Each thread owns a region shard and continuously loops: pick an anchor player → search for 9 compatible neighbours → attempt an atomic claim.",
      how: [
        "Region sharding: shard = fnv1a(region) % worker_count  →  workers never fight over the same region",
        "Anchor selection: round-robin via per-region AtomicU64 cursor (O(1) and wait-free)",
        "Worker wakes every 5 ms (scan_interval) — tight enough for sub-10 ms match formation",
        "crossbeam bounded channel (cap 10 000) carries formed MatchResults to the async drainer",
        "A separate 'match-drainer' thread inserts matches into MatchStore without blocking workers",
        "Metrics: scan_ticks, match_attempts, failed_claims all incremented with Relaxed atomics",
      ],
      code: `// engine.rs — worker_loop
loop {
    metrics.inc_scan();
    let anchors = pool.anchors_for_shard(worker_id, worker_count);
    for (region, anchor_id) in anchors {
        try_form_match(&pool, &metrics, &match_tx, &config, &region, anchor_id, needed);
    }
    thread::sleep(config.scan_interval); // 5 ms
}`,
      complexity: "O(regions_per_shard) per tick · O(B) candidate scan per region",
      file: "engine.rs · config.rs",
    },
  },
  {
    id: "relaxation",
    label: "Time relaxation",
    icon: "⏱",
    color: "#10b981",
    glow: "#10b98133",
    summary: "MMR window widens as players wait",
    detail: {
      what:
        "Every time a worker evaluates an anchor player it computes a dynamic MMR window based on how long that player has been waiting. Fresh players get a tight window (fair matches); veterans get a widening window (guaranteeing they eventually get a game).",
      how: [
        "Formula: window = clamp(initial + wait_s × relax_rate, initial, max)",
        "Defaults: initial = 75 MMR, relax_rate = 12 MMR/s, max = 600 MMR",
        "After 6.25 s a player's window reaches 150 MMR (2× initial)",
        "After 43.75 s the window hits the hard cap of 600 MMR — no further relaxation",
        "#[inline] ensures zero function-call overhead in the hot path",
        "The current window is also surfaced to the client via GET /queue/{id}",
      ],
      code: `// relaxation.rs
#[inline]
pub fn mmr_window(config: &MatchmakerConfig, wait_seconds: f64) -> i32 {
    let relaxed = config.initial_mmr_window as f64
        + wait_seconds * config.mmr_relax_per_second;
    relaxed
        .round()
        .clamp(config.initial_mmr_window as f64, config.max_mmr_window as f64)
        as i32
}`,
      complexity: "O(1) — arithmetic only, no allocation",
      file: "relaxation.rs · config.rs",
    },
  },
  {
    id: "balance",
    label: "Team balance",
    icon: "⚖",
    color: "#ec4899",
    glow: "#ec489933",
    summary: "Optimal 5v5 split via C(10,5) search",
    detail: {
      what:
        "Once 10 compatible players are found they must be divided into two teams of 5. The engine exhaustively evaluates all C(10,5) = 252 splits and picks the one that minimises |avg_mmr(A) − avg_mmr(B)|.",
      how: [
        "Roster selection: sliding window of 10 players with min combined spread (score = spread × 1000 + skill_gap)",
        "Team split: next_combination iterator generates all 252 C(10,5) subsets",
        "Each split is scored as |sum_A × 5 − sum_B × 5| — integer arithmetic, no FP rounding",
        "Best split is returned; avg_mmr per team computed for the MatchResult",
        "Observed result from load test: avg team gap = 0.4 MMR, max = 3.4 MMR",
        "Unit test balances_extremes() asserts gap < 150 for any 10-player field",
      ],
      code: `// balance.rs — optimal_team_split
loop {
    let diff = (sum_a * team_size as i64 - sum_b * team_size as i64).abs();
    if best.as_ref().map_or(true, |(_, _, d)| diff < *d) {
        best = Some((team_a, team_b, diff));
    }
    if !next_combination(&mut combo, n) { break; }
}`,
      complexity: "O(C(10,5)) = O(252) = O(1) — constant regardless of pool size",
      file: "balance.rs · engine.rs",
    },
  },
  {
    id: "match",
    label: "Match ready",
    icon: "✦",
    color: "#3dffa8",
    glow: "#3dffa833",
    summary: "Atomic claim → broadcast → persist",
    detail: {
      what:
        "Before broadcasting the match the engine performs an atomic two-phase claim to guarantee no player ends up in two simultaneous matches. Only after all 10 are successfully claimed is the MatchResult published.",
      how: [
        "Phase 1 (validate): check all 10 entries are Waiting with the expected generation counter",
        "Phase 2 (claim): mark each as Matched one-by-one; rollback any already-claimed players on race loss",
        "Generation counter prevents ABA: if a player left and re-queued their generation changed → claim fails",
        "MatchResult sent via crossbeam bounded channel → match-drainer thread → MatchStore (in-memory cache)",
        "Async DB persister polls the channel every 50 ms and writes to MySQL inside a transaction",
        "GET /matches/{id} checks in-memory MatchStore first, falls back to MySQL for historical matches",
      ],
      code: `// pool.rs — try_claim (Phase 2 with rollback)
for (id, &gen) in ids.iter().zip(expected_gens) {
    let mut entry = self.entries.get_mut(id)
        .ok_or_else(|| rollback_claim(self, &claimed))?;
    if entry.state != Waiting || entry.player.generation != gen {
        rollback_claim(self, &claimed); return false;
    }
    entry.state = Matched;
    claimed.push(*id);
}`,
      complexity: "O(N) = O(10) validation + claim · O(N) rollback on failure",
      file: "pool.rs · engine.rs · db.rs",
    },
  },
];

/* ── sub-components ─────────────────────────────────────────────────────── */

function Particle({ color }: { color: string }) {
  const style: React.CSSProperties = {
    position: "absolute",
    width: 4,
    height: 4,
    borderRadius: "50%",
    background: color,
    opacity: 0,
    animation: `particle-float ${1.2 + Math.random() * 1.2}s ease-out ${Math.random() * 0.8}s infinite`,
    left: `${10 + Math.random() * 80}%`,
    top: `${10 + Math.random() * 80}%`,
  };
  return <span style={style} />;
}

function ConnectorArrow({ active, color }: { active: boolean; color: string }) {
  return (
    <div className="pipeline-arrow" aria-hidden="true">
      <div
        className="pipeline-arrow-track"
        style={{ "--arrow-color": active ? color : "var(--border)" } as React.CSSProperties}
      >
        <div
          className="pipeline-arrow-pulse"
          style={{
            background: active ? color : "transparent",
            boxShadow: active ? `0 0 8px ${color}` : "none",
          }}
        />
      </div>
      <svg width="10" height="14" viewBox="0 0 10 14" style={{ display: "block", margin: "0 auto" }}>
        <polygon
          points="5,14 0,4 10,4"
          fill={active ? color : "var(--border)"}
          style={{ filter: active ? `drop-shadow(0 0 4px ${color})` : "none", transition: "fill 0.4s, filter 0.4s" }}
        />
      </svg>
    </div>
  );
}

function ComplexityBadge({ text }: { text: string }) {
  return (
    <span className="complexity-badge">
      <span className="complexity-icon">Θ</span>
      {text}
    </span>
  );
}

function FileBadge({ text }: { text: string }) {
  return (
    <span className="file-badge">
      <span>📄</span> {text}
    </span>
  );
}

/* ── main component ─────────────────────────────────────────────────────── */

interface PipelineProps {
  health: HealthResponse | null;
}

export function Pipeline({ health }: PipelineProps) {
  const [active, setActive] = useState<string | null>(null);
  const [animated, setAnimated] = useState<string[]>([]);
  const detailRef = useRef<HTMLDivElement>(null);
  const particleTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Cascade animation on mount
  useEffect(() => {
    STAGES.forEach((s, i) => {
      const t = setTimeout(() => {
        setAnimated((prev) => [...prev, s.id]);
      }, i * 120);
      particleTimers.current.push(t);
    });
    return () => particleTimers.current.forEach(clearTimeout);
  }, []);

  const handleSelect = (id: string) => {
    setActive((prev) => (prev === id ? null : id));
    setTimeout(() => detailRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 60);
  };

  const activeStage = STAGES.find((s) => s.id === active) ?? null;

  // Live metric badges mapped to pipeline stages
  const stageBadge = (id: string): string | null => {
    if (!health) return null;
    const m = health.metrics;
    switch (id) {
      case "enqueue": return `${m.players_in_queue} waiting`;
      case "pool":    return `${m.players_in_queue} in pool`;
      case "workers": return `${m.matches_per_second.toFixed(2)}/s`;
      case "relaxation": return null;
      case "balance": return null;
      case "match":   return `${m.matches_formed} formed`;
      default:        return null;
    }
  };

  return (
    <section className="card span-2 pipeline-section" aria-label="Matchmaking pipeline visualizer">
      <h2>Matchmaking pipeline</h2>
      <p className="pipeline-subtitle muted">Click any stage to explore the implementation</p>

      {/* pipeline row */}
      <div className="pipeline-track" role="list">
        {STAGES.map((stage, i) => {
          const isActive = active === stage.id;
          const isAnimated = animated.includes(stage.id);
          const badge = stageBadge(stage.id);

          return (
            <div key={stage.id} className="pipeline-cell" role="listitem">
              {/* stage node */}
              <button
                id={`pipeline-stage-${stage.id}`}
                className={`pipeline-node ${isActive ? "pipeline-node--active" : ""} ${isAnimated ? "pipeline-node--visible" : ""}`}
                style={{
                  "--stage-color": stage.color,
                  "--stage-glow": stage.glow,
                  borderColor: isActive ? stage.color : undefined,
                  boxShadow: isActive ? `0 0 0 1px ${stage.color}, 0 0 28px ${stage.glow}` : undefined,
                } as React.CSSProperties}
                onClick={() => handleSelect(stage.id)}
                aria-pressed={isActive}
                aria-expanded={isActive}
                aria-controls={`pipeline-detail-${stage.id}`}
              >
                {/* particles when active */}
                {isActive && Array.from({ length: 6 }).map((_, j) => (
                  <Particle key={j} color={stage.color} />
                ))}

                <div
                  className="pipeline-node-icon"
                  style={{ background: stage.glow, color: stage.color }}
                >
                  {stage.icon}
                </div>
                <span className="pipeline-node-label">{stage.label}</span>
                <span className="pipeline-node-summary">{stage.summary}</span>
                {badge && (
                  <span className="pipeline-live-badge" style={{ color: stage.color, borderColor: stage.color + "55" }}>
                    {badge}
                  </span>
                )}
              </button>

              {/* connector arrow (not after last) */}
              {i < STAGES.length - 1 && (
                <ConnectorArrow
                  active={active === stage.id || active === STAGES[i + 1].id}
                  color={active === stage.id ? stage.color : active === STAGES[i + 1].id ? STAGES[i + 1].color : ""}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* detail panel */}
      <div ref={detailRef} id={activeStage ? `pipeline-detail-${activeStage.id}` : undefined}>
        {activeStage && (
          <div
            className="pipeline-detail"
            style={{ borderColor: activeStage.color + "55", "--stage-color": activeStage.color } as React.CSSProperties}
          >
            <div className="pipeline-detail-header">
              <span className="pipeline-detail-icon" style={{ background: activeStage.glow, color: activeStage.color }}>
                {activeStage.icon}
              </span>
              <div>
                <h3 className="pipeline-detail-title" style={{ color: activeStage.color }}>
                  {activeStage.label}
                </h3>
                <div className="pipeline-detail-badges">
                  <ComplexityBadge text={activeStage.detail.complexity} />
                  <FileBadge text={activeStage.detail.file} />
                </div>
              </div>
              <button
                className="pipeline-close"
                onClick={() => setActive(null)}
                aria-label="Close detail panel"
              >
                ✕
              </button>
            </div>

            <p className="pipeline-detail-what">{activeStage.detail.what}</p>

            <div className="pipeline-detail-body">
              <div className="pipeline-how">
                <h4>How it works</h4>
                <ul className="pipeline-how-list">
                  {activeStage.detail.how.map((item, i) => (
                    <li key={i}>
                      <span className="pipeline-how-bullet" style={{ background: activeStage.color }} />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="pipeline-code-block">
                <div className="pipeline-code-header">
                  <span className="pipeline-code-lang">rust</span>
                  <span className="pipeline-code-file">{activeStage.detail.file.split("·")[0].trim()}</span>
                </div>
                <pre className="pipeline-code"><code>{activeStage.detail.code}</code></pre>
              </div>
            </div>
          </div>
        )}

        {!activeStage && (
          <div className="pipeline-hint">
            <span className="pipeline-hint-icon">↑</span>
            Click any stage above to learn what happens there.
          </div>
        )}
      </div>
    </section>
  );
}
