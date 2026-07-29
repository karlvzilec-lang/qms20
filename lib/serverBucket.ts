// Small shared helpers for Netlify Functions that need to read/write a single
// qams_data bucket directly (outside the normal client-driven /api/data flow).
// Mirrors the patterns already proven in netlify/functions/{data,reconcile}.ts --
// kept here so auto-qa-daily.ts and yellow-transcript.ts don't each reinvent them.

import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { qamsData } from "../db/schema.js";
import { supabaseEnabled, readAllFromSupabase, mergeBucketSupabase } from "../db/supabase.js";

// Reads one bucket, preferring whichever of Netlify/Supabase has the newer
// updatedAt -- same "newest wins" merge policy /api/data's GET uses, so a
// server-side read never disagrees with what the client would see right now.
export async function readBucket<T = unknown>(bucket: string): Promise<T | null> {
  const [netlifyResult, supabaseResult] = await Promise.allSettled([
    db
      .select({ data: qamsData.data, updatedAt: qamsData.updatedAt })
      .from(qamsData)
      .where(eq(qamsData.bucket, bucket)),
    supabaseEnabled() ? readAllFromSupabase() : Promise.resolve([]),
  ]);

  const n = netlifyResult.status === "fulfilled" && netlifyResult.value[0]
    ? { data: netlifyResult.value[0].data, updatedAt: netlifyResult.value[0].updatedAt?.getTime() ?? 0 }
    : null;
  const sRow = supabaseResult.status === "fulfilled"
    ? supabaseResult.value.find((r) => r.bucket === bucket)
    : undefined;
  const s = sRow ? { data: sRow.data, updatedAt: sRow.updatedAt?.getTime() ?? 0 } : null;

  if (!n && !s) return null;
  if (!n) return s!.data as T;
  if (!s) return n.data as T;
  return (n.updatedAt >= s.updatedAt ? n.data : s.data) as T;
}

// Row-level upsert into a JSON-array bucket via the same atomic merge RPC
// /api/data's `op:'merge'` path uses -- upserts by `id`, never clobbers
// concurrent writers (a human uploading a fresh Excel batch while this runs).
export async function mergeBucketRows(bucket: string, upserts: unknown[], deletes: unknown[] = []): Promise<void> {
  if (!upserts.length && !deletes.length) return;
  const updatedAt = new Date();
  const upsertsJson = JSON.stringify(upserts);
  const deletesJson = JSON.stringify(deletes);
  await Promise.allSettled([
    db.execute(
      sql`SELECT qams_merge_bucket(${bucket}, ${upsertsJson}::jsonb, ${deletesJson}::jsonb, ${updatedAt.toISOString()}::timestamptz)`,
    ),
    supabaseEnabled() ? mergeBucketSupabase(bucket, upserts, deletes, updatedAt) : Promise.resolve(),
  ]);
}
