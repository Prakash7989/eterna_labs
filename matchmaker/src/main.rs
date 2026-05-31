use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::{Method, StatusCode};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use chrono::Utc;
use matchmaker::{
    Database, JoinQueueRequest, MatchmakerConfig, MatchmakerEngine, MatchResult, PlayerId,
    QueueStatus,
};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tower_http::cors::{Any, CorsLayer};
use tracing::{error, info, warn};
use uuid::Uuid;

use matchmaker::db::{MatchListItem, QueueStats};
use matchmaker::models::PlayerState;
use matchmaker::relaxation::mmr_window;

#[derive(Clone)]
struct AppState {
    engine: Arc<MatchmakerEngine>,
    db: Arc<RwLock<Option<Database>>>,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
    db_connected: bool,
    metrics: matchmaker::metrics::MetricsSnapshot,
    database: QueueStats,
}

#[derive(Debug, Serialize)]
struct JoinResponse {
    player_id: PlayerId,
    mmr: i32,
    region: String,
    current_mmr_window: i32,
}

#[derive(Debug, Deserialize)]
struct ListMatchesQuery {
    limit: Option<i64>,
}

fn empty_db_stats() -> QueueStats {
    QueueStats {
        waiting: 0,
        matched_players: 0,
        total_matches: 0,
    }
}

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "matchmaker=info,tower_http=info".into()),
        )
        .init();

    let config = MatchmakerConfig::default();
    let mut engine = MatchmakerEngine::new(config.clone());
    engine.start();
    let engine = Arc::new(engine);

    let db_slot: Arc<RwLock<Option<Database>>> = Arc::new(RwLock::new(None));
    spawn_db_connector(Arc::clone(&db_slot));
    spawn_match_handler(Arc::clone(&engine), Arc::clone(&db_slot));

    let state = AppState {
        engine,
        db: db_slot,
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::DELETE, Method::OPTIONS])
        .allow_headers(Any)
        .max_age(Duration::from_secs(3600));

    let app = Router::new()
        .route("/health", get(health))
        .route("/api/health", get(health))
        .route("/queue/join", post(join_queue))
        .route("/api/queue/join", post(join_queue))
        .route("/queue/{player_id}", get(queue_status))
        .route("/api/queue/{player_id}", get(queue_status))
        .route("/queue/{player_id}", delete(leave_queue))
        .route("/api/queue/{player_id}", delete(leave_queue))
        .route("/matches/{match_id}", get(get_match))
        .route("/api/matches/{match_id}", get(get_match))
        .route("/api/matches", get(list_matches))
        .route("/api/stats", get(db_stats))
        .layer(cors)
        .with_state(state);

    let port = std::env::var("MATCHMAKER_PORT")
        .ok()
        .or_else(|| std::env::var("PORT").ok())
        .and_then(|s| s.parse().ok())
        .unwrap_or(8081);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));

    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            error!(
                port,
                "port already in use — stop the other process or set MATCHMAKER_PORT"
            );
            std::process::exit(1);
        }
        Err(e) => {
            error!(%e, port, "failed to bind");
            std::process::exit(1);
        }
    };

    info!("matchmaker listening on http://{addr} (MySQL connects in background)");
    axum::serve(listener, app).await.expect("serve");
}

fn spawn_db_connector(db_slot: Arc<RwLock<Option<Database>>>) {
    tokio::spawn(async move {
        loop {
            match Database::connect_from_env().await {
                Ok(db) => {
                    if let Err(e) = db.migrate().await {
                        warn!(%e, "migration failed, retrying in 3s");
                        tokio::time::sleep(Duration::from_secs(3)).await;
                        continue;
                    }
                    match db.reset_stale_waiting().await {
                        Ok(n) if n > 0 => info!(cleared = n, "reset stale waiting rows from prior run"),
                        Err(e) => warn!(%e, "stale queue cleanup failed"),
                        _ => {}
                    }
                    info!("connected to MySQL");
                    *db_slot.write().await = Some(db);
                    return;
                }
                Err(e) => {
                    warn!(
                        %e,
                        "MySQL not ready — using in-memory matchmaking only; fix DB_* in .env or start Docker"
                    );
                    tokio::time::sleep(Duration::from_secs(3)).await;
                }
            }
        }
    });
}

