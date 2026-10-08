/**
 * Tests for js/naming.js. No Node on this machine, so this runs under jsc:
 *   scripts/run-tests.sh
 *
 * jsc has load() and print(); it has no require(), which is why naming.js also
 * hangs itself on globalThis.
 */

load("js/naming.js");
var N = GMPNaming;

var passed = 0;
var failed = 0;

function eq(actual, expected, label) {
  var a = JSON.stringify(actual);
  var e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    print("FAIL  " + label + "\n      expected " + e + "\n      got      " + a);
  }
}

function throws(fn, label) {
  try {
    fn();
    failed++;
    print("FAIL  " + label + " (expected a throw, got none)");
  } catch (e) {
    passed++;
  }
}

// --- applySuffix -----------------------------------------------------------

eq(N.applySuffix("MyEdit", "_FOR_GRADE"), "MyEdit_FOR_GRADE", "appends the suffix");
eq(N.applySuffix("MyEdit", ""), "MyEdit", "empty suffix is a no-op");
eq(N.applySuffix("MyEdit", "   "), "MyEdit", "whitespace-only suffix is a no-op");
eq(N.applySuffix("  MyEdit  ", "_REF"), "MyEdit_REF", "source name is trimmed");
eq(N.applySuffix("MyEdit", "  _REF  "), "MyEdit_REF", "suffix is trimmed");
eq(N.applySuffix("MyEdit", "REF"), "MyEditREF", "no underscore is invented for the editor");

// The realistic mistake: running the panel on an output it already made.
eq(N.applySuffix("MyEdit_FOR_GRADE", "_FOR_GRADE"), "MyEdit_FOR_GRADE",
   "does not double-suffix an already-prepped sequence");
eq(N.applySuffix("MyEdit_FOR_GRADE_v03", "_FOR_GRADE"), "MyEdit_FOR_GRADE",
   "strips the version stamp before checking for a double suffix");
eq(N.applySuffix("MyEdit_FOR_MIX", "_FOR_GRADE"), "MyEdit_FOR_MIX_FOR_GRADE",
   "a DIFFERENT suffix still appends - mix output prepped for grade");

// A real house name, to be sure the convention survives.
eq(N.applySuffix("VR_ChristmasCampaign_Teaser_8_MASTER_ENG_9x16_V1", "_FOR_GRADE"),
   "VR_ChristmasCampaign_Teaser_8_MASTER_ENG_9x16_V1_FOR_GRADE",
   "house naming convention passes through, trailing _V1 untouched");

// --- splitVersion ----------------------------------------------------------

eq(N.splitVersion("MyEdit_FOR_GRADE"), { stem: "MyEdit_FOR_GRADE", version: null },
   "no version stamp");
eq(N.splitVersion("MyEdit_FOR_GRADE_v02"), { stem: "MyEdit_FOR_GRADE", version: 2 },
   "reads _v02");
eq(N.splitVersion("MyEdit_FOR_GRADE_v100"), { stem: "MyEdit_FOR_GRADE", version: 100 },
   "reads three digits");
eq(N.splitVersion("Teaser_v1"), { stem: "Teaser_v1", version: null },
   "single-digit _v1 is the editor's own name, not ours");

// --- resolveName -----------------------------------------------------------

eq(N.resolveName("MyEdit_FOR_GRADE", []),
   { name: "MyEdit_FOR_GRADE", version: null, collided: false },
   "free name is used as-is");

eq(N.resolveName("MyEdit_FOR_GRADE", ["Something else"]),
   { name: "MyEdit_FOR_GRADE", version: null, collided: false },
   "unrelated names do not collide");

eq(N.resolveName("MyEdit_FOR_GRADE", ["MyEdit_FOR_GRADE"]),
   { name: "MyEdit_FOR_GRADE_v02", version: 2, collided: true },
   "first collision goes to _v02");

eq(N.resolveName("MyEdit_FOR_GRADE", ["MyEdit_FOR_GRADE", "MyEdit_FOR_GRADE_v02"]),
   { name: "MyEdit_FOR_GRADE_v03", version: 3, collided: true },
   "second collision goes to _v03");

// The gap case: _v02 was deleted from the project, but its XML may still be on
// the grade drive. Continue past the highest, do not backfill the hole.
eq(N.resolveName("MyEdit_FOR_GRADE", ["MyEdit_FOR_GRADE", "MyEdit_FOR_GRADE_v03"]),
   { name: "MyEdit_FOR_GRADE_v04", version: 4, collided: true },
   "versions continue past the highest rather than filling a deleted gap");

eq(N.resolveName("MyEdit_FOR_GRADE", ["myedit_for_grade"]),
   { name: "MyEdit_FOR_GRADE_v02", version: 2, collided: true },
   "collision check is case-insensitive");

