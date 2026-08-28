import type { Config } from "@netlify/functions";
import { sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { qamsData } from "../../db/schema.js";
import {
  supabaseEnabled,
  readAllFromSupabase,
  upsertToSupabase,
} from "../../db/supabase.js";
import { tokenFromRequest } from "../../db/token.js";

// ─────────────────────────────────────────────────────────────────────────────
// /api/reconcile
//
// Compares the Netlify Database and Supabase row-by-row and reports any drift.
// Supabase cannot directly connect to Netlify DB (they are separate managed
// Postgres instances with no cross-connectivity). This function acts as the
// check-and-balance broker: it has credentials for both and compares them
// at the application layer.
//
// GET  /api/reconcile           → health report (no writes)
// POST /api/reconcile           → health report + auto-fix drift (copies
//                                 the newer copy of each drifted bucket to
//                                 the lagging database)
// ─────────────────────────────────────────────────────────────────────────────

interface BucketRow {
  bucket: string;
  data: unknown;
  updatedAt: Date | null;
}

// Simple deterministic checksum: JSON-stringify → byte length.
// Good enough to detect drift without transmitting full payloads.
function checksum(data: unknown): number {
  try {
    return JSON.stringify(data)?.length ?? 0;
  } catch {
    return -1;
  }
}

// Count items if the bucket holds a JSON array; otherwise return null.
function rowCount(data: unknown): number | null {
  return Array.isArray(data) ? data.length : null;
}

// De-duplicate a JSON-array bucket by its "id" field before writing it to the
// losing side of a drift fix. Auto-fix picks a winner purely by updatedAt
// timestamp with no data-quality check -- without this, a side that already
// carries duplicate-id entries (e.g. from a client-side import bug) could have
// a newer timestamp than a clean side and silently overwrite it, spreading the
// corruption to both databases instead of fixing anything.
function dedupeById(data: unknown): unknown {
  if (!Array.isArray(data)) return data;
  const seen = new Set<unknown>();
  return data.filter((item) => {
    const id = item && typeof item === "object" ? (item as Record<string, unknown>).id : undefined;
    if (id === undefined || id === null || id === "") return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export default async (req: Request) => {
  // Reconcile is an admin-only operation — require a valid token when configured.
  if (process.env.QMS_SESSION_SECRET) {
    const claims = tokenFromRequest(req);
    if (!claims || !["admin", "superadmin"].includes(claims.role)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  if (!supabaseEnabled()) {
    return Response.json(
      {
        ok: false,
        error: "Supabase mirror is disabled — SUPABASE_URL and SUPABASE_ANON_KEY are not configured.",
        hint: "Set SUPABASE_URL and SUPABASE_ANON_KEY in Netlify → Site configuration → Environment variables.",
      },
      { status: 503 },
    );
  }

  const autoFix = req.method === "POST";

  // ── Fetch both databases in parallel ──────────────────────────────────────
  const [netlifyResult, supabaseResult] = await Promise.allSettled([
    db
      .select({
        bucket: qamsData.bucket,
        data: qamsData.data,
        updatedAt: qamsData.updatedAt,
      })
      .from(qamsData),
    readAllFromSupabase(),
  ]);

  if (netlifyResult.status === "rejected" && supabaseResult.status === "rejected") {
    return Response.json(
      {
        ok: false,
        error: "Both databases are unreachable.",
        netlifyError: String(netlifyResult.reason),
        supabaseError: String(supabaseResult.reason),
      },
      { status: 503 },
    );
  }

  const netlifyRows: BucketRow[] =
    netlifyResult.status === "fulfilled"
      ? netlifyResult.value.map((r) => ({
          bucket: r.bucket,
          data: r.data,
          updatedAt: r.updatedAt,
        }))
      : [];

  const supabaseRows: BucketRow[] =
    supabaseResult.status === "fulfilled"
      ? supabaseResult.value.map((r) => ({
          bucket: r.bucket,
          data: r.data,
          updatedAt: r.updatedAt,
        }))
      : [];

  // ── Build per-bucket maps ─────────────────────────────────────────────────
  const netlifyMap = new Map(netlifyRows.map((r) => [r.bucket, r]));
  const supabaseMap = new Map(supabaseRows.map((r) => [r.bucket, r]));
  const allBuckets = new Set([...netlifyMap.keys(), ...supabaseMap.keys()]);

  // ── Compare ───────────────────────────────────────────────────────────────
  type BucketStatus = "in_sync" | "drifted" | "netlify_only" | "supabase_only";

  interface BucketReport {
    bucket: string;
    status: BucketStatus;
    netlify: { checksum: number; rows: number | null; updatedAt: string | null } | null;
    supabase: { checksum: number; rows: number | null; updatedAt: string | null } | null;
    winner?: "netlify" | "supabase";
    fixed?: boolean;
  }

  // /api/data's GET strips `password` from every users row before it reaches
  // a browser -- so if either database's OWN stored copy of `users` has
  // genuinely lost passwords (any of the merge-path incidents this app has
  // had), reconcile's normal "copy whichever side has the newer updatedAt
  // over the other" logic would propagate that loss to the GOOD side in one
  // raw, unguarded overwrite -- exactly the kind of write every other fix
  // this session added a guard against, and this endpoint bypassed every one
  // of them (db.insert()/upsertToSupabase() here call the database directly,
  // never routing through data.ts's merge handler where those guards live).
  // Before pushing the "winner" over the "loser", re-attach any password the
  // loser still has for a user the winner is about to overwrite without one.
  function preserveUserPasswords(winnerData: unknown, loserData: unknown): unknown {
    if (!Array.isArray(winnerData) || !Array.isArray(loserData)) return winnerData;
    const loserById = new Map(
      (loserData as Array<Record<string, unknown>>).filter((u) => u && u.id).map((u) => [u.id, u]),
    );
    for (const u of winnerData as Array<Record<string, unknown>>) {
      if (!u || u.password) continue;
      const loser = loserById.get(u.id as string);
      if (loser && loser.password) {
        u.password = loser.password;
        u.pwVersion = loser.pwVersion;
      }
    }
    return winnerData;
  }

  // Same reasoning, for the other proven incident this session: a form
  // object with an older internal updatedAt can only be a stale snapshot
  // (every real edit path stamps a fresh one), never a legitimate edit --
  // pushing it over a newer one via this endpoint's raw overwrite would
  // silently revert a form's scoringMode exactly like the 2026-08-25
  // incident, bypassing the staleness guard data.ts's merge handler has.
  function dropStaleFormOverwrites(winnerData: unknown, loserData: unknown): unknown {
    if (!Array.isArray(winnerData) || !Array.isArray(loserData)) return winnerData;
    const loserById = new Map(
      (loserData as Array<Record<string, unknown>>).filter((f) => f && f.id).map((f) => [f.id, f]),
    );
    return (winnerData as Array<Record<string, unknown>>).map((f) => {
      const loser = f && f.id ? loserById.get(f.id as string) : undefined;
      const winnerTs = f && typeof f.updatedAt === "string" ? Date.parse(f.updatedAt) : NaN;
      const loserTs = loser && typeof loser.updatedAt === "string" ? Date.parse(loser.updatedAt) : NaN;
      if (loser && !Number.isNaN(winnerTs) && !Number.isNaN(loserTs) && winnerTs < loserTs) {
        return loser; // the "loser" side actually has the more recently-edited copy of this form
      }
      return f;
    });
  }

  const report: BucketReport[] = [];
  const fixes: Promise<void>[] = [];

  for (const bucket of allBuckets) {
    const n = netlifyMap.get(bucket) ?? null;
    const s = supabaseMap.get(bucket) ?? null;

    const nInfo = n
      ? { checksum: checksum(n.data), rows: rowCount(n.data), updatedAt: n.updatedAt?.toISOString() ?? null }
      : null;
    const sInfo = s
      ? { checksum: checksum(s.data), rows: rowCount(s.data), updatedAt: s.updatedAt?.toISOString() ?? null }
      : null;

    let status: BucketStatus;
    if (!n) status = "supabase_only";
    else if (!s) status = "netlify_only";
    else if (nInfo!.checksum === sInfo!.checksum) status = "in_sync";
    else status = "drifted";

    const entry: BucketReport = { bucket, status, netlify: nInfo, supabase: sInfo };

    // ── Auto-fix: copy the newer copy to the lagging DB ───────────────────
    if (autoFix && status !== "in_sync") {
      const nTs = n?.updatedAt?.getTime() ?? 0;
      const sTs = s?.updatedAt?.getTime() ?? 0;

      if (status === "netlify_only" || (status === "drifted" && nTs >= sTs)) {
        // Netlify is authoritative — push to Supabase
        entry.winner = "netlify";
        let winnerData: unknown = dedupeById(n!.data);
        if (bucket === "users") winnerData = preserveUserPasswords(winnerData, s?.data);
        if (bucket === "forms") winnerData = dropStaleFormOverwrites(winnerData, s?.data);
        fixes.push(
          upsertToSupabase(bucket, winnerData, n!.updatedAt ?? new Date())
            .then(() => { entry.fixed = true; })
            .catch((e) => { console.error(`fix→supabase ${bucket}`, e); entry.fixed = false; }),
        );
      } else {
        // Supabase is authoritative — push to Netlify
        entry.winner = "supabase";
        let winnerData: unknown = dedupeById(s!.data);
        if (bucket === "users") winnerData = preserveUserPasswords(winnerData, n?.data);
        if (bucket === "forms") winnerData = dropStaleFormOverwrites(winnerData, n?.data);
        fixes.push(
          db
            .insert(qamsData)
            .values({ bucket, data: winnerData as any, updatedAt: s!.updatedAt ?? new Date() })
            .onConflictDoUpdate({
              target: qamsData.bucket,
              set: { data: winnerData as any, updatedAt: s!.updatedAt ?? new Date() },
            })
            .then(() => { entry.fixed = true; })
            .catch((e) => { console.error(`fix→netlify ${bucket}`, e); entry.fixed = false; }),
        );
      }
    }

    report.push(entry);
  }

  if (fixes.length) await Promise.allSettled(fixes);

  // ── Aggregate summary ─────────────────────────────────────────────────────
  const inSync     = report.filter((r) => r.status === "in_sync").length;
  const drifted    = report.filter((r) => r.status === "drifted").length;
  const netlifyOnly = report.filter((r) => r.status === "netlify_only").length;
  const supabaseOnly = report.filter((r) => r.status === "supabase_only").length;

  const totalNetlifyRows = netlifyRows.reduce(
    (acc, r) => acc + (rowCount(r.data) ?? 1), 0,
  );
  const totalSupabaseRows = supabaseRows.reduce(
    (acc, r) => acc + (rowCount(r.data) ?? 1), 0,
  );

  return Response.json(
    {
      ok: true,
      checkedAt: new Date().toISOString(),
      autoFixed: autoFix,
      summary: {
        totalBuckets: allBuckets.size,
        inSync,
        drifted,
        netlifyOnly,
        supabaseOnly,
        netlifyBuckets: netlifyRows.length,
        supabaseBuckets: supabaseRows.length,
        netlifyTotalRows: totalNetlifyRows,
        supabaseTotalRows: totalSupabaseRows,
        healthy: drifted === 0 && netlifyOnly === 0 && supabaseOnly === 0,
      },
      buckets: report.sort((a, b) => {
        const order: Record<BucketStatus, number> = {
          drifted: 0, netlify_only: 1, supabase_only: 2, in_sync: 3,
        };
        return order[a.status] - order[b.status];
      }),
      errors: {
        netlify: netlifyResult.status === "rejected" ? String(netlifyResult.reason) : null,
        supabase: supabaseResult.status === "rejected" ? String(supabaseResult.reason) : null,
      },
    },
    {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
      },
    },
  );
};

export const config: Config = {
  path: "/api/reconcile",
};
