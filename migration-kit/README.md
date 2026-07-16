# QMS v2 — Migration Kit

Everything needed to move this app's data to a different server — on-prem,
cloud, or Windows Server — using SQL to create the schema and JSON to move
the data.

This app stores all of its data in **one table**, `qams_data`, as a set of
named "buckets" (`records`, `agents`, `users`, `settings`, `npsRecords`, …)
each holding one JSON document. That single-table design is what makes
migration simple: there is exactly one table to create on the target server,
and exactly one JSON export/import to move everything else.

## 1. Create the schema on the target server

Pick the file matching your target engine and run it once against a fresh
(empty) database:

| Target | File |
|---|---|
| PostgreSQL — Supabase, RDS, Neon, Railway, fly.io, Netlify DB, Azure Postgres, self-hosted | `schema.postgresql.sql` |
| MySQL / MariaDB — RDS MySQL, PlanetScale, Azure Database for MySQL | `schema.mysql.sql` |
| SQL Server — Azure SQL, **on-prem Windows Server** | `schema.mssql.sql` |
| SQLite — local file, Cloudflare D1, Turso/LibSQL | `schema.sqlite.sql` |

These match the app's live production schema exactly (see
`../db/schema.ts` and `../netlify/database/migrations/` for the
Drizzle-managed history this was generated from) — running one of these
files creates the identical table structure the running app already uses.

The PostgreSQL file also creates `qams_merge_bucket()`, the function the app
calls for row-level concurrent-safe merges on high-churn buckets (evaluations,
NPS entries, etc.). The other three engines don't have an equivalent
procedure language available here, so that same merge logic is instead
implemented in application code — see step 3.

## 2. Move the data

Two ways to move data, use whichever fits your situation:

**A. One-time export/import (simplest — no live connection between old and new server needed)**
1. In the running app: **Settings → Migration → Full Data Export → Fetch & Preview → Download JSON**.
2. Stand up the target server (step 1 above, plus step 3 if you need the API layer).
3. Point the target server's `/api/data` endpoint at the new database, then
   in the app's Migration tab: **Import Bundle** → choose the downloaded
   JSON → set the target URL → **Push to Target**. Every bucket is upserted
   with a merge strategy — nothing is silently overwritten.

**B. Live push (source and target both reachable at once)**
1. In the running app: **Settings → Migration → Fetch & Preview** (pulls the
   merged view from the current backend).
2. Enter the target server's URL in **Push to Target Server** → **Test**
   (confirms connectivity) → **Push All**.

## 3. Stand up an API server on the target (if you're not using Netlify Functions there)

The production app's backend is a set of Netlify Functions
(`../netlify/functions/*.ts`) — those are Netlify-specific. To run the same
`/api/data` contract anywhere else (a plain Windows Server, a Linux box, a
Docker container), download the on-prem server package from
**Settings → Migration → On-Prem Server Package**:

- `server.js` — Express server implementing the same GET/POST `/api/data`
  contract, with adapters for SQLite (default, zero-config), PostgreSQL, and
  SQL Server, selected via the `DB_TYPE` environment variable.
- `package.json`, `.env.example`, `Dockerfile`.

Quick start on Windows Server:
```
node --version   # need v18+
npm install
node server.js   # listens on :3001
```

Set `DB_TYPE` and `DB_URL` in `.env` to match whichever schema file you ran
in step 1. Then point the QMS app's own `DATABASE_URL`/environment config —
or the Migration tab's **Push to Target** field — at
`http://YOUR_SERVER:3001/api/data`.

## Notes

- These schema files are a snapshot generated from the app's own in-app DDL
  viewer (Settings → Migration → Database Schema (DDL), Super Admin only —
  the same four buttons that produced these files). If that in-app generator
  is ever changed, re-sync these files from it so they don't drift.
- The PostgreSQL RLS policy in `schema.postgresql.sql` is a permissive
  `allow_all` policy matching what this app currently runs with in its
  shared Supabase project. If you're deploying to a database shared with
  other applications, scope that policy (or switch the app to a
  service_role key) rather than reusing it as-is.
