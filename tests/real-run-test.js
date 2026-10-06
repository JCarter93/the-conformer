/**
 * The whole pipeline, run against a REAL captured job, checked for
 * COMPLETENESS rather than for particular values.
 *
 * WHY THIS EXISTS
 *
 * Five bugs in this project have had the identical shape: a value computed
 * correctly and never delivered to the thing that needed it.
 *
 *   - `gradedWidth` was never recorded, so the whole Set-to-Frame-Size
 *     correction returned null for every clip.
 *   - The framing verdict never reached `placedScaleFor`, so verification
 *     produced the right answer and changed nothing.
 *   - `versions` fell off the run inside `applyVerification`, so the version
 *     picker was unreachable on every run that verified.
 *   - The fit was gated behind the "Carry Motion" checkbox, so turning Motion
 *     off placed 8K media at Scale 100.
 *   - `verdict.chosenWidth` was read and has never been emitted, so resolved
 *     cuts alone were placed unfitted.
 *
 * Every one passed its unit tests, because those tests hand-build their
 * fixtures and therefore supply the very field that is missing in real life.
 * A field-name checklist does not catch the next one either - it only catches
 * the names someone thought to list.
 *
 * So this asserts the OUTPUT IS COMPLETE, on data captured from an actual
 * conform: every placement that can be scaled has a scale, every placement is
 * frame-aligned, nothing that went in came out missing. Whichever field goes
 * missing next, the placement it feeds ends up incomplete, and that is what
 * fails here.
 *
 * The fixture is `tests/fixtures/real-run.json` - the plan, the clips and the
 * verdicts from the main-cut job it was built on. Re-capture it when the shape of any
 * of those changes; do NOT hand-edit it to make a test pass.
 */

var module = { exports: {} };
var exports = module.exports;
load("js/plan.js");
var P = module.exports;

var passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed++;
  else { failed++; print("FAIL  " + label); }
}
function eq(actual, expected, label) {
  var a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) passed++;
  else { failed++; print("FAIL  " + label + "\n      expected " + e + "\n      got      " + a); }
}

var FIX = JSON.parse(readFile("tests/fixtures/real-run.json"));
var opts = FIX.opts;

var run = P.buildRun(FIX.plan, FIX.clips, opts);
P.mergeRefusals(run, P.retimedRefusals(FIX.clips));
var verified = P.applyVerification(run, FIX.verdicts, opts);

// --- the run survives verification intact ----------------------------------

ok(verified.placements.length > 0, "the real job produces placements");
ok(Array.isArray(verified.versions), "the version list survives verification");
eq(verified.summary.versions, run.summary.versions,
   "and keeps every contested cut the plan found");

// --- EVERY placement is complete -------------------------------------------
//
// Not "the ones we remembered to check". All of them.

var noScale = [], notAligned = [], noOffset = [], noFile = [];
verified.placements.forEach(function (p) {
  // A placement whose media and sequence sizes are both known MUST have a
  // scale worked out. Null here is the signature of a field that went
  // missing somewhere upstream.
  var knowable = p.dims && p.dims.sourceWidth && p.dims.gradedWidth;
  if (knowable && !p.scaleFix) noScale.push(P.formatSeconds(p.start) + " " + p.name);
  if (p.scaleFix && typeof p.scaleFix.gradedFit !== "number") {
    noScale.push(P.formatSeconds(p.start) + " " + p.name + " (no gradedFit)");
  }
  if (typeof p.sourceIn !== "number") noOffset.push(P.formatSeconds(p.start) + " " + p.name);
  if (!p.gradedPath) noFile.push(P.formatSeconds(p.start) + " " + p.name);
  if (p.startTicks % opts.ticksPerFrame !== 0 ||
      p.sourceInTicks % opts.ticksPerFrame !== 0 ||
      p.sourceOutTicks % opts.ticksPerFrame !== 0) {
    notAligned.push(P.formatSeconds(p.start) + " " + p.name);
  }
});

if (noScale.length) print("      unscaled: " + noScale.join(", "));
ok(noScale.length === 0, "every placement that can be scaled has a scale");
if (noOffset.length) print("      no offset: " + noOffset.join(", "));
ok(noOffset.length === 0, "every placement has a source offset");
if (noFile.length) print("      no file: " + noFile.join(", "));
ok(noFile.length === 0, "every placement names a graded file");
if (notAligned.length) print("      off-grid: " + notAligned.join(", "));
ok(notAligned.length === 0, "every placement is on the frame grid");

// --- the cuts the PICTURE resolved are complete too -------------------------
//
// These take a different route through applyVerification, and that route is
// where the last bug lived: they were the only clips in a real conform placed
// without a scale, because the branch read a field the matcher never emits.

var resolved = verified.placements.filter(function (p) {
  return p.verification && p.verification.verdict === "resolved";
});
ok(resolved.length > 0, "the fixture actually exercises the resolved path");
resolved.forEach(function (p) {
  ok(!!p.scaleFix, "resolved cut at " + P.formatSeconds(p.start) + " has a scale correction");
  ok(!!p.dims && !!p.dims.gradedWidth,
     "resolved cut at " + P.formatSeconds(p.start) + " knows its graded file's size");
});

// --- every refusal can be acted on ------------------------------------------

var mute = [];
verified.refused.forEach(function (r) {
  if (!r.name || !r.reason) mute.push(JSON.stringify(r).slice(0, 60));
});
if (mute.length) print("      silent refusals: " + mute.join(", "));
ok(mute.length === 0, "every refusal names a clip and gives a reason");

print("");
print(passed + " passed, " + failed + " failed");
if (failed > 0) throw new Error(failed + " test(s) failed");
