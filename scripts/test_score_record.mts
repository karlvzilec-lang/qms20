// Regression test for lib/scoreRecord.ts, the server-side authoritative
// re-scorer that closes the "stale client scores a section under the wrong
// mode" bug class after it recurred twice against client-side-only fixes
// (see netlify/functions/data.ts's comment on the `records` bucket guard).
// Locks in the exact scoring rules so a future change to this file can't
// silently reintroduce the same failure.
import assert from "node:assert/strict";
import { computeScoreFromAnswers, resolveScoringMode } from "../lib/scoreRecord.js";

let passed = 0;
function ok(label: string, cond: boolean) {
  if (!cond) { console.error("FAIL:", label); process.exitCode = 1; return; }
  console.log("ok  :", label);
  passed++;
}

const SECTION_5PT = { id: "s1", title: "Call Opening", totalPoints: 5, items: [
  { id: "1.1", title: "Item A", points: 2, autoFail: false },
  { id: "1.2", title: "Item B", points: 3, autoFail: true },
] };

// ── resolveScoringMode() precedence ─────────────────────────────────────
ok("missing scoringMode defaults to all-or-nothing, not weighted",
  resolveScoringMode({ ...SECTION_5PT, scoringMode: undefined }, {}, undefined) === "all-or-nothing");
ok("explicit per-section scoringMode is honored",
  resolveScoringMode({ ...SECTION_5PT, scoringMode: "weighted" }, {}, undefined) === "weighted");
ok("system-wide globalScoringMode overrides per-section",
  resolveScoringMode({ ...SECTION_5PT, scoringMode: "weighted" }, { globalScoringMode: "all-or-nothing" }, undefined) === "all-or-nothing");
ok("form's own globalScoringMode overrides the system-wide setting",
  resolveScoringMode({ ...SECTION_5PT, scoringMode: "weighted" }, { globalScoringMode: "weighted" }, { globalScoringMode: "all-or-nothing" }) === "all-or-nothing");

// ── computeScoreFromAnswers() ───────────────────────────────────────────
const form = [SECTION_5PT];

{
  // The exact reproduction of the 2026-08-14/08-21/08-25 incidents: a
  // section stuck on 'weighted' with one N answer must still zero out
  // under all-or-nothing once the mode resolves correctly.
  const answers = { "1.1": "Y", "1.2": "N" };
  const settings = { globalScoringMode: "all-or-nothing" };
  const r = computeScoreFromAnswers(form, answers, settings, undefined);
  ok("all-or-nothing: any N zeroes the whole section, not just that item's points",
    r.sectionScores.s1.earned === 0 && r.sectionScores.s1.possible === 5);
  ok("all-or-nothing: an autoFail item answered N triggers auto-fail",
    r.autoFailTriggered === true && r.finalScore === 0);
}

{
  const answers = { "1.1": "Y", "1.2": "Y" };
  const r = computeScoreFromAnswers(form, answers, { globalScoringMode: "all-or-nothing" }, undefined);
  ok("all-or-nothing: all-Y section earns full section points, not summed item points",
    r.sectionScores.s1.earned === 5 && r.finalScore === 100);
}

{
  const answers = { "1.1": "Y", "1.2": "N" };
  const r = computeScoreFromAnswers(form, answers, { globalScoringMode: "weighted" }, undefined);
  ok("weighted mode: only the failed item's own points are lost, section isn't zeroed",
    r.sectionScores.s1.earned === 2 && r.sectionScores.s1.possible === 5);
}

{
  // All-NA section: excluded from both earned and possible entirely.
  const answers = { "1.1": "NA", "1.2": "NA" };
  const r = computeScoreFromAnswers(form, answers, { globalScoringMode: "all-or-nothing" }, undefined);
  ok("all-NA section is excluded from possible (not scored as 0/5)",
    r.sectionScores.s1.possible === 0 && r.finalScore === 0);
}

{
  // Malformed form data (non-numeric totalPoints) must not poison the
  // whole record's score with NaN.
  const badForm = [{ ...SECTION_5PT, totalPoints: "not-a-number" as unknown as number }];
  const answers = { "1.1": "Y", "1.2": "Y" };
  const r = computeScoreFromAnswers(badForm, answers, { globalScoringMode: "all-or-nothing" }, undefined);
  ok("non-numeric totalPoints degrades to 0, never NaN", Number.isFinite(r.finalScore));
}

{
  // Empty/undefined answers must not throw.
  const r = computeScoreFromAnswers(form, undefined, {}, undefined);
  ok("undefined answers does not throw and scores as fully unanswered",
    r.finalScore === 0 && r.sectionScores.s1.possible === 0);
}

console.log(`\n${passed} check${passed === 1 ? "" : "s"} passed.`);
if (process.exitCode) { console.error("\nSome checks FAILED."); process.exit(1); }
