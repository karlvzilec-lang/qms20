// Server-side authoritative re-scoring for the `records` bucket.
//
// Root cause this exists to close permanently: computeScoreFromAnswers()
// (index.html) is the client's single source of truth for scoring, and it
// has already been patched twice against the same failure mode -- a
// section's scoringMode read as 'weighted' instead of the form's real
// 'all-or-nothing' configuration, because the SUBMITTING BROWSER's local
// cache of the `forms` bucket was stale. The first fix (default a MISSING
// field to all-or-nothing) didn't help a client that had the wrong value
// PRESENT, not missing. The second fix (re-fetch `forms` from the server
// immediately before scoring) still depends on that specific browser
// actually running the patched code and that fetch actually succeeding --
// neither is guaranteed for a device with a long-broken background sync,
// which is exactly the device that kept reproducing this bug. No client-
// side patch can be a real "never again" when the failure is that a
// particular browser never picks up the fix at all.
//
// The only fix that doesn't depend on any client's state is having the
// server recompute the score itself, from the raw answers, against the
// CURRENT form definition already sitting in this database -- and use
// that instead of whatever the client sent, whenever the two disagree.
// This function is a deliberate line-for-line port of
// computeScoreFromAnswers()/resolveScoringMode() in index.html (~line
// 8888) -- keep it in sync by hand if that function's scoring rules ever
// change; there is no way to share the literal code across a browser
// inline <script> and a Netlify Function.

export interface ScoreFormItem {
  id: string;
  title: string;
  points: number;
  autoFail?: boolean;
}
export interface ScoreFormSection {
  id: string;
  title: string;
  items: ScoreFormItem[];
  scoringMode?: string;
  totalPoints: number;
}
export interface ScoreFormSettings {
  globalScoringMode?: string;
  passScore?: number;
}

export interface SectionScoreResult {
  earned: number;
  possible: number;
  title: string;
  total: number;
  mode: string;
  hasNoItems: boolean;
}

export interface FailedItem {
  itemId: string;
  itemTitle: string;
  sectionId: string;
  sectionTitle: string;
}

export interface ScoreResult {
  finalScore: number;
  autoFailTriggered: boolean;
  autoFailItems: string[];
  failedItems: FailedItem[];
  sectionScores: Record<string, SectionScoreResult>;
}

// Mirrors resolveScoringMode() in index.html exactly, including precedence
// (form's own override > system-wide setting > per-section > default) and
// the all-or-nothing default for an unresolved section -- a missing/stale
// mode field should make scoring MORE conservative, never silently mask a
// real failure as a pass.
export function resolveScoringMode(
  sec: ScoreFormSection | undefined,
  settings: ScoreFormSettings | undefined,
  formSettings: ScoreFormSettings | undefined,
): string {
  const globalMode = formSettings?.globalScoringMode || settings?.globalScoringMode || "per-section";
  return globalMode === "per-section" ? (sec?.scoringMode || "all-or-nothing") : globalMode;
}

// Mirrors computeScoreFromAnswers() in index.html exactly.
export function computeScoreFromAnswers(
  form: ScoreFormSection[] | undefined,
  answers: Record<string, string> | undefined,
  settings: ScoreFormSettings | undefined,
  formSettings: ScoreFormSettings | undefined,
): ScoreResult {
  const safeAnswers = answers || {};
  let totalEarned = 0;
  let totalPossible = 0;
  let autoFailTriggered = false;
  const autoFailItems: string[] = [];
  const failedItems: FailedItem[] = [];
  const sectionScores: Record<string, SectionScoreResult> = {};

  (form || []).forEach((sec) => {
    const mode = resolveScoringMode(sec, settings, formSettings);
    const answeredItems = (sec.items || []).filter((item) => {
      const ans = safeAnswers[item.id] || "";
      return ans !== "" && ans !== "NA";
    });
    const noItems = answeredItems.filter((item) => safeAnswers[item.id] === "N");
    noItems.forEach((item) => {
      failedItems.push({ itemId: item.id, itemTitle: item.title, sectionId: sec.id, sectionTitle: sec.title });
      if (item.autoFail) {
        autoFailTriggered = true;
        autoFailItems.push(item.title);
      }
    });

    let secEarned = 0;
    let secPossible = 0;
    // (+x||0) guards a malformed/migrated form record (missing or non-
    // numeric totalPoints/points) from poisoning the whole record's total
    // with NaN -- see the matching comment in index.html's engine.
    if (mode === "all-or-nothing") {
      if (answeredItems.length > 0) {
        secPossible = (+sec.totalPoints) || 0;
        secEarned = noItems.length > 0 ? 0 : secPossible;
      }
    } else {
      answeredItems.forEach((item) => {
        const pts = (+item.points) || 0;
        secPossible += pts;
        if (safeAnswers[item.id] === "Y") secEarned += pts;
      });
    }
    totalEarned += secEarned;
    totalPossible += secPossible;
    sectionScores[sec.id] = {
      earned: secEarned,
      possible: secPossible,
      title: sec.title,
      total: (+sec.totalPoints) || 0,
      mode,
      hasNoItems: noItems.length > 0,
    };
  });

  let finalScore = totalPossible > 0 ? (totalEarned / totalPossible) * 100 : 0;
  if (autoFailTriggered) finalScore = 0;
  finalScore = +finalScore.toFixed(1);

  return { finalScore, autoFailTriggered, autoFailItems, failedItems, sectionScores };
}
