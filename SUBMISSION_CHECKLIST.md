# Submission Checklist

Use this before handing in the Eterna Labs 5v5 Matchmaker project.

## Deliverables

| # | Requirement | Location | Verified |
|---|-------------|----------|----------|
| 1 | Thread-safe Rust matchmaking service | `matchmaker/` | `cargo test` passes |
| 2 | Load simulation script | `simulate_load.py` | Run against live API |
| 3 | README (algorithm, trade-offs, complexity, scaling) | `README.md`, `matchmaker/README.md` | Included |

## Pre-submit run (3 terminals)

```powershell
# Terminal 1 — MySQL (optional if using local MySQL + .env)
docker compose up -d

# Terminal 2 — API
cd matchmaker
copy .env.example .env   # edit DB_PASS if needed
cargo run

# Terminal 3 — Frontend
cd frontend
npm install
npm run dev
```

Open http://localhost:5173 and http://localhost:8081/api/health

## Simulation ( graders / demo )

```powershell
pip install -r requirements.txt
python simulate_load.py --players 500 --concurrency 50 --regions na-east
```

Expected: 0 server errors, majority matched, team balance gap &lt; 5 MMR avg.

## What was verified (latest run)

- `cargo test` — 2 unit tests pass (relaxation, team balance)
- `cargo build --release` — succeeds (MSVC)
- `npm run build` — frontend production build succeeds
- API: join → status → leave — OK
- Simulation: 50 players, 4 games, 0 errors
- MySQL: matches persisted (`db_matches` = memory `matches_formed`)
- Stale queue rows cleared on startup (741 orphaned rows fixed)

## Known limitations (documented in README)

- Last incomplete lobby (e.g. 50 players → 4 games, 10 timeout) when joins are spread over time
- Frontend polls queue status (no WebSocket yet)
- Single-node in-memory pool; horizontal scale described in README

## Files not to commit

- `matchmaker/.env` (credentials) — use `.env.example`
- `matchmaker/target/`, `frontend/node_modules/`, `frontend/dist/`
