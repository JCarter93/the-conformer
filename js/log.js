/**
 * log.js - an append-only run log that cannot lose lines.
 *
 * The first version appended by read-whole-file, then write-whole-file, from
 * calls nobody awaited. Two lines logged back to back both read the same old
 * contents and the second write erased the first - measured on the first
 * logged Premiere 2025 conform: the Check summary and the per-pass result were
 * simply missing, and "done" was stamped 70 ms after "start" for seven
 * placements, because the timestamp was taken when the write finally ran.
 *
 * makeLogger() fixes both: the time is read when the line is LOGGED, and the
 * writes go through one promise chain, so each read-modify-write finishes
 * before the next begins. The file access is passed in, which is what lets
 * tests/log-test.js reproduce the race under jsc.
 */

/**
 * `append(entryText)` does the actual write and may be async. `now()` returns
 * the timestamp string. Returns logLine(text) -> a promise for that line.
 */
function makeLogger(append, now) {
  var clock = now || function () { return new Date().toISOString(); };
  var chain = Promise.resolve();
  return function logLine(text) {
    var entry = clock() + "  " + text + "\n";
    chain = chain.then(function () { return append(entry); })
                 .catch(function () { /* logging must never break a run */ });
    return chain;
  };
}

/** Keep a log under `max` characters by dropping its oldest half, on a line boundary. */
function trimLog(text, max) {
  var s = String(text || "");
  if (!max || s.length <= max) return s;
  var kept = s.slice(s.length - Math.floor(max / 2));
  var nl = kept.indexOf("\n");
  return nl === -1 ? kept : kept.slice(nl + 1);
}

module.exports = { makeLogger: makeLogger, trimLog: trimLog };
