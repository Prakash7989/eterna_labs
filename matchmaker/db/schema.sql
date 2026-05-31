CREATE TABLE IF NOT EXISTS queue_entries (
    player_id CHAR(36) PRIMARY KEY,
    mmr INT NOT NULL,
    region VARCHAR(64) NOT NULL,
    status ENUM('waiting', 'matched', 'left') NOT NULL DEFAULT 'waiting',
    match_id CHAR(36) NULL,
    joined_at DATETIME(6) NOT NULL,
    updated_at DATETIME(6) NOT NULL,
    INDEX idx_region_status (region, status),
    INDEX idx_status (status)
);

CREATE TABLE IF NOT EXISTS matches (
    match_id CHAR(36) PRIMARY KEY,
    region VARCHAR(64) NOT NULL,
    team_a_mmr DOUBLE NOT NULL,
    team_b_mmr DOUBLE NOT NULL,
    mmr_spread INT NOT NULL,
    formed_at DATETIME(6) NOT NULL,
    INDEX idx_formed_at (formed_at DESC)
);

CREATE TABLE IF NOT EXISTS match_participants (
    match_id CHAR(36) NOT NULL,
    player_id CHAR(36) NOT NULL,
    team ENUM('a', 'b') NOT NULL,
    mmr INT NOT NULL,
    PRIMARY KEY (match_id, player_id),
    CONSTRAINT fk_match FOREIGN KEY (match_id) REFERENCES matches (match_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS engine_config (
    id INT PRIMARY KEY DEFAULT 1,
    team_size INT NOT NULL,
    worker_count INT NOT NULL,
    scan_interval_ms INT NOT NULL,
    initial_mmr_window INT NOT NULL,
    mmr_relax_per_second DOUBLE NOT NULL,
    max_mmr_window INT NOT NULL,
    mmr_bucket_size INT NOT NULL,
    max_candidates_per_anchor INT NOT NULL
);

INSERT IGNORE INTO engine_config 
(id, team_size, worker_count, scan_interval_ms, initial_mmr_window, mmr_relax_per_second, max_mmr_window, mmr_bucket_size, max_candidates_per_anchor)
VALUES 
(1, 5, 4, 5, 75, 12.0, 600, 100, 64);
