/**
 * Tests for js/plan.js - every decision the Conformer makes before it writes
 * anything. No Node on this machine, so this runs under jsc:
 *   scripts/run-tests.sh
 *
 * jsc has load() and print() but no require(), so module/exports are shimmed
 * before loading the module under test. That is deliberate: these tests run the
 * REAL module, not a hand-written mirror of it. Two of Onliner's failed runs
 * came from pre-flighting a mirror that happened to behave better than the code
 * it stood in for.
 */

var module = { exports: {} };
var exports = module.exports;
load("js/plan.js");
var P = module.exports;

var passed = 0, failed = 0;

function eq(actual, expected, label) {
  var a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) passed++;
  else { failed++; print("FAIL  " + label + "\n      expected " + e + "\n      got      " + a); }
}
function ok(cond, label) {
  if (cond) passed++;
  else { failed++; print("FAIL  " + label); }
}
function has(hay, needle, label) {
  if (String(hay).indexOf(needle) !== -1) passed++;
  else { failed++; print("FAIL  " + label + "\n      \"" + needle + "\" not in: " + hay); }
}

// --- path normalisation ----------------------------------------------------
// Measured: an item already in the project reports ///Volumes/..., the same
// file freshly imported reports /Volumes/... A literal compare fails.

eq(P.normalisePath("///Volumes/M/a.mov"), "/Volumes/M/a.mov", "collapses a triple slash");
eq(P.normalisePath("/Volumes/M/a.mov"), "/Volumes/M/a.mov", "leaves a clean path alone");
eq(P.normalisePath("file:///Volumes/M/a.mov"), "/Volumes/M/a.mov", "strips a file:// prefix");
eq(P.normalisePath("  ///Volumes/M/a.mov  "), "/Volumes/M/a.mov", "trims surrounding space");
eq(P.normalisePath(null), "", "null is the empty path, not a crash");
// Windows. UXP hands back backslashes; the plan, the helper and every
// comparison speak forward slashes, which Windows itself accepts.
eq(P.normalisePath("C:\\Graded\\a.mov"), "C:/Graded/a.mov", "backslashes become forward slashes");
eq(P.normalisePath("c:\\Graded\\a.mov"), "C:/Graded/a.mov", "the drive letter is upper-cased so c: and C: are one file");
ok(P.normalisePath("C:\\Graded\\a.mov") === P.normalisePath("C:/Graded/a.mov"),
   "a backslash path and its forward-slash twin compare equal");
eq(P.normalisePath("\\\\server\\share\\a.mov"), "//server/share/a.mov", "a UNC path keeps its double lead or it stops resolving");
eq(P.normalisePath("///Volumes/M/a.mov"), "/Volumes/M/a.mov", "a Mac triple slash is still collapsed, not mistaken for UNC");
eq(P.baseName("C:\\Graded\\a.mov"), "a.mov", "baseName works on a Windows path");
// Premiere 26.5.2 on Windows hands back project.path as \\?\C:\... (seen live).
eq(P.normalisePath("\\\\?\\C:\\Users\\e\\p.prproj"), "C:/Users/e/p.prproj", "an extended-length local path loses its \\\\?\\ prefix");
eq(P.normalisePath("\\\\?\\UNC\\server\\share\\a.mov"), "//server/share/a.mov", "an extended-length UNC path becomes a plain UNC path");
ok(P.normalisePath("\\\\?\\C:\\G\\a.mov") === P.normalisePath("C:/G/a.mov"), "extended and plain spellings of one file compare equal");
eq(P.baseName("\\\\server\\share\\a.mov"), "a.mov", "baseName works on a UNC path");
ok(P.normalisePath("///Volumes/M/a.mov") === P.normalisePath("/Volumes/M/a.mov"),
   "a file matches itself across the two spellings");
// macOS hands back decomposed filenames; a Python-written plan may be composed.
ok(P.normalisePath("/V/café.mov") === P.normalisePath("/V/café.mov"),
   "NFD and NFC spellings of the same name compare equal");
eq(P.baseName("///Volumes/M/sub/V1-0002_A007.mov"), "V1-0002_A007.mov", "basename off a messy path");

// --- ticks and frame alignment --------------------------------------------

eq(P.secondsToTicks(1), 254016000000, "one second in ticks");
eq(P.secondsToTicks(0), 0, "zero seconds");
var TPF_25 = 10160640000;        // 25fps
var TPF_2397 = 10594584000;      // 23.976fps
eq(P.alignToFrame(P.secondsToTicks(2), TPF_25), P.secondsToTicks(2),
   "2s is already on the 25fps grid");
ok(P.alignToFrame(P.secondsToTicks(2), TPF_2397) % TPF_2397 === 0,
   "2s snaps onto the 23.976 grid");
ok(Math.abs(P.alignToFrame(P.secondsToTicks(2), TPF_2397) - P.secondsToTicks(2)) < TPF_2397,
   "snapping moves it by less than a frame");
eq(P.alignToFrame(12345, 0), 12345, "a zero timebase is passed through, not divided by");

// --- readPlan --------------------------------------------------------------

has(P.readPlan("not json").error, "not valid JSON", "rejects non-JSON");
has(P.readPlan("{\"a\":1}").error, "JSON array", "rejects an object");
has(P.readPlan("[{\"start\":1,\"dur\":1}]").error, "\"source\"", "names the missing field");
var good = P.readPlan("[{\"source\":\"/a.mov\",\"start\":1,\"dur\":2}]");
eq(good.error, null, "a well-formed plan parses");
eq(good.entries.length, 1, "and yields its entries");

// --- classify --------------------------------------------------------------

function entry(over) {
  var e = { source: "/rushes/A007.MOV", start: 10, in: 5, dur: 2,
            status: "OK", graded: "/graded/V1-0002_A007.mov", sourceIn: 0.48, gradedDur: 2.96 };
  for (var k in over) e[k] = over[k];
  return e;
}

