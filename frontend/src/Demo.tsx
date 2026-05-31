import { useCallback, useEffect, useRef, useState } from "react";

/* ══════════════════════════════════════════════════════════════════════════
   TYPES
══════════════════════════════════════════════════════════════════════════ */
export type Tier = "Bronze" | "Silver" | "Gold" | "Diamond";
type TierFilter = "All" | Tier;
type TabId = "last" | "history" | "metrics" | "log";

export interface DemoPlayer {
  id: string;
  label: string;
  mmr: number;
  region: string;
  joinedAt: number; // ms timestamp
}

interface DemoMatch {
  id: number;
  teamA: DemoPlayer[];
  teamB: DemoPlayer[];
  teamAmmr: number;
  teamBmmr: number;
  spread: number;
  balance: number; // |avg_A - avg_B|
  quality: number; // 0-100
  formedAt: Date;
  region: string;
}

interface LogEntry {
  ts: string;
  msg: string;
  type: "join" | "match" | "burst" | "warn" | "error";
}

/* ══════════════════════════════════════════════════════════════════════════
   TIER HELPERS
══════════════════════════════════════════════════════════════════════════ */
export function getTier(mmr: number): Tier {
  if (mmr >= 3000) return "Diamond";
  if (mmr >= 2000) return "Gold";
  if (mmr >= 1000) return "Silver";
  return "Bronze";
}

export const TIER_COLOR: Record<Tier, string> = {
  Bronze:  "#cd7f32",
  Silver:  "#94a3b8",
  Gold:    "#ffc857",
  Diamond: "#818cf8",
};

const TIER_BG: Record<Tier, string> = {
  Bronze:  "#cd7f3218",
  Silver:  "#94a3b818",
  Gold:    "#ffc85718",
  Diamond: "#818cf818",
};

const TIER_BADGE: Record<Tier, string> = {
  Bronze: "B", Silver: "S", Gold: "G", Diamond: "D",
};

const MMR_RANGES: Record<Tier, [number, number]> = {
  Bronze:  [100,  999],
  Silver:  [1000, 1999],
  Gold:    [2000, 2999],
  Diamond: [3000, 4200],
};

/* ══════════════════════════════════════════════════════════════════════════
   RELAXATION  (mirrors relaxation.rs)
   window = clamp(75 + wait_s × 12, 75, 600)
══════════════════════════════════════════════════════════════════════════ */
const INIT_WIN  = 75;
const RELAX_PS  = 12;
const MAX_WIN   = 600;
const MAX_WAIT_S = (MAX_WIN - INIT_WIN) / RELAX_PS; // ≈43.75 s

export function mmrWindow(waitSec: number): number {
  return Math.round(Math.min(MAX_WIN, Math.max(INIT_WIN, INIT_WIN + waitSec * RELAX_PS)));
}

/** Green → amber → red as the window opens */
export function waitBarColor(waitSec: number): string {
  if (waitSec < 5)  return "#3dffa8";
  if (waitSec < 20) return "#ffc857";
  return "#ff6b6b";
}

/* ══════════════════════════════════════════════════════════════════════════
   MATCH QUALITY  (0–100 %)
   Derived from observed data: quality ≈ 100 - spread×0.052 - balance×0.1
══════════════════════════════════════════════════════════════════════════ */
function matchQuality(spread: number, balance: number): number {
  return Math.round(Math.max(0, Math.min(100, 100 - spread * 0.052 - balance * 0.1)));
}

export function qualityColor(q: number): string {
  if (q >= 90) return "#3dffa8";
  if (q >= 75) return "#ffc857";
  return "#ff6b6b";
}

/* ══════════════════════════════════════════════════════════════════════════
   COMBINATORICS HELPER
══════════════════════════════════════════════════════════════════════════ */
function comb(n: number, k: number): number {
  if (k > n) return 0;
  if (k === 0 || k === n) return 1;
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return Math.round(result);
}

