-- ═══ QMS v2 — MySQL / MariaDB Schema ════════════════════════════════
-- Compatible with: AWS RDS MySQL, PlanetScale, Azure Database for MySQL,
-- self-hosted MySQL/MariaDB (on-prem or cloud VM), MySQL on Windows Server.
--
-- Note: the atomic row-level merge available on Postgres (qams_merge_bucket)
-- has no equivalent stored-procedure-free implementation here. The on-prem
-- server package (server.js, generated from Settings → Migration in the
-- running app) implements the same merge logic in application code instead —
-- see the `op:'merge'` branch in that file.

CREATE TABLE IF NOT EXISTS qams_data (
  bucket     VARCHAR(255) NOT NULL,
  data       JSON         NOT NULL,
  updated_at DATETIME(3)  NOT NULL
             DEFAULT CURRENT_TIMESTAMP(3)
             ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (bucket)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;
