-- Atomic, row-level merge for the JSON-array "buckets" used by the QAMS app.
--
-- High-churn collections (QA evaluations, NPS entries) are stored as a single
-- JSON array document per bucket. Replacing that whole document on every save
-- caused lost updates: two users editing the same bucket at the same time would
-- overwrite each other's rows. This function instead applies a delta — rows to
-- upsert (keyed by `id`) and ids to delete — to the stored array inside a single
-- statement that locks the bucket row, so concurrent saves serialize and merge
-- rather than clobbering one another.
--
-- Additive migration: it only creates a function and leaves the existing
-- qams_data table untouched.
CREATE OR REPLACE FUNCTION qams_merge_bucket(
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

  -- Keep existing rows that are neither deleted nor being replaced (in order).
  FOR elem IN SELECT value FROM jsonb_array_elements(cur)
  LOOP
    eid := elem ->> 'id';
    CONTINUE WHEN eid = ANY(del_ids);
    CONTINUE WHEN eid = ANY(up_ids);
    result := result || jsonb_build_array(elem);
  END LOOP;

  -- Append the upserted rows (skipping any also marked for deletion).
  FOR elem IN SELECT value FROM jsonb_array_elements(p_upserts)
  LOOP
    CONTINUE WHEN (elem ->> 'id') = ANY(del_ids);
    result := result || jsonb_build_array(elem);
  END LOOP;

  UPDATE qams_data SET data = result, updated_at = p_updated_at WHERE bucket = p_bucket;
END;
$$ LANGUAGE plpgsql;
