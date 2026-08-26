-- Fixes an O(n^2) performance bug in qams_merge_bucket() (introduced by the
-- original 20260617120000 migration) that silently broke every write to the
-- `records` bucket on the Supabase mirror for roughly two weeks.
--
-- Root cause analysis: the original implementation rebuilds the bucket's
-- array with `result := result || jsonb_build_array(elem)` inside a
-- PL/pgSQL loop. Each `||` concatenation reallocates and copies the entire
-- (growing) result array, so a loop of N iterations costs O(N^2) total, not
-- O(N). This is invisible on small buckets (editRequests: 6 rows, disputes:
-- 2 rows, coachings: 104 rows all merged in milliseconds) but catastrophic
-- once a bucket grows large: merging a single row into the `records` bucket
-- (~1000 rows) measured at 7.8 SECONDS via EXPLAIN ANALYZE against the live
-- Supabase database on 2026-08-26 -- comfortably past Supabase's request
-- timeout, so every write silently failed (caught by data.ts's
-- Promise.allSettled and only logged server-side) while the equivalent
-- write against Netlify's own Postgres instance kept succeeding, letting
-- the two mirrors drift apart for two weeks with no visible symptom on the
-- live site (Netlify's copy was always the newer, correctly-served one).
--
-- Fix: replace the procedural loop with a set-based rebuild using
-- jsonb_agg() (which uses an amortized-O(1)-per-row growable array
-- internally, the same strategy as array_agg()) over a WITH ORDINALITY +
-- ORDER BY (phase, ord) query that preserves the exact same output order
-- the original two sequential loops produced: existing rows that aren't
-- deleted or replaced, in their original relative order, followed by the
-- upserted rows in their given order. Verified byte-for-byte identical to
-- the original algorithm's output across replace/delete/no-id-row/append
-- cases before this replaced the original in production, and measured at
-- ~72ms for the same single-row merge that took 7.8s before -- roughly a
-- 100x improvement, and it no longer degrades quadratically as the bucket
-- grows.
--
-- Additive migration: only replaces the function body (same name, same
-- signature, same return type), no table changes.
CREATE OR REPLACE FUNCTION qams_merge_bucket(
  p_bucket text,
  p_upserts jsonb,
  p_delete_ids jsonb,
  p_updated_at timestamptz
) RETURNS void AS $$
DECLARE
  cur jsonb;
  result jsonb;
  up_ids text[];
  del_ids text[];
BEGIN
  -- Create the bucket if it doesn't exist yet, then lock it for this statement
  -- so concurrent merges of the same bucket run one at a time.
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

  SELECT jsonb_agg(elem ORDER BY phase, ord) INTO result
  FROM (
    -- Kept existing rows: neither deleted nor being replaced by an upsert.
    -- A row with no `id` field has nothing to key on, so it's always kept
    -- (matches the original's `CONTINUE WHEN eid = ANY(...)` never
    -- triggering for a NULL eid).
    SELECT 0 AS phase, ord, value AS elem
    FROM jsonb_array_elements(cur) WITH ORDINALITY AS t(value, ord)
    WHERE (value ->> 'id') IS NULL
       OR ((value ->> 'id') <> ALL(del_ids) AND (value ->> 'id') <> ALL(up_ids))
    UNION ALL
    -- Appended upserts: skip any also marked for deletion in this same call.
    SELECT 1 AS phase, ord, value AS elem
    FROM jsonb_array_elements(p_upserts) WITH ORDINALITY AS t(value, ord)
    WHERE (value ->> 'id') IS NULL OR (value ->> 'id') <> ALL(del_ids)
  ) t;

  UPDATE qams_data SET data = COALESCE(result, '[]'::jsonb), updated_at = p_updated_at WHERE bucket = p_bucket;
END;
$$ LANGUAGE plpgsql;