eq(P.classify(entry()).placeable, true, "a clean OK entry is placeable");
eq(P.classify(entry({ status: "SUPERSEDED" })).placeable, true,
   "SUPERSEDED is placeable - it is provenance, not a problem");
eq(P.classify(entry({ status: "RETRIMMED", sourceIn: undefined })).placeable, false,
   "RETRIMMED is refused");
has(P.classify(entry({ status: "RETRIMMED", sourceIn: undefined })).reason, "find_offsets.py",
   "and says which step was skipped");
has(P.classify(entry({ status: "AMBIGUOUS" })).reason, "same round", "AMBIGUOUS is explained");
has(P.classify(entry({ status: "MISSING" })).reason, "no graded file", "MISSING is explained");
has(P.classify(entry({ status: "SKIP" })).reason, "confidently", "SKIP is explained");
eq(P.classify(entry({ sourceIn: undefined })).placeable, false, "no sourceIn, no placement");
eq(P.classify(entry({ sourceIn: -1 })).placeable, false, "a negative sourceIn is refused");
eq(P.classify(entry({ dur: 0 })).placeable, false, "a zero-length cut is refused");

// THE range check. Marks past the end of the media do not error - a 6-frame
// file marked 2-4s placed a silent 2-second clip of nothing. This is the only
// place that can be caught, since Media.duration is unreadable from the API.
var overrun = P.classify(entry({ sourceIn: 2.0, dur: 2.0, gradedDur: 0.32 }));
eq(overrun.placeable, false, "a cut running past the end of the graded file is refused");
has(overrun.reason, "past the end", "and says so plainly");
has(overrun.reason, "0.32s file", "naming the file's real length");
eq(P.classify(entry({ sourceIn: 0.96, dur: 2.0, gradedDur: 2.96 })).placeable, true,
   "a cut that exactly fills the graded file is fine");
eq(P.classify(entry({ gradedDur: undefined })).placeable, false,
   "no gradedDur means the range cannot be checked, so it is refused");

// --- matchToTimeline -------------------------------------------------------

function clip(over) {
  var c = { trackIndex: 0, start: 10, dur: 2, srcIn: 5, path: "/rushes/A007.MOV", name: "A007.MOV" };
  for (var k in over) c[k] = over[k];
  return c;
}

var m1 = P.matchToTimeline([entry()], [clip()]);
eq(m1[0].matched, true, "entry matches the clip at its position");

var moved = P.matchToTimeline([entry()], [clip({ start: 14 })]);
eq(moved[0].matched, false, "a clip that has moved is not matched");
has(moved[0].reason, "the edit has changed", "and the reason says why");

var renamed = P.matchToTimeline([entry()], [clip({ path: "/rushes/B002.MOV" })]);
eq(renamed[0].matched, false, "a different source at the same position is refused");
has(renamed[0].reason, "B002.MOV", "naming what is actually there");

var retrimmed = P.matchToTimeline([entry()], [clip({ dur: 3.5 })]);
eq(retrimmed[0].matched, false, "a cut re-trimmed since the plan is refused");
has(retrimmed[0].reason, "re-trimmed since", "and says the offset no longer lines up");

// The same rush used twice must consume two different clips, not the same one.
var twice = P.matchToTimeline(
  [entry({ start: 10 }), entry({ start: 30 })],
  [clip({ start: 10 }), clip({ start: 30 })]);
eq([twice[0].matched, twice[1].matched], [true, true], "one rush used twice matches both cuts");
ok(twice[0].clip.start !== twice[1].clip.start, "and they take different clips");

// A retimed clip cannot be conformed: TrackItem has getSpeed but no setter, so
// a replacement lands at 100% and drifts against picture. Measured on a real
// clip at 1.05.
var retimed = P.matchToTimeline([entry()], [clip({ speed: 1.05 })]);
eq(retimed[0].matched, true, "a retimed clip is still matched (the plan knows about it)");
eq(retimed[0].retimed, true, "and flagged as retimed");
has(retimed[0].reason, "105%", "the reason names the actual speed");
has(retimed[0].reason, "by hand", "and says what to do about it");

var reversed = P.matchToTimeline([entry()], [clip({ speed: 1, reversed: true })]);
eq(reversed[0].retimed, true, "a reversed clip counts as retimed too");

eq(P.matchToTimeline([entry()], [clip({ speed: 1 })])[0].retimed, undefined,
   "a 100% clip is not flagged");
eq(P.matchToTimeline([entry()], [clip({ speed: undefined })])[0].matched, true,
   "an unreadable speed is not treated as evidence of a retime");

var retimedRun = P.buildRun([entry()], [clip({ speed: 0.5 })], { ticksPerFrame: TPF_25 });
eq(retimedRun.summary.placeable, 0, "a retimed clip is never placed");
eq(retimedRun.summary.refused, 1, "it is refused");
eq(retimedRun.summary.matchedClips, 1, "and counts as a clip the plan accounted for");
has(retimedRun.refused[0].reason, "50%", "with its speed in the refusal");

// Conforming several tracks at once: an entry that names its track must not
// match a clip on another, and two clips starting at the same moment on
// different tracks must not collide.
var twoTracks = P.matchToTimeline(
  [entry({ start: 10, trackIndex: 1 })],
  [clip({ start: 10, trackIndex: 0 }), clip({ start: 10, trackIndex: 1 })]);
eq(twoTracks[0].matched, true, "an entry matches the clip on ITS track");
eq(twoTracks[0].clip.trackIndex, 1, "and not the one at the same time on another track");

var wrongTrackOnly = P.matchToTimeline(
  [entry({ start: 10, trackIndex: 2 })], [clip({ start: 10, trackIndex: 0 })]);
eq(wrongTrackOnly[0].matched, false, "no clip on the named track is not a match elsewhere");

var keyed = P.buildRun(
  [entry({ start: 10, trackIndex: 0, sourceIn: 0.5, gradedDur: 6 }),
   entry({ start: 10, trackIndex: 1, sourceIn: 0.5, gradedDur: 6 })],
  [clip({ start: 10, trackIndex: 0 }), clip({ start: 10, trackIndex: 1 })],
  { ticksPerFrame: TPF_25 });
