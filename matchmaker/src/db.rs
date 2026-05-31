use chrono::{DateTime, Utc};
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions};
use sqlx::{ConnectOptions, MySqlPool, Row};
use uuid::Uuid;

use crate::models::{MatchResult, PlayerId, PlayerState};

#[derive(Clone)]
pub struct Database {
    pool: MySqlPool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct MatchListItem {
    pub match_id: String,
    pub region: String,
    pub team_a_mmr: f64,
    pub team_b_mmr: f64,
    pub mmr_spread: i32,
    pub formed_at: DateTime<Utc>,
    pub player_count: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct QueueStats {
    pub waiting: i64,
    pub matched_players: i64,
    pub total_matches: i64,
}

#[derive(Debug, Clone)]
pub struct DbQueueRow {
    pub player_id: String,
    pub mmr: i32,
    pub region: String,
    pub status: String,
    pub match_id: Option<String>,
    pub joined_at: DateTime<Utc>,
}

impl DbQueueRow {
    pub fn player_state(&self) -> PlayerState {
        match self.status.as_str() {
            "matched" => PlayerState::Matched,
            "left" => PlayerState::Left,
            _ => PlayerState::Waiting,
        }
    }

    pub fn player_id_uuid(&self) -> Option<PlayerId> {
        Uuid::parse_str(&self.player_id).ok()
    }

    pub fn match_id_uuid(&self) -> Option<PlayerId> {
        self.match_id
            .as_ref()
            .and_then(|s| Uuid::parse_str(s).ok())
    }
}

impl Database {
    /// Prefer `DATABASE_URL`, otherwise `DB_HOST` / `DB_USER` / `DB_PASS` / `DB_NAME` / `DB_PORT`.
    /// Passwords with `@`, `#`, etc. are safe (not parsed as URL).
    pub async fn connect_from_env() -> Result<Self, sqlx::Error> {
        if let Ok(url) = std::env::var("DATABASE_URL") {
            if !url.is_empty() {
                return Self::connect(&url).await;
            }
        }

        let host = std::env::var("DB_HOST").unwrap_or_else(|_| "127.0.0.1".into());
        let user = std::env::var("DB_USER").unwrap_or_else(|_| "root".into());
        let pass = std::env::var("DB_PASS")
            .or_else(|_| std::env::var("DB_PASSWORD"))
            .unwrap_or_else(|_| "root".into());
        let db_name = std::env::var("DB_NAME").unwrap_or_else(|_| "matchmaker".into());
        let port: u16 = std::env::var("DB_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(3306);

        Self::ensure_database(&host, port, &user, &pass, &db_name).await?;

        let mut opts = MySqlConnectOptions::new()
            .host(&host)
            .port(port)
            .username(&user)
            .password(&pass)
            .database(&db_name)
            .ssl_mode(sqlx::mysql::MySqlSslMode::Required);
        opts = opts.disable_statement_logging();

        let pool = MySqlPoolOptions::new()
            .max_connections(20)
            .connect_with(opts)
            .await?;
        Ok(Self { pool })
    }

    async fn ensure_database(
        host: &str,
        port: u16,
        user: &str,
        pass: &str,
        db_name: &str,
    ) -> Result<(), sqlx::Error> {
        let mut opts = MySqlConnectOptions::new()
            .host(host)
            .port(port)
            .username(user)
            .password(pass)
            .ssl_mode(sqlx::mysql::MySqlSslMode::Required);
        opts = opts.disable_statement_logging();

        let pool = MySqlPoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await?;

        let sql = format!(
            "CREATE DATABASE IF NOT EXISTS `{}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
            db_name.replace('`', "``")
        );
        sqlx::query(&sql).execute(&pool).await?;
        pool.close().await;
        Ok(())
    }

    /// On startup, clear queue rows left from a previous process (memory pool is empty).
    pub async fn reset_stale_waiting(&self) -> Result<u64, sqlx::Error> {
        let result = sqlx::query(
            "UPDATE queue_entries SET status = 'left', updated_at = ? WHERE status = 'waiting'",
        )
        .bind(Utc::now())
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected())
    }

    pub async fn connect(database_url: &str) -> Result<Self, sqlx::Error> {
        let pool = MySqlPoolOptions::new()
            .max_connections(20)
            .connect(database_url)
            .await?;
        Ok(Self { pool })
    }

    pub async fn migrate(&self) -> Result<(), sqlx::Error> {
        let statements = [
            include_str!("../db/schema.sql"),
        ];
        for stmt in statements.join("\n").split(';') {
            let sql = stmt.trim();
            if sql.is_empty() {
                continue;
            }
            sqlx::query(sql).execute(&self.pool).await?;
        }
        Ok(())
    }

    pub async fn upsert_waiting(
        &self,
        player_id: PlayerId,
        mmr: i32,
        region: &str,
        joined_at: DateTime<Utc>,
    ) -> Result<(), sqlx::Error> {
        let id = player_id.to_string();
        let now = Utc::now();
        sqlx::query(
            r#"
            INSERT INTO queue_entries (player_id, mmr, region, status, match_id, joined_at, updated_at)
            VALUES (?, ?, ?, 'waiting', NULL, ?, ?)
            ON DUPLICATE KEY UPDATE
                mmr = VALUES(mmr),
                region = VALUES(region),
                status = 'waiting',
                match_id = NULL,
                joined_at = VALUES(joined_at),
                updated_at = VALUES(updated_at)
            "#,
        )
        .bind(&id)
        .bind(mmr)
        .bind(region)
        .bind(joined_at)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn mark_left(&self, player_id: PlayerId) -> Result<bool, sqlx::Error> {
        let id = player_id.to_string();
        let result = sqlx::query(
            r#"
            UPDATE queue_entries
            SET status = 'left', updated_at = ?
            WHERE player_id = ? AND status = 'waiting'
            "#,
        )
        .bind(Utc::now())
        .bind(&id)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    pub async fn persist_match(&self, m: &MatchResult) -> Result<(), sqlx::Error> {
        let match_id = m.match_id.to_string();
        let mut tx = self.pool.begin().await?;

        sqlx::query(
            r#"
            INSERT INTO matches (match_id, region, team_a_mmr, team_b_mmr, mmr_spread, formed_at)
            VALUES (?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&match_id)
        .bind(&m.region)
        .bind(m.team_a_mmr)
        .bind(m.team_b_mmr)
        .bind(m.mmr_spread)
        .bind(m.formed_at)
        .execute(&mut *tx)
        .await?;

        for player_id in m.team_a.iter().chain(m.team_b.iter()) {
            let pid = player_id.to_string();
            let team = if m.team_a.contains(player_id) { "a" } else { "b" };
            let mmr: Option<i32> = sqlx::query_scalar(
                "SELECT mmr FROM queue_entries WHERE player_id = ?",
            )
            .bind(&pid)
            .fetch_optional(&mut *tx)
            .await?;

            sqlx::query(
                r#"
                INSERT INTO match_participants (match_id, player_id, team, mmr)
                VALUES (?, ?, ?, ?)
                "#,
            )
            .bind(&match_id)
            .bind(&pid)
            .bind(team)
            .bind(mmr.unwrap_or(0))
            .execute(&mut *tx)
            .await?;

            sqlx::query(
                r#"
                UPDATE queue_entries
                SET status = 'matched', match_id = ?, updated_at = ?
                WHERE player_id = ?
                "#,
            )
            .bind(&match_id)
            .bind(Utc::now())
            .bind(&pid)
            .execute(&mut *tx)
            .await?;
        }

        tx.commit().await?;
        Ok(())
    }

    pub async fn get_match(&self, match_id: Uuid) -> Result<Option<MatchResult>, sqlx::Error> {
        let mid = match_id.to_string();
        let row = sqlx::query(
            r#"
            SELECT match_id, region, team_a_mmr, team_b_mmr, mmr_spread, formed_at
            FROM matches WHERE match_id = ?
            "#,
        )
        .bind(&mid)
        .fetch_optional(&self.pool)
        .await?;

        let Some(row) = row else {
            return Ok(None);
        };

        let region: String = row.get("region");
        let team_a_mmr: f64 = row.get("team_a_mmr");
        let team_b_mmr: f64 = row.get("team_b_mmr");
        let mmr_spread: i32 = row.get("mmr_spread");
        let formed_at: DateTime<Utc> = row.get("formed_at");

        let participants = sqlx::query(
            "SELECT player_id, team FROM match_participants WHERE match_id = ?",
        )
        .bind(&mid)
        .fetch_all(&self.pool)
        .await?;

        let mut team_a = Vec::new();
        let mut team_b = Vec::new();
        for p in participants {
            let pid_str: String = p.get("player_id");
            let team: String = p.get("team");
            let id = Uuid::parse_str(&pid_str).unwrap_or_else(|_| Uuid::nil());
            if team == "a" {
                team_a.push(id);
            } else {
                team_b.push(id);
            }
        }

        Ok(Some(MatchResult {
            match_id,
            region,
            team_a,
            team_b,
            team_a_mmr,
            team_b_mmr,
            mmr_spread,
            formed_at,
        }))
    }

    pub async fn get_queue_status(
        &self,
        player_id: PlayerId,
    ) -> Result<Option<DbQueueRow>, sqlx::Error> {
        let id = player_id.to_string();
        let row = sqlx::query(
            r#"
            SELECT player_id, mmr, region, status, match_id, joined_at
            FROM queue_entries WHERE player_id = ?
            "#,
        )
        .bind(&id)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(|r| DbQueueRow {
            player_id: r.get("player_id"),
            mmr: r.get("mmr"),
            region: r.get("region"),
            status: r.get("status"),
            match_id: r.get("match_id"),
            joined_at: r.get("joined_at"),
        }))
    }

    pub async fn list_matches(&self, limit: i64) -> Result<Vec<MatchListItem>, sqlx::Error> {
        let limit = limit.clamp(1, 100);
        let rows = sqlx::query(
            r#"
            SELECT
                m.match_id,
                m.region,
                m.team_a_mmr,
                m.team_b_mmr,
                m.mmr_spread,
                m.formed_at,
                COUNT(mp.player_id) AS player_count
            FROM matches m
            LEFT JOIN match_participants mp ON mp.match_id = m.match_id
            GROUP BY m.match_id, m.region, m.team_a_mmr, m.team_b_mmr, m.mmr_spread, m.formed_at
            ORDER BY m.formed_at DESC
            LIMIT ?
            "#,
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        Ok(rows
            .into_iter()
            .map(|r| MatchListItem {
                match_id: r.get("match_id"),
                region: r.get("region"),
                team_a_mmr: r.get("team_a_mmr"),
                team_b_mmr: r.get("team_b_mmr"),
                mmr_spread: r.get("mmr_spread"),
                formed_at: r.get("formed_at"),
                player_count: r.get("player_count"),
            })
            .collect())
    }

    pub async fn queue_stats(&self) -> Result<QueueStats, sqlx::Error> {
        let waiting: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM queue_entries WHERE status = 'waiting'",
        )
        .fetch_one(&self.pool)
        .await?;

        let matched_players: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM queue_entries WHERE status = 'matched'",
        )
        .fetch_one(&self.pool)
        .await?;

        let total_matches: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM matches")
                .fetch_one(&self.pool)
                .await?;

        Ok(QueueStats {
            waiting,
            matched_players,
            total_matches,
        })
    }
}
