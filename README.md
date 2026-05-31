# Eterna Labs — 5v5 Real-Time Competitive Matchmaker

A high-performance, real-time **5v5** matchmaking engine built with **Rust**, backed by **MySQL** persistence, and managed via a modern **React** web dashboard. 

This repository implements a production-grade, thread-safe matchmaking service capable of sharding regional queues, performing time-based skill constraint relaxation, optimizing player splits for fair team match-ups, and handling thousands of concurrent requests under extreme load.

---

## 🚀 Deliverables Status

| Deliverable | Status | Description |
| :--- | :---: | :--- |
| **1. Working Code** | **Complete** | Thread-safe Rust service in `matchmaker/` with concurrent `DashMap` pools, transactional claim rollback, lock-free observability metrics, Axum HTTP APIs, and MySQL persistence. |
| **2. Simulation Script** | **Complete** | `simulate_load.py` can inject thousands of players concurrently, poll match outcomes, and report wait time, throughput, and match quality. |
| **3. README Document** | **Complete** | Root README, backend README, and `INTERVIEWER_README.md` explain the implementation, complexity, tradeoffs, demo commands, and interview talking points. |
| **4. React Dashboard** | **Complete** | `frontend/` provides join/leave queue controls, player status, live metrics, and recent MySQL matches. |

## Latest Updates

- Fixed stale browser queue sessions causing repeated `404 Not Found` errors on `DELETE /api/queue/{player_id}` after a backend restart or expired player id.
- `DELETE /api/queue/{player_id}` is now idempotent and returns `204 No Content` even if the player is already absent, which is the correct behavior for a leave/cancel action.
- The React dashboard now clears stale `localStorage` queue ids when status polling fails, so old player ids do not keep generating failed requests.
- Added `INTERVIEWER_README.md`, a separate explanation you can use to walk an interviewer through the design.

---

## ⚡ Quick Start

### 1. Start MySQL Database (Docker)
Ensure Docker is running on your system, then start the container:
```powershell
docker compose up -d
```
*Note: The MySQL container automatically initializes the schema from `matchmaker/db/schema.sql` on startup.*

### 2. Run the Backend API
Set the target port and run the Cargo binary:
```powershell
cd matchmaker
copy .env.example .env
$env:MATCHMAKER_PORT = "8081"
cargo run
```
*Note: the current backend waits and retries until MySQL is available because queue and match state are persisted there for the dashboard. Start Docker first or provide a valid `DATABASE_URL`.*

