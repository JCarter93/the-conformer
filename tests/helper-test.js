/**
 * Tests for js/helper.js - the part that can be tested without a filesystem.
 *
 * The heartbeat rule is the one worth guarding: the panel must not send work to
 * a helper that has died, because the request would sit in the queue forever
 * and the panel would wait out its whole timeout before saying anything useful.
 */

var module = { exports: {} };
var exports = module.exports;
load("js/helper.js");
var H = module.exports;

var passed = 0, failed = 0;
function eq(actual, expected, label) {
  var a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) passed++;
  else { failed++; print("FAIL  " + label + "\n      expected " + e + "\n      got      " + a); }
}

var now = 1000000;

eq(H.isFresh({ lastSeen: now - 1 }, now), true, "a heartbeat a second ago is alive");
eq(H.isFresh({ lastSeen: now - (H.HEARTBEAT_STALE_SECONDS - 1) }, now), true,
   "just inside the window is alive");
eq(H.isFresh({ lastSeen: now - (H.HEARTBEAT_STALE_SECONDS + 1) }, now), false,
   "past the window is dead");
eq(H.isFresh(null, now), false, "no status file at all is dead");
eq(H.isFresh({}, now), false, "a status file with no heartbeat is dead");
eq(H.isFresh({ lastSeen: "soon" }, now), false, "a non-numeric heartbeat is dead, not a crash");
// A clock that has gone backwards (or a helper writing ahead) must not read as
// dead - the panel would tell the editor to reinstall a helper that is fine.
eq(H.isFresh({ lastSeen: now + 5 }, now), true, "a heartbeat slightly in the future is alive");

// --- waiting on the heartbeat, not on a stopwatch --------------------------
//
// A fixed timeout has to guess the longest legitimate job. It guessed wrong: a
// four-track verify answered in 904.3s against a 900s limit, so the panel gave
// up 4.3 seconds before the answer arrived and reported that the helper had not
// replied. It had.

var W = { sawBusy: false, sinceStartMs: 1000, sinceAliveMs: 1000,
          pickupMs: 30000, idleMs: 90000, hardCapMs: 3600000 };
function w(over) { var o = {}; for (var k in W) o[k] = W[k]; for (var k2 in over) o[k2] = over[k2]; return o; }

eq(H.waitVerdict({ running: true, busy: "verify" }, w({ sinceStartMs: 5000000 })), "waiting",
   "a helper that is demonstrably working is waited for, however long it takes");
eq(H.waitVerdict({ running: true, busy: null }, w()), "waiting",
   "a helper that has not picked the job up yet is given time to");
eq(H.waitVerdict({ running: true, busy: null }, w({ sinceStartMs: 31000 })), "dropped",
   "alive and idle past the pickup window means nobody took the job");
eq(H.waitVerdict({ running: true, busy: null }, w({ sawBusy: true })), "dropped",
   "alive and idle after working on it means the job was claimed then dropped");
eq(H.waitVerdict({ running: false, busy: null }, w({ sinceAliveMs: 10000 })), "waiting",
   "a missed heartbeat or two is a restart, not a death");
eq(H.waitVerdict({ running: false, busy: null }, w({ sinceAliveMs: 91000 })), "dead",
   "a heartbeat stale past the idle window is a death");
eq(H.waitVerdict({ running: true, busy: "verify" }, w({ sinceStartMs: 3600001 })), "waiting",
   "the hard cap does not cut off a helper that is still reporting work");
eq(H.waitVerdict({ running: true, busy: null }, w({ sinceStartMs: 3600001 })), "dropped",
   "an idle helper is reported as dropped, which is the more useful reason");

// --- the panel and the helper must agree on the job names ------------------
//
// These live in two languages and never import each other, so a kind the panel
// sends and the helper has never heard of fails as "unknown request kind" only
// once an editor presses the button. Each new job is one line in each file and
// it is easy to write only one of them.

var helperSrc = readFile("js/helper.js");
var pySrc = readFile("helper/conform_helper.py");
var kinds = {}, m;
var re = /request\(\s*"([a-z]+)"/g;
while ((m = re.exec(helperSrc)) !== null) kinds[m[1]] = true;
var sent = Object.keys(kinds).sort();
eq(sent.length > 0, true, "the panel sends at least one kind of request");
sent.forEach(function (kind) {
  eq(pySrc.indexOf('kind == "' + kind + '"') !== -1, true,
     "the helper handles the \"" + kind + "\" requests the panel sends");
});

print("");
print(passed + " passed, " + failed + " failed");
if (failed > 0) throw new Error(failed + " test(s) failed");