/// Sole consumer of formed matches: in-memory store + MySQL when connected.
fn spawn_match_handler(engine: Arc<MatchmakerEngine>, db_slot: Arc<RwLock<Option<Database>>>) {
    tokio::spawn(async move {
        let mut persisted = std::collections::HashSet::new();
        loop {
            for m in engine.poll_matches() {
                engine.matches.insert(m.clone());
                let guard = db_slot.read().await;
                if let Some(db) = guard.as_ref() {
                    if persisted.contains(&m.match_id) {
                        continue;
                    }
                    if let Err(e) = db.persist_match(&m).await {
                        error!(%e, match_id = %m.match_id, "failed to persist match");
                    } else {
                        persisted.insert(m.match_id);
                        if persisted.len() > 50_000 {
                            persisted.clear();
                        }
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    });
}

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    let metrics = state
        .engine
        .metrics
        .snapshot(state.engine.pool.len());

    let guard = state.db.read().await;
    let (db_connected, database) = if let Some(db) = guard.as_ref() {
        match db.queue_stats().await {
            Ok(s) => (true, s),
            Err(e) => {
                error!(%e, "db stats failed");
                (true, empty_db_stats())
            }
        }
    } else {
        (false, empty_db_stats())
    };

    Json(HealthResponse {
        status: if db_connected { "ok" } else { "degraded" },
        db_connected,
        metrics,
        database,
    })
}

async fn db_stats(State(state): State<AppState>) -> Result<Json<QueueStats>, StatusCode> {
    let guard = state.db.read().await;
    let db = guard.as_ref().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    db.queue_stats()
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn list_matches(
    State(state): State<AppState>,
    Query(q): Query<ListMatchesQuery>,
) -> Result<Json<Vec<MatchListItem>>, StatusCode> {
    let limit = q.limit.unwrap_or(20);
    let guard = state.db.read().await;
    let db = guard.as_ref().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    db.list_matches(limit)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn join_queue(
    State(state): State<AppState>,
    Json(body): Json<JoinQueueRequest>,
) -> Result<Json<JoinResponse>, StatusCode> {
    if body.region.trim().is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    if !(0..=10_000).contains(&body.mmr) {
        return Err(StatusCode::BAD_REQUEST);
    }

    let player_id = body.player_id.unwrap_or_else(Uuid::new_v4);
    let player = state
        .engine
        .join_queue(player_id, body.mmr, body.region.clone());

    if let Some(db) = state.db.read().await.as_ref() {
        if let Err(e) = db
            .upsert_waiting(player.id, player.mmr, &player.region, player.joined_at)
            .await
        {
            warn!(%e, "db upsert failed (matchmaking still active in memory)");
        }
    }

    let window = mmr_window(&state.engine.config, 0.0);

    Ok(Json(JoinResponse {
        player_id: player.id,
        mmr: player.mmr,
        region: player.region,
        current_mmr_window: window,
    }))
}

async fn queue_status(
    State(state): State<AppState>,
    Path(player_id): Path<Uuid>,
) -> Result<Json<QueueStatus>, StatusCode> {
    if let Some((player, status, match_id)) = state.engine.pool.get_status(player_id) {
        let wait = player.wait_seconds();
        let window = mmr_window(&state.engine.config, wait);
        return Ok(Json(QueueStatus {
            player_id,
            state: status,
            mmr: player.mmr,
            region: player.region,
            wait_seconds: wait,
            current_mmr_window: window,
            match_id,
        }));
    }

    let guard = state.db.read().await;
    let Some(db) = guard.as_ref() else {
        return Err(StatusCode::NOT_FOUND);
    };

    let Some(row) = db
        .get_queue_status(player_id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    else {
        return Err(StatusCode::NOT_FOUND);
    };

    let wait = Utc::now()
        .signed_duration_since(row.joined_at)
        .num_milliseconds()
        .max(0) as f64
        / 1000.0;
    let window = mmr_window(&state.engine.config, wait);

    let match_id = row.match_id_uuid();
    let region = row.region.clone();
    Ok(Json(QueueStatus {
        player_id,
        state: row.player_state(),
        mmr: row.mmr,
        region,
        wait_seconds: wait,
        current_mmr_window: window,
        match_id,
    }))
}

async fn leave_queue(
    State(state): State<AppState>,
    Path(player_id): Path<Uuid>,
) -> Result<StatusCode, StatusCode> {
    let left_memory = state.engine.leave_queue(player_id);

    if let Some(db) = state.db.read().await.as_ref() {
        let _ = db.mark_left(player_id).await;
    }

    if left_memory {
        return Ok(StatusCode::NO_CONTENT);
    }

    if let Some(db) = state.db.read().await.as_ref() {
        if db
            .get_queue_status(player_id)
            .await
            .ok()
            .flatten()
            .is_some_and(|r| r.player_state() == PlayerState::Waiting)
        {
            let _ = db.mark_left(player_id).await;
            return Ok(StatusCode::NO_CONTENT);
        }
    }

    Err(StatusCode::NOT_FOUND)
}

async fn get_match(
    State(state): State<AppState>,
    Path(match_id): Path<Uuid>,
) -> Result<Json<MatchResult>, StatusCode> {
    if let Some(m) = state.engine.matches.get(match_id) {
        return Ok(Json(m));
    }

    let guard = state.db.read().await;
    let db = guard.as_ref().ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    db.get_match(match_id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)
}
