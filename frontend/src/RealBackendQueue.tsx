import { useState } from "react";
import { api, JoinResponse } from "./api";

const REGIONS = ["na-east", "na-west", "eu-west", "ap-south"];
const OFFSETS = [-45, -36, -27, -18, -9, 0, 9, 18, 27, 36, 45, -54, 54, -63, 63];

interface RealBackendQueueProps {
  onQueued: () => Promise<void> | void;
}

function mmrFor(baseMmr: number, index: number): number {
  const offset = OFFSETS[index % OFFSETS.length];
  return Math.max(0, Math.min(10000, baseMmr + offset));
}

export function RealBackendQueue({ onQueued }: RealBackendQueueProps) {
  const [region, setRegion] = useState(REGIONS[0]);
  const [baseMmr, setBaseMmr] = useState(1500);
  const [count, setCount] = useState(10);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [lastPlayers, setLastPlayers] = useState<JoinResponse[]>([]);

  const queuePlayers = async () => {
    const safeCount = Math.max(1, Math.min(100, count));
    setLoading(true);
    setMessage(null);

    try {
      const players = await Promise.all(
        Array.from({ length: safeCount }, (_, index) =>
          api.join(mmrFor(baseMmr, index), region),
        ),
      );

      setLastPlayers(players);
      setMessage(`Queued ${players.length} real backend players in ${region}.`);
      await onQueued();
      window.setTimeout(() => void onQueued(), 1500);
      window.setTimeout(() => void onQueued(), 4000);
    } catch (e) {
      setMessage(e instanceof Error ? `Queue failed: ${e.message}` : "Queue failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="card span-2 real-queue-card">
      <div className="real-queue-header">
        <div>
          <h2>Real backend players</h2>
          <p className="muted real-queue-subtitle">
            Sends real join requests to Rust and MySQL.
          </p>
        </div>
        <span className="pill matched">backend</span>
      </div>

      <div className="real-queue-controls">
        <label>
          Region
          <select value={region} onChange={(e) => setRegion(e.target.value)}>
            {REGIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>

        <label>
          Base MMR
          <input
            type="number"
            min={0}
            max={10000}
            value={baseMmr}
            onChange={(e) => setBaseMmr(Number(e.target.value))}
          />
        </label>

        <label>
          Players
          <input
            type="number"
            min={1}
            max={100}
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
          />
        </label>

        <button type="button" onClick={queuePlayers} disabled={loading}>
          {loading ? "Queueing..." : "Queue real players"}
        </button>
      </div>

      <div className="real-queue-hint">
        Use 10 players for a full backend match, or 9 if your manual player is already waiting
        with the same region and nearby MMR.
      </div>

      {message && <p className="real-queue-message">{message}</p>}

      {lastPlayers.length > 0 && (
        <dl className="stats real-queue-stats">
          <div>
            <dt>Last queued</dt>
            <dd>{lastPlayers.length}</dd>
          </div>
          <div>
            <dt>MMR range</dt>
            <dd>
              {Math.min(...lastPlayers.map((p) => p.mmr))}-
              {Math.max(...lastPlayers.map((p) => p.mmr))}
            </dd>
          </div>
          <div>
            <dt>Region</dt>
            <dd>{region}</dd>
          </div>
          <div>
            <dt>Sample ID</dt>
            <dd className="mono">{lastPlayers[0].player_id.slice(0, 8)}...</dd>
          </div>
        </dl>
      )}
    </section>
  );
}
