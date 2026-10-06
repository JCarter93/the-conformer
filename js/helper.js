/**
 * helper.js - the panel's side of the conversation with the background helper.
 *
 * UXP has no subprocess API, so anything needing ffmpeg or numpy runs in a
 * separate process and the two talk through a folder. The folder is the
 * PANEL'S OWN DATA FOLDER, which UXP grants without any permission prompt -
 * that is what lets this work with no picker and no terminal.
 *
 * The protocol is deliberately dull:
 *
 *    panel  writes  queue/req-<id>.json     { id, kind, params }
 *    helper writes  queue/res-<id>.json     { id, ok, result | error, log }
 *    helper writes  queue/status.json       every few seconds, as a heartbeat
 *
 * A response is written to `.part` and renamed, so the panel can never read a
 * half-written one and mistake it for a broken answer.
 *
 * This module is pure enough to test except for the file access itself, which
 * is kept in three small functions at the top.
 */

var HEARTBEAT_STALE_SECONDS = 20;
var POLL_MS = 400;

// Where the helper's log is depends on the platform's installer, so the
// message points at the installer's status command rather than at a folder.
var LOG_HINT = "Check the helper log: scripts/install-helper.sh status on a Mac, " +
               "scripts\\install-helper.ps1 status on Windows, prints its location.";

function uxpFs() {
  return require("uxp").storage.localFileSystem;
}

/** The queue folder inside the plugin's data folder, created on first use. */
async function queueFolder() {
  const fs = uxpFs();
  const data = await fs.getDataFolder();
  try {
    return await data.getEntry("queue");
  } catch (e) {
    return await data.createFolder("queue");
  }
}

