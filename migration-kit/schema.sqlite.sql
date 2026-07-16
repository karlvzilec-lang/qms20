-- ═══ QMS v2 — SQLite Schema ══════════════════════════════════════════
-- Compatible with: local Windows/Linux/macOS files, Cloudflare D1, Turso,
-- LibSQL. This is the zero-config default the on-prem server package uses
-- out of the box (DB_TYPE=sqlite in .env).

CREATE TABLE IF NOT EXISTS qams_data (
  bucket     TEXT NOT NULL PRIMARY KEY,
  data       TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now','utc'))
);

CREATE INDEX IF NOT EXISTS idx_qams_ts
  ON qams_data (updated_at DESC);
