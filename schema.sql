CREATE TABLE IF NOT EXISTS devices (
  id VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  last_seen_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS messages (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  request_id VARCHAR(200) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  source VARCHAR(100) NULL,
  source_id VARCHAR(200) NULL,
  source_request_type VARCHAR(100) NULL,
  requested_device_id VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NULL,
  device_id VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NULL,
  recipient VARCHAR(16) NOT NULL,
  body TEXT NOT NULL,
  status ENUM('queued', 'dispatched', 'sent', 'failed', 'unknown') NOT NULL DEFAULT 'queued',
  error VARCHAR(1000) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  dispatched_at DATETIME(3) NULL,
  sent_at DATETIME(3) NULL,
  INDEX queue_lookup (status, created_at),
  INDEX device_status (device_id, status),
  INDEX source_lookup (source, source_id, source_request_type),
  FOREIGN KEY (requested_device_id) REFERENCES devices(id),
  FOREIGN KEY (device_id) REFERENCES devices(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
