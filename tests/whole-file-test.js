/**
 * Tests for the two modes that place a WHOLE file against a sequence:
 * a single graded master, and mix stems.
 *
 * Both ask the same question - the file is supposed to BE this sequence, so
 * where does the sequence's first frame sit inside it - and both have the same
 * way of going quietly wrong: a head handle nobody mentioned puts every frame
 * out by the same amount, and it looks perfectly fine until someone checks a
 * sync point. So the evidence that decided the offset is carried on every
 * placement, and "I assumed" is said out loud rather than implied.
 *
 * Runs under jsc; there is no Node on this machine.
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

var TPF_25 = 10160640000;        // 25fps
var FRAME = 0.04;
var SEQ = 85.04;                 // the offline it was built on, measured
var ZERO = 3600;                 // its zero point: 01:00:00:00, measured

// --- alignWhole: timecode is the evidence that needs no assumption ---------

var flush = P.alignWhole({ fileDur: SEQ, fileStartTC: ZERO, seqDur: SEQ, seqZero: ZERO,
                           frameSeconds: FRAME });
eq(flush.ok, true, "a master whose start TC matches the sequence zero point fits");
eq(flush.sourceIn, 0, "and starts at its own first frame");
eq(flush.method, "timecode", "decided by timecode, not by length");
eq(flush.warnings, [], "with nothing to warn about");

// A render with handles: it starts EARLIER than the sequence, so the
// sequence's first frame is some way into it.
var handled = P.alignWhole({ fileDur: SEQ + 4, fileStartTC: ZERO - 2, seqDur: SEQ, seqZero: ZERO,
                             frameSeconds: FRAME });
eq(handled.ok, true, "a master with handles either side still fits");
eq(handled.sourceIn, 2, "and the head handle is exactly the timecode difference");

// This is the failure the mode exists to prevent: same file, no timecode.
var blind = P.alignWhole({ fileDur: SEQ + 4, seqDur: SEQ, seqZero: ZERO, frameSeconds: FRAME });
eq(blind.ok, true, "without timecode it is still placed");
eq(blind.sourceIn, 0, "from its first frame");
has(blind.method, "assumed", "but the method says the offset was assumed");
has(blind.warnings.join(" "), "handle at the head",
    "and it names the exact way that assumption goes wrong");

// A file that begins after the sequence cannot cover the opening, whatever
// its length.
var late = P.alignWhole({ fileDur: SEQ + 10, fileStartTC: ZERO + 3, seqDur: SEQ, seqZero: ZERO,
                          frameSeconds: FRAME });
eq(late.ok, false, "a file starting after the sequence is refused");
has(late.reason, "AFTER the sequence", "and says so plainly");

var short = P.alignWhole({ fileDur: SEQ - 5, fileStartTC: ZERO, seqDur: SEQ, seqZero: ZERO,
                           frameSeconds: FRAME });
eq(short.ok, false, "a file too short to reach the end is refused");
has(short.reason, "too short", "and says which way it is wrong");

// Short by less than a frame is not short.
var hair = P.alignWhole({ fileDur: SEQ - 0.02, fileStartTC: ZERO, seqDur: SEQ, seqZero: ZERO,
                          frameSeconds: FRAME });
eq(hair.ok, true, "half a frame under is rounding, not a short file");

// Handles plus a timecode that eats the tail.
var eaten = P.alignWhole({ fileDur: SEQ + 1, fileStartTC: ZERO - 3, seqDur: SEQ, seqZero: ZERO,
                           frameSeconds: FRAME });
eq(eaten.ok, false, "a head offset that runs the cut off the end is refused");
has(eaten.reason, "starting", "and reports the offset it was working from");

// The self-proving case: no timecode, but the file IS the sequence.
var exact = P.alignWhole({ fileDur: SEQ, seqDur: SEQ, seqZero: ZERO, frameSeconds: FRAME });
eq(exact.ok, true, "an exact-length file with no timecode fits");
has(exact.method, "exact length", "and proves its own offset");
eq(exact.warnings, [], "so there is nothing to assume and nothing to warn about");

var stumpy = P.alignWhole({ fileDur: 10, seqDur: SEQ, seqZero: ZERO, frameSeconds: FRAME });
eq(stumpy.ok, false, "a short file with no timecode is still refused");

eq(P.alignWhole({ seqDur: SEQ, seqZero: ZERO }).ok, false, "no duration, no placement");
has(P.alignWhole({ seqDur: SEQ }).reason, "duration", "and it says what was missing");
eq(P.alignWhole({ fileDur: SEQ, seqDur: 0 }).ok, false, "a sequence with no duration is refused");

// --- stemLabel -------------------------------------------------------------

eq(P.stemLabel("/m/1000_Film_MAINCUT_85_MIX_FullMix_V1.wav"), "Full Mix", "FullMix");
eq(P.stemLabel("/m/1000_Film_MAINCUT_85_MIX_Music_V1.wav"), "Music", "Music");
eq(P.stemLabel("/m/1000_Film_MAINCUT_85_MIX_SFX_V1.wav"), "SFX", "SFX");
eq(P.stemLabel("/m/1000_Film_MAINCUT_85_MIX_VO_V1.wav"), "VO", "VO");
eq(P.stemLabel("/m/Film_DX_v3.wav"), "Dialogue", "DX is dialogue");
eq(P.stemLabel("/m/Film_MX_v3.wav"), "Music", "MX is music");
eq(P.stemLabel("/m/Film - Full Mix - v2.wav"), "Full Mix", "spaces and dashes separate too");
eq(P.stemLabel("/m/Film_Ambience.wav"), "Ambience", "Ambience");
// "full mix" must win over the "mix" inside it.
eq(P.stemLabel("/m/Film_Fullmix.wav"), "Full Mix", "fullmix is not just a mix");
// A word boundary, not a substring: this must NOT read as VO.
eq(P.stemLabel("/m/Provo_Sessions_Reel.wav"), "Provo_Sessions_Reel",
   "a stem word inside another word is not a match");
eq(P.stemLabel("/m/Something_Unlabelled.wav"), "Something_Unlabelled",
   "an unrecognised stem keeps its own name rather than being guessed at");

// --- masterPlan ------------------------------------------------------------

var mp = P.masterPlan({ path: "/g/FILM_MASTER_V1.mov", fileDur: SEQ, fileStartTC: ZERO,
                        seqDur: SEQ, seqZero: ZERO, ticksPerFrame: TPF_25, trackIndex: 5 });
eq(mp.summary.placeable, 1, "a clean master places");
eq(mp.placements[0].trackIndex, 5, "onto the spare track it was given");
eq(mp.placements[0].start, 0, "flush to the start of the sequence");
eq(mp.placements[0].dur, SEQ, "for the whole programme");
eq(mp.placements[0].startTicks, 0, "at tick zero");
ok(mp.placements[0].sourceOutTicks % TPF_25 === 0, "frame-aligned out point");
eq(mp.files.length, 1, "one file to import");

var mpShort = P.masterPlan({ path: "/g/SHORT.mov", fileDur: 10, fileStartTC: ZERO,
                             seqDur: SEQ, seqZero: ZERO, ticksPerFrame: TPF_25, trackIndex: 5 });
eq(mpShort.summary.placeable, 0, "a short master places nothing");
eq(mpShort.summary.refused, 1, "and is refused by name");
eq(mpShort.refused[0].name, "SHORT.mov", "with the filename the editor will recognise");

// --- stemsPlan -------------------------------------------------------------

function stemSet(over) {
  var files = [
    { path: "/m/F_MIX_SFX_V1.wav", dur: SEQ, startTC: ZERO },
    { path: "/m/F_MIX_FullMix_V1.wav", dur: SEQ, startTC: ZERO },
    { path: "/m/F_MIX_VO_V1.wav", dur: SEQ, startTC: ZERO },
    { path: "/m/F_MIX_Music_V1.wav", dur: SEQ, startTC: ZERO }
  ];
  return P.stemsPlan(Object.assign({ files: files, seqDur: SEQ, seqZero: ZERO,
                                     ticksPerFrame: TPF_25, trackIndex: 3 }, over || {}));
}

var sp = stemSet();
eq(sp.summary.placeable, 4, "all four stems place");
eq(sp.placements.map(function (p) { return p.label; }),
   ["FullMix", "VO", "Music", "SFX"],
   "named from what differs across the set, in the order a mixer hands them over");
eq(sp.placements.map(function (p) { return p.trackIndex; }), [3, 4, 5, 6],
   "one per track, counting up from the first spare");
eq(sp.placements[0].start, 0, "every stem is flush to the start");
eq(sp.placements[0].dur, SEQ, "and runs the length of the programme");

// A stem shorter than the rest of the set, but still long enough to cover the
// programme - stems are often delivered with a tail. Placeable, and worth
// saying out loud, because one short stem among several is usually a render
// that stopped early.
var ragged = stemSet({ files: [
  { path: "/m/F_MIX_FullMix_V1.wav", dur: SEQ + 3, startTC: ZERO },
  { path: "/m/F_MIX_Music_V1.wav", dur: SEQ, startTC: ZERO }
] });
eq(ragged.summary.placeable, 2, "a shorter stem still places where it covers the programme");
eq((ragged.placements[0].warnings || []).length, 0, "the full-length one says nothing");
has((ragged.placements[1].warnings || []).join(" "), "shorter than the longest",
    "the short one is called out against the set");

// A stem that cannot be placed must not take the others down with it.
var oneBad = stemSet({ files: [
  { path: "/m/F_MIX_FullMix_V1.wav", dur: SEQ, startTC: ZERO },
  { path: "/m/F_MIX_Music_V1.wav", dur: 3, startTC: ZERO }
] });
eq(oneBad.summary.placeable, 1, "the good stem still places");
eq(oneBad.summary.refused, 1, "and the unusable one is refused on its own");
eq(oneBad.refused[0].label, "Music", "named by the stem it was meant to be");

// --- labelling a REAL delivery ---------------------------------------------
//
// A word list cannot do this. Measured on an actual mix: "MIX MINUS MUSIC" is
// the mix with the music TAKEN OUT, and matching the word "music" labelled it
// the Music stem - so a mixer pulling that track would get the opposite of
// what they asked for. Two more stems collapsed onto the same name with it.
var REAL = ["BACKGROUNDS", "M+E", "MIX MINUS MUSIC", "MUSIC DIPPED",
            "MUSIC UNDIPPED", "SFX", "SYNC"]
  .map(function (n) { return "/m/Film Title - V3 " + n + ".wav"; });
eq(P.stemLabels(REAL),
   ["BACKGROUNDS", "M+E", "MIX MINUS MUSIC", "MUSIC DIPPED", "MUSIC UNDIPPED", "SFX", "SYNC"],
   "a real set is named by what differs, not by a word that happens to appear");

// Without a word-boundary rule these two share the ending "DIPPED" and come
// out as "" and "UN".
eq(P.stemLabels(["/m/X MUSIC DIPPED.wav", "/m/X MUSIC UNDIPPED.wav"]), ["DIPPED", "UNDIPPED"],
   "a shared affix is only stripped where it lands on a separator");

eq(P.stemLabels(["/m/Film_MIX_Music_V1.wav", "/m/Film_MIX_Music_V2.wav",
                 "/m/Film_MIX_SFX_V1.wav"]), ["Music_V1", "Music_V2", "SFX_V1"],
   "two versions of one stem stay distinguishable");

eq(P.stemLabels(["/m/Just_The_One.wav"]), ["Just_The_One"], "a single stem keeps its own name");

// A negation must not sort beside the thing it excludes.
var realPlan = P.stemsPlan({ files: REAL.map(function (x) { return { path: x, dur: SEQ }; }),
  seqDur: SEQ, seqZero: ZERO, ticksPerFrame: TPF_25, trackIndex: 1 });
eq(realPlan.summary.placeable, 7, "all seven real stems place");
eq(realPlan.placements.map(function (p) { return p.label; }),
   ["SYNC", "MUSIC DIPPED", "MUSIC UNDIPPED", "SFX", "BACKGROUNDS", "M+E", "MIX MINUS MUSIC"],
   "dialogue, music, effects, atmos - and the mix-minus last, not beside Music");

eq(P.stemsPlan({ files: [], seqDur: SEQ, seqZero: ZERO, ticksPerFrame: TPF_25 }).summary.placeable,
   0, "no stems, no placements, no crash");

print("");
print(passed + " passed, " + failed + " failed");
if (failed > 0) throw new Error(failed + " test(s) failed");
