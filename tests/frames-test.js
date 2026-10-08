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

// --- a HIDDEN track is shown for its own render, and put back hidden --------
//
// Measured: V5 switched off by the editor, ticked for conform - every frame
// rendered blank. And a track the editor had hidden was then reported as
// "left muted" by the panel, which read as the panel's own failure.
var tracks = [{ muted: false }, { muted: true }, { muted: true }];   // V1 shown; V2, V3 hidden by the editor
var seenAtRender = null;
function trackApi(t) {
  return { isMuted: async function () { return t.muted; }, setMute: async function (m) { t.muted = !!m; } };
}
var seqWithTracks = {
  getVideoTrackCount: async function () { return tracks.length; },
  getVideoTrack: async function (i) { return trackApi(tracks[i]); },
  getCaptionTrackCount: async function () { return 0; }
};
host.Project.getActiveProject = async function () { return { getSequence: async function () { return seqWithTracks; } }; };
host.Exporter.exportSequenceFrame = async function (seq, t, file) {
  seenAtRender = tracks.map(function (x) { return x.muted; }).join(",");
  kitFiles[file] = "frame";
};
var hiddenRun = null;
hosted.exports.exportReferenceFrames("seq", [{ key: "t1c0", start: 0, probes: [0.4], frameSeconds: 0.04 }],
  kitFolder, { width: 360, height: 640 }, 1).then(function (f) { hiddenRun = f; }, function (e) { frameErr = e; });
drainMicrotasks();
eq(seenAtRender, "true,false,true", "rendering V2: V2 shown, V1 and V3 hidden");
eq(tracks.map(function (x) { return x.muted; }).join(","), "false,true,true", "afterwards every track is as the editor left it");
eq(hiddenRun && hiddenRun.stillMuted.length, 0, "and the editor's own hidden tracks are not reported as left muted");

// --- frames that never land are retried one at a time, while it helps -----
//
// Measured on Windows 25.6.6 in a GPU-less VM: exportSequenceFrame reported
// success for frames that never reached disk - 9 of 21 landed, one
// back-to-back retry got 7 more, and 5 never came. Here each frame needs a
// different number of attempts; the waits are shortened so this runs in
// well under a second. jsc only fires timers after the script body, so the
// verdict is reported from the completion callback.
var attempts = {}, needs = { "ref_t0c0_400.png": 1, "ref_t0c0_800.png": 2, "ref_t0c0_1200.png": 3, "ref_t0c0_1600.png": 99 };
var dropFiles = {};
var dropFolder = fakeFolder(dropFiles);
host.Project.getActiveProject = async function () { return { getSequence: async function () { return seqWithTracks; } }; };
host.Exporter.exportSequenceFrame = async function (seq, t, file) {
  attempts[file] = (attempts[file] || 0) + 1;
  if (attempts[file] >= needs[file]) dropFiles[file] = "frame";   // reported success either way
};
var lone = {}, loneFiles = {};
function finish() {
  print((failed ? "FAILED " : "ok ") + passed + " passed, " + failed + " failed");
  if (failed) setTimeout(function () { throw new Error(failed + " failed"); }, 0);
}
hosted.exports.exportReferenceFrames("seq", [{ key: "t0c0", start: 0, probes: [0.4, 0.8, 1.2, 1.6], frameSeconds: 0.04 }],
  dropFolder, { width: 360, height: 640 }, undefined, { firstMs: 30, eachMs: 30, rounds: 3 }).then(function (f) {
  var by = {}; f.forEach(function (x) { by[x.file] = x; });
  eq(by["ref_t0c0_400.png"].ok && !by["ref_t0c0_400.png"].retried, true, "a frame that lands first time is not retried");
  eq(by["ref_t0c0_800.png"].ok, true, "one that needs a second attempt lands on the first retry round");
  eq(by["ref_t0c0_1200.png"].ok, true, "one that needs a third lands on a LATER round - the old single retry lost it");
  eq(by["ref_t0c0_1600.png"].ok, false, "one that never lands is reported missing");
  eq(by["ref_t0c0_1600.png"].error, "the frame never appeared on disk", "and says so");
  eq(attempts["ref_t0c0_1600.png"], 4, "retried until a round landed nothing (1 + 3 rounds), then given up");
  // A frame that never lands, alone: one fruitless round and it stops.
  host.Exporter.exportSequenceFrame = async function (seq, t, file) { lone[file] = (lone[file] || 0) + 1; };
  return hosted.exports.exportReferenceFrames("seq", [{ key: "t9c0", start: 0, probes: [0.4], frameSeconds: 0.04 }],
    fakeFolder(loneFiles), { width: 360, height: 640 }, undefined, { firstMs: 30, eachMs: 30, rounds: 3 });
}).then(function () {
  eq(lone["ref_t9c0_400.png"], 2, "a round that lands nothing ends the retrying (1 + 1 attempts)");
  finish();
}, function (e) { eq(String(e), "", "the retry run completed"); finish(); });