eq(keyed.summary.placeable, 2, "both tracks' clips place");
ok(keyed.placements[0].key !== keyed.placements[1].key,
   "clips at the same time on different tracks get different keys");

// Path comparison survives the triple-slash spelling.
var slashy = P.matchToTimeline([entry()], [clip({ path: "///rushes/A007.MOV" })]);
eq(slashy[0].matched, true, "matches across the ///Volumes spelling");

// --- buildRun --------------------------------------------------------------

var entries = [
  entry({ start: 30, dur: 2, sourceIn: 0.48, graded: "/graded/V1-0002_A007.mov", gradedDur: 2.96 }),
  entry({ start: 10, dur: 2, sourceIn: 1.00, graded: "/graded/V1-0002_A007.mov", gradedDur: 2.96 }),
  entry({ start: 50, dur: 2, status: "MISSING", graded: null, sourceIn: null })
];
var clips = [clip({ start: 10 }), clip({ start: 30 }), clip({ start: 50 })];
var run = P.buildRun(entries, clips, { ticksPerFrame: TPF_25 });

eq(run.summary.planned, 3, "counts what was planned");
eq(run.summary.placeable, 2, "two are placeable");
eq(run.summary.refused, 1, "one is refused");
eq(run.placements[0].start, 10, "placements come back in timeline order");
eq(run.placements[1].start, 30, "...ascending");
eq(run.refused[0].name, "A007.MOV", "the refusal names the shot");
has(run.refused[0].reason, "no graded file", "and carries its reason");

// A refused clip is one the plan KNOWS about; it must not be counted as a clip
// the plan never mentioned, or the panel reports refusals as "left alone".
eq(run.summary.matchedClips, 3, "counts every clip the plan accounted for, placed or refused");
var allRefused = P.buildRun(
  [entry({ start: 10, status: "MISSING", graded: null, sourceIn: null })],
  [clip({ start: 10 })], { ticksPerFrame: TPF_25 });
eq(allRefused.summary.matchedClips, 1, "a refused clip still counts as matched");
eq(allRefused.summary.placeable, 0, "and is not placeable");

eq(run.files.length, 1, "one import for a file serving two cuts");
eq(run.summary.reused, 1, "and says how many placements reuse an import");
eq(run.files[0], "/graded/V1-0002_A007.mov", "the import list is normalised paths");

ok(run.placements[0].startTicks % TPF_25 === 0, "start lands on the frame grid");
ok(run.placements[0].sourceInTicks % TPF_25 === 0, "sourceIn lands on the frame grid");
ok(run.placements[0].sourceOutTicks > run.placements[0].sourceInTicks, "out is after in");
eq(run.placements[0].sourceOutTicks - run.placements[0].sourceInTicks,
   P.alignToFrame(P.secondsToTicks(3), TPF_25) - P.alignToFrame(P.secondsToTicks(1), TPF_25),
   "the marked range is exactly the cut's length");

// The timeline is the authority on where and how long.
var stale = P.buildRun([entry({ start: 10, dur: 2 })], [clip({ start: 10, dur: 2.0001 })],
                       { ticksPerFrame: TPF_25, durToleranceSeconds: 0.04 });
eq(stale.placements.length, 1, "a sub-frame difference still places");
eq(stale.placements[0].dur, 2.0001, "and takes its duration from the CLIP, not the plan");

// --- verificationKit -------------------------------------------------------

var kitRun = P.buildRun(
  [entry({ start: 10, dur: 4, sourceIn: 0.5, gradedDur: 6 }),
   entry({ start: 30, dur: 0.24, sourceIn: 0, gradedDur: 0.24 })],
  [clip({ start: 10, dur: 4 }), clip({ start: 30, dur: 0.24 })],
  { ticksPerFrame: TPF_25 });
var kit = P.verificationKit(kitRun, { fps: 25, frameSeconds: 0.04 });
eq(kit.clips.length, 2, "a kit entry per placement");
eq(kit.clips[0].key, kitRun.placements[0].key, "keyed the same as the placement");
ok(kit.clips[0].probes.length >= 3, "a long cut gets several probes");
ok(kit.clips[0].probes.every(function (t) { return t < 4; }), "probes stay inside the cut");
// Never the first frame: on real clips a probe at 0.0 scored 0.15 and 0.34
// (the head of a cut is often a dissolve) while probes a few frames later
// scored 0.93 and 0.96 on the same shots.
ok(kit.clips[0].probes.every(function (t) { return t > 0; }), "no probe sits on the cut's first frame");
// Spread across the cut: clustered probes agreed on the wrong framing for a
// clip whose first second was transitional.
eq(kit.clips[0].probes, [0.6, 1.8, 3], "probes are spread across the cut");
ok(kit.clips[0].probes[2] - kit.clips[0].probes[0] > kit.clips[0].dur * 0.4,
   "the spread covers most of the cut");
// A 6-frame cut has almost nowhere to put them: both land inside it, and the
// matcher needs two agreeing before it will confirm anything.
eq(kit.clips[1].probes.length, 2, "a 6-frame cut still gets two probes");
ok(kit.clips[1].probes.every(function (t) { return t <= 0.24 - 0.04; }),
   "and neither runs into its last frame");
eq(kit.clips[0].room, 2, "room is the graded file's spare length");
// Zero room is a real answer - the graded file IS the cut - and must not be
// turned into null by a falsy-value shortcut, or the matcher has no range.
var zeroRoom = P.verificationKit(P.buildRun(
  [entry({ start: 10, dur: 2, sourceIn: 0, gradedDur: 2 })],
  [clip({ start: 10, dur: 2 })], { ticksPerFrame: TPF_25 }), { fps: 25 });
eq(zeroRoom.clips[0].room, 0, "a graded file that is exactly the cut has room 0, not null");

