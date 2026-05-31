import { useCallback, useEffect, useState } from "react";
import {
  api,
  HealthResponse,
  JoinResponse,
  MatchListItem,
  MatchResult,
  QueueStatus,
} from "./api";
import { Pipeline } from "./Pipeline";
import { Demo } from "./Demo";

const REGIONS = ["na-east", "na-west", "eu-west", "ap-south"];
const STORAGE_KEY = "matchmaker_player_id";

export default function App() {
  const [mmr, setMmr] = useState(1500);
  const [region, setRegion] = useState(REGIONS[0]);
  const [playerId, setPlayerId] = useState<string | null>(
    () => localStorage.getItem(STORAGE_KEY),
  );
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const [match, setMatch] = useState<MatchResult | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [recentMatches, setRecentMatches] = useState<MatchListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refreshHealth = useCallback(async () => {
    try {
      const h = await api.health();
      setHealth(h);
    } catch {
      setHealth(null);
    }
    try {
      const m = await api.listMatches();
      setRecentMatches(m);
    } catch {
      setRecentMatches([]);
    }
  }, []);

  useEffect(() => {
    refreshHealth();
    const id = setInterval(refreshHealth, 5000);
    return () => clearInterval(id);
  }, [refreshHealth]);

  useEffect(() => {
    if (!playerId) return;
    const poll = async () => {
      try {
        const status = await api.status(playerId);
        setQueueStatus(status);
        if (status.state === "matched" && status.match_id) {
          const m = await api.match(status.match_id);
          setMatch(m);
        }
      } catch (e) {
        localStorage.removeItem(STORAGE_KEY);
        setPlayerId(null);
        setQueueStatus(null);
        setMatch(null);
        setError(
          e instanceof Error
            ? `Saved queue session expired: ${e.message}`
            : "Saved queue session expired",
        );
      }
    };
    poll();
    const id = setInterval(poll, 1500);
    return () => clearInterval(id);
  }, [playerId]);

  const handleJoin = async () => {
    setError(null);
    setLoading(true);
    setMatch(null);
    try {
      const res: JoinResponse = await api.join(mmr, region);
      setPlayerId(res.player_id);
      localStorage.setItem(STORAGE_KEY, res.player_id);
      setQueueStatus({
        player_id: res.player_id,
        state: "waiting",
        mmr: res.mmr,
        region: res.region,
        wait_seconds: 0,
        current_mmr_window: res.current_mmr_window,
        match_id: null,
      });
      await refreshHealth();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Join failed");
    } finally {
      setLoading(false);
    }
  };

  const handleLeave = async () => {
    if (!playerId) return;
    setError(null);
    const idToLeave = playerId;
    localStorage.removeItem(STORAGE_KEY);
    setPlayerId(null);
    setQueueStatus(null);
    setMatch(null);
    try {
      await api.leave(idToLeave);
      await refreshHealth();
    } catch (e) {
      setError(e instanceof Error ? `Leave request failed: ${e.message}` : "Leave request failed");
    }
  };

  return (
    <div className="app">
      <header className="hero">
        <h1>5v5 Matchmaker</h1>
        <p>Real-time competitive queue — Rust engine + MySQL + React</p>
      </header>

      {error && <div className="banner error">{error}</div>}

      <div className="grid">
        <Pipeline health={health} />

        <Demo />

        <section className="card">
          <h2>Join queue</h2>
          <label>
            MMR
            <input
              type="number"
              min={0}
              max={10000}
              value={mmr}
              onChange={(e) => setMmr(Number(e.target.value))}
              disabled={!!playerId && queueStatus?.state === "waiting"}
            />
          </label>
          <label>
            Region
            <select
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              disabled={!!playerId && queueStatus?.state === "waiting"}
            >
              {REGIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <div className="actions">
            {!playerId || queueStatus?.state === "left" ? (
              <button type="button" onClick={handleJoin} disabled={loading}>
                {loading ? "Joining…" : "Find match"}
              </button>
            ) : (
              <button type="button" className="secondary" onClick={handleLeave}>
                Leave queue
              </button>
            )}
          </div>
        </section>

        <section className="card">
          <h2>Your status</h2>
          {!playerId && <p className="muted">Join the queue to start.</p>}
          {playerId && queueStatus && (
            <dl className="stats">
              <div>
                <dt>State</dt>
                <dd className={`pill ${queueStatus.state}`}>{queueStatus.state}</dd>
              </div>
              <div>
                <dt>Wait</dt>
                <dd>{queueStatus.wait_seconds.toFixed(1)}s</dd>
              </div>
              <div>
                <dt>MMR window</dt>
                <dd>±{queueStatus.current_mmr_window}</dd>
              </div>
              <div>
                <dt>Player ID</dt>
                <dd className="mono">{playerId.slice(0, 8)}…</dd>
              </div>
            </dl>
          )}
        </section>

        {match && (
          <section className="card match-card span-2">
            <h2>Match found</h2>
            <p className="match-meta">
              {match.region} · spread {match.mmr_spread} ·{" "}
              {new Date(match.formed_at).toLocaleTimeString()}
            </p>
            <div className="teams">
              <div>
                <h3>Team A</h3>
                <p className="mmr-avg">Avg MMR {match.team_a_mmr.toFixed(0)}</p>
                <ul>
                  {match.team_a.map((id) => (
                    <li key={id} className="mono">
                      {id.slice(0, 8)}…
                    </li>
                  ))}
                </ul>
              </div>
              <div className="vs">VS</div>
              <div>
                <h3>Team B</h3>
                <p className="mmr-avg">Avg MMR {match.team_b_mmr.toFixed(0)}</p>
                <ul>
                  {match.team_b.map((id) => (
                    <li key={id} className="mono">
                      {id.slice(0, 8)}…
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </section>
        )}

        <section className="card">
          <h2>Live metrics</h2>
          {health ? (
            <dl className="stats">
              <div>
                <dt>MySQL</dt>
                <dd className={health.db_connected ? "pill matched" : "pill waiting"}>
                  {health.db_connected ? "connected" : "connecting…"}
                </dd>
              </div>
              <div>
                <dt>In queue (memory)</dt>
                <dd>{health.metrics.players_in_queue}</dd>
              </div>
              <div>
                <dt>Waiting (DB)</dt>
                <dd>{health.database.waiting}</dd>
              </div>
              <div>
                <dt>Matches formed</dt>
                <dd>{health.metrics.matches_formed}</dd>
              </div>
              <div>
                <dt>Total matches (DB)</dt>
                <dd>{health.database.total_matches}</dd>
              </div>
              <div>
                <dt>Throughput</dt>
                <dd>{health.metrics.matches_per_second.toFixed(3)}/s</dd>
              </div>
            </dl>
          ) : (
            <p className="muted">Start the API server to see metrics.</p>
          )}
        </section>

        <section className="card span-2">
          <h2>Recent matches (MySQL)</h2>
          {recentMatches.length === 0 ? (
            <p className="muted">No matches yet — queue 10+ players in the same region.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Region</th>
                  <th>Team A MMR</th>
                  <th>Team B MMR</th>
                  <th>Spread</th>
                  <th>Players</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {recentMatches.map((m) => (
                  <tr key={m.match_id}>
                    <td>{m.region}</td>
                    <td>{m.team_a_mmr.toFixed(0)}</td>
                    <td>{m.team_b_mmr.toFixed(0)}</td>
                    <td>{m.mmr_spread}</td>
                    <td>{m.player_count}</td>
                    <td>{new Date(m.formed_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
