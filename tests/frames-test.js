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

// --- a frame left by an earlier run must not stand in for this run's -------
//
// Measured on Premiere 25 (Mac): the kit folder still held ref_x.png from the
// previous Check, so the wait for this run's frame ended at once, the fresh
// ref_x.png.png was never renamed over it, and the whole Check verified the
// PREVIOUS run's frames. Driven here through the real exportReferenceFrames
// against a fake host that writes the way 25.6.6 does.
function fakeFolder(files) {
  var folder = { nativePath: "/kit", files: files };
  function entry(name) {
    return {
      name: name,
      delete: async function () { delete files[name]; },
      moveTo: async function (to, o) {
        if (files[o.newName] !== undefined && !o.overwrite) throw new Error("exists");
        files[o.newName] = files[name]; delete files[name];
      }
    };
  }
  folder.getEntries = async function () { return Object.keys(files).map(entry); };
  folder.getEntry = async function (name) {
    if (files[name] === undefined) throw new Error("no such entry " + name);
    return entry(name);
  };
  return folder;
}
var kitFiles = { "ref_t0c0_400.png": "stale 640x360", "ref_t0c0_800.png.png": "stale too", "other.png": "keep" };
var kitFolder = fakeFolder(kitFiles);
var host = {
  Project: { getActiveProject: async function () {
    return { getSequence: async function () { return { getVideoTrackCount: async function () { return 1; },
      getVideoTrack: async function () { return { isMuted: async function () { return false; } }; } }; } };
  } },
  Guid: { fromString: function (s) { return s; } },
  TickTime: { createWithSeconds: function (t) { return t; } },
  Exporter: { exportSequenceFrame: async function (seq, t, file, path, w, h) {
    kitFiles[file + ".png"] = "fresh " + w + "x" + h;      // 25.6.6 doubles the extension
  } }
};
var hosted = { exports: {} };
(new Function("module", "exports", "require", readFile("js/ppro.js")))(
  hosted, hosted.exports, function (name) { if (name === "premierepro") return host; throw new Error(name); });
var frames = null, frameErr = null;
hosted.exports.exportReferenceFrames("seq", [{ key: "t0c0", start: 0, probes: [0.4, 0.8], frameSeconds: 0.04 }],
  kitFolder, { width: 360, height: 640 }).then(function (f) { frames = f; }, function (e) { frameErr = e; });
drainMicrotasks();
eq(frameErr, null, "the export ran");
eq(kitFiles["ref_t0c0_400.png"], "fresh 360x640", "the stale frame was replaced by this run's");
eq(kitFiles["ref_t0c0_800.png"], "fresh 360x640", "a stale doubled name does not linger either");
eq(kitFiles["ref_t0c0_800.png.png"], undefined, "and nothing is left under the doubled name");
eq(kitFiles["other.png"], "keep", "files this run does not render are left alone");
eq(frames && frames.every(function (f) { return f.ok; }), true, "every frame reported landed");

print((failed ? "FAILED " : "ok ") + passed + " passed, " + failed + " failed");
if (failed) throw new Error(failed + " failed");