// --- applyVerification -----------------------------------------------------

function verdictRun() {
  return P.buildRun(
    [entry({ start: 10, sourceIn: 0.5, gradedDur: 6 }), entry({ start: 30, sourceIn: 0.5, gradedDur: 6 }),
     entry({ start: 50, sourceIn: 0.5, gradedDur: 6 }), entry({ start: 70, sourceIn: 0.5, gradedDur: 6 })],
    [clip({ start: 10 }), clip({ start: 30 }), clip({ start: 50 }), clip({ start: 70 })],
    { ticksPerFrame: TPF_25 });
}
var base = verdictRun();
var keys = base.placements.map(function (p) { return p.key; });
var verified = P.applyVerification(base, { verdicts: [
  { key: keys[0], verdict: "confirmed", measured: 0.5 },
  { key: keys[1], verdict: "disputed", measured: 1.2, note: "the picture puts the cut at 1.200s, the plan says 0.500s - 17.5 frames apart" },
  { key: keys[2], verdict: "retimed", note: "the match slides 5.0% across the cut" },
  { key: keys[3], verdict: "static", note: "locked-off shot" }
] });

eq(verified.summary.placeable, 2, "confirmed and static are placed");
eq(verified.summary.refused, 2, "disputed and retimed are refused");
eq(verified.verification.counts.confirmed, 1, "counts the confirmations");
eq(verified.verification.counts.static, 1, "counts the static shots");
has(verified.refused[0].reason, "picture disagrees", "a disputed clip says the picture disagrees");
has(verified.refused[0].reason, "17.5 frames", "and carries the matcher's own numbers");
has(verified.refused[1].reason, "cannot set a clip's speed", "a retimed verdict explains the limit");

// A single strong probe agreeing with the plan is corroboration, not proof -
// it places, and is NOT listed among the clips nothing could confirm.
var corrob = P.applyVerification(verdictRun(), { verdicts: [
  { key: keys[0], verdict: "corroborated", measured: 0.5, note: "one probe matched strongly (0.96)" }
] });
eq(corrob.verification.counts.corroborated, 1, "corroborated is counted separately");
eq(corrob.summary.placeable, 4, "and the clip still places");
eq(corrob.verification.unverified.filter(function (u) { return u.start === 10; }).length, 0,
   "a corroborated clip is not listed as unproved");

// Verification failing to PROVE something is not evidence against it: the
// timecode answer is still exact arithmetic. Place it, and name it.
var inconclusive = P.applyVerification(verdictRun(), { verdicts: [
  { key: keys[0], verdict: "inconclusive", note: "probes disagree by 0.40s" }
] });
eq(inconclusive.summary.placeable, 4, "inconclusive and unchecked clips are still placed");
eq(inconclusive.verification.counts.inconclusive, 1, "the inconclusive one is counted");
eq(inconclusive.verification.counts.unchecked, 3, "and so are the ones with no verdict");
eq(inconclusive.verification.unverified.length, 4, "all four are listed for the editor");
has(inconclusive.verification.unverified[0].why, "probes disagree", "carrying the matcher's reason");

// Refusals from the Check survive verification rather than being dropped.
var withRefusals = P.buildRun(
  [entry({ start: 10, sourceIn: 0.5, gradedDur: 6 }), entry({ start: 50, status: "MISSING", graded: null, sourceIn: null })],
  [clip({ start: 10 }), clip({ start: 50 })], { ticksPerFrame: TPF_25 });
var kept = P.applyVerification(withRefusals, { verdicts: [
  { key: withRefusals.placements[0].key, verdict: "confirmed" }
] });
eq(kept.summary.refused, 1, "an earlier refusal is still refused after verification");
eq(kept.summary.placeable, 1, "and the confirmed clip still places");

// Two cuts from one file, one of them disputed: the import list must shrink.
var shareRun = P.buildRun(
  [entry({ start: 10, sourceIn: 0.5, gradedDur: 6, graded: "/graded/one.mov" }),
   entry({ start: 30, sourceIn: 2.0, gradedDur: 6, graded: "/graded/one.mov" })],
  [clip({ start: 10 }), clip({ start: 30 })], { ticksPerFrame: TPF_25 });
eq(shareRun.files.length, 1, "one file for two cuts before verification");
var shareVerified = P.applyVerification(shareRun, { verdicts: [
  { key: shareRun.placements[0].key, verdict: "confirmed" },
  { key: shareRun.placements[1].key, verdict: "disputed", note: "x" }
] });
eq(shareVerified.summary.placeable, 1, "the disputed cut is dropped");
eq(shareVerified.files.length, 1, "the file is still imported for the cut that survived");

// --- retimed clips are held back from the planner ---------------------------

var retimedRows = P.retimedRefusals([
  clip({ start: 10, speed: 1 }), clip({ start: 30, speed: 1.2 }),
  clip({ start: 50, speed: 1, reversed: true })
]);
eq(retimedRows.length, 2, "only the retimed clips produce refusals");
has(retimedRows[0].reason, "120%", "the speed is named");
has(retimedRows[1].reason, "reversed", "a reversed clip says so");
eq(retimedRows[0].key, P.keyFor(clip({ start: 30 })), "keyed like every other refusal");

var merged = P.mergeRefusals(
  P.buildRun([entry()], [clip()], { ticksPerFrame: TPF_25 }), retimedRows);
eq(merged.summary.refused, 2, "merged refusals are counted");
eq(merged.refused[0].start, 30, "and sorted into place");

// --- an ambiguous cut is kept as a candidate for the picture to settle ------

function ambiguous(over) {
  return entry(Object.assign({
    status: "AMBIGUOUS", sourceIn: undefined, graded: null,
    candidates: [{ path: "/graded/V2-0001_A002.mov" }, { path: "/graded/V4-0002_A002.mov" }]
  }, over || {}));
}

