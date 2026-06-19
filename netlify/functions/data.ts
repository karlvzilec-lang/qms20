import type { Config } from "@netlify/functions";
import { sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { qamsData } from "../../db/schema.js";
import {
  supabaseEnabled,
  readAllFromSupabase,
  upsertToSupabase,
  mergeBucketSupabase,
} from "../../db/supabase.js";

// Shared data API for the QAMS app, backed by TWO independent databases.
//
//   GET  /api/data  -> [{ bucket, data }, ...]  (all buckets)
//   POST /api/data  -> upsert one bucket. Two write shapes:
//       { bucket, data }                       full-document replace
//       { bucket, op:'merge', upserts, deletes } row-level delta merge
//
// The merge shape exists to stop lost updates on high-churn collections
// (QA evaluations, NPS entries). Those are stored as a single JSON array per
// bucket; replacing the whole array on every save let concurrent editors
// overwrite each other. A merge applies only the changed rows (upsert by `id`)
// and explicit deletes, inside an atomic, row-locking SQL function, so
// simultaneous saves combine instead of clobbering one another.
//
// Redundancy model
// ────────────────
// Every write is sent to the Netlify (Postgres) database AND to a standalone
// Supabase database at the same time. The two are completely independent —
// neither knows about the other — so a failure or outage of one never blocks
// the other. A write succeeds as long as at least one database accepts it.
//
// Reads pull from both databases concurrently and merge per bucket, keeping
// the most recently updated copy. If either database is unreachable, the
// response is served from whichever one answered. This makes the two stores
// act as live mirrors / hot backups of each other.

interface MergedRow {
  bucket: string;
  data: unknown;
  updatedAt: number; // epoch ms, used only for merge tie-breaking
}

export default async (req: Request) => {
  try {
    if (req.method === "GET") {
      const [netlifyResult, supabaseResult] = await Promise.allSettled([
        db
          .select({
            bucket: qamsData.bucket,
            data: qamsData.data,
            updatedAt: qamsData.updatedAt,
          })
          .from(qamsData),
        supabaseEnabled() ? readAllFromSupabase() : Promise.resolve([]),
      ]);

      if (netlifyResult.status === "rejected") {
        console.error("netlify read failed", netlifyResult.reason);
      }
      if (supabaseResult.status === "rejected") {
        console.error("supabase read failed", supabaseResult.reason);
      }

      // Both databases down -> surface an error rather than empty success.
      if (
        netlifyResult.status === "rejected" &&
        supabaseResult.status === "rejected"
      ) {
        return Response.json(
          { error: "All databases unavailable" },
          { status: 503, headers: { "Cache-Control": "no-store" } },
        );
      }

      // Merge: newest copy of each bucket wins across the two databases.
      const merged = new Map<string, MergedRow>();
      const absorb = (
        rows: Array<{ bucket: string; data: unknown; updatedAt: Date | null }>,
      ) => {
        for (const row of rows) {
          const ts = row.updatedAt ? row.updatedAt.getTime() : 0;
          const existing = merged.get(row.bucket);
          if (!existing || ts >= existing.updatedAt) {
            merged.set(row.bucket, { bucket: row.bucket, data: row.data, updatedAt: ts });
          }
        }
      };
      if (netlifyResult.status === "fulfilled") absorb(netlifyResult.value);
      if (supabaseResult.status === "fulfilled") absorb(supabaseResult.value);

      const rows = [...merged.values()].map(({ bucket, data }) => ({
        bucket,
        data,
      }));

      return Response.json(rows, {
        headers: {
          "Cache-Control": "no-store",
          // Lightweight visibility into which mirror answered this request.
          "X-Data-Sources": [
            netlifyResult.status === "fulfilled" ? "netlify" : null,
            supabaseResult.status === "fulfilled" && supabaseEnabled()
              ? "supabase"
              : null,
          ]
            .filter(Boolean)
            .join(","),
        },
      });
    }

    if (req.method === "POST") {
      const body = await req.json();
      const bucket = body?.bucket;
      if (!bucket || typeof bucket !== "string") {
        return Response.json({ error: "Missing 'bucket'" }, { status: 400 });
      }

      const data = body.data ?? null;
      // One shared timestamp so both copies sort identically on later reads.
      const updatedAt = new Date();

      // ── Row-level delta merge (high-churn array buckets) ──────────────────
      if (body.op === "merge") {
        const upserts = Array.isArray(body.upserts) ? body.upserts : [];
        const deletes = Array.isArray(body.deletes) ? body.deletes : [];
        // Nothing to do — treat as a successful no-op.
        if (upserts.length === 0 && deletes.length === 0) {
          return Response.json({ ok: true, bucket, persisted: { netlify: true, supabase: null } });
        }

        const upsertsJson = JSON.stringify(upserts);
        const deletesJson = JSON.stringify(deletes);

        const [netlifyMerge, supabaseMerge] = await Promise.allSettled([
          db.execute(
            sql`SELECT qams_merge_bucket(${bucket}, ${upsertsJson}::jsonb, ${deletesJson}::jsonb, ${updatedAt.toISOString()}::timestamptz)`,
          ),
          supabaseEnabled()
            ? mergeBucketSupabase(bucket, upserts, deletes, updatedAt)
            : Promise.resolve(),
        ]);

        const netlifyOk = netlifyMerge.status === "fulfilled";
        const supabaseOk = supabaseMerge.status === "fulfilled";

        if (!netlifyOk) console.error("netlify merge failed", netlifyMerge.reason);
        if (supabaseEnabled() && !supabaseOk) {
          console.error("supabase merge failed", supabaseMerge.reason);
        }

        if (!netlifyOk && !supabaseOk) {
          return Response.json(
            { error: "All databases unavailable", bucket },
            { status: 503 },
          );
        }

        return Response.json({
          ok: true,
          bucket,
          persisted: {
            netlify: netlifyOk,
            supabase: supabaseEnabled() ? supabaseOk : null,
          },
        });
      }

      const [netlifyWrite, supabaseWrite] = await Promise.allSettled([
        db
          .insert(qamsData)
          .values({ bucket, data, updatedAt })
          .onConflictDoUpdate({
            target: qamsData.bucket,
            set: { data, updatedAt },
          }),
        supabaseEnabled()
          ? upsertToSupabase(bucket, data, updatedAt)
          : Promise.resolve(),
      ]);

      const netlifyOk = netlifyWrite.status === "fulfilled";
      const supabaseOk = supabaseWrite.status === "fulfilled";

      if (!netlifyOk) console.error("netlify write failed", netlifyWrite.reason);
      if (supabaseEnabled() && !supabaseOk) {
        console.error("supabase write failed", supabaseWrite.reason);
      }

      // Durable as long as at least one independent database accepted it.
      if (!netlifyOk && !supabaseOk) {
        return Response.json(
          { error: "All databases unavailable", bucket },
          { status: 503 },
        );
      }

      return Response.json({
        ok: true,
        bucket,
        persisted: {
          netlify: netlifyOk,
          supabase: supabaseEnabled() ? supabaseOk : null,
        },
      });
    }

    return new Response("Method not allowed", { status: 405 });
  } catch (e) {
    console.error("data api error", e);
    return Response.json({ error: "Internal error" }, { status: 500 });
  }
};

export const config: Config = {
  path: "/api/data",
};
