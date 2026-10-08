/**
 * Portability guard: the panel must not know it is on a Mac.
 *
 * Same shape as locked-access-test.js - a source-text assertion for a class
 * of bug no unit test reaches. The panel was built on a Mac and the only
 * Windows machine with Premiere on it is a colleague's edit suite, so a Mac
 * path that creeps back in cannot be caught by running anything. It is
 * caught here instead, on the Mac where it was written.
 *
 * The Conformer's panel JS was already clean of platform roots: it works
 * from folder ENTRIES the editor picked and deliberately never calls
 * getEntryWithUrl (see folderContents in js/ppro.js). This keeps it that way,
 * and holds the helper - which does have to find things by path - to the
 * same rule: derive the root from the platform, never spell it out.
 */

var passed = 0, failed = 0;
function ok(cond, label) { if (cond) passed++; else { failed++; print("FAIL  " + label); } }

var PANEL_FILES = ["js/app.js", "js/ppro.js", "js/plan.js", "js/helper.js", "js/prefs.js", "js/naming.js", "js/log.js", "index.html"];
var HELPERS = ["helper/conform_helper.py", "helper/plan_conform.py",
               "helper/find_offsets.py", "helper/verify_offsets.py"];

/** Blank comments and string bodies, keeping newlines so line numbers hold. */
function stripNoise(src) {
  var out = src.split("");
  var i = 0, n = src.length;
  var blank = function (from, to) {
    for (var k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < n) {
    var two = src.substr(i, 2);
    if (two === "/*") { var end = src.indexOf("*/", i + 2); if (end === -1) end = n; blank(i, end + 2); i = end + 2; continue; }
    if (two === "//") { var nl = src.indexOf("\n", i); if (nl === -1) nl = n; blank(i, nl); i = nl; continue; }
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

/** Blank only JS comments, so string literals are still inspected. */
function stripComments(src) {
  var out = src.split("");
  var i = 0, n = src.length;
  var blank = function (from, to) {
    for (var k = from; k < to && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < n) {
    var two = src.substr(i, 2);
    if (two === "/*") { var end = src.indexOf("*/", i + 2); if (end === -1) end = n; blank(i, end + 2); i = end + 2; continue; }
    if (two === "//") { var nl = src.indexOf("\n", i); if (nl === -1) nl = n; blank(i, nl); i = nl; continue; }
    var ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      var j = i + 1;
      while (j < n && src[j] !== ch) { if (src[j] === "\\") j++; j++; }
      i = j + 1; continue;
    }
    i++;
  }
  return out.join("");
}

/** Python: blank # comments and triple-quoted docstrings, keep code and plain strings. */
function stripPython(src) {
  var out = src.replace(/"""[\s\S]*?"""/g, function (m) { return m.replace(/[^\n]/g, " "); });
  return out.split("\n").map(function (line) {
    var hash = line.indexOf("#");
    return hash === -1 ? line : line.slice(0, hash);
  }).join("\n");
}

function lineOf(src, index) { return src.slice(0, index).split("\n").length; }

function everyMatch(src, re) {
  var hits = [], m;
  re.lastIndex = 0;
  while ((m = re.exec(src)) !== null) { hits.push({ index: m.index, text: m[0] }); if (!re.global) break; }
  return hits;
}

var ROOTS = [
  [/\/Applications\b/g, "a literal /Applications"],
  [/\/Users\//g, "a literal /Users/"],
  [/~\/Library/g, "a literal ~/Library"],
  [/Library\/Application Support/g, "a literal Library/Application Support"],
  [/\/Volumes\//g, "a literal /Volumes/"],
  [/\.app\/Contents/g, "a literal .app/Contents"],
  [/launchctl/g, "launchctl"]
];

// --- 1. no platform root in panel code (strings included) ---------------------

PANEL_FILES.forEach(function (file) {
  var src = stripComments(readFile(file));
  ROOTS.forEach(function (pair) {
    everyMatch(src, pair[0]).forEach(function (hit) {
      ok(false, file + ":" + lineOf(src, hit.index) + " has " + pair[1] +
         " - the panel must not know which platform it is on");
    });
  });
});
ok(true, "panel files scanned for platform roots (" + PANEL_FILES.length + " files)");

// --- 2. the panel still never reaches for a path by URL --------------------------
//
// getEntryWithUrl threw for twelve files that were demonstrably on disk when
// the folder sat outside the granted scope, and every render looked failed.
// Listing the picked folder entry is both more robust and more portable.

PANEL_FILES.forEach(function (file) {
  var src = stripNoise(readFile(file));
  everyMatch(src, /getEntryWithUrl\s*\(/g).forEach(function (hit) {
    ok(false, file + ":" + lineOf(src, hit.index) +
       " calls getEntryWithUrl - list the folder entry the editor picked instead");
  });
  everyMatch(src, /["']file:["']\s*\+/g).forEach(function (hit) {
    ok(false, file + ":" + lineOf(src, hit.index) + " builds a file URL by hand");
  });
  everyMatch(src, /\b\w*(?:nativePath|Path|Dir|folder)\s*\+\s*["']\/["']/g).forEach(function (hit) {
    ok(false, file + ":" + lineOf(src, hit.index) + " joins a filesystem path with a literal \"/\"");
  });
});
ok(true, "panel files scanned for URL and join assumptions");

// --- 3. the path normaliser is Windows-aware, and there is only one of it ---------
//
// plan.js and ppro.js each carry normalisePath (one is pure and tested, the
// other lives beside the Premiere calls that use it). They must stay
// byte-identical bar the var/let keyword, or a path compares equal in the
// plan and unequal against the project.

function bodyOf(file) {
  var src = readFile(file);
  var at = src.indexOf("function normalisePath(");
  if (at === -1) return null;
  var open = src.indexOf("{", at), depth = 0, k = open;
  for (; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}") { depth--; if (depth === 0) { k++; break; } }
  }
  return src.slice(open, k).replace(/\blet\b/g, "var");
}
var planBody = bodyOf("js/plan.js"), pproBody = bodyOf("js/ppro.js");
ok(planBody !== null && pproBody !== null, "both normalisePath functions exist");
ok(planBody === pproBody, "plan.js and ppro.js normalisePath are identical");
ok(planBody !== null && /\\\\/.test(planBody), "normalisePath turns backslashes round");
ok(/lastIndexOf\("\/"\)/.test(readFile("js/plan.js").slice(readFile("js/plan.js").indexOf("function baseName"))) ,
   "baseName splits on the forward slash normalisePath guarantees");

// --- 4. the helper derives its roots from the platform ------------------------------

HELPERS.forEach(function (HELPER) {
  var py2 = stripPython(readFile(HELPER));
  [[/\/Users\//g, "/Users/"], [/\/Applications\b/g, "/Applications"],
   [/~\/Library/g, "~/Library"], [/Library\/Application Support/g, "Library/Application Support"]]
    .forEach(function (pair) {
      everyMatch(py2, pair[0]).forEach(function (hit) {
        ok(false, HELPER + ":" + lineOf(py2, hit.index) + " has a literal " + pair[1] +
           " in code - derive it from the platform (see uxp_storage_roots / find_tool)");
      });
    });
});
var py = stripPython(readFile(HELPERS[0]));
ok(/def uxp_storage_roots/.test(py) && /APPDATA/.test(py), "the helper knows the Windows UXP storage roots");
ok(/def find_tool/.test(py) && /shutil\.which/.test(py), "the helper finds ffmpeg in bin/ beside the repo, then on PATH");
ok(/"tools": self\.tools/.test(py), "the heartbeat reports which tools the helper found");
ok(/def need_tools/.test(py) && /ffmpeg\.org/.test(py), "jobs that need ffmpeg are refused with the download link");
var appSrc2 = readFile("js/app.js");
ok(/openExternal\(/.test(appSrc2) && /helperLink/.test(appSrc2), "the panel offers a Get ffmpeg link through shell.openExternal");
ok(/"launchProcess"/.test(readFile("manifest.json")), "the manifest allows opening https links");
ok(/"--log"/.test(py), "the helper can write its own log (the Windows task cannot redirect for it)");

// --- 5. the installers come in pairs ---------------------------------------------

["scripts/install-dev.sh", "scripts/install-dev.ps1",
 "scripts/uninstall-dev.sh", "scripts/uninstall-dev.ps1",
 "scripts/install-helper.sh", "scripts/install-helper.ps1"].forEach(function (f) {
  var present = true;
  try { readFile(f); } catch (e) { present = false; }
  ok(present, f + " exists - every installer has a counterpart on the other platform");
});

// The user-facing messages must not point a Windows editor at a Mac script.
var msgs = readFile("js/helper.js") + readFile("js/app.js");
ok(!/install-helper\.sh\b(?![^"]*ps1)/.test(msgs.replace(/\/\/[^\n]*/g, "").replace(/LOG_HINT = [^;]*;/, "")) ||
   /\.ps1/.test(msgs), "helper messages mention the Windows installer wherever they mention the Mac one");

print("");
print(passed + " passed, " + failed + " failed");
if (failed > 0) throw new Error(failed + " test(s) failed");