/* ══════════════════════════════════════════════════════════════════════════
   OPTIMAL C(10,5) TEAM SPLIT  (mirrors balance.rs)
   252 combinations — exhaustive & provably optimal
══════════════════════════════════════════════════════════════════════════ */
function nextCombination(combo: number[], n: number): boolean {
  const k = combo.length;
  let i = k - 1;
  while (i >= 0 && combo[i] === n - k + i) i--;
  if (i < 0) return false;
  combo[i]++;
  for (let j = i + 1; j < k; j++) combo[j] = combo[j - 1] + 1;
  return true;
}

function optimalTeamSplit(players: DemoPlayer[]): [DemoPlayer[], DemoPlayer[]] {
  const n = players.length;  // must be 10
  const k = n / 2;           // 5
  const combo = Array.from({ length: k }, (_, i) => i);
  let bestDiff = Infinity;
  let bestA: DemoPlayer[] = [];
  let bestB: DemoPlayer[] = [];

  do {
    const setA = new Set(combo);
    const teamA = players.filter((_, i) => setA.has(i));
    const teamB = players.filter((_, i) => !setA.has(i));
    const diff = Math.abs(
      teamA.reduce((s, p) => s + p.mmr, 0) - teamB.reduce((s, p) => s + p.mmr, 0),
    );
    if (diff < bestDiff) { bestDiff = diff; bestA = teamA; bestB = teamB; }
  } while (nextCombination(combo, n));

  return [bestA, bestB];
}

/* ══════════════════════════════════════════════════════════════════════════
   PLAYER FACTORY
══════════════════════════════════════════════════════════════════════════ */
let _pid = 1;

function makePlayer(tierHint: TierFilter, region: string): DemoPlayer {
  const t: Tier =
    tierHint === "All"
      ? (["Bronze", "Silver", "Gold", "Diamond"] as Tier[])[Math.floor(Math.random() * 4)]
      : tierHint;
  const [lo, hi] = MMR_RANGES[t];
  const mmr = Math.round(lo + Math.random() * (hi - lo));
  return { id: crypto.randomUUID(), label: `P${_pid++}`, mmr, region, joinedAt: Date.now() };
}

