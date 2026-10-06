/**
 * Guards the Premiere rules that no unit test can reach, by static analysis of
 * js/ppro.js. Inherited from Onliner, where this guard exists because the rule
 * shipped broken once: the code reads fine, the transaction looks well-formed,
 * and it only fails against a live Premiere.
 *
 * The rule has five faces, all the same underlying one - if it came from an
 * earlier `await`, assume it is dead:
 *   actions, handles, values, sequences, track items.
 */

var ACTION_CALL = /create[A-Z][A-Za-z0-9]*Action\s*\(/g;

var passed = 0, failed = 0;

function ok(cond, label) {
  if (cond) passed++;
  else { failed++; print("FAIL  " + label); }
}

/** Blank out comments and string bodies so they cannot fake a match. */
function stripNoise(src) {
  var out = src.split("");
  var i = 0, n = src.length;
  var blank = function (from, to) {
    for (var k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < n) {
    var two = src.substr(i, 2);
    if (two === "/*") {
      var end = src.indexOf("*/", i + 2);
      if (end === -1) end = n;
      blank(i, end + 2); i = end + 2; continue;
    }
    if (two === "//") {
      var nl = src.indexOf("\n", i);
      if (nl === -1) nl = n;
      blank(i, nl); i = nl; continue;
    }
    var ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      var j = i + 1;
      while (j < n && src[j] !== ch) { if (src[j] === "\\") j++; j++; }
      blank(i, j + 1); i = j + 1; continue;
    }
    i++;
  }
  return out.join("");
}

/** [start,end) spans of every lockedAccess( ... ) call, by paren matching. */
function lockedSpans(src) {
  var spans = [];
  var idx = src.indexOf("lockedAccess(");
  while (idx !== -1) {
    var open = src.indexOf("(", idx);
    var depth = 0, k = open;
    for (; k < src.length; k++) {
      if (src[k] === "(") depth++;
      else if (src[k] === ")") { depth--; if (depth === 0) { k++; break; } }
    }
    spans.push([idx, k]);
    idx = src.indexOf("lockedAccess(", k);
  }
  return spans;
}

function lineOf(src, index) { return src.slice(0, index).split("\n").length; }

function bodyOf(src, name) {
  var at = src.indexOf("function " + name + "(");
  if (at === -1) return null;
  var open = src.indexOf("{", at), depth = 0, k = open;
  for (; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") { depth--; if (depth === 0) { k++; break; } }
  }
  return src.slice(at, k);
}

var raw = readFile("js/ppro.js");
var src = stripNoise(raw);
var spans = lockedSpans(src);

ok(spans.length > 0, "ppro.js uses lockedAccess at all");

// --- every create*Action must be CREATED inside lockedAccess ---------------

var checked = 0, m;
ACTION_CALL.lastIndex = 0;
while ((m = ACTION_CALL.exec(src)) !== null) {
  checked++;
  var at = m.index;
  var inside = spans.some(function (s) { return at >= s[0] && at < s[1]; });
  ok(inside, m[0].replace(/\s*\($/, "") + " at js/ppro.js:" + lineOf(src, at) +
     " must be created inside project.lockedAccess(...)");
}
ok(checked > 0, "found action call sites to check (the guard is live)");

// --- values handed to an action must be built there too --------------------
// A PointF built outside and used inside dies exactly like a stale handle.
// motionValue is the helper that builds them and is CALLED from inside
// lockedAccess, so its own body is exempt - exempt the body, not the pattern.

var VALUE_BUILDERS = [/\bnew\s+P?\.?PointF\s*\(/g, /\bmotionValue\s*\(/g,
                      /\bcreateKeyframe\s*\(/g];

var helperSpan = (function () {
  var at = src.indexOf("function motionValue");
  if (at === -1) return null;
  var open = src.indexOf("{", at), depth = 0, k = open;
  for (; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") { depth--; if (depth === 0) { k++; break; } }
  }
  return [at, k];
})();
ok(helperSpan !== null, "found the motionValue helper to exempt");

var valueSites = 0;
VALUE_BUILDERS.forEach(function (re) {
  re.lastIndex = 0;
  var v;
  while ((v = re.exec(src)) !== null) {
    if (helperSpan && v.index >= helperSpan[0] && v.index < helperSpan[1]) continue;
    valueSites++;
    var at2 = v.index;
    var inside2 = spans.some(function (s2) { return at2 >= s2[0] && at2 < s2[1]; });
    ok(inside2, v[0].replace(/\s*\($/, "") + " at js/ppro.js:" + lineOf(src, at2) +
       " must be built inside project.lockedAccess(...) - a value built outside goes stale");
  }
});
ok(valueSites > 0, "found action-value builders to check");

// --- every stage re-resolves its Sequence by GUID ---------------------------

var PIPELINE = ["readTimebase", "readSequenceShape", "readTrackClips",
                "renameSequence", "placeClip", "findClipAt"];

PIPELINE.forEach(function (name) {
  var body = bodyOf(src, name);
  ok(body !== null, name + " exists in ppro.js");
  if (!body) return;
  ok(/await\s+resolveSequence\s*\(/.test(body),
     name + " must re-resolve its Sequence with resolveSequence(...) - one carried " +
     "in from a previous stage is stale");
  ok(!/^async function [a-zA-Z]+\(\s*sequence\s*[,)]/.test(body),
     name + " should take a GUID (sequenceRef), not a Sequence object");
});

// --- the Motion keyframe rebase must not be quietly dropped -----------------
/**
 * Keyframes live in SOURCE time, and the graded file's in-point is not the
 * offline's. Copied verbatim they land at the wrong moment, or outside the clip
 * - where Premiere clamps to the nearest keyframe and the parameter reads FLAT
 * while still reporting the right keyframe count. Nothing errors, so only a
 * structural check catches its removal.
 */
var applyBody = bodyOf(src, "applyMotion");
ok(applyBody !== null, "applyMotion exists");
if (applyBody) {
  ok(/gradedSourceInTicks\)\s*-\s*Number\(captured\.srcInTicks\)/.test(applyBody),
     "applyMotion must rebase keyframes by (gradedSourceIn - offlineSourceIn)");
  ok(/\.ticks\s*\+\s*shift/.test(applyBody),
     "every restored keyframe must carry the rebase shift");
}

// --- placement must never ripple -------------------------------------------
/**
 * Rippling would close the gap and shift every clip after each removal, so the
 * conform would no longer line up with picture. Same rule as Onliner's
 * removals, for the same reason.
 */
var placeBody = bodyOf(src, "placeClip");
ok(placeBody !== null, "placeClip exists");
if (placeBody) {
  ok(/createRemoveItemsAction\s*\([^)]*,\s*false\s*,/.test(placeBody),
     "placeClip's audio removal must pass ripple = false");
}

print("");
print(passed + " passed, " + failed + " failed  (" + checked + " action call sites checked)");
if (failed > 0) throw new Error(failed + " test(s) failed");
