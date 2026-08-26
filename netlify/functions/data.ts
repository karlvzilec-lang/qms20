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
import { tokenFromRequest } from "../../db/token.js";
import { computeScoreFromAnswers, type ScoreFormSection, type ScoreFormSettings } from "../../lib/scoreRecord.js";

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
  // Token guard: only enforced when QMS_SESSION_SECRET is configured.
  // Writes require a valid session; reads are left open for health-check / initial load.
  if (req.method !== "GET" && process.env.QMS_SESSION_SECRET) {
    const claims = tokenFromRequest(req);
    if (!claims) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

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

      // This GET is intentionally unauthenticated (health-check / initial load,
      // per the comment above) -- the "users" bucket must never carry password
      // hashes out through it. The client verifies logins against /api/auth
      // (which never exposes the hash either); it does not need the hash
      // locally. See _setUserPassword()/getCurrentUser() in index.html for the
      // pwVersion-based session-staleness check that replaced the old
      // hash-derived one this made impossible.
      const stripPassword = (bucket: string, data: unknown): unknown => {
        if (bucket !== "users" || !Array.isArray(data)) return data;
        return data.map((u) => {
          if (!u || typeof u !== "object" || !("password" in u)) return u;
          const { password: _password, ...rest } = u as Record<string, unknown>;
          return rest;
        });
      };

      const rows = [...merged.values()].map(({ bucket, data }) => ({
        bucket,
        data: stripPassword(bucket, data),
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
          return Response.json({ ok: true, bucket, persisted: { netlify: true, supabase: supabaseEnabled() ? true : null } });
        }

        // Server-side guard, independent of the client's own fix for the same
        // bug: this GET response strips `password` from every users row
        // before it reaches a browser (see stripPassword() below), so any
        // client's local merge of that response can end up with a
        // password-less copy of an existing user, which then arrives here as
        // an upsert. Applying it as-is would permanently erase that user's
        // password server-side — confirmed live 2026-08-14, this exact path
        // wiped all 110 users' passwords and locked out the entire site.
        // Re-attach the currently-stored password whenever an upsert to an
        // EXISTING user omits it, but only when the upsert's own pwVersion
        // still matches what's stored — an upsert asserting a genuinely new
        // password (higher pwVersion) is never overridden.
        if (bucket === "users") {
          try {
            const existingRows = await db
              .select({ data: qamsData.data })
              .from(qamsData)
              .where(sql`${qamsData.bucket} = 'users'`);
            const existing = Array.isArray(existingRows[0]?.data) ? (existingRows[0].data as Array<Record<string, unknown>>) : [];
            const existingById = new Map(existing.filter((u) => u && u.id).map((u) => [u.id, u]));
            for (const u of upserts as Array<Record<string, unknown>>) {
              if (!u || u.password) continue;
              const cur = existingById.get(u.id as string);
              if (cur && cur.password && (cur.pwVersion ?? 0) === (u.pwVersion ?? 0)) {
                u.password = cur.password;
              }
            }
          } catch {
            // Read failed — fall through and merge as-is rather than blocking the write.
          }
        }

        // Server-side guard against a stale client reverting a config
        // bucket to an old snapshot of the SAME row it already holds.
        // _MERGE_BUCKETS' row-level merge (upsert-by-id) protects rows a
        // client doesn't know about from being lost, but it does nothing to
        // stop a client's own outdated copy of a row it DOES know about
        // from overwriting a newer one -- "merge" only means "don't drop
        // other people's rows," not "don't let my old copy of this row
        // win." Confirmed live 2026-08-25: a device whose local `forms`
        // cache still held the form exactly as it was on 2026-08-04 (its
        // own updatedAt field proved this) pushed that snapshot again,
        // silently reverting every section's scoringMode from the
        // corrected 'all-or-nothing' back to 'weighted' -- with no
        // corresponding admin action in changeLog, i.e. nobody edited
        // Settings, a stale client just re-uploaded what it already had.
        // Every real edit path (saveSettings(), the form builder) stamps a
        // fresh updatedAt on the form object itself, so an incoming upsert
        // whose own updatedAt is OLDER than what's already stored for that
        // same id can only be a stale replay, never a legitimate edit --
        // keep the newer, currently-stored version instead.
        if (bucket === "forms") {
          try {
            const existingRows = await db
              .select({ data: qamsData.data })
              .from(qamsData)
              .where(sql`${qamsData.bucket} = 'forms'`);
            const existing = Array.isArray(existingRows[0]?.data) ? (existingRows[0].data as Array<Record<string, unknown>>) : [];
            const existingById = new Map(existing.filter((f) => f && f.id).map((f) => [f.id, f]));
            for (let i = (upserts as Array<Record<string, unknown>>).length - 1; i >= 0; i--) {
              const incoming = (upserts as Array<Record<string, unknown>>)[i];
              if (!incoming) continue;
              const cur = existingById.get(incoming.id as string);
              const incomingTs = typeof incoming.updatedAt === "string" ? Date.parse(incoming.updatedAt) : NaN;
              const curTs = cur && typeof cur.updatedAt === "string" ? Date.parse(cur.updatedAt) : NaN;
              if (!Number.isNaN(incomingTs) && !Number.isNaN(curTs) && incomingTs < curTs) {
                (upserts as Array<Record<string, unknown>>).splice(i, 1); // drop the stale replay — keep what's already stored
              }
            }
          } catch {
            // Read failed — fall through and merge as-is rather than blocking the write.
          }
        }

        // Authoritative server-side re-score, independent of whatever the
        // submitting browser computed. computeScoreFromAnswers() on the
        // client is scored against that device's own locally-cached `forms`
        // bucket, and this exact bug (a section scored under a stale
        // 'weighted' cache instead of the form's real 'all-or-nothing'
        // configuration) has already recurred twice despite two client-side
        // fixes -- once for a MISSING scoringMode field defaulting wrong,
        // once for a client not re-fetching before scoring. Both fixes only
        // help a browser that is actually running the patched code and
        // whose fetch to re-verify actually succeeds; neither is guaranteed
        // for a device with a long-broken background sync, which is exactly
        // the device that kept reproducing this. Recomputing here, from the
        // raw answers against the form definition this database actually
        // holds right now, is correct regardless of any client's state.
        // Skipped when `answers` is empty (CSV/JSON imports intentionally
        // carry no raw answers to recompute from -- their finalScore/result
        // are the only source of truth for those rows) so imports are never
        // silently zeroed out.
        if (bucket === "records") {
          try {
            const [formsRows, settingsRows] = await Promise.all([
              db.select({ data: qamsData.data }).from(qamsData).where(sql`${qamsData.bucket} = 'forms'`),
              db.select({ data: qamsData.data }).from(qamsData).where(sql`${qamsData.bucket} = 'settings'`),
            ]);
            const forms = Array.isArray(formsRows[0]?.data) ? (formsRows[0].data as Array<Record<string, unknown>>) : [];
            const settings = (settingsRows[0]?.data as ScoreFormSettings) || {};
            for (const rec of upserts as Array<Record<string, unknown>>) {
              const answers = rec?.answers as Record<string, string> | undefined;
              if (!rec || !answers || Object.keys(answers).length === 0) continue;
              const formObj = forms.find((f) => f.id === rec.formId) || forms.find((f) => f.status === "published");
              if (!formObj) continue;
              const sections = formObj.sections as ScoreFormSection[] | undefined;
              const formSettings = formObj.settings as ScoreFormSettings | undefined;
              const scored = computeScoreFromAnswers(sections, answers, settings, formSettings);
              rec.finalScore = scored.finalScore;
              rec.autoFail = scored.autoFailTriggered;
              rec.sectionScores = scored.sectionScores;
              rec.failedItems = scored.failedItems;
              const passScore = (formSettings?.passScore as number | undefined) ?? (settings.passScore as number | undefined) ?? 80;
              rec.result = scored.autoFailTriggered ? "AUTO FAIL" : scored.finalScore >= passScore ? "PASS" : "FAIL";
            }
          } catch {
            // Read failed — fall through and persist the client's own score
            // rather than blocking the write; better than an outage, and no
            // worse than this check not existing at all.
          }
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
