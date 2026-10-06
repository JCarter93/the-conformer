/**
 * Guards a class of bug that only shows up when an editor presses the button.
 *
 * `spareAudioTrackIndex` was written, used by app.js, and never added to
 * ppro.js's exports. Everything looked fine - the panel loaded, Check ran, the
 * report was right - and it failed as "ppro.spareAudioTrackIndex is not a
 * function" at the moment of placing, after the run had already duplicated the
 * sequence and imported eleven files.
 *
 * Nothing else catches this: the modules are only wired together inside
 * Premiere, and a UXP panel has to be reloaded by restarting the app.
 */

var passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed++;
  else { failed++; print("FAIL  " + label); }
}

/** Blank out comments and strings so a path like "js/ppro.js" cannot match. */
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

/** The names a module actually exports. */
function exportsOf(path) {
  var src = stripNoise(readFile(path));
  var at = src.indexOf("module.exports");
  if (at === -1) return [];
  var open = src.indexOf("{", at), depth = 0, k = open;
  for (; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") { depth--; if (depth === 0) { k++; break; } }
  }
  var body = src.slice(open + 1, k - 1);
  return body.split(",").map(function (piece) {
    return piece.split(":")[0].trim();
  }).filter(Boolean);
}

/** Every `alias.name` the panel reaches for on a required module. */
function callsOn(src, alias) {
  var re = new RegExp("\\b" + alias + "\\.([A-Za-z_][A-Za-z0-9_]*)", "g");
  var found = {}, m;
  while ((m = re.exec(src)) !== null) found[m[1]] = true;
  return Object.keys(found).sort();
}

var app = stripNoise(readFile("js/app.js"));

[["ppro", "js/ppro.js"], ["plan", "js/plan.js"], ["helper", "js/helper.js"], ["prefs", "js/prefs.js"]]
  .forEach(function (pair) {
    var alias = pair[0], path = pair[1];
    var exported = exportsOf(path);
    ok(exported.length > 0, path + " exports something (the guard can see it)");
    callsOn(app, alias).forEach(function (name) {
      ok(exported.indexOf(name) !== -1,
         "app.js calls " + alias + "." + name + "() but " + path + " does not export it");
    });
  });

// --- every function app.js CALLS must exist --------------------------------
//
// app.js has no runtime coverage: it reaches for `document` at the top level,
// so no test can execute it, and a call to a function that is not there is
// perfectly valid JavaScript until the moment it runs. Editing this file by
// splicing text once deleted five functions - renderVersions and loadThumbs
// among them - and every other check still passed: it parsed, the modules all
// exported what was asked of them, and the panel would have thrown the first
// time anyone pressed Check.

var GLOBALS = {
  require: 1, setTimeout: 1, clearTimeout: 1, setInterval: 1, clearInterval: 1,
  Promise: 1, Number: 1, String: 1, Boolean: 1, Array: 1, Object: 1, Math: 1,
  JSON: 1, Date: 1, Error: 1, Set: 1, Map: 1, RegExp: 1, Symbol: 1,
  Uint8Array: 1, ArrayBuffer: 1, parseInt: 1, parseFloat: 1, isNaN: 1,
  isFinite: 1, encodeURIComponent: 1, decodeURIComponent: 1, alert: 1,
  console: 1, fetch: 1, btoa: 1, atob: 1
};
var KEYWORDS = {
  "if": 1, "for": 1, "while": 1, "switch": 1, "catch": 1, "return": 1,
  "typeof": 1, "new": 1, "function": 1, "await": 1, "else": 1, "do": 1,
  "throw": 1, "case": 1, "in": 1, "of": 1, "delete": 1, "void": 1,
  "yield": 1, "instanceof": 1, "constructor": 1,
  // `async (` opens an async arrow function, not a call.
  "async": 1
};

var appSrc = stripNoise(readFile("js/app.js"));
var defined = {};
var d, dre = /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g;
while ((d = dre.exec(appSrc)) !== null) defined[d[1]] = true;
var vre = /(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
while ((d = vre.exec(appSrc)) !== null) defined[d[1]] = true;

var called = {}, m2;
var cre = /(?:^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
while ((m2 = cre.exec(appSrc)) !== null) called[m2[1]] = true;

var undef = Object.keys(called).filter(function (n) {
  return !defined[n] && !GLOBALS[n] && !KEYWORDS[n];
}).sort();
if (undef.length) print("      app.js calls with no definition: " + undef.join(", "));
ok(undef.length === 0, "every function app.js calls is defined in it");

// --- every module must at least PARSE --------------------------------------
//
// app.js is the one file no other test loads: it reaches for `document` and
// `require` at the top level, so it cannot simply be run here. A syntax error
// in it is invisible until the panel is opened inside Premiere, where the
// failure is a panel that does not appear at all. `new Function` parses
// without executing, which is exactly the check that was missing.

["js/app.js", "js/plan.js", "js/helper.js", "js/ppro.js", "js/prefs.js"].forEach(function (f) {
  var parsed = true;
  try { new Function("module", "exports", "require", "document", "window", readFile(f)); }
  catch (e) { parsed = false; print("      " + f + ": " + e); }
  ok(parsed, f + " parses");
});

print("");
print(passed + " passed, " + failed + " failed");
if (failed > 0) throw new Error(failed + " test(s) failed");
