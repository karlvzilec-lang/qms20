// Supabase mirror — uses the REST API (plain HTTPS) instead of a direct
// Postgres connection. Netlify's Lambda-based functions run on IPv4 networks
// that cannot reach Supabase's IPv6-only TCP pooler endpoints, so HTTP is
// the only reliable transport from a serverless environment.
//
// Required env vars:
//   SUPABASE_URL      https://<project-ref>.supabase.co
//   SUPABASE_ANON_KEY <anon/public JWT>

const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";

export function supabaseEnabled(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

export interface SupabaseRow {
  bucket: string;
  data: unknown;
  updatedAt: Date | null;
}

// ── internal helpers ──────────────────────────────────────────────────────

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function rest(
  path: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
): Promise<Response> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...init,
    headers: headers(init.headers ?? {}),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Supabase REST ${res.status}: ${body}`);
  }
  return res;
}

// ── public API ────────────────────────────────────────────────────────────

export async function readAllFromSupabase(): Promise<SupabaseRow[]> {
  const res = await rest("/qams_data?select=bucket,data,updated_at");
  const rows = (await res.json()) as Array<{
    bucket: string;
    data: unknown;
    updated_at: string | null;
  }>;
  return rows.map((r) => ({
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
  await rest("/qams_data?on_conflict=bucket", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ bucket, data, updated_at: updatedAt.toISOString() }),
  });
}

// Row-level delta merge via the stored procedure.
export async function mergeBucketSupabase(
  bucket: string,
  upserts: unknown[],
  deletes: unknown[],
  updatedAt: Date,
): Promise<void> {
  await rest("/rpc/qams_merge_bucket", {
    method: "POST",
    body: JSON.stringify({
      p_bucket: bucket,
      p_upserts: upserts,
      p_delete_ids: deletes,
      p_updated_at: updatedAt.toISOString(),
    }),
  });
}
