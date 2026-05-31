# 5v5 Real-Time Competitive Matchmaker

A high-performance, in-memory **5v5** matchmaking engine written in **Rust**. Players join a regional queue with an MMR (skill rating); background worker threads form balanced teams of 10, split them into two teams of 5, and expose results over a REST API.

This document describes everything implemented so far: architecture, algorithms, API, configuration, build/run instructions, and known limitations.

---

## Table of Contents

1. [Project Status](#project-status)
2. [Repository Layout](#repository-layout)
3. [High-Level Architecture](#high-level-architecture)
4. [Engineering Challenges & Solutions](#engineering-challenges--solutions)
5. [Matchmaking Algorithm](#matchmaking-algorithm)
6. [Complexity Analysis](#complexity-analysis)
7. [Scaling Considerations](#scaling-considerations)
8. [HTTP API](#http-api)
9. [Configuration](#configuration)
10. [Build & Run](#build--run)
11. [Dependencies](#dependencies)
12. [Testing](#testing)
13. [Roadmap (Not Yet Implemented)](#roadmap-not-yet-implemented)

---

## Project Status

| Deliverable | Status |
|-------------|--------|
| Thread-safe matchmaking core (Rust library) | Done |
| HTTP service (`matchmaker` binary) | Done |
| **MySQL persistence** (`db/`, `src/db.rs`) | Done |
| **React frontend** (`../frontend/`) | Done |
| **Load simulation** (`../simulate_load.py`) | Done |
| Load simulation script | **Not yet** |
| Full README (this file) | Done |

---

## Repository Layout

```
eterna_labs/
├── docker-compose.yml          # MySQL 8.4
├── frontend/                   # React + Vite UI
└── matchmaker/
    ├── Cargo.toml              # Crate manifest & dependencies
    ├── rust-toolchain.toml     # Pins MSVC toolchain on Windows
    ├── .cargo/config.toml      # Default target: x86_64-pc-windows-msvc
    ├── README.md               # This file
    └── src/
        ├── lib.rs              # Public module exports
        ├── main.rs             # Axum HTTP server
        ├── config.rs           # Tunables (MMR window, workers, etc.)
        ├── models.rs           # Player, match, API DTOs
        ├── db.rs               # MySQL repository (sqlx)
        ├── pool.rs             # Thread-safe player pool + indexes
        ├── engine.rs           # Matcher workers + orchestration
        ├── relaxation.rs       # Time-based MMR window widening
        ├── balance.rs          # Optimal 5v5 team split
        └── metrics.rs          # Lock-free health counters
```

The crate is a **single binary + library**: `matchmaker` (library) powers the `matchmaker` (binary) HTTP server.

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     HTTP Layer (Tokio + Axum)                    │
│  POST /queue/join  GET /queue/{id}  DELETE /queue/{id}         │
│  GET /matches/{id}  GET /health                                  │
└────────────────────────────┬────────────────────────────────────┘
                             │
┌────────────────────────────▼────────────────────────────────────┐
│                    MatchmakerEngine                              │
│  ┌──────────────┐  ┌─────────────┐  ┌────────────────────────┐ │
│  │ PlayerPool   │  │ MatchStore  │  │ MatchmakerMetrics      │ │
│  │ (DashMap)    │  │ (RwLock)    │  │ (AtomicU64 counters)   │ │
│  └──────┬───────┘  └─────────────┘  └────────────────────────┘ │
│         │                                                        │
│  ┌──────▼───────────────────────────────────────────────────┐   │
│  │ Matcher workers (N threads, region-sharded)               │   │
│  │  • Pick anchor → scan MMR buckets → form roster → claim   │   │
│  └──────────────────────────────────────────────────────────┘   │
│         │                                                        │
│  ┌──────▼───────┐                                                │
│  │ match-drainer│  Persists formed matches into MatchStore       │
│  └──────────────┘                                                │
└─────────────────────────────────────────────────────────────────┘
```

**Data flow**

1. Client `POST /queue/join` → player inserted into `PlayerPool` + regional MMR bucket index.
2. Matcher workers loop every ~5ms, each owning a **shard** of regions (`hash(region) % worker_count`).
3. Worker picks an **anchor** player, gathers candidates within a **relaxed MMR window**, selects 10 players, runs **team balance**, then **atomically claims** all 10.
4. Match is sent on a bounded channel; **match-drainer** thread writes to `MatchStore`.
5. Client polls `GET /queue/{id}` until `state: matched` and reads `GET /matches/{match_id}`.

---

## Engineering Challenges & Solutions

### 1. Latency vs. Match Quality

**Problem:** Tight skill matching increases wait time; loose matching forms games quickly but feels unfair.

**Solution — time-based constraint relaxation** (`relaxation.rs`):

- Initial MMR window: **75** (max |MMR − anchor| for candidates).
- Window grows by **12 MMR per second** waited, capped at **600**.
- Formula:  
  `window = clamp(initial + wait_seconds × relax_rate, initial, max)`

Fresh joins get high-quality nearby-skill lobbies; long waits (e.g. extreme MMR) eventually widen enough to find a game.

---

### 2. Thread-Safe State & Atomic Eviction

**Problem:** Multiple matcher threads scan the same pool; two workers must not assign the same player to different matches.

**Solution:**

| Mechanism | Purpose |
|-----------|---------|
| `DashMap<PlayerId, PoolEntry>` | Concurrent reads/writes per player without global mutex |
| Per-player **generation** counter | Bumped on re-queue; stale claims detected |
| `try_claim(ids, generations, match_id)` | Two-phase validate-then-mark; **rollback** if mid-claim race lost |
| Regional **MMR bucket index** | Fast candidate lookup without locking entire pool |

**Claim algorithm** (`pool.rs`):

1. Verify all players are `Waiting` with expected `generation`.
2. Mark each `Matched` one-by-one; remove from bucket index.
3. If any step fails, **rollback** already-claimed players to `Waiting` and re-index.

Failed claims increment `failed_claims` metric (contention signal).

---

### 3. Time-Based Constraint Relaxation

Implemented in `relaxation.rs` and applied per anchor using `anchor.wait_seconds()` at match attempt time. Exposed to clients via `GET /queue/{id}` as `current_mmr_window`.

---

### 4. Team Balance Optimization

**Problem:** Finding 10 players is not enough — they must split into two fair teams of 5.

**Solution** (`balance.rs` + `engine.rs`):

1. **Roster selection:** Sort candidates by MMR; slide a window of 10 and pick the window with **lowest MMR spread** (minimize skill range in the lobby).
2. **Team split:** For exactly 10 players, enumerate **C(10,5) = 252** team compositions; choose split minimizing `|sum(team_a) − sum(team_b)|` (equivalent to minimizing average MMR gap).

Greedy pre-sort by distance-to-anchor is used when gathering from the pool; final fairness is enforced by the 252-way split.

---

### 5. Low-Latency Health Metrics

**Problem:** Observability must not block the matching hot path.

**Solution** (`metrics.rs`):

- All counters are `AtomicU64` with `Ordering::Relaxed` on increment.
- `/health` aggregates snapshots only when requested (not on every scan).
- Tracked: joins, leaves, matches formed, match attempts, failed claims, scan ticks, rolling average claim latency.

---

### 6. Worker Parallelism Without Duplicated Work

- Workers are **region-sharded**: `shard = hash(region) % worker_count`.
- **Round-robin anchor** cursor per region spreads starting points across waiters.
- Scan interval default: **5 ms** (configurable).

---

## Matchmaking Algorithm

Pseudocode for one worker tick on one anchor:

```
anchor ← next_anchor_in_my_shard()
window ← mmr_window(config, anchor.wait_seconds)
candidates ← pool.candidates_near(region, anchor.mmr, window, limit=64)
if |candidates| + 1 < 10: return

group ← {anchor} ∪ closest_mmr(candidates, count=10)
(roster, team_a, team_b) ← find_best_roster(group)  // sliding window + 252 split

if pool.try_claim(roster, generations, new_match_id):
    emit MatchResult { team_a, team_b, mmr stats }
```

**Default config** (`config.rs`):

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `team_size` | 5 | Players per team |
| `worker_count` | CPU cores (2–32) | Parallel matcher threads |
| `scan_interval` | 5 ms | Sleep between scan passes |
| `initial_mmr_window` | 75 | Starting skill tolerance |
| `mmr_relax_per_second` | 12.0 | Window growth per second |
| `max_mmr_window` | 600 | Ceiling on relaxation |
| `mmr_bucket_size` | 100 | MMR index bucket width |
| `max_candidates_per_anchor` | 64 | Cap on neighbor scan |

---

## Complexity Analysis

Let **P** = players in queue, **B** = buckets touched per search (~`2 × window / bucket_size`), **C** = `max_candidates_per_anchor` (64), **n** = 10.

| Operation | Time | Space |
|-----------|------|-------|
| Join / leave | O(1) amortized (DashMap) + O(1) bucket list update | O(1) per player |
| Candidate scan | O(B × avg_bucket_size), bounded by **C** | O(C) |
| Roster (sliding window) | O(C log C) sort + O(C) windows | O(C) |
| Team balance | O(252) = **O(1)** for fixed 5v5 | O(n) |
| try_claim | O(n) players, n = 10 | O(n) |
| Per worker tick | O(regions_on_shard × (C log C + 252)) | — |

**Overall throughput:** Scales with `worker_count` until pool or channel contention dominates. Bucket index avoids O(P) full scans.

---

## Scaling Considerations

**Current design (single process, in-memory)**

- Suitable for prototyping, local dev, and single-node deployments.
- State is **not** persisted; restart clears queue and matches.
- Horizontal scaling would require:
  - **Regional shards** (separate matchmaker instances per region).
  - **Distributed queue** (Redis, custom service) with consistent hashing on player id.
  - **Leader-elected matchers** or partition-by-MMR-range to avoid double-matching.
  - Push notifications (WebSocket/SSE) instead of polling `GET /queue/{id}`.

**Bottlenecks to watch**

- `DashMap` contention under very high join/leave rates.
- `failed_claims` rising → too many workers competing for same anchors (tune sharding or scan interval).
- `MatchStore` uses `RwLock<HashMap>` — fine for reads; consider append-only log at scale.

**Windows toolchain note**

- Project pins `stable-x86_64-pc-windows-msvc` because GNU/MinGW `dlltool` can fail on some setups.
- See `rust-toolchain.toml` and `.cargo/config.toml`.

---

## MySQL Database

Schema: `db/schema.sql` (auto-applied on server start).

| Table | Purpose |
|-------|---------|
| `queue_entries` | Every join/leave/match state per player |
| `matches` | Formed match metadata (MMR averages, spread, time) |
| `match_participants` | Player ↔ team assignment per match |

**Persistence flow:** join/leave write immediately; a background task polls the in-memory match channel every 50ms and `persist_match` into MySQL.

**Environment:** `DATABASE_URL` (see `.env.example`).

---

## HTTP API

Base URL: `http://localhost:{PORT}` (default port **8081**, overridable — see [Build & Run](#build--run)).

Routes are duplicated under `/api/*` for frontend convenience. **CORS** is enabled for browser access.

### `POST /queue/join`

Enqueue a player.

**Request body**

```json
{
  "player_id": "optional-uuid",
  "mmr": 1520,
  "region": "na-east"
}
```

- `player_id`: optional; server generates UUID if omitted.
- `mmr`: integer 0–10000.
- `region`: non-empty string (players only match within the same region).

**Response `200`**

```json
{
  "player_id": "550e8400-e29b-41d4-a716-446655440000",
  "mmr": 1520,
  "region": "na-east",
  "current_mmr_window": 75
}
```

---

### `GET /queue/{player_id}`

Poll queue status.

**Response `200`**

```json
{
  "player_id": "550e8400-e29b-41d4-a716-446655440000",
  "state": "waiting",
  "mmr": 1520,
  "region": "na-east",
  "wait_seconds": 12.5,
  "current_mmr_window": 225,
  "match_id": null
}
```

`state`: `waiting` | `matched` | `left`

When matched, `match_id` is set and `GET /matches/{match_id}` returns teams.

---

### `DELETE /queue/{player_id}`

Leave the queue. Returns **`204`** on success, **`404`** if unknown.

---

### `GET /matches/{match_id}`

Retrieve a formed match.

**Response `200`**

```json
{
  "match_id": "...",
  "region": "na-east",
  "team_a": ["uuid", "..."],
  "team_b": ["uuid", "..."],
  "team_a_mmr": 1510.2,
  "team_b_mmr": 1508.8,
  "mmr_spread": 180,
  "formed_at": "2026-05-30T14:00:00Z"
}
```

---

### `GET /health` or `GET /api/health`

Service, in-memory engine metrics, and MySQL queue stats.

**Response `200`**

```json
{
  "status": "ok",
  "metrics": {
    "players_in_queue": 42,
    "matches_formed": 95,
    "matches_per_second": 0.026
  },
  "database": {
    "waiting": 40,
    "matched_players": 950,
    "total_matches": 95
  }
}
```

---

### `GET /api/matches?limit=20`

List recent matches from MySQL (newest first).

---

### `GET /api/stats`

Database-only queue/match counts.

---

## React Frontend

Location: `../frontend/`

| Feature | Description |
|---------|-------------|
| Join queue | MMR + region form |
| Live status | Polls every 1.5s until matched |
| Match view | Team A vs Team B when formed |
| Metrics | Memory + DB stats from `/api/health` |
| Match history | Table from `/api/matches` |

```powershell
cd ../frontend
npm install
npm run dev
```

Vite proxies `/api`, `/health`, `/queue`, `/matches` → `http://localhost:8081`.

---

### Example (PowerShell)

```powershell
# Start server (see port note below)
$env:MATCHMAKER_PORT = "8081"
cargo run

# Join queue
Invoke-RestMethod -Method POST -Uri "http://localhost:8081/queue/join" `
  -ContentType "application/json" `
  -Body '{"mmr": 1500, "region": "na-east"}'

# Check status
Invoke-RestMethod -Uri "http://localhost:8081/queue/{player_id}"

# Health
Invoke-RestMethod -Uri "http://localhost:8081/health"
```

---

## Configuration

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `mysql://matchmaker:matchmaker@127.0.0.1:3306/matchmaker` | MySQL connection |
| `MATCHMAKER_PORT` | `8081` | HTTP listen port |
| `RUST_LOG` | `matchmaker=info` | Tracing filter (via `tracing-subscriber`) |

If port **8080** is in use (e.g. by `httpd.exe` on Windows), set `MATCHMAKER_PORT=8081` or stop the conflicting service.

### Programmatic config

`MatchmakerConfig::default()` in `config.rs` can be customized before `MatchmakerEngine::new(config)` in `main.rs` (or future env-based loading).

---

## Build & Run

### Prerequisites

- [Rust](https://rustup.rs/) 1.70+ (project tested on **1.96**)
- [Docker](https://www.docker.com/) for MySQL (or local MySQL 8+)
- [Node.js](https://nodejs.org/) 18+ for the React UI
- On Windows: **MSVC** toolchain (`stable-x86_64-pc-windows-msvc`)

Install MSVC toolchain if needed:

```powershell
rustup toolchain install stable-x86_64-pc-windows-msvc
```

### Build

```powershell
cd matchmaker
cargo build --release
```

### Run

```powershell
# From repo root
docker compose up -d

cd matchmaker
copy .env.example .env
$env:MATCHMAKER_PORT = "8081"
cargo run
```

Release binary:

```powershell
.\target\x86_64-pc-windows-msvc\release\matchmaker.exe
```

### Verify

```powershell
cargo test
```

Unit tests cover MMR relaxation monotonicity and team-balance sanity checks.

---

## Dependencies

| Crate | Role |
|-------|------|
| `axum` / `tokio` | Async HTTP server |
| `dashmap` | Concurrent player map |
| `parking_lot` | Fast `RwLock` for match store |
| `crossbeam-channel` | Bounded match result queue |
| `uuid` | Player and match IDs |
| `chrono` | Timestamps |
| `serde` / `serde_json` | JSON API |
| `tracing` | Structured logging |
| `sqlx` | Async MySQL access |
| `tower-http` | CORS middleware |
| `dotenvy` | Load `.env` |

---

## Testing

```powershell
cargo test
```

| Test | Module | What it checks |
|------|--------|----------------|
| `window_grows_with_wait` | `relaxation` | MMR window increases with wait time and caps at max |
| `balances_extremes` | `balance` | 10-player split produces roughly balanced team averages |

---

## Roadmap (Not Yet Implemented)

- WebSocket/SSE for real-time match notifications (frontend currently polls).
- Config from environment / config file without recompiling.
- Graceful shutdown (signal workers to stop).
- Persistence / Redis-backed queue for multi-instance deployment.
- Role-based matchmaking (tank/DPS/support) and party/premade groups.
- Anti-smurf and ping-based region selection.

---

## License

Not specified — add a license file before public distribution.
