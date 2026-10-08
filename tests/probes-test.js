/**
 * Verification probes must sit ON the sequence's frame grid.
 *
 * The panel renders each reference frame at probe + half a frame. With a probe
 * off the grid (0.30s on a 25p cut is 7.5 frames in) that render lands on the
 * NEXT frame while the matcher compares it as the earlier one - and since each
 * probe is off by a different fraction, the error reads as a speed change.
 * Measured on 50p rushes in a 25p edit (2026-10-07/08): clean cuts reported
 * "retimed" at 2.2-2.7% and "disputed" by one frame; with snapped probes the
 * same footage confirmed at the planned offset on every probe.
 */
var module = { exports: {} };
(new Function("module", "exports", "require", readFile("js/plan.js")))(
  module, module.exports, function (name) { throw new Error("no host module: " + name); });
var plan = module.exports;

var passed = 0, failed = 0;
function ok(cond, label) { if (cond) passed++; else { failed++; print("FAIL  " + label); } }

// Probes are rounded to the microsecond, so at 23.976/29.97 they sit a few
// millionths of a frame off the exact grid - far inside the half-frame margin.
function onGrid(t, f) { var n = t / f; return Math.abs(n - Math.round(n)) < 1e-4; }

function kitFor(durs, frameSeconds) {
  var placements = durs.map(function (d, i) {
    return { key: "k" + i, start: i * 10, dur: d, gradedPath: "/g" + i + ".mov", sourceIn: 0, gradedDur: d + 1 };
  });
  return plan.verificationKit({ placements: placements, unresolved: [] }, { fps: 1 / frameSeconds, frameSeconds: frameSeconds });
}

[[0.04, "25p"], [1001 / 24000, "23.976"], [1001 / 30000, "29.97"]].forEach(function (pair) {
  var f = pair[0], label = pair[1];
  var durs = [3.0, 2.48, 2.0, 1.04, 7.36, 0.4, 0.2];
  kitFor(durs, f).clips.forEach(function (c, i) {
    c.probes.forEach(function (p) {
      ok(onGrid(p, f), label + " dur " + durs[i] + ": probe " + p + " is on the frame grid");
      ok(p >= 0 && p <= c.dur, label + " dur " + durs[i] + ": probe " + p + " is inside the cut");
    });
    ok(c.probes.length >= 1, label + " dur " + durs[i] + ": at least one probe");
    if (durs[i] >= 1) {
      c.probes.forEach(function (p) {
        ok(p >= 3 * f - 1e-9, label + " dur " + durs[i] + ": probe " + p + " is not in the first three frames");
        ok(p <= c.dur - 2 * f + 1e-9, label + " dur " + durs[i] + ": probe " + p + " is clear of the last two frames");
      });
    }
  });
});

// The regression itself: a 2.0s cut put its first probe at 0.30s - half a frame.
var k = kitFor([2.0], 0.04).clips[0];
ok(k.probes.indexOf(0.3) === -1, "no half-frame probe at 0.30s on a 2.0s 25p cut (got " + k.probes.join(", ") + ")");
ok(k.probes.length === 3, "a 2.0s cut still gets three spread probes");

print((failed ? "FAILED " : "ok ") + passed + " passed, " + failed + " failed");
if (failed) throw new Error(failed + " failed");

// --- placements Premiere cannot make exactly --------------------------------
// Premiere snaps an in-point to the sequence's grid (25.6.6: 0.14 -> 0.12).
var TPF25 = 10160640000;
ok(plan.betweenFramesWarning(0.24, TPF25) === null, "on the 25p grid: no warning");
ok(plan.betweenFramesWarning(0.0, TPF25) === null, "zero: no warning");
ok(/20 ms late/.test(plan.betweenFramesWarning(0.14, TPF25) || ""), "0.14s (an odd 50p frame) is named: plays 20 ms late");
ok(/20 ms early/.test(plan.betweenFramesWarning(0.02, TPF25) || "") ||
   /20 ms late/.test(plan.betweenFramesWarning(0.02, TPF25) || ""), "0.02s is named too");
ok(plan.betweenFramesWarning(0.2400001, TPF25) === null, "float noise is not a warning");
ok(plan.betweenFramesWarning(null, TPF25) === null, "no offset, no warning");
ok(plan.betweenFramesWarning(0.14, null) === null, "no timebase, no warning");
print((failed ? "FAILED " : "ok ") + passed + " passed, " + failed + " failed (with placement warnings)");
if (failed) throw new Error(failed + " failed");
