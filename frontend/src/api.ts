const API_BASE = import.meta.env.VITE_API_URL ?? "";

export type PlayerState = "waiting" | "matched" | "left";

export interface JoinResponse {
  player_id: string;
  mmr: number;
  region: string;
  current_mmr_window: number;
}

export interface QueueStatus {
  player_id: string;
  state: PlayerState;
  mmr: number;
  region: string;
  wait_seconds: number;
  current_mmr_window: number;
  match_id: string | null;
}

export interface MatchResult {
  match_id: string;
  region: string;
  team_a: string[];
  team_b: string[];
  team_a_mmr: number;
  team_b_mmr: number;
  mmr_spread: number;
  formed_at: string;
}

export interface MatchListItem {
  match_id: string;
  region: string;
  team_a_mmr: number;
  team_b_mmr: number;
  mmr_spread: number;
  formed_at: string;
  player_count: number;
}

export interface HealthResponse {
  status: string;
  db_connected?: boolean;
  metrics: {
    players_in_queue: number;
    matches_formed: number;
    matches_per_second: number;
    failed_claims: number;
    avg_match_latency_ms: number;
  };
  database: {
    waiting: number;
    matched_players: number;
    total_matches: number;
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

export const api = {
  join(mmr: number, region: string) {
    return request<JoinResponse>("/api/queue/join", {
      method: "POST",
      body: JSON.stringify({ mmr, region }),
    });
  },
  status(playerId: string) {
    return request<QueueStatus>(`/api/queue/${playerId}`);
  },
  leave(playerId: string) {
    return request<void>(`/api/queue/${playerId}`, { method: "DELETE" });
  },
  match(matchId: string) {
    return request<MatchResult>(`/api/matches/${matchId}`);
  },
  listMatches(limit = 15) {
    return request<MatchListItem[]>(`/api/matches?limit=${limit}`);
  },
  health() {
    return request<HealthResponse>("/api/health");
  },
};