var amb = P.buildRun([ambiguous()], [clip()], { ticksPerFrame: TPF_25 });
eq(amb.summary.placeable, 0, "an ambiguous cut does not place on its own");
eq(amb.summary.unresolved, 1, "it is held as unresolved");
eq(amb.summary.refused, 1, "and refused until something settles it");
has(amb.refused[0].reason, "pick a version below", "the refusal says how to resolve it");
has(amb.refused[0].reason, "verification match the frame", "...and that verification is the other way");
eq(amb.unresolved[0].candidates.length, 2, "both candidates are carried");

var ambKit = P.verificationKit(amb, { fps: 25, frameSeconds: 0.04 });
eq(ambKit.clips.length, 1, "the kit includes the unresolved cut");
eq(ambKit.clips[0].candidates.length, 2, "with its candidates");
eq(ambKit.clips[0].sourceIn, null, "and no offset - the matcher finds that too");

var settled = P.applyVerification(amb, { verdicts: [{
  key: amb.unresolved[0].key, verdict: "resolved", measured: 0.5, score: 0.93,
  chosenGraded: "/graded/V4-0002_A002.mov", chosenDur: 6,
  note: "the picture chose V4-0002_A002.mov over V2-0001_A002.mov (0.93 vs 0.41)"
}] });
eq(settled.summary.placeable, 1, "a resolved cut becomes a placement");
eq(settled.summary.refused, 0, "and stops being refused");
eq(settled.placements[0].gradedPath, "/graded/V4-0002_A002.mov", "using the file the picture chose");
eq(settled.placements[0].sourceIn, 0.5, "and the offset it measured");
ok(settled.placements[0].sourceInTicks % TPF_25 === 0, "frame-aligned like any other placement");
eq(settled.verification.counts.resolved, 1, "counted as resolved");

// Too close to call stays refused.
var unsettled = P.applyVerification(P.buildRun([ambiguous()], [clip()], { ticksPerFrame: TPF_25 }),
  { verdicts: [{ key: amb.unresolved[0].key, verdict: "inconclusive", note: "too close to call" }] });
eq(unsettled.summary.placeable, 0, "an unresolved ambiguity is still not placed");
eq(unsettled.summary.refused, 1, "it stays refused");

// --- the framing verdict must REACH the Scale correction -------------------
//
// buildRun has to decide the Scale before any frame is compared, so the one
// ambiguous case is left flagged. Measuring the framing is the whole point of
// verification - and applyVerification did not recompute it, so a clip that
// matched at FULL FRAME was still placed at the offline's Scale 100, which on
// 8K media in an HD sequence is a 4x zoom. Verification ran and changed nothing.

var bigEntry = entry({ sourceWidth: 7680, sourceHeight: 4320,
                       gradedWidth: 7680, gradedHeight: 4320 });
var bigClip = clip({ motion: { Scale: { value: 100, keyframed: false } } });
var scaleOpts = { ticksPerFrame: TPF_25, frameWidth: 1920, frameHeight: 1080 };

var beforePicture = P.buildRun([bigEntry], [bigClip], scaleOpts);
eq(beforePicture.placements[0].scaleFix.apply, false,
   "before the picture, Scale 100 on outsized media is flagged not corrected");
ok(!!beforePicture.placements[0].dims,
   "the placement carries the dimensions the recompute needs");

var provenFit = P.applyVerification(
  P.buildRun([bigEntry], [bigClip], scaleOpts),
  { verdicts: [{ key: P.keyFor(bigClip), verdict: "confirmed", framing: "full frame",
                 measured: 0.48 }] }, scaleOpts);
eq(provenFit.placements[0].scaleFix.apply, true,
   "a full-frame match turns the flag into a correction");
eq(provenFit.placements[0].scaleFix.scale, 25, "8K into an HD frame is Scale 25");
eq(provenFit.placements[0].scaleFix.evidence, "picture", "and the evidence is the picture");

var provenPunch = P.applyVerification(
  P.buildRun([bigEntry], [bigClip], scaleOpts),
  { verdicts: [{ key: P.keyFor(bigClip), verdict: "confirmed", framing: "punch-in",
                 measured: 0.48 }] }, scaleOpts);
eq(provenPunch.placements[0].scaleFix.apply, false,
   "a punch-in confirmed by the picture is left at the offline's Scale");
eq(provenPunch.placements[0].scaleFix.scale, 100, "which is the 4x magnification, deliberately");

// A verdict with no framing (resolved, static from a short file) must not
// silently undo a correction that arithmetic had already proved.
var noFraming = P.applyVerification(
  P.buildRun([entry({ sourceWidth: 1920, sourceHeight: 1080,
                      gradedWidth: 7680, gradedHeight: 4320 })],
             [clip({ motion: { Scale: { value: 100, keyframed: false } } })], scaleOpts),
  { verdicts: [{ key: P.keyFor(clip()), verdict: "confirmed", measured: 0.48 }] }, scaleOpts);
eq(noFraming.placements[0].scaleFix.apply, true,
   "a verdict carrying no framing leaves the arithmetic correction standing");

// --- a RESOLVED cut must be scaled like any other --------------------------
//
// The resolved branch built its scaleFix from `verdict.chosenWidth`, a field
// the matcher has never emitted - it reports which FILE won, not how big it
// is. With no dimensions placedScaleFor returns null, so the fit silently did
// not happen. Measured on a real conform: every graded clip landed at Scale 25
// except the two resolved ones, which sat at 100 on 8K media.

function ambiguousWithDims() {
  return entry({
    status: "AMBIGUOUS", sourceIn: undefined, graded: null,
    sourceWidth: 7680, sourceHeight: 4320,
    candidates: [
      { path: "/graded/V1-0001_A002.mov", gradedWidth: 7680, gradedHeight: 4320, gradedDur: 6 },
      { path: "/graded/V4-0002_A002.mov", gradedWidth: 7680, gradedHeight: 4320, gradedDur: 6 }
    ]
  });
}
var bigClip2 = clip({ motion: { Scale: { value: 100, keyframed: false } } });
var dimOpts = { ticksPerFrame: TPF_25, frameWidth: 1920, frameHeight: 1080 };

