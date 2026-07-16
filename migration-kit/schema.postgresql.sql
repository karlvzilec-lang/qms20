-- ═══ QMS v2 — PostgreSQL Schema ══════════════════════════════════════
-- Matches this production instance's actual schema (Netlify DB + Supabase mirror).
-- Compatible with: Supabase, Amazon RDS, Neon, Railway, fly.io, Netlify DB,
-- Azure Database for PostgreSQL, self-hosted Postgres (on-prem or cloud VM).
--
-- This is the primary/reference schema — the app's dual-database backend
-- (netlify/functions/*.ts, db/schema.ts) runs on Postgres today. The other
-- dialect files in this folder (schema.mysql.sql / schema.mssql.sql /
-- schema.sqlite.sql) are equivalent schemas for standing up the on-prem
-- server package (see ../README or Settings → Migration → On-Prem Server
-- Package in the running app) against a different engine.
--
-- Usage: run this once against a fresh/empty database, then import data via
-- either the JSON export (Settings → Migration → Full Data Export) or by
-- pointing the app's DATABASE_URL at this instance and letting it write
-- through normally.

CREATE TABLE IF NOT EXISTS qams_data (
  bucket     TEXT        PRIMARY KEY,
  data       JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Row-Level Security (required when connecting via a Supabase anon key;
-- harmless/no-op on a plain self-hosted Postgres with no RLS policies in use
-- elsewhere). If this database is shared with other applications, scope this
-- policy or switch the app to a service_role key instead of a blanket allow.
ALTER TABLE qams_data ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS allow_all ON qams_data;
CREATE POLICY allow_all ON qams_data
  FOR ALL TO public USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_qams_bucket_ts ON qams_data (updated_at DESC);
GRANT ALL ON TABLE qams_data TO anon, authenticated;

-- Atomic row-level merge function. High-churn buckets (evaluations, NPS
-- entries, etc.) are stored as one JSON array per bucket; this function
-- applies an upsert/delete delta to that array inside a single locked
-- statement so concurrent saves from different users serialize and merge
-- instead of clobbering each other's rows. The app's Netlify Functions
-- backend calls this via `op:'merge'` in POST /api/data; the on-prem
-- server.js package (see On-Prem Server Package in the app) re-implements
-- the same logic in application code for engines with no equivalent
-- server-side procedure language (MySQL, SQL Server, SQLite).
CREATE OR REPLACE FUNCTION qams_merge_bucket(
  p_bucket text, p_upserts jsonb, p_delete_ids jsonb, p_updated_at timestamptz
) RETURNS void AS $$
DECLARE
  cur jsonb; result jsonb := '[]'::jsonb; elem jsonb; eid text;
  up_ids text[]; del_ids text[];
BEGIN
  INSERT INTO qams_data (bucket, data, updated_at) VALUES (p_bucket, '[]'::jsonb, p_updated_at)
    ON CONFLICT (bucket) DO NOTHING;
  SELECT data INTO cur FROM qams_data WHERE bucket = p_bucket FOR UPDATE;
  IF cur IS NULL OR jsonb_typeof(cur) <> 'array' THEN cur := '[]'::jsonb; END IF;
  SELECT COALESCE(array_agg(value ->> 'id'), ARRAY[]::text[]) INTO up_ids FROM jsonb_array_elements(p_upserts);
  SELECT COALESCE(array_agg(value), ARRAY[]::text[]) INTO del_ids FROM jsonb_array_elements_text(p_delete_ids);
  FOR elem IN SELECT value FROM jsonb_array_elements(cur) LOOP
    eid := elem ->> 'id';
    CONTINUE WHEN eid = ANY(del_ids);
    CONTINUE WHEN eid = ANY(up_ids);
    result := result || jsonb_build_array(elem);
  END LOOP;
  FOR elem IN SELECT value FROM jsonb_array_elements(p_upserts) LOOP
    CONTINUE WHEN (elem ->> 'id') = ANY(del_ids);
    result := result || jsonb_build_array(elem);
  END LOOP;
  UPDATE qams_data SET data = result, updated_at = p_updated_at WHERE bucket = p_bucket;
END;
$$ LANGUAGE plpgsql;