function fmtTs(): string {
  return new Date().toLocaleTimeString("en", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/* ══════════════════════════════════════════════════════════════════════════
   SUB-COMPONENTS
══════════════════════════════════════════════════════════════════════════ */
const REGIONS = ["na-east", "eu-west", "ap-southeast"];

function PlayerChip({
  player, now, small = false,
}: {
  player: DemoPlayer; now: number; small?: boolean;
}) {
  const t = getTier(player.mmr);
  const waitSec = (now - player.joinedAt) / 1000;
  const barColor = waitBarColor(waitSec);
  const barPct = Math.min(100, (waitSec / MAX_WAIT_S) * 100);

  return (
    <div
      className={`demo-chip ${small ? "demo-chip--small" : ""}`}
      style={{ borderColor: TIER_COLOR[t], background: TIER_BG[t] }}
      title={`${player.mmr} MMR · wait ${waitSec.toFixed(1)}s · window ±${mmrWindow(waitSec)}`}
    >
      <span className="demo-chip-badge" style={{ background: TIER_COLOR[t] }}>
        {TIER_BADGE[t]}
      </span>
      <span className="demo-chip-label">{player.label}</span>
      {small && <span className="demo-chip-mmr">{player.mmr}</span>}
      <div className="demo-chip-bar-track">
        <div
          className="demo-chip-bar"
          style={{ width: `${barPct}%`, background: barColor, boxShadow: `0 0 5px ${barColor}88` }}
        />
      </div>
    </div>
  );
}

function TeamPanel({ team, label, avgMmr, now }: {
  team: DemoPlayer[]; label: string; avgMmr: number; now: number;
}) {
  return (
    <div className="demo-team">
      <h4 className="demo-team-title">
        {label}
        <span className="demo-team-avg">avg {Math.round(avgMmr)}</span>
      </h4>
      <div className="demo-team-chips">
        {team.map((p) => <PlayerChip key={p.id} player={p} now={now} small />)}
      </div>
    </div>
  );
}

function QualityRing({ quality }: { quality: number }) {
  const c = qualityColor(quality);
  const r = 28;
  const circ = 2 * Math.PI * r;
  const dash = (quality / 100) * circ;
  return (
    <div className="demo-quality-ring" title={`Match quality: ${quality}%`}>
      <svg width="80" height="80" viewBox="0 0 80 80">
        <circle cx="40" cy="40" r={r} fill="none" stroke="var(--border)" strokeWidth="5" />
        <circle
          cx="40" cy="40" r={r} fill="none"
          stroke={c} strokeWidth="5"
          strokeDasharray={`${dash} ${circ - dash}`}
          strokeLinecap="round"
          transform="rotate(-90 40 40)"
          style={{ filter: `drop-shadow(0 0 6px ${c})`, transition: "stroke-dasharray 0.6s ease" }}
        />
        <text x="40" y="44" textAnchor="middle" fill={c} fontSize="14" fontWeight="700" fontFamily="inherit">
          {quality}%
        </text>
      </svg>
      <span className="demo-quality-ring-label">Quality</span>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   MAIN DEMO COMPONENT
══════════════════════════════════════════════════════════════════════════ */
export function Demo() {
  const [pool,         setPool]         = useState<DemoPlayer[]>([]);
  const [matches,      setMatches]      = useState<DemoMatch[]>([]);
  const [log,          setLog]          = useState<LogEntry[]>([]);
  const [tab,          setTab]          = useState<TabId>("last");
  const [tierFilter,   setTierFilter]   = useState<TierFilter>("All");
  const [region,       setRegion]       = useState(REGIONS[0]);
  const [now,          setNow]          = useState(Date.now());
  const [matchCounter, setMatchCounter] = useState(0);
  const [autoSim,      setAutoSim]      = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  /* refs so the auto-sim interval always sees fresh values */
  const poolRef         = useRef<DemoPlayer[]>([]);
  const matchCounterRef = useRef(0);
  const regionRef       = useRef(REGIONS[0]);
  const tierFilterRef   = useRef<TierFilter>("All");

  useEffect(() => { poolRef.current = pool; }, [pool]);
  useEffect(() => { matchCounterRef.current = matchCounter; }, [matchCounter]);
  useEffect(() => { regionRef.current = region; }, [region]);
  useEffect(() => { tierFilterRef.current = tierFilter; }, [tierFilter]);

  /* tick every 500 ms → wait bars animate smoothly */
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  /* ── auto-simulation ── */
  useEffect(() => {
    if (!autoSim) return;

    // Every 800 ms: add 1-2 players, and form a match when pool ≥ 10
    const id = setInterval(() => {
      const reg = regionRef.current;
      const tf  = tierFilterRef.current;

      // add 1 or 2 players
      const count = Math.random() < 0.4 ? 2 : 1;
      const newPlayers = Array.from({ length: count }, () => makePlayer(tf, reg));
      setPool((prev) => {
        const updated = [...prev, ...newPlayers];
        poolRef.current = updated;
        return updated;
      });
      setLog((prev) => [
        ...newPlayers.map((p) => ({
          ts: fmtTs(),
          msg: `[auto] ${p.label} (${getTier(p.mmr)}, ${p.mmr} MMR) joined ${reg}`,
          type: "join" as const,
        })),
        ...prev,
      ].slice(0, 200));

      // attempt match formation after state update
      setTimeout(() => {
        const candidates = poolRef.current.filter((p) => p.region === regionRef.current);
        if (candidates.length < 10) return;

        const sorted = [...candidates].sort((a, b) => a.mmr - b.mmr);
        let bestSpread = Infinity;
        let bestStart = 0;
        for (let i = 0; i <= sorted.length - 10; i++) {
          const spread = sorted[i + 9].mmr - sorted[i].mmr;
          if (spread < bestSpread) { bestSpread = spread; bestStart = i; }
        }
        const roster = sorted.slice(bestStart, bestStart + 10);
        const [teamA, teamB] = optimalTeamSplit(roster);
        const teamAmmr = teamA.reduce((s, p) => s + p.mmr, 0) / 5;
        const teamBmmr = teamB.reduce((s, p) => s + p.mmr, 0) / 5;
        const balance  = Math.abs(teamAmmr - teamBmmr);
        const quality  = matchQuality(bestSpread, balance);

        const mc = matchCounterRef.current + 1;
        matchCounterRef.current = mc;
        setMatchCounter(mc);

        const m: DemoMatch = {
          id: mc, teamA, teamB, teamAmmr, teamBmmr,
          spread: bestSpread, balance, quality, formedAt: new Date(), region: regionRef.current,
        };
        setMatches((prev) => [m, ...prev]);

        const matched = new Set([...teamA, ...teamB].map((p) => p.id));
        setPool((prev) => {
          const next = prev.filter((p) => !matched.has(p.id));
          poolRef.current = next;
          return next;
        });
        setLog((prev) => [{
          ts: fmtTs(),
          msg: `[auto] Match #${mc} formed — A:${Math.round(teamAmmr)} vs B:${Math.round(teamBmmr)} · Δ${Math.round(balance)} · spread ${bestSpread} · quality ${quality}%`,
          type: "match" as const,
        }, ...prev].slice(0, 200));
        setTab("last");
      }, 50);
    }, 900);

    return () => clearInterval(id);
  }, [autoSim]);

  /* ── event log ── */
  const addLog = useCallback((msg: string, type: LogEntry["type"]) => {
    setLog((prev) => [{ ts: fmtTs(), msg, type }, ...prev].slice(0, 200));
  }, []);

  /* ── player management ── */
  const addPlayer = useCallback(() => {
    const p = makePlayer(tierFilter, region);
    setPool((prev) => [...prev, p]);
    addLog(`${p.label} (${getTier(p.mmr)}, ${p.mmr} MMR) joined ${region}`, "join");
  }, [tierFilter, region, addLog]);

  const burstAdd = useCallback(() => {
    const players = Array.from({ length: 10 }, () => makePlayer(tierFilter, region));
    setPool((prev) => [...prev, ...players]);
    addLog(`Burst: +10 players injected into ${region}`, "burst");
  }, [tierFilter, region, addLog]);

  /* ── match formation: tightest MMR window → C(10,5) optimal split ── */
  const findMatch = useCallback(() => {
    const candidates = pool.filter((p) => p.region === region);
    if (candidates.length < 10) {
      addLog(
        `Need ≥10 players in ${region} — have ${candidates.length}. Add more.`,
        "error",
      );
      return;
    }

    // Greedy roster: sort by MMR, find the tightest 10-player sliding window
    const sorted = [...candidates].sort((a, b) => a.mmr - b.mmr);
    let bestSpread = Infinity;
    let bestStart = 0;
    for (let i = 0; i <= sorted.length - 10; i++) {
      const spread = sorted[i + 9].mmr - sorted[i].mmr;
      if (spread < bestSpread) { bestSpread = spread; bestStart = i; }
    }

    const roster = sorted.slice(bestStart, bestStart + 10);

    // Exhaustive C(10,5) = 252 team splits → pick minimum |avgA - avgB|
    const [teamA, teamB] = optimalTeamSplit(roster);

    const teamAmmr = teamA.reduce((s, p) => s + p.mmr, 0) / 5;
    const teamBmmr = teamB.reduce((s, p) => s + p.mmr, 0) / 5;
    const spread   = bestSpread;
    const balance  = Math.abs(teamAmmr - teamBmmr);
    const quality  = matchQuality(spread, balance);

    const mc = matchCounter + 1;
    setMatchCounter(mc);

    const m: DemoMatch = {
      id: mc, teamA, teamB, teamAmmr, teamBmmr,
      spread, balance, quality, formedAt: new Date(), region,
    };
    setMatches((prev) => [m, ...prev]);

    const matched = new Set([...teamA, ...teamB].map((p) => p.id));
    setPool((prev) => prev.filter((p) => !matched.has(p.id)));

    addLog(
      `Match #${mc} formed — A:${Math.round(teamAmmr)} vs B:${Math.round(teamBmmr)} · Δ${Math.round(balance)} · spread ${spread} · quality ${quality}%`,
      "match",
    );
    setTab("last");
  }, [pool, region, matchCounter, addLog]);

  /* ── derived ── */
  const regionPool   = pool.filter((p) => p.region === region);
  const displayPool  = tierFilter === "All"
    ? regionPool
    : regionPool.filter((p) => getTier(p.mmr) === tierFilter);
  const relaxedCount = regionPool.filter((p) => (now - p.joinedAt) / 1000 > 15).length;
  const lastMatch    = matches[0] ?? null;

  const avgQuality = matches.length
    ? Math.round(matches.reduce((s, m) => s + m.quality, 0) / matches.length)
    : 0;
  const avgSpread = matches.length
    ? Math.round(matches.reduce((s, m) => s + m.spread,  0) / matches.length)
    : 0;
  const avgBalance = matches.length
    ? Math.round(matches.reduce((s, m) => s + m.balance, 0) / matches.length)
    : 0;

  /* ── render ── */
  return (
    <section className="card span-2 demo-section" aria-label="Interactive matchmaking demo">
      <div className="demo-header">
        <div>
          <h2 style={{ margin: 0 }}>Interactive Demo</h2>
          <p className="muted demo-subtitle">
            Runs the real C(10,5) balance algorithm in your browser · time-based MMR relaxation live
          </p>
        </div>
        <div className="demo-legend">
          {(["Bronze","Silver","Gold","Diamond"] as Tier[]).map((t) => (
            <span key={t} className="demo-legend-item">
              <span className="demo-legend-dot" style={{ background: TIER_COLOR[t] }} />
              {t}
            </span>
          ))}
          <span className="demo-legend-item demo-legend-wait">
            <span className="demo-legend-bar" style={{ background: "linear-gradient(90deg,#3dffa8,#ffc857,#ff6b6b)" }} />
            wait time
          </span>
        </div>
      </div>

      {/* ── controls bar ── */}
      <div className="demo-controls">
        <div className="demo-controls-left">
          <label className="demo-select-wrap">
            <span className="demo-select-label">Region</span>
            <select className="demo-select" value={region} onChange={(e) => setRegion(e.target.value)}>
              {REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <label className="demo-select-wrap">
            <span className="demo-select-label">Add tier</span>
            <select
              className="demo-select"
              value={tierFilter}
              onChange={(e) => setTierFilter(e.target.value as TierFilter)}
            >
              {(["All","Bronze","Silver","Gold","Diamond"] as TierFilter[]).map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="demo-controls-right">
          <button
            className={`demo-btn ${autoSim ? "demo-btn--auto-on" : "demo-btn--ghost"}`}
            onClick={() => setAutoSim((v) => !v)}
            title={autoSim ? "Stop auto-simulation" : "Start auto-simulation (adds players & forms matches automatically)"}
          >
            {autoSim ? "⏹ Stop auto" : "⚡ Auto-simulate"}
          </button>
          <button className="demo-btn demo-btn--ghost" onClick={addPlayer} disabled={autoSim}>+ Add player</button>
          <button className="demo-btn demo-btn--ghost" onClick={burstAdd} disabled={autoSim}>Burst +10</button>
          <button
            className="demo-btn demo-btn--primary"
            onClick={findMatch}
            disabled={regionPool.length < 10 || autoSim}
            title={autoSim ? "Disable auto-simulate to control manually" : regionPool.length < 10 ? `Need ${10 - regionPool.length} more players` : ""}
          >
            ▶ Find match
          </button>
        </div>
      </div>

      {/* ── player pool ── */}
      <div className="demo-pool-bar">
        <span className="demo-pool-title">
          Player pool{" "}
          <span className="demo-pool-count">({regionPool.length} waiting in {region})</span>
        </span>
        {displayPool.length !== regionPool.length && (
          <span className="demo-pool-filter-note">
            showing {displayPool.length} of {regionPool.length} (filtered)
          </span>
        )}
      </div>

      <div className="demo-pool">
        {displayPool.length === 0 ? (
          <p className="muted demo-empty">No players yet — click "+ Add player" or "Burst +10".</p>
        ) : (
          displayPool.map((p) => (
            <PlayerChip key={p.id} player={p} now={now} />
          ))
        )}
      </div>

      {relaxedCount > 0 && (
        <div className="demo-relax-notice">
          ⏱{" "}{relaxedCount} player{relaxedCount !== 1 ? "s have" : " has"} waited &gt;15s —
          MMR window widened for faster matching.
        </div>
      )}

      {/* ── tabs ── */}
      <div className="demo-tabs" role="tablist">
        {(
          [
            { id: "last",    label: "Last match" },
            { id: "history", label: "Match history" },
            { id: "metrics", label: "Live metrics" },
            { id: "log",     label: "Event log" },
          ] as { id: TabId; label: string }[]
        ).map(({ id, label }) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={`demo-tab ${tab === id ? "demo-tab--active" : ""}`}
            onClick={() => setTab(id)}
          >
            {label}
            {id === "history" && matches.length > 0 && (
              <span className="demo-tab-pip">{matches.length}</span>
            )}
            {id === "log" && log.length > 0 && (
              <span className="demo-tab-pip demo-tab-pip--log">{log.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* ── tab content ── */}
      <div className="demo-tab-content" role="tabpanel">

        {/* LAST MATCH */}
        {tab === "last" && (
          !lastMatch ? (
            <div className="demo-empty-state">
              <div className="demo-empty-icon">⚔</div>
              <p className="muted">Queue ≥10 players and click "▶ Find match" to form the first game.</p>
            </div>
          ) : (
            <div className="demo-last-match">
              {/* quality + metadata row */}
              <div className="demo-match-meta-row">
                <QualityRing quality={lastMatch.quality} />
                <div className="demo-match-stats-grid">
                  <div className="demo-mstat">
                    <span className="demo-mstat-val">{lastMatch.spread}</span>
                    <span className="demo-mstat-label">MMR spread</span>
                  </div>
                  <div className="demo-mstat">
                    <span className="demo-mstat-val">{Math.round(lastMatch.balance)}</span>
                    <span className="demo-mstat-label">Team Δ</span>
                  </div>
                  <div className="demo-mstat">
                    <span className="demo-mstat-val">{comb(10, 5)}</span>
                    <span className="demo-mstat-label">Splits tested</span>
                  </div>
                  <div className="demo-mstat">
                    <span className="demo-mstat-val">#{lastMatch.id}</span>
                    <span className="demo-mstat-label">Match ID</span>
                  </div>
                </div>

                {/* quality decomposition */}
                <div className="demo-quality-decomp">
                  <div className="demo-qd-label">
                    <span>Spread score</span>
                    <span style={{ color: qualityColor(Math.round(100 - lastMatch.spread * 0.052)) }}>
                      {Math.round(100 - lastMatch.spread * 0.052)}%
                    </span>
                  </div>
                  <div className="demo-qd-bar-track">
                    <div
                      className="demo-qd-bar"
                      style={{
                        width: `${Math.max(0, 100 - lastMatch.spread * 0.052)}%`,
                        background: qualityColor(100 - lastMatch.spread * 0.052),
                      }}
                    />
                  </div>
                  <div className="demo-qd-label" style={{ marginTop: "0.4rem" }}>
                    <span>Balance score</span>
                    <span style={{ color: qualityColor(Math.round(100 - lastMatch.balance * 0.1)) }}>
                      {Math.round(100 - lastMatch.balance * 0.1)}%
                    </span>
                  </div>
                  <div className="demo-qd-bar-track">
                    <div
                      className="demo-qd-bar"
                      style={{
                        width: `${Math.max(0, 100 - lastMatch.balance * 0.1)}%`,
                        background: qualityColor(100 - lastMatch.balance * 0.1),
                      }}
                    />
                  </div>
                </div>
              </div>

              {/* teams */}
              <div className="demo-teams-layout">
                <TeamPanel team={lastMatch.teamA} label="Team A" avgMmr={lastMatch.teamAmmr} now={now} />
                <div className="demo-vs-badge">VS</div>
                <TeamPanel team={lastMatch.teamB} label="Team B" avgMmr={lastMatch.teamBmmr} now={now} />
              </div>
            </div>
          )
        )}

        {/* MATCH HISTORY */}
        {tab === "history" && (
          <div className="demo-history">
            {matches.length === 0 ? (
              <p className="muted demo-empty">No matches yet.</p>
            ) : (
              matches.map((m) => (
                <div key={m.id} className="demo-history-row">
                  <span className="demo-history-id">#{m.id}</span>
                  <span className="demo-history-info">
                    A: {Math.round(m.teamAmmr)} vs B: {Math.round(m.teamBmmr)}
                  </span>
                  <span className="demo-history-delta">Δ{Math.round(m.balance)}</span>
                  <span className="demo-history-spread">spread {m.spread}</span>
                  <div className="demo-history-bar-wrap">
                    <div
                      className="demo-history-bar"
                      style={{ width: `${m.quality}%`, background: qualityColor(m.quality) }}
                    />
                  </div>
                  <span className="demo-history-quality" style={{ color: qualityColor(m.quality) }}>
                    {m.quality}%
                  </span>
                </div>
              ))
            )}
          </div>
        )}

        {/* LIVE METRICS */}
        {tab === "metrics" && (
          <div className="demo-metrics">
            <div className="demo-metrics-grid">
              {[
                { val: matches.length,       label: "Matches formed",  color: "var(--accent)" },
                { val: `${avgQuality}%`,     label: "Avg quality",     color: qualityColor(avgQuality) },
                { val: avgSpread,            label: "Avg MMR spread",  color: "var(--text)" },
                { val: avgBalance,           label: "Avg team Δ",      color: "var(--text)" },
                { val: regionPool.length,    label: "Queue depth",     color: "var(--text)" },
                { val: relaxedCount,         label: "Relaxing (>15s)", color: relaxedCount > 0 ? "#ffc857" : "var(--text)" },
              ].map(({ val, label, color }) => (
                <div key={label} className="demo-metric-card">
                  <span className="demo-metric-val" style={{ color }}>{val}</span>
                  <span className="demo-metric-label">{label}</span>
                </div>
              ))}
            </div>

            {/* quality sparkline */}
            {matches.length > 0 && (
              <div className="demo-spark-section">
                <div className="demo-spark-title">
                  Match quality trend
                  <span className="demo-spark-note">last {Math.min(20, matches.length)} matches</span>
                </div>
                <div className="demo-sparkline">
                  {[...matches].reverse().slice(-20).map((m, i, arr) => (
                    <div
                      key={m.id}
                      className="demo-spark-bar"
                      style={{
                        height: `${m.quality}%`,
                        background: qualityColor(m.quality),
                        opacity: 0.35 + 0.65 * ((i + 1) / arr.length),
                        boxShadow: `0 0 6px ${qualityColor(m.quality)}66`,
                      }}
                      title={`#${m.id}: ${m.quality}%`}
                    />
                  ))}
                </div>
                <div className="demo-spark-axis">
                  <span>0%</span>
                  <span>← older · newer →</span>
                  <span>100%</span>
                </div>
              </div>
            )}

            {/* MMR distribution */}
            {regionPool.length > 0 && (
              <div className="demo-spark-section">
                <div className="demo-spark-title">Queue MMR distribution — {region}</div>
                <div className="demo-dist">
                  {(["Bronze","Silver","Gold","Diamond"] as Tier[]).map((t) => {
                    const count = regionPool.filter((p) => getTier(p.mmr) === t).length;
                    const pct   = (count / regionPool.length) * 100;
                    return (
                      <div key={t} className="demo-dist-row">
                        <span className="demo-dist-label" style={{ color: TIER_COLOR[t] }}>{t}</span>
                        <div className="demo-dist-track">
                          <div
                            className="demo-dist-fill"
                            style={{ width: `${pct}%`, background: TIER_COLOR[t], boxShadow: `0 0 6px ${TIER_COLOR[t]}55` }}
                          />
                        </div>
                        <span className="demo-dist-count">{count}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* EVENT LOG */}
        {tab === "log" && (
          <div className="demo-log" ref={logRef}>
            {log.length === 0 ? (
              <p className="muted demo-empty">No events yet.</p>
            ) : (
              log.map((e, i) => (
                <div key={i} className={`demo-log-row demo-log-row--${e.type}`}>
                  <span className="demo-log-ts">{e.ts}</span>
                  <span className={`demo-log-dot demo-log-dot--${e.type}`} />
                  <span className="demo-log-msg">{e.msg}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </section>
  );
}