var ambDims = P.buildRun([ambiguousWithDims()], [bigClip2], dimOpts);
ok(!!ambDims.unresolved[0].candidateInfo, "the candidates' sizes travel with the unresolved cut");
eq(ambDims.unresolved[0].candidateInfo["/graded/V4-0002_A002.mov"].gradedWidth, 7680,
   "keyed by the path the verdict will name");

var resolvedFit = P.applyVerification(ambDims, { verdicts: [{
  key: ambDims.unresolved[0].key, verdict: "resolved", measured: 0.5, score: 0.93,
  framing: "full frame", chosenGraded: "/graded/V4-0002_A002.mov", chosenDur: 6
}] }, dimOpts);
eq(resolvedFit.summary.placeable, 1, "the resolved cut places");
ok(resolvedFit.placements[0].scaleFix !== null,
   "and it HAS a scale correction rather than a silent null");
eq(resolvedFit.placements[0].scaleFix.gradedFit, 25, "8K fits an HD frame at 25");
eq(resolvedFit.placements[0].scaleFix.apply, true, "so Scale 100 is corrected, not carried across");
eq(resolvedFit.placements[0].scaleFix.scale, 25, "to 25");

// --- nothing may fall off a run on its way through verification ------------
//
// applyVerification returns a FRESH object rather than editing the run, which
// is exactly how `versions` went missing: the picker was built, unit-tested
// against hand-made data that happened to carry the field, and unreachable in
// the panel because verification is on by default. A field that silently stops
// existing is invisible until someone looks for the feature and cannot find
// it. So: everything the run carried in comes out, unless it is listed here as
// deliberately dropped, with the reason.
var DROPPED_ON_PURPOSE = {
  unresolved: "emptied - verification is what resolves them",
  planOpts: "the caller re-attaches it",
  frameMatched: "the caller re-attaches it"
};

var shapeIn = P.buildRun([ambiguous(), entry()], [clip(), clip({ start: 30 })],
                         { ticksPerFrame: TPF_25 });
shapeIn.planOpts = { ticksPerFrame: TPF_25 };
shapeIn.frameMatched = true;
var shapeOut = P.applyVerification(shapeIn, { verdicts: [] }, { ticksPerFrame: TPF_25 });
var lost = Object.keys(shapeIn).filter(function (k) {
  return shapeOut[k] === undefined && !DROPPED_ON_PURPOSE[k];
});
if (lost.length) print("      fields lost in applyVerification: " + lost.join(", "));
ok(lost.length === 0, "verification carries every field of the run through");

// --- the version list must SURVIVE verification ----------------------------
//
// applyVerification builds a fresh run object. Leaving `versions` off it made
// the picker disappear the moment verification ran - which is every real run,
// because verification is on by default. The feature was built, tested against
// hand-made data that carried the field, and unreachable in the panel.

var ambRun = P.buildRun([ambiguous()], [clip()], { ticksPerFrame: TPF_25 });
eq(ambRun.summary.versions, 1, "an ambiguous cut is offered before verification");
var ambVerified = P.applyVerification(ambRun, { verdicts: [{
  key: ambRun.unresolved[0].key, verdict: "resolved", measured: 0.5, score: 0.93,
  chosenGraded: "/graded/V4-0002_A002.mov", chosenDur: 6
}] });
eq(ambVerified.summary.versions, 1, "and is STILL offered after it");
eq(ambVerified.versions[0].chosen, "/graded/V4-0002_A002.mov",
   "showing the file the picture settled on");
eq(ambVerified.versions[0].why, "the picture chose it",
   "and saying that something already decided, so this is an override");
eq(ambVerified.versions[0].candidates.filter(function (c) { return c.chosen; }).length, 1,
   "exactly one candidate is flagged as the one in use");

// A hand-picked row is not overwritten by the picture's opinion of it.
var handRun = P.buildRun([ambiguous()], [clip()], {
  ticksPerFrame: TPF_25, chosen: { "t0c10000": "/graded/V2-0001_A002.mov" } });
var handVerified = P.applyVerification(handRun, { verdicts: [] }, { ticksPerFrame: TPF_25 });
eq(handVerified.versions[0].byUser, true, "a hand-picked version stays hand-picked");
eq(handVerified.versions[0].chosen, "/graded/V2-0001_A002.mov", "and keeps the editor's file");

// --- choosing between versions by hand -------------------------------------
//
// Every cut with more than one export is offered, not only the ambiguous ones:
// SUPERSEDED was decided by folder date, which is a good default and an
// invisible one.

function twoRounds(over) {
  return entry(Object.assign({
    status: "SUPERSEDED", graded: "/graded/V2/V1-0007_A007.mov", sourceIn: 0.4, gradedDur: 2.8,
    candidates: [
      { path: "/graded/260407/V1-0004_A007.mov", folder: "260407", sourceIn: 0.2,
        gradedDur: 2.4, method: "timecode" },
      { path: "/graded/V2/V1-0007_A007.mov", folder: "V2", sourceIn: 0.4,
        gradedDur: 2.8, method: "timecode", chosen: true }
    ]
  }, over || {}));
}

var sup = P.buildRun([twoRounds()], [clip()], { ticksPerFrame: TPF_25 });
eq(sup.summary.versions, 1, "a re-graded cut is offered as a choice");
eq(sup.summary.placeable, 1, "while still placing by default");
eq(sup.versions[0].chosen, "/graded/V2/V1-0007_A007.mov", "defaulting to the newest round");
eq(sup.versions[0].why, "newest grade round", "and saying why that one");
eq(sup.versions[0].byUser, false, "nobody chose it by hand");
eq(sup.versions[0].candidates.length, 2, "both rounds are listed");
eq(sup.versions[0].candidates[1].chosen, true, "the default is flagged in the list");
eq(sup.versions[0].candidates[0].folder, "260407", "with the folder that distinguishes them");

