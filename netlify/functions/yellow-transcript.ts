import type { Config } from "@netlify/functions";
import { tokenFromRequest } from "../../db/token.js";
import { readBucket } from "../../lib/serverBucket.js";
import { scoreYellowLink, type FormSection, type RosterAgent } from "../../lib/autoQa.js";

// GET /api/yellow-transcript?url=<Yellow Messenger public link>
//
// Fetches one transcript server-side (the browser can't reach Yellow.ai directly --
// this app's CSP connect-src doesn't allowlist it, by design), runs the rule-based
// QA scoring engine against the currently published form, and returns a fully-scored
// result. Scoring lives here (not duplicated client-side) so the interactive "paste
// links" flow and the daily scheduled batch (auto-qa-daily.ts) share one implementation.
//
// Auth: requires a valid session token for qa/admin/superadmin -- unlike /api/data's
// open GET, this endpoint calls out to a third party and should be authenticated on
// every request, not just writes.
interface QamsForm {
  id: string;
  status: string;
  sections: FormSection[];
}

export default async (req: Request) => {
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });

  if (process.env.QMS_SESSION_SECRET) {
    const claims = tokenFromRequest(req);
    if (!claims || !["qa", "admin", "superadmin"].includes(claims.role)) {
      return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }
  }

  const params = new URL(req.url).searchParams;
  const url = params.get("url") || "";
  if (!url) {
    return Response.json({ success: false, error: "Missing 'url' query parameter" }, { status: 400 });
  }
  // Optional pre-known fields (from a batch-upload row, or an individual "Check
  // Now" call) -- take priority over guessing agent/campaign/date from the
  // transcript alone. See scoreYellowLink() in lib/autoQa.ts.
  const hints = {
    staffId: params.get("staffId") || undefined,
    agentName: params.get("agentName") || undefined,
    campaign: params.get("campaign") || undefined,
    evalDate: params.get("evalDate") || undefined,
    refNo: params.get("refNo") || undefined,
    mobileNumber: params.get("mobileNumber") || undefined,
  };

  try {
    const [forms, agents] = await Promise.all([
      readBucket<QamsForm[]>("forms"),
      readBucket<RosterAgent[]>("agents"),
    ]);
    const published = (forms || []).find((f) => f.status === "published");
    if (!published) {
      return Response.json({ success: false, error: "No published QA form found" }, { status: 503 });
    }

    const result = await scoreYellowLink(url, published.sections, agents || [], hints);
    return Response.json({
      success: true,
      formId: published.id,
      ...result,
    });
  } catch (e) {
    return Response.json(
      { success: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
};

export const config: Config = {
  path: "/api/yellow-transcript",
};
