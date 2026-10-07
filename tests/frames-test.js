/**
 * Reference frames under Premiere 25.6.6's naming.
 *
 * Asked for `ref_x.png`, Premiere 26 writes `ref_x.png` but Premiere 25.6.6
 * writes `ref_x.png.png`. The panel only looked for the first, so on 2025 the
 * kit shipped with no reference frames and every cut came back inconclusive.
 * landedAs() is what accepts both - tested here against the real module.
 */
var module = { exports: {} };
(new Function("module", "exports", "require", readFile("js/ppro.js")))(
  module, module.exports, function (name) { throw new Error("no host module: " + name); });
var P = module.exports;

var passed = 0, failed = 0;
function eq(actual, expected, label) {
  if (actual === expected) passed++;
  else { failed++; print("FAIL  " + label + "\n      expected " + expected + "\n      got      " + actual); }
}

eq(P.landedAs({ "ref_t0c0_594.png": true }, "ref_t0c0_594.png"), "ref_t0c0_594.png", "Premiere 26: the name asked for");
eq(P.landedAs({ "ref_t0c0_594.png.png": true }, "ref_t0c0_594.png"), "ref_t0c0_594.png.png", "Premiere 25.6.6: the doubled extension is found");
eq(P.landedAs({ "ref_t0c0_594.png": true, "ref_t0c0_594.png.png": true }, "ref_t0c0_594.png"), "ref_t0c0_594.png", "both present: the clean name wins");
eq(P.landedAs({ "ref_t0c0_594.png.png.png": true }, "ref_t0c0_594.png"), null, "not any number of extensions - only Premiere's one extra");
eq(P.landedAs({ "ref_t0c1_594.png.png": true }, "ref_t0c0_594.png"), null, "another frame's file is not this one");
eq(P.landedAs({}, "ref_t0c0_594.png"), null, "nothing written is nothing found");
eq(P.landedAs({ "ref_a.jpg.jpg": true }, "ref_a.jpg"), "ref_a.jpg.jpg", "follows whatever extension was asked for");

print((failed ? "FAILED " : "ok ") + passed + " passed, " + failed + " failed");
if (failed) throw new Error(failed + " failed");
