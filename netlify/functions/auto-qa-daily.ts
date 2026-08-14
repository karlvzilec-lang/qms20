import type { Config } from "@netlify/functions";
import { readBucket, mergeBucketRows } from "../../lib/serverBucket.js";
import { getRecentCorrections, scoreYellowLink, type ApprovedDraftForCorrections, type FormSection, type LlmScoringConfig, type RosterAgent } from "../../lib/autoQa.js";

// Scheduled Auto QA batch — runs once daily, no manual trigger needed.
//
// Reads every 'queued' row in the autoQaLinkQueue bucket (populated by QA officers
// uploading an Excel of transcript links in the Auto QA screen), scores each one
// through the same rule-based engine the interactive "paste links" flow uses
// (lib/autoQa.ts), and writes a 'pending' draft per link into autoQaDrafts --
// exactly the same shape a manually-run "Save as Draft" produces, just created by
// `system (daily batch)` instead of a person. Nothing here ever touches the live
// `records` bucket directly; a QA officer still has to approve every draft on the
// Auto QA Drafts review screen before it becomes a real evaluation.
//
// Netlify does not allow arbitrary public HTTP requests to trigger a function that
// declares a `schedule` config -- only Netlify's own scheduler can invoke it -- so
// this needs no separate auth check the way yellow-transcript.ts does.
//
// Processing is sequential and capped per run (MAX_PER_RUN) rather than unbounded,
// since standard (non-background) Netlify Functions have a short execution budget.
// Anything past the cap simply stays 'queued' and picks up on tomorrow's run. If
// daily link volume turns out to regularly exceed the cap, this should move to a
// Netlify Background Function (netlify/functions/auto-qa-daily-background.ts,
// ~15 min budget instead of ~10-26s) rather than raising the cap indefinitely.
const MAX_PER_RUN = 15;

interface QueueRow {
  id: string;
  link: string;
  status: "queued" | "processed" | "error" | "duplicate";
  processedAt?: string | null;
  draftId?: string | null;
  error?: string | null;
  // Optional essential fields from the batch-upload template -- see
  // scoreYellowLink()'s `hints` param in lib/autoQa.ts. All optional; a row
  // uploaded with only a link still processes, just with more left for the
  // reviewer to fill in on the Auto QA Drafts screen.
  staffId?: string;
  agentName?: string;
  campaign?: string;
  evalDate?: string;
  refNo?: string;
  mobileNumber?: string;
  [key: string]: unknown;
}

interface QamsForm {
  id: string;
  status: string;
  sections: FormSection[];
  settings?: { globalScoringMode?: string };
}

interface QamsSettings {
  globalScoringMode?: string;
}

export default async () => {
  const [queue, forms, agents, drafts, settings] = await Promise.all([
    readBucket<QueueRow[]>("autoQaLinkQueue"),
    readBucket<QamsForm[]>("forms"),
    readBucket<RosterAgent[]>("agents"),
    readBucket<ApprovedDraftForCorrections[]>("autoQaDrafts"),
    readBucket<QamsSettings>("settings"),
  ]);

  const published = (forms || []).find((f) => f.status === "published");
  // A form's own settings.globalScoringMode (an admin explicitly forcing a
  // mode for that specific form) takes precedence over the system-wide
  // Settings screen value -- matches the client's resolveScoringMode()
  // precedence so a draft's batch-computed score can't silently disagree
  // with what the live evaluation form would compute for the same answers.
  const globalScoringMode = published?.settings?.globalScoringMode || settings?.globalScoringMode || "per-section";
  const pending = (queue || []).filter((r) => r.status === "queued").slice(0, MAX_PER_RUN);

  if (!pending.length) {
    return Response.json({ ok: true, processed: 0, message: "No queued links." });
  }
  if (!published) {
    return Response.json({ ok: false, error: "No published QA form found -- skipped this run." }, { status: 503 });
  }

  // See yellow-transcript.ts for why AUTOQA_AI_API_KEY must be tried first: Netlify's
  // own Anthropic extension (if enabled on the team) auto-injects an unrelated,
  // non-working value under the plain ANTHROPIC_API_KEY name.
  const apiKey = process.env.AUTOQA_AI_API_KEY || process.env.ANTHROPIC_API_KEY || "";
  const llmConfig: LlmScoringConfig | undefined = apiKey
    ? { apiKey, model: process.env.AUTOQA_AI_MODEL || process.env.ANTHROPIC_MODEL || undefined }
    : undefined;
  const corrections = getRecentCorrections(drafts || [], published.sections);

  const draftsToUpsert: Record<string, unknown>[] = [];
  const queueUpdates: QueueRow[] = [];
  let errors = 0;

  for (const row of pending) {
    try {
      const result = await scoreYellowLink(row.link, published.sections, agents || [], {
        staffId: row.staffId,
        agentName: row.agentName,
        campaign: row.campaign,
        evalDate: row.evalDate,
        refNo: row.refNo,
        mobileNumber: row.mobileNumber,
      }, llmConfig, corrections, globalScoringMode);
      const draftId = crypto.randomUUID();
      draftsToUpsert.push({
        id: draftId,
        link: row.link,
        status: "pending",
        createdBy: "system (daily batch)",
        createdAt: new Date().toISOString(),
        transcript: result.transcript,
        scoringMethod: result.scoringMethod,
        languageNote: result.languageNote,
        scoringWarning: result.scoringWarning,
        proposedAnswers: result.prefill.answers,
        proposedComments: result.prefill.comments,
        needsReview: result.prefill.needsReview,
        draftScore: result.draftScore,
        formId: published.id,
        proposedAgentId: result.agentMatch?.id || "",
        agentMatchConfident: !!result.agentMatch,
        agentMatchSource: result.agentMatchSource,
        agentNameGuess: result.agentNameGuess,
        proposedCampaign: result.resolvedCampaign,
        proposedCallType: "Chat",
        proposedEvalDate: result.resolvedEvalDate,
        proposedRefNo: result.resolvedRefNo,
        proposedMobileNumber: result.resolvedMobileNumber,
        proposedReasonForCalling: result.reasonForCalling,
        proposedOverallRemarks: result.overallRemarks,
        resolvedAt: null,
        resolvedBy: null,
        finalAnswers: null,
        finalRecordId: null,
        rejectionNote: null,
      });
      queueUpdates.push({ ...row, status: "processed", processedAt: new Date().toISOString(), draftId, error: null });
    } catch (e) {
      errors++;
      queueUpdates.push({
        ...row,
        status: "error",
        processedAt: new Date().toISOString(),
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  await Promise.all([
    mergeBucketRows("autoQaDrafts", draftsToUpsert),
    mergeBucketRows("autoQaLinkQueue", queueUpdates as unknown[]),
  ]);

  return Response.json({
    ok: true,
    processed: pending.length,
    drafted: draftsToUpsert.length,
    errors,
    remainingQueued: (queue || []).filter((r) => r.status === "queued").length - pending.length,
  });
};

export const config: Config = {
  schedule: "0 2 * * *",
};
