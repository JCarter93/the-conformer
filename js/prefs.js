/**
 * prefs.js - remembers the panel's settings between runs.
 *
 * Same shape as Onliner's: localStorage is the primary store, every access is
 * guarded, and a restricted context falls back to an in-memory object so the
 * panel keeps working for the session and merely forgets when Premiere closes.
 */

var STORAGE_KEY = "theconformer.prefs.v1";

var DEFAULTS = {
  // Video and audio are chosen INDEPENDENTLY, because the grade and the mix
  // come back from different people at different times and belong in one
  // sequence. Either may be "none", but not both.
  videoMode: "multiclip",     // none | multiclip | master
  audioMode: "none",          // none | stems
  mode: "multiclip",          // legacy single-mode setting, migrated on load
  duplicateFirst: true,       // never conform the locked offline in place
  suffix: "_GRADED",
  carryMotion: true,          // scale and position are the EDIT, not a look
  verifyPicture: true,        // check the offsets against the picture
  align: "auto",              // auto | head | tail | centre | handle
  handleFrames: "12",
  binName: "GRADED",
  trackIndex: "0",
  // A UXP persistent token for the graded folder, so the panel remembers it
  // between sessions. A native path alone cannot be re-opened without one.
  gradedToken: "",
  gradedPath: "",
  // Stems play ON TOP of the scratch mix unless the offline's own audio is
  // muted, which sounds like a bad mix rather than like a mistake.
  muteOriginalAudio: true,
  // Each mode remembers its own source: a folder of per-cut exports, a single
  // master file, and a folder of stems are three different things, and making
  // them share one slot means every mode switch is a re-pick.
  masterToken: "",
  masterPath: "",
  stemsToken: "",
  stemsPath: ""
};

var memory = null;

/**
 * Carry a saved single-mode setting over to the two-axis one.
 *
 * The panel used to have one `mode` that was video OR audio. Anyone upgrading
 * has that saved, and silently resetting them to the default would quietly
 * change what the next Check does.
 */
function migrate(raw) {
  if (raw && raw.mode && raw.videoMode === undefined && raw.audioMode === undefined) {
    if (raw.mode === "audio") { raw.videoMode = "none"; raw.audioMode = "stems"; }
    else { raw.videoMode = raw.mode; raw.audioMode = "none"; }
  }
  return raw;
}

function readRaw() {
  try {
    var s = localStorage.getItem(STORAGE_KEY);
    return s ? JSON.parse(s) : {};
  } catch (e) {
    return memory || {};
  }
}

function writeRaw(obj) {
  memory = obj;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
    return true;
  } catch (e) {
    return false;
  }
}

function load() {
  var stored = migrate(readRaw());
  var out = {};
  for (var k in DEFAULTS) out[k] = DEFAULTS[k];
  for (var k2 in stored) {
    if (Object.prototype.hasOwnProperty.call(DEFAULTS, k2)) out[k2] = stored[k2];
  }
  // A blank suffix would name the conform exactly like the offline it came
  // from, which is how an editor loses track of which is which.
  if (typeof out.suffix !== "string" || !out.suffix.trim()) out.suffix = DEFAULTS.suffix;
  if (typeof out.binName !== "string" || !out.binName.trim()) out.binName = DEFAULTS.binName;
  if (["auto", "head", "tail", "centre", "handle"].indexOf(out.align) === -1) out.align = DEFAULTS.align;
  return out;
}

function save(settings) {
  var out = {};
  for (var k in DEFAULTS) {
    if (Object.prototype.hasOwnProperty.call(settings, k)) out[k] = settings[k];
  }
  return writeRaw(out);
}

function reset() {
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
  memory = null;
  return load();
}

module.exports = { DEFAULTS: DEFAULTS, load: load, save: save, reset: reset };