// Contested cuts are listed in TIMECODE order, like everything else in the
// report. Track order put 0:25 above 0:11, and a swap went onto the wrong cut.
var manyVersions = P.buildRun(
  [twoRounds({ start: 30 }), twoRounds({ start: 10 }), twoRounds({ start: 20 })],
  [clip({ start: 30, trackIndex: 0 }), clip({ start: 10, trackIndex: 2 }),
   clip({ start: 20, trackIndex: 1 })], { ticksPerFrame: TPF_25 });
eq(manyVersions.versions.map(function (v) { return v.start; }), [10, 20, 30],
   "version rows are ordered by timecode, not by track");

// Picking the older round swaps the file AND its offset - the plan solved
// every candidate, so this needs no re-plan.
var older = P.buildRun([twoRounds()], [clip()], {
  ticksPerFrame: TPF_25,
  chosen: { "t0c10000": "/graded/260407/V1-0004_A007.mov" }
});
eq(older.summary.placeable, 1, "the chosen version places");
eq(older.placements[0].gradedPath, "/graded/260407/V1-0004_A007.mov", "using the file picked");
eq(older.placements[0].sourceIn, 0.2, "and that file's own offset, not the default's");
eq(older.placements[0].gradedDur, 2.4, "and its own duration");
has(older.placements[0].method, "chosen by hand", "the method records who decided");
eq(older.versions[0].byUser, true, "the listing says the choice was made by hand");
eq(older.versions[0].why, "you chose this one", "and why that file is in use");

// The plan's own objects must not be edited: a choice belongs to one run.
var plan1 = twoRounds();
P.buildRun([plan1], [clip()], { ticksPerFrame: TPF_25,
  chosen: { "t0c10000": "/graded/260407/V1-0004_A007.mov" } });
eq(plan1.graded, "/graded/V2/V1-0007_A007.mov", "the plan entry is left as it was");
eq(plan1.sourceIn, 0.4, "offset and all");

// A path spelled either way picks the same file.
var oddPath = P.buildRun([twoRounds()], [clip()], {
  ticksPerFrame: TPF_25, chosen: { "t0c10000": "///graded/260407/V1-0004_A007.mov" }
});
eq(oddPath.placements[0].gradedPath, "/graded/260407/V1-0004_A007.mov",
   "a triple-slash choice still matches");

// --- picking settles an ambiguous cut WITHOUT verification ------------------

function ambWithOffsets(over) {
  return ambiguous(Object.assign({
    candidates: [
      { path: "/graded/V2-0001_A002.mov", folder: "260407", sourceIn: 0.12, gradedDur: 4.84 },
      { path: "/graded/V4-0002_A002.mov", folder: "260407", sourceIn: null, gradedDur: 1.2 }
    ]
  }, over || {}));
}

var offered = P.buildRun([ambWithOffsets()], [clip()], { ticksPerFrame: TPF_25 });
eq(offered.summary.versions, 1, "an ambiguous cut is offered too");
eq(offered.versions[0].chosen, null, "with nothing chosen for it");
eq(offered.versions[0].candidates[0].holds, true, "a long enough candidate can hold the cut");
eq(offered.versions[0].candidates[1].holds, false,
   "one shorter than the cut cannot be it, whatever it looks like");

var byHand = P.buildRun([ambWithOffsets()], [clip()], {
  ticksPerFrame: TPF_25, chosen: { "t0c10000": "/graded/V2-0001_A002.mov" }
});
eq(byHand.summary.placeable, 1, "choosing settles it with no verification at all");
eq(byHand.summary.refused, 0, "and nothing is left refused");
eq(byHand.summary.unresolved, 0, "nor unresolved");
eq(byHand.placements[0].sourceIn, 0.12, "placed at the candidate's own offset");

// Choosing a file whose offset is still unknown is a HALF answer: which file,
// but not where in it. That belongs with the picture, not in the timeline.
var halfway = P.buildRun([ambWithOffsets()], [clip()], {
  ticksPerFrame: TPF_25, chosen: { "t0c10000": "/graded/V4-0002_A002.mov" }
});
eq(halfway.summary.placeable, 0, "a choice without an offset does not place");
eq(halfway.summary.unresolved, 1, "it waits on the picture");
eq(halfway.unresolved[0].candidates.length, 1, "with the list narrowed to the one chosen");
has(halfway.refused[0].reason, "could not work out where", "and says what is still missing");

// A choice that names a file nobody offered is ignored, not obeyed.
var bogus = P.buildRun([twoRounds()], [clip()], {
  ticksPerFrame: TPF_25, chosen: { "t0c10000": "/graded/NOT_A_CANDIDATE.mov" }
});
eq(bogus.placements[0].gradedPath, "/graded/V2/V1-0007_A007.mov", "falls back to the plan's pick");
eq(bogus.versions[0].byUser, false, "and does not claim a hand choice was made");

// A cut with only one export is not a choice, so it is not offered.
var single = P.buildRun([entry({ candidates: [{ path: "/graded/V1-0002_A007.mov" }] })],
                        [clip()], { ticksPerFrame: TPF_25 });
eq(single.summary.versions, 0, "one export is not a decision to make");

eq(P.pickedVersion([{ path: "/a.mov" }], null), null, "no choice picks nothing");
eq(P.pickedVersion([{ path: "/a.mov" }], "/b.mov"), null, "an unknown path picks nothing");

// --- sharedFiles -----------------------------------------------------------

var shared = P.sharedFiles(run.placements);
eq(shared.length, 1, "spots the file serving two cuts");
eq(shared[0].starts, [10, 30], "listing both positions");
eq(P.sharedFiles([run.placements[0]]).length, 0, "a file used once is not shared");

// --- formatSeconds ---------------------------------------------------------

eq(P.formatSeconds(75.5), "1:15.50", "formats as an editor reads it");
eq(P.formatSeconds(5), "0:05.00", "pads the seconds");


