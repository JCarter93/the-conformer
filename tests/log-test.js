/**
 * The run log must keep every line, in order, stamped when it was logged.
 * Reproduces the race that lost lines on the first logged 2025 conform: an
 * append that reads the file, yields, then writes the old contents plus its
 * line. Unserialised, two back-to-back lines both read the same old contents.
 */
var module = { exports: {} };
(new Function("module", "exports", "require", readFile("js/log.js")))(
  module, module.exports, function (name) { throw new Error("no host module: " + name); });
var L = module.exports;

var passed = 0, failed = 0;
function ok(cond, label) { if (cond) passed++; else { failed++; print("FAIL  " + label); } }

// A file whose append is read - yield - write, like the UXP entry's read()/write().
function fakeFile() {
  var f = { text: "" };
  f.append = function (entry) {
    var before;
    return Promise.resolve().then(function () { before = f.text; })
      .then(function () { return Promise.resolve(); })          // the await between read and write
      .then(function () { f.text = before + entry; });
  };
  return f;
}

// 1. The old way loses lines - so the test is able to see the bug at all.
var naive = fakeFile();
["a", "b", "c"].forEach(function (t) { naive.append(t + "\n"); });
drainMicrotasks();
ok(naive.text.split("\n").filter(Boolean).length < 3, "unserialised appends lose lines (the bug this guards)");

// 2. makeLogger keeps every line, in the order logged.
var file = fakeFile(), tick = 0;
var log = L.makeLogger(file.append, function () { return "t" + (++tick); });
["CHECK start", "CHECK picture {}", "CHECK picture warning", "CONFORM start", "CONFORM picture placed=7",
 "CONFORM done"].forEach(function (t) { log(t); });
drainMicrotasks();
var lines = file.text.split("\n").filter(Boolean);
ok(lines.length === 6, "all six lines kept (got " + lines.length + ")");
ok(lines[0] === "t1  CHECK start" && lines[5] === "t6  CONFORM done", "in order");
// 3. Stamped when LOGGED, not when the write got round to it.
ok(lines[3].indexOf("t4  ") === 0, "the timestamp is taken at the log call");

// 4. A failing write does not stop later lines.
var flaky = fakeFile(), n = 0;
var log2 = L.makeLogger(function (e) { if (++n === 1) return Promise.reject(new Error("disk")); return flaky.append(e); },
                        function () { return "t"; });
log2("lost"); log2("kept");
drainMicrotasks();
ok(flaky.text === "t  kept\n", "one failed write does not block the rest");

// 5. Trimming keeps the newest half, on a line boundary.
var big = ""; for (var i = 0; i < 100; i++) big += "line " + i + "\n";
var t = L.trimLog(big, 400);
ok(t.length <= 200 && t.indexOf("line 99\n") !== -1, "trim keeps the newest lines");
ok(/^line \d+\n/.test(t), "trim starts on a whole line");
ok(L.trimLog("short\n", 400) === "short\n", "short logs are untouched");

print((failed ? "FAILED " : "ok ") + passed + " passed, " + failed + " failed");
if (failed) throw new Error(failed + " failed");