eq(N.resolveName("MyEdit_FOR_GRADE", ["MyEdit_FOR_GRADE", "MyEdit_FOR_GRADE_v09"]),
   { name: "MyEdit_FOR_GRADE_v10", version: 10, collided: true },
   "crosses from two digits to double figures");

eq(N.resolveName("MyEdit_FOR_GRADE", ["MyEdit_FOR_GRADE", "MyEdit_FOR_GRADE_v99"]),
   { name: "MyEdit_FOR_GRADE_v100", version: 100, collided: true },
   "crosses 99 into three digits");

// Grade and Mix outputs of the same source must not version off each other.
eq(N.resolveName("MyEdit_FOR_MIX", ["MyEdit_FOR_GRADE", "MyEdit_FOR_GRADE_v02"]),
   { name: "MyEdit_FOR_MIX", version: null, collided: false },
   "a different suffix has its own version series");

eq(N.resolveName("  MyEdit_FOR_GRADE  ", [" MyEdit_FOR_GRADE "]),
   { name: "MyEdit_FOR_GRADE_v02", version: 2, collided: true },
   "surrounding whitespace is ignored on both sides");

// --- planName --------------------------------------------------------------

eq(N.planName("MyEdit", "_FOR_GRADE", ["MyEdit_FOR_GRADE"]),
   { name: "MyEdit_FOR_GRADE_v02", version: 2, collided: true },
   "planName joins applySuffix and resolveName");

// Re-running the panel on its own output, twice over.
eq(N.planName("MyEdit_FOR_GRADE_v02", "_FOR_GRADE",
              ["MyEdit_FOR_GRADE", "MyEdit_FOR_GRADE_v02"]),
   { name: "MyEdit_FOR_GRADE_v03", version: 3, collided: true },
   "re-prepping an output lands on the next version, not a doubled suffix");

// --- toFileStem ------------------------------------------------------------

eq(N.toFileStem("MyEdit_FOR_GRADE"), "MyEdit_FOR_GRADE", "clean name is unchanged");
eq(N.toFileStem("16:9 / Master"), "16-9 - Master", "colon and slash are replaced");
eq(N.toFileStem("Edit  with   spaces"), "Edit with spaces", "runs of spaces collapse");
eq(N.toFileStem("Trailing dots..."), "Trailing dots", "trailing dots are dropped");

// --- limits ----------------------------------------------------------------

throws(function () {
  var many = ["Edit_FOR_GRADE"];
  for (var i = 2; i <= 999; i++) many.push("Edit_FOR_GRADE" + N.formatVersion(i));
  N.resolveName("Edit_FOR_GRADE", many);
}, "throws rather than looping forever once versions are exhausted");

// ---------------------------------------------------------------------------

print("");
print(passed + " passed, " + failed + " failed");
if (failed > 0) throw new Error(failed + " test(s) failed");

// --- The Conformer's case (2026-10-08) ---------------------------------------
// A second conform of the same offline used to make a SECOND sequence called
// exactly "<offline>_GRADED". It must version up, and re-conforming an already
// conformed sequence must not stack the suffix.
var C = N.planName("ZZ_CONFORM_TEST_16x9", "_GRADED", ["ZZ_CONFORM_TEST_16x9", "ZZ_CONFORM_TEST_16x9_GRADED"]);
eq(C.name, "ZZ_CONFORM_TEST_16x9_GRADED_v02", "a second conform is _v02, not a duplicate name");
eq(C.collided, true, "and says it versioned up");
eq(N.planName("ZZ_CONFORM_TEST_16x9", "_GRADED",
              ["ZZ_CONFORM_TEST_16x9_GRADED", "ZZ_CONFORM_TEST_16x9_GRADED"]).name,
   "ZZ_CONFORM_TEST_16x9_GRADED_v02", "two same-named leftovers from before the fix still give _v02");
eq(N.planName("ZZ_CONFORM_TEST_16x9", "_GRADED", ["zz_conform_test_16x9_graded", "ZZ_CONFORM_TEST_16x9_GRADED_v02"]).name,
   "ZZ_CONFORM_TEST_16x9_GRADED_v03", "case-insensitive, and past the highest version");
eq(N.planName("ZZ_CONFORM_TEST_16x9_GRADED_v02", "_GRADED", ["ZZ_CONFORM_TEST_16x9_GRADED", "ZZ_CONFORM_TEST_16x9_GRADED_v02"]).name,
   "ZZ_CONFORM_TEST_16x9_GRADED_v03", "conforming a conform does not stack _GRADED_GRADED");
print((failed ? "FAILED " : "ok ") + passed + " passed, " + failed + " failed (with the Conformer's cases)");
if (failed) throw new Error(failed + " failed");