// --- "Set to Frame Size" -----------------------------------------------------
// A fitted clip reads Scale 100 while showing the whole frame, and a fresh
// placement does not inherit the flag. Measured: copying that 100 onto 8K media
// in an HD sequence put the offline and placed frames at -0.007 correlation.

eq(P.fitScale(7680, 4320, 1920, 1080), 25, "8K fits an HD frame at 25%");
eq(P.fitScale(1920, 1080, 1920, 1080), 100, "HD media fits at 100%");
eq(P.fitScale(null, 4320, 1920, 1080), null, "unknown dimensions give no answer");

var fitted = P.placedScaleFor({ offlineScale: 100, sourceWidth: 7680, sourceHeight: 4320,
  gradedWidth: 7680, gradedHeight: 4320, frameWidth: 1920, frameHeight: 1080 });
eq(fitted.fitted, true, "Scale 100 on 8K in HD is read as Set to Frame Size");
eq(fitted.scale, 25, "and the placed clip is scaled to fit instead");

var punchIn = P.placedScaleFor({ offlineScale: 27, sourceWidth: 7680, sourceHeight: 4320,
  gradedWidth: 7680, gradedHeight: 4320, frameWidth: 1920, frameHeight: 1080 });
eq(punchIn.fitted, false, "Scale 27 where fit is 25 is a real punch-in");
eq(punchIn.scale, 27, "and it is carried across unchanged");

var hd = P.placedScaleFor({ offlineScale: 100, sourceWidth: 1920, sourceHeight: 1080,
  gradedWidth: 1920, gradedHeight: 1080, frameWidth: 1920, frameHeight: 1080 });
eq(hd.fitted, false, "HD media at 100 is simply filling the frame, not fitted");
eq(hd.scale, 100, "so nothing changes");

// A graded export at a different size from the source still lands correctly.
var upres = P.placedScaleFor({ offlineScale: 100, sourceWidth: 7680, sourceHeight: 4320,
  gradedWidth: 3840, gradedHeight: 2160, frameWidth: 1920, frameHeight: 1080 });
eq(upres.scale, 50, "a UHD graded export of 8K source fits at 50%");

// Verification's own framing result outranks the arithmetic where it exists.
var saysPunch = P.placedScaleFor({ offlineScale: 100, sourceWidth: 7680, sourceHeight: 4320,
  gradedWidth: 7680, gradedHeight: 4320, frameWidth: 1920, frameHeight: 1080,
  verifiedFraming: "punch-in" });
eq(saysPunch.fitted, false, "the picture saying punch-in overrules the 100 reading");
eq(saysPunch.scale, 100, "so the 4x magnification is preserved deliberately");

eq(P.placedScaleFor({ offlineScale: 100, frameWidth: 1920, frameHeight: 1080 }), null,
   "no media dimensions, no correction - it is not guessed");


// Arithmetic alone must not trigger a refit: measured, one clip of three at
// Scale 100 was a deliberate 4x punch-in, and "correcting" it replaced a
// close-up with the wide shot.
var inferred = P.placedScaleFor({ offlineScale: 100, sourceWidth: 7680, sourceHeight: 4320,
  gradedWidth: 7680, gradedHeight: 4320, frameWidth: 1920, frameHeight: 1080 });
eq(inferred.fitted, true, "arithmetic still suspects Set to Frame Size");
eq(inferred.evidence, "arithmetic", "and says where that reading came from");
eq(inferred.apply, false, "but it is NOT applied without the picture");

var proven = P.placedScaleFor({ offlineScale: 100, sourceWidth: 7680, sourceHeight: 4320,
  gradedWidth: 7680, gradedHeight: 4320, frameWidth: 1920, frameHeight: 1080,
  verifiedFraming: "full frame" });
eq(proven.apply, true, "the picture matching at full frame authorises the refit");
eq(proven.evidence, "picture", "and the evidence is recorded");
eq(proven.scale, 25, "refitting 8K into an HD frame means Scale 25");

var realPunchIn = P.placedScaleFor({ offlineScale: 100, sourceWidth: 7680, sourceHeight: 4320,
  gradedWidth: 7680, gradedHeight: 4320, frameWidth: 1920, frameHeight: 1080,
  verifiedFraming: "punch-in" });
eq(realPunchIn.apply, false, "a punch-in confirmed by the picture is left alone");

// A GRADED EXPORT OF A DIFFERENT SIZE needs no picture to settle it.
//
// Measured on the job it was built on: an HD comp sitting at Scale 100 - filling the
// frame exactly, nothing fitted about it - came back from the grade as an 8K
// export. Scale 100 on that file is a 4x zoom into the top-left. This is pure
// arithmetic with no Set-to-Frame-Size ambiguity anywhere in it, and gating it
// behind the picture meant the clip was neither corrected nor even flagged.
var regraded = P.placedScaleFor({ offlineScale: 100, sourceWidth: 1920, sourceHeight: 1080,
  gradedWidth: 7680, gradedHeight: 4320, frameWidth: 1920, frameHeight: 1080 });
eq(regraded.fitted, false, "an HD clip at 100 was filling the frame, not fitted to it");
eq(regraded.guessing, false, "and there is nothing to guess about");
eq(regraded.scale, 25, "the 8K graded export needs Scale 25 to show the same framing");
eq(regraded.apply, true, "so it is corrected without waiting for the picture");
has(regraded.why, "different size from the source", "and says why it was changed");

// Where the Scale already means the same thing, nothing is applied.
eq(hd.apply, false, "matching media sizes need no correction");
has(hd.why, "already means the same thing", "and say so rather than going quiet");

// The one genuine ambiguity is still refused without the picture.
eq(inferred.guessing, true, "Scale 100 on outsized media is flagged as a guess");
eq(proven.guessing, false, "the picture removes the guess");
has(inferred.why, "only the picture can tell", "and the flag explains itself");

print("");
print(passed + " passed, " + failed + " failed");
if (failed > 0) throw new Error(failed + " test(s) failed");
