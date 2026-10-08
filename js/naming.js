/**
 * naming.js - output sequence names, and what to do when one already exists.
 *
 * Pure string logic, no Premiere API. Kept separate so it can be run and
 * tested outside the panel (tests/naming-test.js, run with jsc).
 *
 * Shared with The Onliner - the same file, so both panels version their
 * outputs identically. The Conformer used to name its duplicate
 * "<offline>_GRADED" whether or not that already existed, and a second
 * conform left two sequences with the same name in the project.
 *
 * The rule from the spec: the suffix APPENDS to the source sequence name, it
 * never replaces it, so an output is always traceable back to what it came
 * from. Re-running after a picture change is normal here, so a name clash
 * auto-increments a version rather than overwriting or erroring.
 */

// Spec says _v02. Note this is lowercase, unlike the house V1 in delivery
// filenames - these are working sequences in the project panel, not deliverables.
var VERSION_SEP = "_v";
var FIRST_VERSION = 2;
var MAX_VERSION = 999;

/**
 * Matches a trailing version stamp: "_v02", "_v13", "_v100".
 * Requires at least two digits so a real name ending "_v2" of the editor's own
 * making is left alone.
 */
var VERSION_RE = /_v(\d{2,})$/;

function trimSuffix(suffix) {
  return String(suffix == null ? "" : suffix).trim();
}

/**
 * Strip a trailing "_v02" if present. Returns { stem, version } where version
 * is null when there was no stamp.
 */
function splitVersion(name) {
  var m = VERSION_RE.exec(name);
  if (!m) return { stem: name, version: null };
  return { stem: name.slice(0, m.index), version: parseInt(m[1], 10) };
}

function formatVersion(n) {
  return VERSION_SEP + (n < 10 ? "0" + n : String(n));
}

/**
 * Build the wanted name for an output sequence.
 *
 * Guards against double-suffixing: if the editor points the panel at an
 * already-prepped sequence (easy to do - they sit in the same project), we do
 * not produce "MyEdit_FOR_GRADE_FOR_GRADE". The version stamp is stripped
 * first, so "MyEdit_FOR_GRADE_v03" also resolves back to "MyEdit".
 */
function applySuffix(sourceName, suffix) {
  var base = String(sourceName == null ? "" : sourceName).trim();
  var sfx = trimSuffix(suffix);
  if (!sfx) return base;

  var stem = splitVersion(base).stem;
  if (stem.length >= sfx.length && stem.slice(-sfx.length) === sfx) {
    // Already carries this suffix - re-prepping a prepped sequence.
    return stem;
  }
  return stem + sfx;
}

/**
 * Resolve a wanted name against the names already in the project.
 *
 * Free name wins. Otherwise version up from the HIGHEST existing version, not
 * the first gap - a deleted _v02 may still have its XML/AAF sitting on the
 * grade drive, and reusing the number would point two handoffs at one name.
 *
 * `existingNames` is compared case-insensitively: Premiere allows sequences
 * differing only in case, but a colourist's file system very often does not.
 *
 * Returns { name, version, collided }.
 */
function resolveName(wantedName, existingNames) {
  var wanted = String(wantedName == null ? "" : wantedName).trim();
  var taken = Object.create(null);
  var list = existingNames || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] == null) continue;
    taken[String(list[i]).trim().toLowerCase()] = true;
  }

  if (!taken[wanted.toLowerCase()]) {
    return { name: wanted, version: null, collided: false };
  }

  // Find the highest version already used on this stem.
  var stem = splitVersion(wanted).stem;
  var highest = 1;
  var stemLower = stem.toLowerCase();
  for (var key in taken) {
    var parts = splitVersion(key);
    if (parts.stem === stemLower && parts.version !== null && parts.version > highest) {
      highest = parts.version;
    }
  }

  var next = Math.max(highest + 1, FIRST_VERSION);
  while (next <= MAX_VERSION) {
    var candidate = stem + formatVersion(next);
    if (!taken[candidate.toLowerCase()]) {
      return { name: candidate, version: next, collided: true };
    }
    next++;
  }
  throw new Error("Ran out of version numbers for \"" + stem + "\" (stopped at v" + MAX_VERSION + ").");
}

/**
 * One call for the panel: source name + suffix + what's in the project ->
 * the name to actually use.
 */
function planName(sourceName, suffix, existingNames) {
  return resolveName(applySuffix(sourceName, suffix), existingNames);
}

/**
 * File-system-safe version of a sequence name, for the XML/AAF written
 * alongside it. Premiere is happy with "/" and ":" in a sequence name; the
 * disk is not.
 */
function toFileStem(name) {
  return String(name == null ? "" : name)
    .replace(/[\/\\:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "");
}

var api = {
  applySuffix: applySuffix,
  resolveName: resolveName,
  planName: planName,
  splitVersion: splitVersion,
  formatVersion: formatVersion,
  toFileStem: toFileStem,
  VERSION_SEP: VERSION_SEP
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof globalThis !== "undefined") globalThis.GMPNaming = api;
