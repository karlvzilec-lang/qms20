import pg from "pg";

// ─────────────────────────────────────────────────────────────────────────
// Supabase: the standalone redundant copy of the QAMS data store.
//
// This is intentionally NOT a Netlify primitive. The Netlify Postgres
// database (see ./index.ts) remains the authoritative store; Supabase is a
// completely independent mirror that holds the exact same `qams_data` rows.
// The two never talk to each other — every write is sent to both, and reads
// fall back to whichever copy is reachable. If either database is offline,
// the application keeps working from the other one.
//
// Configure it by setting a single environment variable to a Supabase
// Postgres connection string (the "Connection pooling" / Transaction string
// from the Supabase dashboard works well in serverless):
//
//   SUPABASE_DATABASE_URL=postgresql://...supabase.co:6543/postgres?sslmode=require
//
// When the variable is absent, the Supabase side is silently skipped and the
// app runs on Netlify Database alone.
// ─────────────────────────────────────────────────────────────────────────

const { Pool } = pg;

const connectionString = process.env.SUPABASE_DATABASE_URL;

let pool: pg.Pool | null = null;
let schemaReady: Promise<void> | null = null;

export function supabaseEnabled(): boolean {
  return Boolean(connectionString);
}

function getPool(): pg.Pool {
  if (!pool) {
    // Strip ?sslmode=... from the connection string so the pg driver uses
    // only the ssl option below (avoids "self-signed certificate" errors from
    // Supabase's Supavisor pooler which pg cannot verify with its default store).
    const connStr = (connectionString ?? "").replace(/([?&])sslmode=[^&]*/g, "$1").replace(/[?&]$/, "");
    pool = new Pool({
      connectionString: connStr,
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 8_000,
    });
  }
  return pool;
}

// Mirror of the Netlify `qams_data` table. Because Supabase is a standalone
// service outside Netlify's migration pipeline, its schema is created on
// demand (idempotently) the first time it is used.
// Same atomic row-level merge function the Netlify side gets via migration
// (see netlify/database/migrations/.../add_qams_merge_function). Created here
// idempotently because Supabase is outside Netlify's migration pipeline.
const MERGE_FN_SQL = `CREATE OR REPLACE FUNCTION qams_merge_bucket(
  p_bucket text,
  p_upserts jsonb,
  p_delete_ids jsonb,
  p_updated_at timestamptz
) RETURNS void AS $$
DECLARE
  cur jsonb;
  result jsonb := '[]'::jsonb;
  elem jsonb;
  eid text;
  up_ids text[];
  del_ids text[];
BEGIN
  INSERT INTO qams_data (bucket, data, updated_at)
    VALUES (p_bucket, '[]'::jsonb, p_updated_at)
    ON CONFLICT (bucket) DO NOTHING;

  SELECT data INTO cur FROM qams_data WHERE bucket = p_bucket FOR UPDATE;
  IF cur IS NULL OR jsonb_typeof(cur) <> 'array' THEN
    cur := '[]'::jsonb;
  END IF;

  SELECT COALESCE(array_agg(value ->> 'id'), ARRAY[]::text[]) INTO up_ids
    FROM jsonb_array_elements(p_upserts);

  SELECT COALESCE(array_agg(value), ARRAY[]::text[]) INTO del_ids
    FROM jsonb_array_elements_text(p_delete_ids);

  FOR elem IN SELECT value FROM jsonb_array_elements(cur)
  LOOP
    eid := elem ->> 'id';
    CONTINUE WHEN eid = ANY(del_ids);
    CONTINUE WHEN eid = ANY(up_ids);
    result := result || jsonb_build_array(elem);
  END LOOP;

  FOR elem IN SELECT value FROM jsonb_array_elements(p_upserts)
  LOOP
    CONTINUE WHEN (elem ->> 'id') = ANY(del_ids);
    result := result || jsonb_build_array(elem);
  END LOOP;

  UPDATE qams_data SET data = result, updated_at = p_updated_at WHERE bucket = p_bucket;
END;
$$ LANGUAGE plpgsql;`;

function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = getPool()
      .query(
        `CREATE TABLE IF NOT EXISTS qams_data (
           bucket text PRIMARY KEY,
           data jsonb,
           updated_at timestamptz DEFAULT now()
         )`,
      )
      .then(() => getPool().query(MERGE_FN_SQL))
      .then(() => undefined)
      .catch((e) => {
        // Allow a later request to retry instead of caching the failure.
        schemaReady = null;
        throw e;
      });
  }
  return schemaReady;
}

export interface SupabaseRow {
  bucket: string;
  data: unknown;
  updatedAt: Date | null;
}

export async function readAllFromSupabase(): Promise<SupabaseRow[]> {
  await ensureSchema();
  const res = await getPool().query(
    "SELECT bucket, data, updated_at FROM qams_data",
  );
  return res.rows.map((r) => ({
    bucket: r.bucket,
    data: r.data,
    updatedAt: r.updated_at ? new Date(r.updated_at) : null,
  }));
}

export async function upsertToSupabase(
  bucket: string,
  data: unknown,
  updatedAt: Date,
): Promise<void> {
  await ensureSchema();
  // node-postgres serializes objects/arrays to JSON for jsonb params, and
  // maps `null`/`undefined` to SQL NULL — matching the Netlify side exactly.
  await getPool().query(
    `INSERT INTO qams_data (bucket, data, updated_at)
       VALUES ($1, $2, $3)
     ON CONFLICT (bucket)
       DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
    [bucket, data ?? null, updatedAt],
  );
}

// Apply a row-level delta to a bucket's JSON array, atomically and in step with
// the Netlify mirror. Used for high-churn buckets so concurrent edits merge
// instead of overwriting each other.
export async function mergeBucketSupabase(
  bucket: string,
  upserts: unknown[],
  deletes: unknown[],
  updatedAt: Date,
): Promise<void> {
  await ensureSchema();
  await getPool().query(
    "SELECT qams_merge_bucket($1, $2::jsonb, $3::jsonb, $4)",
    [
      bucket,
      JSON.stringify(upserts ?? []),
      JSON.stringify(deletes ?? []),
      updatedAt,
    ],
  );
}
