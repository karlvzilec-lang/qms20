# QMS20 — Cellcard QA Monitoring System

A single-file SPA (`index.html`) for managing call-center QA evaluations, backed by Netlify Functions and a Postgres/Supabase data layer. Includes role-based access control, an Auto QA pipeline that scores Yellow Messenger transcripts (rule-based and LLM), and an NPS dashboard.

## Setup

**Requirements:** Node 20+, npm, and the [Netlify CLI](https://docs.netlify.com/cli/get-started/) for local functions/dev server.

```bash
npm install
```

### Run locally

The frontend is a static file, so any static server works for UI-only work:

```bash
npx http-server . -p 8934
```

To exercise the Netlify Functions (auth, data sync, Auto QA) locally, use Netlify Dev instead, which also proxies `/api/*` for you:

```bash
netlify dev
```

### Environment variables

Set these in Netlify (Site configuration → Environment variables) for production, or in a local `.env` for `netlify dev`. Every integration degrades gracefully when its variables are unset — the app runs client-side-only without them.

| Variable | Used for |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Supabase mirror of app data (`netlify/functions/data.ts`, `reconcile.ts`) |
| `QMS_SESSION_SECRET` | Signs/verifies session tokens issued by `netlify/functions/auth.ts` |
| `AUTOQA_AI_API_KEY`, `AUTOQA_AI_MODEL` | LLM-based Auto QA scoring (Khmer/English transcripts) |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Anthropic-specific Auto QA scoring path |

`netlify/functions/auto-qa-daily.ts` also runs as a Netlify Scheduled Function (`0 2 * * *`) once deployed — no separate cron setup needed.

### Checks

```bash
npm run typecheck          # tsc --noEmit over netlify/functions, lib, db
npm run check-index-syntax # parse-checks index.html's inline <script>
npm run ci                 # both of the above — same as CI runs on push/PR to main
```

## Deployment

Deploys to [Netlify](https://www.netlify.com/) (`netlify.toml` configures the publish directory and security headers). Push to `main` to trigger a deploy once the site is linked (`netlify link` / `netlify init`).

## License

MIT — see [LICENSE](LICENSE).