async function readJson(folder, name) {
  try {
    const entry = await folder.getEntry(name);
    const text = await entry.read();
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

async function writeJson(folder, name, value) {
  const file = await folder.createFile(name, { overwrite: true });
  await file.write(JSON.stringify(value, null, 1));
  return file;
}

/** Is the helper alive? Judged by its heartbeat, not by its mere existence. */
function isFresh(status, nowSeconds) {
  if (!status || typeof status.lastSeen !== "number") return false;
  return (nowSeconds - status.lastSeen) < HEARTBEAT_STALE_SECONDS;
}

async function status() {
  const folder = await queueFolder();
  const raw = await readJson(folder, "status.json");
  const now = Date.now() / 1000;
  return {
    running: isFresh(raw, now),
    version: raw ? raw.version : null,
    pid: raw ? raw.pid : null,
    // What it is doing, so a long job reads as work rather than as a hang. The
    // heartbeat is written from its own thread precisely so this stays true
    // while ffmpeg is chewing through 8K ProRes.
    busy: raw ? raw.busy : null,
    busySeconds: raw ? raw.busySeconds : null,
    secondsSinceHeartbeat: raw && raw.lastSeen ? Math.round(now - raw.lastSeen) : null,
    // What the helper found to run - null entries mean it will refuse the
    // jobs that need them, and the panel should say where to get one.
    tools: raw && raw.tools ? raw.tools : null,
    queuePath: folder.nativePath
  };
}

function newId() {
  return String(Date.now()) + "-" + Math.floor(Math.random() * 100000);
}

/**
 * Should we keep waiting for an answer, and if not, why not?
 *
 * Pure, so the three ways a wait can end are testable without a helper, a
 * filesystem or fifteen minutes. `waiting` is the only good answer; the rest
 * each carry a different thing for the editor to do.
 */
function waitVerdict(live, w) {
  if (live && live.running && live.busy) return "waiting";
  // Alive but idle, and our answer never came: the request was claimed and
  // dropped. A helper restarted mid-job renames the request `.taken` and never
  // comes back to it - deliberately, so a crash cannot run a job twice - which
  // means no answer is coming and waiting longer cannot help.
  if (live && live.running && (w.sawBusy || w.sinceStartMs > w.pickupMs)) return "dropped";
  // No heartbeat. Give it the idle window first: a helper being restarted
  // comes back within a few seconds, and failing instantly on a blip would be
  // its own kind of wrong answer.
  if (live && !live.running && w.sinceAliveMs > w.idleMs) return "dead";
  if (w.sinceStartMs > w.hardCapMs) return "capped";
  return "waiting";
}

/**
 * Send one request and wait for its answer.
 *
 * **Wait on the HEARTBEAT, not on a stopwatch.** A fixed wall-clock timeout has
 * to guess how long the longest legitimate job takes, and it guessed wrong: a
 * four-track verify answered in 904.3s against a 900s limit, so the panel
 * abandoned a job 4.3 seconds before the answer landed and told the editor the
 * helper had not replied. It had.
 *
 * The helper publishes what it is working on every five seconds from its own
 * thread, so there is no need to guess. Waiting is only wrong in two cases,
 * and both are visible:
 *
 *  - the heartbeat has gone stale, so the helper died mid-job;
 *  - the helper is alive and IDLE while our answer never came, which means the
 *    request was claimed and then dropped - a helper restarted mid-job renames
 *    the request `.taken` and never returns to it, by design, so that a crash
 *    cannot make it run the same job twice.
 *
 * Both now fail in seconds with the actual reason instead of after fifteen
 * minutes with the wrong one.
 *
 * `onProgress` is called with the seconds waited, so the panel can say what it
 * is waiting for rather than freezing.
 */
async function request(kind, params, opts) {
  const o = opts || {};
  // How long to wait with NO sign of life - not how long a job may take.
  const idleMs = o.timeoutMs || 90 * 1000;
  // A final backstop, for a helper that is alive and busy forever.
  const hardCapMs = o.hardCapMs || 60 * 60 * 1000;
  // Long enough for the helper's 0.5s poll to notice the request and claim it.
  const pickupMs = 30 * 1000;
  const folder = await queueFolder();

  const live = await status();
  if (!live.running && !o.skipStatusCheck) {
    throw new Error("The background helper is not running. Install it once with " +
                    "scripts/install-helper (.sh on a Mac, .ps1 on Windows) - it is what " +
                    "runs ffmpeg for the panel, which Premiere's own plugin runtime cannot do.");
  }

  const id = newId();
  await writeJson(folder, "req-" + id + ".json", { id: id, kind: kind, params: params || {} });

  const started = Date.now();
  let waited = 0;
  let lastAlive = Date.now();
  let sawBusy = false;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    let res = await readJson(folder, "res-" + id + ".json");
    if (!res) {
      const live = await status();
      if (live.running && live.busy) { lastAlive = Date.now(); sawBusy = true; }
      const verdict = waitVerdict(live, {
        sawBusy: sawBusy,
        sinceStartMs: Date.now() - started,
        sinceAliveMs: Date.now() - lastAlive,
        pickupMs: pickupMs, idleMs: idleMs, hardCapMs: hardCapMs
      });
      if (verdict !== "waiting") {
        // Look once more before giving up: the helper writes the response and
        // clears `busy` at almost the same moment, and reading those two in
        // the wrong order would throw away an answer that had just arrived.
        res = await readJson(folder, "res-" + id + ".json");
        if (!res && verdict === "dropped") {
          throw new Error("The helper restarted while it was working on this, so the job was "
                          + "dropped. Nothing was changed - press Check again.");
        }
        if (!res && verdict === "dead") {
          throw new Error("The helper stopped responding " +
                          Math.round((Date.now() - lastAlive) / 1000) + "s ago" +
                          (sawBusy ? " while it was working on this job" : "") +
                          ". " + LOG_HINT);
        }
        if (!res && verdict === "capped") {
          throw new Error("The helper has been working on this for " +
                          Math.round(hardCapMs / 60000) + " minutes and has not finished. " +
                          LOG_HINT);
        }
      }
    }
    if (res) {
      if (!res.ok) {
        const err = new Error(res.error || "the helper could not complete that");
        err.log = res.log || [];
        throw err;
      }
      res.result = res.result || {};
      res.result._log = res.log || [];
      res.result._seconds = res.seconds;
      return res.result;
    }
    const nowWaited = Math.round((Date.now() - started) / 1000);
    if (o.onProgress && nowWaited !== waited) {
      waited = nowWaited;
      o.onProgress(waited);
    }
  }
}

/** Plan a conform: match the clips to graded files and work out each sourceIn. */
async function plan(params, opts) {
  return await request("plan", params, opts);
}

/**
 * What a set of whole files IS: duration, start timecode, size, channels.
 *
 * The single-master and stem modes do no matching, so this is their entire
 * evidence base - and start timecode is the only thing that can tell a master
 * rendered with head handles from one rendered flush.
 */
async function probe(paths, opts) {
  const res = await request("probe", { paths: paths, fps: (opts || {}).fps },
                            Object.assign({ timeoutMs: 90 * 1000 }, opts || {}));
  return (res && res.files) || {};
}

/**
 * One frame out of the middle of each file, so a choice between two exports
 * can be made by looking rather than by reading filenames.
 *
 * Short by design - a second or two - so it can run right after a check, with
 * or without verification. The timeout is correspondingly tight: waiting
 * fifteen minutes for a thumbnail would be waiting for something that has
 * already failed.
 */
async function thumbs(paths, opts) {
  return await request("thumbs", { paths: paths },
                       Object.assign({ timeoutMs: 90 * 1000 }, opts || {}));
}

/**
 * Where the helper writes thumbnails: inside the queue folder, which is inside
 * the panel's own data folder and needs no permission from anyone.
 */
async function thumbsFolder() {
  const folder = await queueFolder();
  try {
    return await folder.getEntry("thumbs");
  } catch (e) {
    return await folder.createFolder("thumbs");
  }
}

/** Verify a rendered kit against the picture. */
async function verify(kitDir, opts) {
  return await request("verify", { kitDir: kitDir }, opts);
}

/**
 * A folder inside the plugin's data folder, for the verification kit.
 *
 * Using the data folder rather than asking the editor to pick somewhere is the
 * whole point: no picker, and the helper knows where to look without being
 * told.
 */
async function kitFolder(name) {
  const fs = uxpFs();
  const data = await fs.getDataFolder();
  const wanted = name || "kit";
  try {
    return await data.getEntry(wanted);
  } catch (e) {
    return await data.createFolder(wanted);
  }
}

module.exports = {
  HEARTBEAT_STALE_SECONDS: HEARTBEAT_STALE_SECONDS,
  isFresh: isFresh,
  waitVerdict: waitVerdict,
  status: status,
  request: request,
  plan: plan,
  probe: probe,
  thumbs: thumbs,
  thumbsFolder: thumbsFolder,
  verify: verify,
  queueFolder: queueFolder,
  kitFolder: kitFolder
};