### 3. Run the React Web Dashboard
Open a new terminal window to start the frontend server:
```powershell
cd frontend
npm install
npm run dev
```
Open your browser to [http://localhost:5173](http://localhost:5173) to view live queue metrics, active matchmaking pools, and past match histories.

---

## 🧪 Load Simulation Script

We implemented a highly concurrent, asynchronous load simulation script (`simulate_load.py`) using Python's `asyncio` and `aiohttp`. The script generates players with a **realistic normal MMR distribution** (centered at 1500 MMR, std-dev of 300) across multiple regions, enqueues them concurrently, and polls their status until a 5v5 match is formed.

### Running the Simulator
To run the simulator against your server with default settings (2000 players, 100 max concurrency):
```powershell
python simulate_load.py
```

### Advanced Options
You can configure the simulation using CLI arguments:
```powershell
python simulate_load.py --players 5000 --concurrency 250 --timeout 60.0
```
- `--players`: Number of players to simulate (default: `2000`).
- `--concurrency`: Max concurrent HTTP requests (default: `100`).
- `--url`: Base URL of the matchmaker API (default: `http://localhost:8081`).
- `--timeout`: Max time a player waits in queue before timeout (default: `30s`).
- `--poll-interval`: Frequency of player status checks (default: `1.0s`).
- `--regions`: List of sharded regions to distribute players into.

### Real Simulation Output (500 Concurrent Players)
```text
=== Eterna Labs Matchmaker Load Simulator ===
Target Server: http://localhost:8081
Config: 500 players | Max Concurrency: 50
Regions: na-east, eu-west, ap-southeast
Timeout limit: 30.0s | Poll interval: 1.0s

[OK] Connected successfully to Matchmaker.
  Server status: ok
  Players currently in queue: 0
  Matches formed so far: 0

Progress: [==============================] 500/500 (100.0%) | Joined: 500 | Matched: 470 (47 games) | Timeouts: 0 | Errors: 0 | Time: 32.5s

=== Simulation Completed in 32.55s ===

Queue Throughput & Success Rate:
  - Total Players Simulated: 500
  - Successfully Matched:   470 (94.00%)
  - Timed Out (No Match):   30 (6.00%)
  - Server/Network Errors:  0 (0.00%)
  - Total 5v5 Games Formed: 47
  - Matching Throughput:     14.44 players/sec (1.44 games/sec)

Queue Wait Times (for matched players):
  - Average (Mean):         2.03 seconds
  - Median:                 1.01 seconds
  - Minimum:                1.00 seconds
  - Maximum:                25.33 seconds

Match Quality Metrics (47 matches analyzed):
  - Avg. MMR Spread within Match:     151.3 MMR (ideal is lower)
  - Avg. Team Skill Balance Gap:      0.4 MMR (ideal is close to 0)
  - Max. Team Skill Balance Gap:      3.4 MMR
```

---

## 🛠️ Engineering Challenges & Solutions

### 1. Latency vs. Match Quality (MMR Constraint Relaxation)
*   **The Challenge**: Tight skill bounds make competitive matches but cause high queue times. Loose skill bounds form games quickly but result in unfair matchups.
*   **Our Solution**: **Time-based constraint relaxation** (implemented in `relaxation.rs`). The MMR window starts narrow (default: 75 MMR) and widens dynamically at a linear rate (default: +12 MMR/sec) up to a hard cap (default: 600 MMR):
    $$\text{Window} = \text{Clamp}(\text{Initial} + \text{WaitTime} \times \text{RelaxRate}, \text{Initial}, \text{Max})$$
    Fresh entries enjoy highly balanced lobbies, while extreme MMR outliers (who wait longer) slowly broaden their search space to secure games.

### 2. Thread-Safety & Avoidance of Double Matching
*   **The Challenge**: Multiple background worker threads process sharded regional queues concurrently. Two threads must never assign the same player to different matches.
*   **Our Solution**: A thread-safe transactional claiming protocol (implemented in `pool.rs` and `engine.rs`):
    - Regional queues are sharded: `shard = hash(region) % worker_count` to eliminate lock contention.
    - Each player in the `DashMap` concurrency index maintains a **monotonic generation counter**.
    - Before staging a match, a worker validates that all 10 players are in a `Waiting` state and match their exact generation.
    - The worker executes an **atomic two-phase claim**. If a claim race is lost mid-way, the transaction is **rolled back** (players returned to `Waiting` and re-indexed), maintaining total pool consistency.

### 3. Fair 5v5 Team Splits
*   **The Challenge**: Selecting 10 players of similar skill is only half the battle. They must be split into two teams of 5 such that the average MMR of Team A is as close as possible to Team B.
*   **Our Solution**: Optimal mathematical partitioning (implemented in `balance.rs`):
    - For exactly 10 players, there are $\binom{10}{5} = 252$ possible team compositions.
    - Our engine executes a highly optimized $O(252) = O(1)$ evaluation loop over all combinations.
    - It selects the combination that minimizes the absolute average MMR difference:
      $$\min | \text{AvgMMR}(\text{TeamA}) - \text{AvgMMR}(\text{TeamB}) |$$
      As demonstrated in our load simulation, this algorithm formed matches with an average team skill balance gap of **only 0.4 MMR**!

### 4. Zero-Blocking Observability
*   **The Challenge**: Monitoring throughput, locks, and latency in real-time must not introduce lock contention in the hot matchmaking path.
*   **Our Solution**: Lock-free metrics (implemented in `metrics.rs`). Counters (joins, matches formed, scan ticks, claim latencies) use atomic primitives (`AtomicU64`) with relaxed ordering (`Ordering::Relaxed`), keeping critical execution paths entirely non-blocking.

---

## 📊 Complexity Analysis

Let $P$ represent the number of players in queue, $B$ the number of regional MMR buckets touched per search, $C$ the candidate search cap (default: 64), and $N$ the match lobby size ($N=10$).

| Operation | Time Complexity | Space Complexity | Explanation |
| :--- | :--- | :--- | :--- |
| **Join Queue** | $O(1)$ amortized | $O(1)$ | Fast insert in `DashMap` concurrency index and append to local regional index. |
| **Leave Queue** | $O(1)$ amortized | $O(1)$ | Evicts entry from DashMap and marks state to prevent stale claims. |
| **Candidate Scan** | $O(B \times \text{BucketSize}) \to O(1)$ | $O(C)$ | Uses local regional MMR sharded indexes rather than searching full queues. Bounded by cap $C=64$. |
| **Roster Sorting** | $O(C \log C)$ | $O(C)$ | Sorts neighbors to find tightest sliding window of 10 players. |
| **Team Split** | $O(\binom{10}{5}) = O(252) \to O(1)$ | $O(N)$ | Constant 252 evaluations for optimal 5v5 splits. |
| **Atomic Claim** | $O(N)$ | $O(N)$ | Lock-free validation and single-phase transaction. |

---

## 📈 Scaling to Millions of Players

To transition this single-node architecture to support millions of concurrent players globally:

1. **Distributed State via Redis Shards**
   Replace `DashMap` with a Redis cluster sharded by regional identifier. Regional queues can be managed via Sorted Sets (`ZSET`), where the score represents the player's MMR, allowing $O(\log P)$ range queries for finding candidates.
2. **WebSocket & SSE Push Notifications**
   Replace polling `GET /queue/{player_id}` with persistent state sockets. When workers form a match, they publish a match-made event to a Redis Pub/Sub topic, which triggers WebSocket servers to push the lobby configurations to the clients instantly.
3. **Partitioned Matching Workers**
   Scale matchmaking worker instances independently. Assign workers to specific region-MMR boundaries (e.g., worker group A handles `na-east` players in the `1000-2000` MMR range). This guarantees workers do not lock overlapping partitions, preventing transaction rollbacks.
4. **Append-Only Write Buffering**
   Replace immediate database persistence with a message broker (e.g., Apache Kafka or RabbitMQ). Workers push formed matches to the queue, and dedicated consumer groups consume and write matches to MySQL in micro-batches to prevent DB lock saturation.
