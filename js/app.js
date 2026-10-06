/**
 * app.js - panel UI, state, and the run loop. Knows nothing about the
 * premierepro API; every call into Premiere goes through js/ppro.js, and every
 * decision about what to place comes from js/plan.js.
 *
 * Scope: multi-clip video mode - DaVinci/Baselight-style per-cut exports placed
 * back over their cuts. Single-master and audio-stem modes are not built yet.
 *
 * The flow is deliberately two-stage, Check then Conform, and the Conform
 * button stays disabled until a Check has run. This is the same gate Onliner
 * puts in front of the multicam problem: when a step needs a human, pause with
 * a named list rather than warning after the damage. Here the list is every
 * clip that will NOT be placed, and why - the part of the handover an editor
 * can actually act on.
 */

// UXP resolves require() against the PLUGIN ROOT, not the requiring file's
// folder, so these are root-relative despite living beside this file.
const prefs = require("./js/prefs");
const ppro = require("./js/ppro");
const plan = require("./js/plan");
const helper = require("./js/helper");

const $ = (id) => document.getElementById(id);

const CONTROLS = {
  videoMode: "text",
  audioMode: "text",
  duplicateFirst: "checkbox",
  muteOriginalAudio: "checkbox",
  suffix: "text",
  carryMotion: "checkbox",
  verifyPicture: "checkbox",
  align: "text",
  handleFrames: "text",
  binName: "text"
};

const state = {
  settings: prefs.load(),
  sequences: [],
  sourceId: null,
  trackIndices: [0],
  shape: null,
  gradedFolder: null,   // a UXP folder entry, restored from a persistent token
  audioRun: null,       // the stems half of the last Check
  clips: [],            // the offline clips the video half was planned against
  masterFile: null,     // single-master mode: the one graded file
  stemsFolder: null,    // audio mode: the folder the stems came back in
  span: null,           // the offline's duration and zero point, read per check
  probed: null,         // what the helper read off the chosen file(s)
  planEntries: null,
  planned: null,      // the last plan + the clips it was built against, so a
                      // change of version rebuilds the run without re-planning
  chosen: {},         // key -> graded path the editor picked by hand
  verdicts: null,     // the last picture check, kept so one swap does not void it
  thumbs: {},         // graded path -> data URL, filled in after a check
  run: null,          // the last Check result
  helper: null,       // last known helper status
  busy: false
};

// ---------------------------------------------------------------------------
// Small UI helpers
// ---------------------------------------------------------------------------

function setStatus(text, kind) {
  const el = $("status");
  el.textContent = text;
  el.className = "status " + (kind === "bad" ? "bad" : (kind === "warn" ? "warn" : "muted"));
}

function setBusy(busy, what) {
  state.busy = busy;
  ["btnCheck", "btnRun", "btnPickGraded", "btnRefresh"].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = busy;
  });
  if (!busy) refreshRunButton();
  if (busy && what) setStatus(what);
}

function refreshRunButton() {
  // EITHER half being ready is enough: a mix can be conformed onto an offline
  // whose grade has not come back yet, and vice versa.
  const anything = (state.run ? state.run.placements.length : 0) +
                   (state.audioRun ? state.audioRun.placements.length : 0);
  $("btnRun").disabled = !(anything && !state.busy);
}

function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

/**
 * A titled block in a report. Returns the block, to append rows to.
 *
 * The reports used to be one flat list of lines where a section heading was
 * just another grey line, so nothing told you where one group ended and the
 * next began, and everything read as equally important.
 */
function section(parent, title, count, kind) {
  const sec = document.createElement("div");
  sec.className = "rsec" + (kind ? " " + kind : "");
  const head = document.createElement("div");
  head.className = "rsec-head";
  const t = document.createElement("span");
  t.className = "rsec-title";
  t.textContent = title;
  head.appendChild(t);
  if (count !== null && count !== undefined) {
    const c = document.createElement("span");
    c.className = "rsec-count";
    c.textContent = String(count);
    head.appendChild(c);
  }
  sec.appendChild(head);
  parent.appendChild(sec);
  return sec;
}

/**
 * One clip in a report: WHERE it is, WHAT it is, and WHY - three separate
 * things rather than one long sentence. The reason gets its own line under the
 * name, because that is the part an editor acts on and it used to be the
 * dimmest text on the panel.
 */
function row(parent, o) {
  const r = document.createElement("div");
  r.className = "rrow" + (o.kind ? " " + o.kind : "");
  const top = document.createElement("div");
  top.className = "rrow-top";
  const tc = document.createElement("span");
  tc.className = "tc";
  tc.textContent = (typeof o.start === "number") ? plan.formatSeconds(o.start) : "";
  top.appendChild(tc);
  if (typeof o.trackIndex === "number" && o.trackIndex >= 0) {
    const t = document.createElement("span");
    t.className = "trk";
    t.textContent = "V" + (o.trackIndex + 1);
    top.appendChild(t);
  }
  const nm = document.createElement("span");
  nm.className = "nm";
  nm.textContent = o.name || "";
  top.appendChild(nm);
  r.appendChild(top);
  // The change goes on its own line, not beside the name. Sharing the row
  // squeezed the name into breaking mid-word ("..._COMP_V / 2.mov"), and the
  // one thing this row exists to announce ended up the hardest part to read.
  if (o.change) line(r, o.change, "chg");
  if (o.why) line(r, o.why, "why");
  parent.appendChild(r);
  return r;
}

function line(parent, text, cls) {
  const div = document.createElement("div");
  if (cls) div.className = cls;
  div.textContent = text;
  parent.appendChild(div);
  return div;
}

function readControls() {
  const out = {};
  Object.keys(CONTROLS).forEach((id) => {
    const el = $(id);
    if (!el) return;
    out[id] = CONTROLS[id] === "checkbox" ? !!el.checked : String(el.value == null ? "" : el.value);
  });
  return out;
}

function writeControls(settings) {
  Object.keys(CONTROLS).forEach((id) => {
    const el = $(id);
    if (!el) return;
    if (CONTROLS[id] === "checkbox") el.checked = !!settings[id];
    else el.value = settings[id] == null ? "" : String(settings[id]);
  });
}

/** A blank suffix would name the conform exactly like its offline. */
function effectiveSuffix() {
  const typed = String(state.settings.suffix || "").trim();
  return typed || prefs.DEFAULTS.suffix;
}

function sourceName() {
  const hit = state.sequences.filter((s) => s.id === state.sourceId)[0];
  return hit ? hit.name : "";
}

function updateNamePreview() {
  const el = $("namePreview");
  if (!state.sourceId) { el.textContent = ""; return; }
  el.textContent = state.settings.duplicateFirst
    ? sourceName() + effectiveSuffix()
    : "In place: " + sourceName();
}

// ---------------------------------------------------------------------------
// Reading the project
// ---------------------------------------------------------------------------

async function loadProject() {
  const summary = await ppro.readProjectSummary();
  if (!summary) {
    $("projectLine").textContent = "No project open in Premiere.";
    $("projectPath").textContent = "";
    return;
  }
  $("projectLine").textContent = summary.name + "  ·  " + summary.sequenceCount + " sequences";
  // The path is shown, not hidden in a tooltip: a conform written into the
  // wrong project is not something an editor can easily unpick, and project
  // names repeat across jobs far more often than paths do.
  $("projectPath").textContent = summary.path || "";

  state.sequences = await ppro.listSequences();
  const select = $("sourceSelect");
  clear(select);
  state.sequences.forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.name;
    select.appendChild(opt);
  });
  if (summary.activeSequence) {
    state.sourceId = summary.activeSequence.id;
    select.value = state.sourceId;
  } else if (state.sequences.length) {
    state.sourceId = state.sequences[0].id;
    select.value = state.sourceId;
  }
  await loadTracks();
  updateNamePreview();
}

async function loadTracks() {
  const list = $("trackList");
  clear(list);
  if (!state.sourceId) return;
  state.shape = await ppro.readSequenceShape(state.sourceId);

  // Remembered selection, kept only where those tracks still exist and still
  // hold clips - a sequence picked yesterday may have a different shape today.
  const remembered = String(state.settings.trackIndex || "0")
    .split(",").map((n) => Number(n)).filter((n) => !isNaN(n));
  const usable = state.shape.videoTracks.filter((t) => t.clips > 0);
  let chosen = remembered.filter((i) => usable.some((t) => t.index === i));
  if (!chosen.length) chosen = usable.length ? [usable[0].index] : [];
  state.trackIndices = chosen;

  state.shape.videoTracks.forEach((t) => {
    const box = document.createElement("sp-checkbox");
    box.setAttribute("size", "s");
    box.textContent = t.label + "  (" + t.clips + " clip" + (t.clips === 1 ? "" : "s") + ")";
    box.checked = chosen.indexOf(t.index) !== -1;
    if (!t.clips) box.disabled = true;
    box.addEventListener("change", () => {
      const on = !!box.checked;
      const at = state.trackIndices.indexOf(t.index);
      if (on && at === -1) state.trackIndices.push(t.index);
      if (!on && at !== -1) state.trackIndices.splice(at, 1);
      state.trackIndices.sort((a, b) => a - b);
      persist();
      invalidateCheck();
    });
    list.appendChild(box);
  });
  if (!state.shape.videoTracks.length) line(list, "This sequence has no video tracks.", "empty");
}

// ---------------------------------------------------------------------------
// The plan file
// ---------------------------------------------------------------------------

async function pickGraded() {
  const uxp = require("uxp");
  const fs = uxp.storage.localFileSystem;
  // A master is ONE file; the other two modes are folders. Asking for the
  // wrong kind is the sort of thing an editor works around rather than
  // reports, so the picker matches the mode.
  if (videoMode() === "master") {
    const file = await fs.getFileForOpening({ allowMultiple: false });
    if (!file) return;
    await useSource(file, "master");
    return;
  }
  const folder = await fs.getFolder();
  if (!folder) return;
  await useSource(folder, videoMode());
}

/** The stems folder has its own button, because it sits alongside the picture. */
async function pickStems() {
  const folder = await require("uxp").storage.localFileSystem.getFolder();
  if (!folder) return;
  await useSource(folder, "audio");
}

/** Remember the chosen source against the mode it belongs to. */
async function useSource(entry, forMode) {
  const lineId = forMode === "audio" ? "stemsLine" : "gradedLine";
  const keys = { multiclip: ["gradedToken", "gradedPath"], master: ["masterToken", "masterPath"],
                 audio: ["stemsToken", "stemsPath"] }[forMode];
  if (forMode === "master") state.masterFile = entry;
  else if (forMode === "audio") state.stemsFolder = entry;
  else state.gradedFolder = entry;
  $(lineId).textContent = entry.nativePath;
  try {
    const token = await require("uxp").storage.localFileSystem.createPersistentToken(entry);
    state.settings[keys[0]] = token;
    state.settings[keys[1]] = entry.nativePath;
    prefs.save(state.settings);
  } catch (e) { /* not fatal - it just will not be remembered */ }
  invalidateCheck();
}


/**
 * Re-open whatever each mode had chosen last time.
 *
 * All three are restored, not just the current mode's, so switching modes does
 * not send the editor back to the file picker for something they already chose.
 * A token that no longer resolves is normal - delivery folders get reorganised
 * constantly - so it is reported against that mode and nothing else breaks.
 */
async function restoreGradedFolder() {
  const fs = require("uxp").storage.localFileSystem;
  const slots = [
    ["gradedToken", "gradedPath", "multiclip"],
    ["masterToken", "masterPath", "master"],
    ["stemsToken", "stemsPath", "audio"]
  ];
  for (const [tokenKey, pathKey, forMode] of slots) {
    const token = state.settings[tokenKey];
    if (!token) continue;
    try {
      const entry = await fs.getEntryForPersistentToken(token);
      if (!entry) continue;
      if (forMode === "master") state.masterFile = entry;
      else if (forMode === "audio") state.stemsFolder = entry;
      else state.gradedFolder = entry;
    } catch (e) {
      const line = (forMode === "audio") ? "stemsLine" : "gradedLine";
      if (forMode === "audio" || forMode === videoMode()) {
        $(line).textContent = state.settings[pathKey]
          ? state.settings[pathKey] + "  (no longer reachable - choose it again)"
          : "No " + (forMode === "master" ? "file" : "folder") + " chosen";
      }
    }
  }
  applyMode();
}

/** Any change to what a Check was based on disarms it. */
function invalidateCheck() {
  state.run = null;
  state.audioRun = null;
  state.clips = [];
  clear($("runReport"));
  // The picks go too. They are keyed by track and timecode, so keeping them
  // across a change of sequence or graded folder would silently apply one
  // cut's decision to a different cut that happens to start at the same time.
  state.planned = null;
  state.chosen = {};
  $("checkSummary").textContent = "Not checked yet.";
  clear($("checkDetail"));
  refreshRunButton();
}

// ---------------------------------------------------------------------------
// The helper
// ---------------------------------------------------------------------------

// Where to get ffmpeg. It is GPLv3, so the panel never ships it; the helper
// finds a static build in bin/ or on PATH and says so in its heartbeat.
const FFMPEG_DOWNLOAD_URL = "https://ffmpeg.org/download.html";

/**
 * Show or hide the "Get ffmpeg" link under the helper line. UXP anchors do not
 * navigate; the system browser is asked through shell.openExternal, which the
 * manifest's launchProcess permission allows for https.
 */
function showFfmpegLink(url) {
  const el = $("helperLink");
  if (!el) return;
  el.hidden = !url;
  el.onclick = url ? async (ev) => {
    ev.preventDefault();
    try {
      const err = await require("uxp").shell.openExternal(url, "Open the ffmpeg download page in your browser.");
      if (err) setStatus("Could not open the browser: " + err, "warn");
    } catch (e) {
      setStatus("Could not open the browser: " + (e.message || e) + " \u2014 the page is " + url, "warn");
    }
  } : null;
}

async function refreshHelper() {
  try {
    const live = await helper.status();
    state.helper = live;
    const tools = live.tools || null;
    const noFfmpeg = live.running && tools && (!tools.ffmpeg || !tools.ffprobe);
    $("helperLine").textContent = live.running
      ? (noFfmpeg
          ? "Helper running, but it has no ffmpeg \u2014 nothing can be planned or checked until it does. " +
            "Put a static ffmpeg and ffprobe in the plugin's bin folder (Mac: scripts/fetch-ffmpeg.sh) or on PATH, then restart the helper."
          : (live.busy
              ? "Helper busy \u2014 " + live.busy + ", " + Math.round(live.busySeconds || 0) + "s"
              : "Helper running (" + live.version + ")"))
      : "Helper not running \u2014 install it once with scripts/install-helper (.sh on a Mac, .ps1 on Windows)";
    $("helperLine").className = live.running && !noFfmpeg ? "note" : "warn";
    showFfmpegLink(noFfmpeg ? (tools.downloadUrl || FFMPEG_DOWNLOAD_URL) : null);
  } catch (e) {
    state.helper = { running: false };
    $("helperLine").textContent = "Helper not reachable: " + (e.message || e);
    $("helperLine").className = "warn";
  }
}

// ---------------------------------------------------------------------------
// Check - the dry run
// ---------------------------------------------------------------------------

async function check() {
  if (!state.sourceId) { setStatus("Choose the offline sequence first.", "warn"); return; }
  // Each axis is guarded on its own, and the source is a DIFFERENT THING in
  // each picture mode - a flat "choose the graded footage folder first" in
  // single-master mode is both wrong and impossible to act on, because there
  // is no folder to choose there.
  const v = videoMode(), a = audioMode();
  if (v === "none" && a === "none") {
    setStatus("Nothing to conform - choose a picture mode, a sound mode, or both.", "warn");
    return;
  }
  const videoSource = v === "master" ? state.masterFile : state.gradedFolder;
  if (v !== "none" && !videoSource) {
    setStatus(v === "master" ? "Choose the graded master file first."
                             : "Choose the graded footage folder first.", "warn");
    return;
  }
  if (a === "stems" && !state.stemsFolder) {
    setStatus("Choose the stems folder first.", "warn");
    return;
  }

  // CLEAR THE BOARD FIRST. A check that then fails used to leave the previous
  // check's report and the previous conform's report on screen with a red
  // error underneath - three different runs reading as one, and the report
  // looked like the answer to the check that had just failed.
  $("checkSummary").textContent = "Checking\u2026";
  clear($("checkDetail"));
  clear($("runReport"));
  $("runNote").textContent = "Check first. Nothing is placed until the refusals have been read.";

  state.run = null;
  state.audioRun = null;
  state.clips = [];
  setBusy(true, "Reading the timeline\u2026");
  try {
    // PICTURE, then SOUND. Planned separately because they answer different
    // questions; reported and placed together because they land in ONE
    // sequence - an editor should not have to conform twice and merge by hand.
    if (v === "multiclip") {
      const got = await planMultiClip();
      state.run = got.run;
      state.clips = got.clips;
    } else if (v === "master") {
      state.run = await planWhole("master");
    }
    if (a === "stems") state.audioRun = await planWhole("audio");

    renderChecks();
    const ready = (state.run ? state.run.placements.length : 0) +
                  (state.audioRun ? state.audioRun.placements.length : 0);
    setStatus(ready ? "Checked. " + ready + " ready to place."
                    : "Checked. Nothing can be placed - see the list.", ready ? null : "warn");
    if (state.run && state.run.versions) loadThumbs(state.run);
  } catch (e) {
    state.run = null;
    state.audioRun = null;
    state.planned = null;
    setStatus(String(e.message || e), "bad");
    const detail = $("checkDetail");
    clear(detail);
    $("checkSummary").textContent = "Check failed \u2014 nothing here is current.";
    line(detail, String(e.message || e), "warn");
    if (e.log && e.log.length) {
      line(detail, "The helper said:", "sublabel");
      e.log.slice(-8).forEach((l) => line(detail, "  " + l, "muted"));
    }
  } finally {
    setBusy(false);
    refreshRunButton();
  }
}

/**
 * Plan the per-cut video mode: read the timeline, match it against the graded
 * folder, verify against the picture if asked. Returns the run rather than
 * rendering it, so the sound half can be planned alongside.
 */
async function planMultiClip() {
    if (!state.trackIndices.length) throw new Error("Tick at least one track to conform.");
    let clips = [];
    for (const t of state.trackIndices) {
      clips = clips.concat(await ppro.readTrackClips(state.sourceId, t));
    }
    const ticksPerFrame = await ppro.readTimebase(state.sourceId);
    const fps = plan.TICKS_PER_SECOND / ticksPerFrame;

    // Only clips backed by a file can be conformed. Graphics and titles have no
    // media path, and sending them would just produce MISSING rows for things
    // that were never graded in the first place.
    // Retimed clips never reach the planner. There is no offset that could be
    // right for them - the API cannot set a clip's speed - and sending them
    // means frame matching spends minutes failing, then reports "frames likely
    // not in the graded file", which is a misleading reason for a speed change.
    const conformable = clips.filter((c) => !plan.isRetimed(c));
    const payload = conformable.filter((c) => !!c.path).map((c) => ({
      start: c.start, in: c.srcIn, dur: c.dur, source: plan.normalisePath(c.path),
      // Copied straight through by the planner and read back by plan.js, so a
      // clip can only ever match on the track it came from.
      trackIndex: c.trackIndex
    }));
    if (!payload.length) {
      throw new Error("No clips on the chosen track" + (state.trackIndices.length > 1 ? "s" : "") +
                      " are backed by a media file.");
    }

    setBusy(true, "Matching " + payload.length + " clips from " + state.trackIndices.length +
            " track" + (state.trackIndices.length === 1 ? "" : "s") + " against the graded folder\u2026");
    const planned = await helper.plan({
      clips: payload,
      gradedDir: state.gradedFolder.nativePath,
      fps: fps,
      align: state.settings.align,
      handleFrames: Number(state.settings.handleFrames || 12)
    }, { onProgress: (s2) => setStatus("Planning\u2026 " + s2 + "s") });

    // The frame size is what makes "Set to Frame Size" detectable: Premiere's
    // Scale is a percentage of the SOURCE's pixels, so the sequence's own size
    // is needed to know what "fits" means.
    const planOpts = {
      ticksPerFrame: ticksPerFrame,
      frameWidth: state.shape ? state.shape.frameWidth : null,
      frameHeight: state.shape ? state.shape.frameHeight : null,
      chosen: state.chosen
    };
    // Kept so that changing a version rebuilds the run from the SAME plan.
    // Every candidate already carries its own offset, so a different pick is
    // arithmetic the panel can do on its own - no helper, no waiting.
    state.planned = { entries: planned.entries, clips: conformable, allClips: clips,
                      frameMatched: planned.frameMatched, fps: fps };
    let run = plan.buildRun(planned.entries, conformable, planOpts);
    run.planOpts = planOpts;
    run.ticksPerFrame = ticksPerFrame;
    run.frameMatched = planned.frameMatched;
    // They were held back from the planner, so their refusals are added here -
    // a clip nobody mentions is a clip nobody checks.
    plan.mergeRefusals(run, plan.retimedRefusals(clips));

    // Verification, if asked for: render the frames, hand the kit to the
    // helper, fold the verdicts straight back in. No picker, no terminal.
    if (state.settings.verifyPicture && (run.placements.length || (run.unresolved || []).length)) {
      run = await verifyRun(run, fps, ticksPerFrame);
    } else if ((run.unresolved || []).length) {
      setStatus((run.unresolved || []).length + " cut(s) match two graded exports - switch on " +
                "\u201cVerify against the picture\u201d and they can be settled automatically.", "warn");
    }

  return { run: run, clips: clips };
}


/**
 * Render the reference frames and have the helper match them.
 *
 * The kit goes in the panel's own data folder, which is both why there is no
 * picker and how the helper knows where to find it.
 */
async function verifyRun(run, fps, ticksPerFrame) {
  const frameSeconds = 1 / fps;
  const kit = plan.verificationKit(run, {
    fps: fps, frameSeconds: frameSeconds,
    sequenceWidth: state.shape ? state.shape.frameWidth : null,
    sequenceHeight: state.shape ? state.shape.frameHeight : null
  });

  const folder = await helper.kitFolder("kit");

  // Render TRACK BY TRACK, with the others muted.
  //
  // A rendered frame is the programme, so a V1 cut sitting under a V2 clip
  // would be "verified" against whatever is on top of it. Isolating each track
  // in turn is the only way the reference frame is the shot being conformed.
  // Every cut in the kit, placements AND the ambiguous ones waiting on a
  // verdict. Looking only at placements sent all four ambiguous cuts through
  // the V1 pass with their own tracks hidden, and the V4 one rendered black -
  // which the matcher can only report as "nothing matched".
  const trackOf = {};
  run.placements.forEach((p) => { trackOf[p.key] = p.trackIndex; });
  (run.unresolved || []).forEach((u) => { trackOf[u.key] = u.trackIndex; });

  const byTrack = {};
  const orphans = [];
  kit.clips.forEach((c) => {
    const t = trackOf[c.key];
    if (t === undefined) { orphans.push(c.key); return; }
    (byTrack[t] = byTrack[t] || []).push(c);
  });
  if (orphans.length) {
    // A cut with no known track cannot be isolated, so it is not rendered at
    // all rather than rendered against the wrong picture.
    setStatus(orphans.length + " cut(s) could not be matched to a track and were not verified.", "warn");
  }

  const written = [];
  const muteWarnings = [];
  const trackNumbers = Object.keys(byTrack).map(Number).sort((a, b) => a - b);
  for (const t of trackNumbers) {
    setBusy(true, "Rendering reference frames for V" + (t + 1) +
            " (" + byTrack[t].length + " cuts)\u2026");
    const jobs = byTrack[t].map((c) => ({
      key: c.key, start: c.start, probes: c.probes, frameSeconds: frameSeconds
    }));
    const frames = await ppro.exportReferenceFrames(
      state.sourceId, jobs, folder, { width: 640, height: 360 }, t);
    frames.forEach((f) => written.push(f));
    if (frames.stillMuted && frames.stillMuted.length) {
      muteWarnings.push("V" + (t + 1) + " pass left " + frames.stillMuted.join(", ") + " muted");
    }
  }

  const byKey = {};
  written.forEach((w) => {
    if (!w.ok) return;
    (byKey[w.key] = byKey[w.key] || []).push({ probe: w.probe, file: w.file });
  });
  kit.clips.forEach((c) => { c.refs = byKey[c.key] || []; });
  kit.sequence = sourceName();

  const manifest = await folder.createFile("manifest.json", { overwrite: true });
  await manifest.write(JSON.stringify(kit, null, 1));

  // A kit short of frames is not a smaller kit, it is a weaker verdict: fewer
  // probes means "inconclusive", which reads like hard-to-match footage rather
  // than like a failed render. So it is said out loud.
  if (muteWarnings.length) {
    setStatus("Tracks were left muted: " + muteWarnings.join("; ") +
              " - unmute them in the timeline.", "bad");
  }
  const failed = written.filter((w) => !w.ok).length;
  if (failed) {
    setStatus(failed + " of " + written.length + " reference frames could not be rendered - " +
              "verdicts will be weaker than they should be.", "warn");
  }
  setBusy(true, "Checking the frames against the graded files\u2026" +
          (failed ? " (" + failed + " frames missing)" : ""));
  const doc = await helper.verify(folder.nativePath, {
    onProgress: (s2) => setStatus("Verifying\u2026 " + s2 + "s")
  });
  // Kept so that changing ONE cut's version does not throw away what the
  // picture proved about all the others - see rebuildFromPlan.
  state.verdicts = doc;
  const verified = plan.applyVerification(run, doc, run.planOpts || {});
  verified.ticksPerFrame = ticksPerFrame;
  verified.frameMatched = run.frameMatched;
  return verified;
}

/**
 * One report for one sequence, however many things are going into it.
 *
 * Picture and sound are planned separately but land together, so they are
 * reported together - with their own counts, because "3 refused" means
 * something different about four stems than it does about sixteen cuts.
 */
function renderChecks() {
  const sum = $("checkSummary");
  clear(sum);
  const chips = document.createElement("div");
  chips.className = "chips";
  const chip = (text, kind) => {
    const c = document.createElement("span");
    c.className = "chip" + (kind ? " " + kind : "");
    c.textContent = text;
    chips.appendChild(c);
  };
  const v = state.run, a = state.audioRun;
  if (v) {
    chip((a ? "Picture " : "") + v.summary.placeable + " of " + v.summary.planned + " ready",
         v.summary.placeable ? "ok" : "bad");
    if (v.summary.refused) chip(v.summary.refused + " refused", "bad");
  }
  if (a) {
    chip((v ? "Sound " : "") + a.summary.placeable + " of " + a.summary.planned + " ready",
         a.summary.placeable ? "ok" : "bad");
    if (a.summary.refused) chip(a.summary.refused + " refused", "bad");
  }
  sum.appendChild(chips);

  const detail = $("checkDetail");
  clear(detail);
  if (v) {
    if (v.mode === "master") renderWholeCheck(v, detail);
    else renderCheck(v, state.clips || [], detail);
  }
  if (a) {
    if (v) line(detail, "\u2014 Sound \u2014", "sublabel");
    renderWholeCheck(a, detail);
  }
}

function renderCheck(run, clips, detail) {
  const s = run.summary;

  // ORDER: things needing a decision first, then things to glance at, then the
  // confirmation of what will actually happen. A panel gets scrolled, so what
  // the editor must act on should not be below what they can skim.

  if (run.versions && run.versions.length) renderVersions(run, detail);

  if (run.refused.length) {
    const sec = section(detail, "Will not be placed", run.refused.length, "bad");
    run.refused.forEach((r) => {
      row(sec, { start: r.start, name: r.name, why: r.reason, kind: "bad" });
    });
    line(sec, "These stay as they are, with the offline media on them. An editor can fix a " +
         "named list; nobody can find wrong frames hidden among right ones.", "note");
  }

  // Scale 100 on outsized media, with no picture to settle whether it is
  // "Set to Frame Size" or a deliberate punch-in.
  const suspect = run.placements.filter((p) => p.scaleFix && p.scaleFix.guessing);
  if (suspect.length) {
    const sec = section(detail, "Scale needs the picture to settle it", suspect.length, "warn");
    line(sec, "These read Scale 100 on media far larger than the frame. That is either " +
         "\u201cSet to Frame Size\u201d or a deliberate punch-in, and only the picture can " +
         "tell them apart.", "rsec-lead");
    suspect.forEach((p) => {
      row(sec, { start: p.start, trackIndex: p.trackIndex, name: p.name, kind: "warn",
                 why: "Carried across unchanged. It would be Scale " + p.scaleFix.scale +
                      " if fitted \u2014 switch verification on to settle it." });
    });
  }

  const warned = run.placements.filter((p) => p.warnings && p.warnings.length);
  if (warned.length) {
    const sec = section(detail, "Worth a look \u2014 timecode disagrees", warned.length, "warn");
    warned.forEach((p) => {
      row(sec, { start: p.start, trackIndex: p.trackIndex, name: p.name, kind: "warn",
                 why: p.warnings.join(" \u00b7 ") });
    });
  }

  if (run.verification) renderVerification(run, detail);

  // What will actually happen, as a list rather than as an absence of
  // complaints. The re-scaled clips are flagged HERE rather than in a section
  // of their own, so no clip appears twice.
  if (run.placements.length) {
    const refit = run.placements.filter((p) => p.scaleFix && p.scaleFix.apply);
    const sec = section(detail, "Will be placed", run.placements.length, "ok");
    if (refit.length) {
      line(sec, refit.length + " of these " + (refit.length === 1 ? "is" : "are") +
           " re-scaled: the offline\u2019s own Scale would show a different framing on the " +
           "graded media.", "rsec-lead");
    }
    run.placements.forEach((p) => {
      const v = p.verification || {};
      const why = [];
      if (p.method) why.push(p.method);
      if (v.verdict && v.verdict !== "unchecked") why.push(v.verdict);
      if (p.scaleFix && p.scaleFix.apply) why.push(p.scaleFix.why);
      row(sec, {
        start: p.start, trackIndex: p.trackIndex, name: p.name,
        change: (p.scaleFix && p.scaleFix.apply)
          ? ("Scale " + (p.reframe && p.reframe.Scale ? p.reframe.Scale.value : "?") +
             " \u2192 " + p.scaleFix.scale)
          : null,
        why: why.join(" \u00b7 ")
      });
    });
  }

  // Footnotes. True, worth saying once, and not worth a heading.
  const untouched = clips.length - s.matchedClips;
  if (untouched > 0) {
    line(detail, untouched + " clip" + (untouched === 1 ? " is" : "s are") + " not in the plan " +
         "and will be left alone \u2014 graphics, stills and anything never graded.", "note");
  }
  const shared = plan.sharedFiles(run.placements);
  if (shared.length) {
    line(detail, "Placed one at a time, because their marks cannot overlap: " +
         shared.map((f) => f.name + " (" + f.starts.map((x) => plan.formatSeconds(x)).join(", ") + ")")
           .join("; "), "note");
  }
}

// ---------------------------------------------------------------------------
// Whole-file modes: a single graded master, and mix stems
// ---------------------------------------------------------------------------

/** Every audio file directly inside the stems folder. */
async function stemFilesIn(folder) {
  const AUDIO = [".wav", ".aif", ".aiff", ".mp3", ".m4a", ".caf", ".flac"];
  const entries = await folder.getEntries();
  return entries
    .filter((e) => e.isFile && !e.name.startsWith("._") &&
                   AUDIO.some((x) => e.name.toLowerCase().endsWith(x)))
    .map((e) => plan.normalisePath(e.nativePath))
    .sort();
}

/**
 * Check a master or a set of stems against the offline.
 *
 * There is no matching to do, so the whole job is: how long is the sequence and
 * where does it start, how long is each file and where does IT start, and does
 * the second cover the first. The helper reads the files because Premiere's own
 * `Media.duration` hands back undefined seconds and ticks, and because start
 * timecode - the only thing that can tell a handled render from a flush one -
 * has to come off the file itself.
 */
async function planWhole(kind) {
  const isMaster = kind === "master";
  const chosen = isMaster ? state.masterFile : state.stemsFolder;
  setBusy(true, "Reading the sequence\u2026");

  const span = await ppro.readSequenceSpan(state.sourceId);
  state.span = span;
  if (!span.durationSeconds) throw new Error("That sequence has no duration to conform against.");

  const paths = isMaster
    ? [plan.normalisePath(chosen.nativePath)]
    : await stemFilesIn(chosen);
  if (!paths.length) throw new Error("No audio files in that folder.");

  setBusy(true, "Reading " + paths.length + " file" + (paths.length === 1 ? "" : "s") + "\u2026");
  const fps = span.timebase ? plan.TICKS_PER_SECOND / span.timebase : 25;
  const probed = await helper.probe(paths, { fps: fps });

  let run;
  if (isMaster) {
    const info = probed[paths[0]] || {};
    if (info.error) throw new Error(plan.baseName(paths[0]) + ": " + info.error);
    if (info.hasVideo === false) {
      throw new Error(plan.baseName(paths[0]) + " has no picture in it - that is a sound file, " +
                      "not a graded master.");
    }
    run = plan.masterPlan({
      path: paths[0], fileDur: info.duration, fileStartTC: info.startTC,
      seqDur: span.durationSeconds, seqZero: span.zeroPointSeconds,
      ticksPerFrame: span.timebase, trackIndex: span.videoTrackCount
    });
  } else {
    const files = [];
    const rejected = [];
    paths.forEach((path) => {
      const info = probed[path] || {};
      if (info.error) {
        rejected.push({ start: 0, name: plan.baseName(path), reason: info.error });
        return;
      }
      if (info.hasAudio === false) {
        rejected.push({ start: 0, name: plan.baseName(path),
                        reason: "there is no audio in this file" });
        return;
      }
      files.push({ path: path, dur: info.duration, startTC: info.startTC,
                   channels: info.channelLayout, sampleRate: info.sampleRate });
    });
    run = plan.stemsPlan({
      files: files, seqDur: span.durationSeconds, seqZero: span.zeroPointSeconds,
      ticksPerFrame: span.timebase, trackIndex: span.audioTrackCount
    });
    run.refused = run.refused.concat(rejected);
    run.summary.refused = run.refused.length;
    run.summary.planned = paths.length;
  }
  run.span = span;
  return run;
}

function renderWholeCheck(run, detail) {
  const isMaster = run.mode === "master";
  const span = run.span || {};
  line(detail, "Sequence: " + plan.formatSeconds(span.durationSeconds || 0) + " long, starting at " +
       (typeof span.zeroPointSeconds === "number"
         ? formatTimecode(span.zeroPointSeconds, plan.TICKS_PER_SECOND / span.timebase)
         : "an unknown timecode"), "note");

  if (run.refused.length) {
    const sec = section(detail, "Will not be placed", run.refused.length, "bad");
    run.refused.forEach((r) => row(sec, { name: r.name, why: r.reason, kind: "bad" }));
  }



  // A WARNING EVERY FILE SHARES IS ONE FACT ABOUT THE DELIVERY, not a list of
  // problems. Five stems each repeating "this carries no timecode, so it is
  // placed from its first frame" reads as five things to go and check, and it
  // buries the one stem that has something of its own to say.
  const withWarnings = run.placements.filter((p) => (p.warnings || []).length);
  if (withWarnings.length) {
    const counts = {};
    run.placements.forEach((p) => (p.warnings || []).forEach((w) => {
      counts[w] = (counts[w] || 0) + 1;
    }));
    // Anything TWO OR MORE of them share is said once, with a count. Only a
    // warning belonging to a single file earns that file a line of its own,
    // which is what makes the one odd stem in a set stand out instead of
    // sitting fifth in a column of identical paragraphs.
    const shared = Object.keys(counts).filter((w) => counts[w] > 1);
    const own = run.placements
      .map((p) => ({ p: p, only: (p.warnings || []).filter((w) => shared.indexOf(w) === -1) }))
      .filter((x) => x.only.length);

    const sec = section(detail, "Worth a look", shared.length + own.length, "warn");
    shared.forEach((w) => {
      const all = counts[w] === run.placements.length;
      line(sec, (all ? "Every one of these" : counts[w] + " of these") + " — " + w,
           "rsec-lead");
    });
    own.forEach((x) => row(sec, { name: x.p.label || x.p.name, kind: "warn",
                                  why: x.only.join(" · ") }));
  }

  if (run.placements.length) {
    const sec = section(detail, isMaster ? "Will be placed" : "Stems, in order",
                        run.placements.length, "ok");
    run.placements.forEach((p) => {
      row(sec, {
        name: (p.label ? p.label + "  —  " : "") + p.name,
        change: (isMaster ? "V" : "A") + (p.trackIndex + 1),
        why: p.method + (p.sourceIn
          ? " · starts " + plan.formatSeconds(p.sourceIn) + " into the file"
          : "")
      });
    });
  }

  if (!isMaster && state.settings.muteOriginalAudio && (run.span || {}).audioTrackCount) {
    line(detail, "The offline's own " + run.span.audioTrackCount + " audio track" +
         (run.span.audioTrackCount === 1 ? "" : "s") + " will be muted so the stems replace the " +
         "scratch mix rather than playing on top of it.", "note");
  }
}

/** Seconds since midnight as timecode, for showing a sequence's zero point. */
function formatTimecode(seconds, fps) {
  const f = Math.round(seconds * (fps || 25));
  const rate = Math.round(fps || 25);
  const pad = (n) => (n < 10 ? "0" : "") + n;
  return pad(Math.floor(f / (3600 * rate))) + ":" +
         pad(Math.floor(f / (60 * rate)) % 60) + ":" +
         pad(Math.floor(f / rate) % 60) + ":" + pad(f % rate);
}

/**
 * Place a master or a set of stems.
 *
 * Nothing is overwritten: both modes land on NEW tracks above (or below) what
 * is already there, so a conform that turns out to be one frame out costs
 * nothing but a track to delete.
 */
async function placeWholeInto(targetId, run, report, isMaster, offlineAudioCount) {
  const result = { placed: [], failed: [], named: 0, muted: [] };
  try {
    // Read the span HERE, not at check time. If the picture pass ran first it
    // will have left empty audio tracks behind - Premiere cannot delete a track
    // - so the first spare one has moved, and stems aimed at the check-time
    // index would land on top of the video pass's leftovers.
    const span = await ppro.readSequenceSpan(targetId);
    const base = isMaster ? span.videoTrackCount : span.audioTrackCount;

    const imported = await ppro.importGradedFiles(
      run.files, String(state.settings.binName || "GRADED").trim());
    imported.failed.forEach((p) => line(report, "Could not import " + plan.baseName(p), "bad"));

    for (let i = 0; i < run.placements.length; i++) {
      const p = run.placements[i];
      const trackIndex = base + i;
      setBusy(true, "Placing " + (i + 1) + " of " + run.placements.length + "\u2026");
      const item = imported.items[p.gradedPath];
      if (!item) {
        result.failed.push({ name: p.name, error: "not in the project after import" });
        continue;
      }
      try {
        await ppro.placeWhole(targetId, item, p, {
          videoTrackIndex: isMaster ? trackIndex : 0,
          audioTrackIndex: isMaster ? span.audioTrackCount : trackIndex,
          audioOnly: !isMaster
        });
        const label = p.label || (isMaster ? "GRADED MASTER" : p.name);
        if (await ppro.setTrackName(targetId, !isMaster, trackIndex, label)) result.named++;
        result.placed.push({ name: p.name, label: label,
                             track: (isMaster ? "V" : "A") + (trackIndex + 1) });
      } catch (e) {
        result.failed.push({ name: p.name, error: String(e.message || e) });
      }
      try { await ppro.clearMarks(item); } catch (e) { /* tidiness, not correctness */ }
    }

    // Mute the OFFLINE's own audio, counted before anything was added - not
    // whatever the count is now, which would silence the stems themselves.
    if (!isMaster && state.settings.muteOriginalAudio && offlineAudioCount) {
      const originals = [];
      for (let t = 0; t < offlineAudioCount; t++) originals.push(t);
      result.muted = await ppro.muteAudioTracks(targetId, originals, true);
    }
    renderWholeRun(result, run);
  } catch (e) {
    line(report, String(e.message || e), "bad");
    result.fatal = String(e.message || e);
  }
  return result;
}

/**
 * One conform, one sequence, whatever came back.
 *
 * Clones ONCE, then runs the picture pass and the sound pass into that same
 * sequence. The grade and the mix arrive from different people at different
 * times; putting them together is the whole point, and doing it in one pass is
 * what stops an editor merging two conforms by hand.
 */
async function conform() {
  const v = state.run, a = state.audioRun;
  const vReady = !!(v && v.placements.length);
  const aReady = !!(a && a.placements.length);
  if (!vReady && !aReady) { setStatus("Check first.", "warn"); return; }

  const report = $("runReport");
  clear(report);
  setBusy(true, "Preparing the sequence\u2026");
  let targetName = sourceName();

  try {
    let targetId = state.sourceId;
    if (state.settings.duplicateFirst) {
      const clone = await ppro.cloneSequence(state.sourceId);
      targetId = clone.id;
      targetName = sourceName() + effectiveSuffix();
      await ppro.renameSequence(targetId, targetName);
    }
    line(report, "Conforming onto: " + targetName, "sublabel");

    // The offline's own audio track count, before either pass adds any.
    const before = await ppro.readSequenceSpan(targetId);

    let vResult = null, aResult = null;
    if (vReady) {
      if (v.mode === "master") {
        vResult = await placeWholeInto(targetId, v, report, true, before.audioTrackCount);
      } else {
        setBusy(true, "Importing graded files\u2026");
        vResult = await placeMultiClipInto(targetId, v, report);
      }
    }
    if (aReady) {
      if (vReady) line(report, "\u2014 Sound \u2014", "sublabel");
      aResult = await placeWholeInto(targetId, a, report, false, before.audioTrackCount);
    }

    const placed = (vResult ? vResult.placed.length : 0) + (aResult ? aResult.placed.length : 0);
    const failed = (vResult ? vResult.failed.length : 0) + (aResult ? aResult.failed.length : 0);
    const summary = await ppro.readTrackSummary(targetId);
    line(report, "The sequence now runs " + plan.formatSeconds(summary.durationSeconds) +
         " across " + summary.video.length + " video and " + summary.audio.length +
         " audio tracks.", "note");
    setStatus(failed ? "Conformed with " + failed + " failure(s) - see the report."
                     : "Conformed " + placed + " onto " + targetName + ".",
              failed ? "warn" : "good");
  } catch (e) {
    line(report, String(e.message || e), "bad");
    setStatus(String(e.message || e), "bad");
  } finally {
    setBusy(false);
  }
}

function renderWholeRun(result, run) {
  const report = $("runReport");
  const isMaster = run.mode === "master";
  if (result.placed.length) {
    const sec = section(report, "Placed", result.placed.length, "ok");
    result.placed.forEach((p) => row(sec, { name: p.label + "  —  " + p.name,
                                            change: p.track }));
  }
  if (result.failed.length) {
    const sec = section(report, "Failed", result.failed.length, "bad");
    result.failed.forEach((f) => row(sec, { name: f.name, why: f.error, kind: "bad" }));
  }
  if (result.muted.length) {
    line(report, "Muted the offline's own audio on A1–A" + result.muted.length +
         ". Unmute from the timeline if you want the scratch mix back.", "note");
  }
  if (run.refused.length) {
    line(report, run.refused.length + " file" + (run.refused.length === 1 ? " was" : "s were") +
         " refused at the check and " + (run.refused.length === 1 ? "is" : "are") +
         " not in this sequence.", "warn");
  }
}

// ---------------------------------------------------------------------------
// Choosing between versions
// ---------------------------------------------------------------------------

/**
 * Rebuild the run from the plan already in hand.
 *
 * Changing which export a cut uses costs nothing: plan_conform solved EVERY
 * candidate, so the offset, duration and size for the other file are already
 * here. That is what makes this a dropdown rather than a re-check.
 *
 * Verification does not survive it, and should not - the verdicts describe the
 * files that were checked, and one of them has just been swapped.
 */
function rebuildFromPlan() {
  const p = state.planned;
  if (!p) return null;
  const opts = Object.assign({}, state.run && state.run.planOpts, { chosen: state.chosen });
  const run = plan.buildRun(p.entries, p.clips, opts);
  run.planOpts = opts;
  run.ticksPerFrame = opts.ticksPerFrame;
  run.frameMatched = p.frameMatched;
  plan.mergeRefusals(run, plan.retimedRefusals(p.allClips));

  // KEEP WHAT THE PICTURE PROVED ABOUT THE CUTS NOBODY TOUCHED.
  //
  // A rebuild used to drop the verdicts entirely, so swapping one cut's
  // version silently re-admitted a DIFFERENT cut that verification had refused
  // as retimed - it went from "will not be placed" back to "will be placed",
  // with only a status line to say the check was stale. Measured on a real
  // run: swapping the cut at 0:07.32 brought the retimed one at 0:11.52 back.
  //
  // A verdict is only stale for the cut whose file actually changed. Every
  // other one still describes the file it described before.
  if (state.verdicts && state.verdicts.verdicts) {
    const overridden = {};
    (run.versions || []).forEach((v) => { if (v.byUser) overridden[v.key] = true; });
    const kept = state.verdicts.verdicts.filter((x) => !overridden[x.key]);
    if (kept.length) {
      const verified = plan.applyVerification(run, { verdicts: kept }, opts);
      verified.planOpts = opts;
      verified.ticksPerFrame = opts.ticksPerFrame;
      verified.frameMatched = p.frameMatched;
      verified.versions = run.versions;
      verified.staleFor = Object.keys(overridden);
      return verified;
    }
  }
  return run;
}

function chooseVersion(key, path) {
  const had = !!(state.run && state.run.verification);
  if (path) state.chosen[key] = path;
  else delete state.chosen[key];
  const run = rebuildFromPlan();
  if (!run) return;
  state.run = run;
  renderChecks();
  loadThumbs(run);
  refreshRunButton();
  const stale = (run.staleFor || []).length;
  setStatus(stale
    ? "Version changed. The picture check still stands for every other cut, but not for " +
      (stale === 1 ? "this one" : "these " + stale) + " — run Check again to verify " +
      (stale === 1 ? "it" : "them") + "."
    : "Version changed. " + run.placements.length + " ready to place.", stale ? "warn" : null);
}

/**
 * The cuts where more than one graded export could be the answer.
 *
 * Offered for re-grades as well as for genuine ambiguities. A SUPERSEDED cut
 * has already been decided by folder date - a sound default, and a silent one -
 * and the editor may know the newest round is not the one this shot should use.
 *
 * Most of these settle without a frame being decoded: a file shorter than the
 * cut cannot be it, and on the reference job that alone disqualified a rival in
 * three of four ambiguous cuts. Where it does not, the thumbnail usually does.
 */
function renderVersions(run, el) {
  const undecided = run.versions.filter((v) => !v.chosen).length;
  const sec = section(el, "Choose a version", run.versions.length, "choose");
  line(sec, undecided
    ? undecided + " of these " + (undecided === 1 ? "has" : "have") + " nothing chosen yet."
    : "All chosen. Change any of them below.", "rsec-lead");

  run.versions.forEach((v) => {
    const box = document.createElement("div");
    box.className = "versionrow";
    line(box, plan.formatSeconds(v.start) + "  V" + (v.trackIndex + 1) + "  " + v.name +
         "  (" + v.dur.toFixed(2) + "s)", "versionhead");

    const strip = document.createElement("div");
    strip.className = "thumbstrip";
    v.candidates.forEach((c) => {
      const cell = document.createElement("div");
      cell.className = "thumbcell" + (c.chosen ? " picked" : "");
      const src = state.thumbs[c.path];
      if (src) {
        const img = document.createElement("img");
        img.src = src;
        cell.appendChild(img);
      } else {
        line(cell, " ", "thumbmissing");
      }
      line(cell, c.name, "thumbname");
      // Say what is known WITHOUT the picture, because that is often enough.
      line(cell, (c.holds === false ? "too short for this cut"
                  : (c.sourceIn === null ? "offset not known yet"
                     : "starts at " + c.sourceIn.toFixed(2) + "s")) +
                 (c.gradedDur !== null ? "  ·  " + c.gradedDur.toFixed(2) + "s" : "") +
                 (c.folder ? "  ·  " + c.folder : ""),
           c.holds === false ? "warn" : "muted");
      strip.appendChild(cell);
    });
    box.appendChild(strip);

    const pick = document.createElement("select");
    const none = document.createElement("option");
    none.value = "";
    none.textContent = v.status === "SUPERSEDED"
      ? "Let the plan choose (newest grade round)"
      : "Let the picture choose";
    pick.appendChild(none);
    v.candidates.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c.path;
      opt.textContent = c.name + (c.holds === false ? "  (too short)" : "");
      pick.appendChild(opt);
    });
    // SHOW WHAT IS ACTUALLY IN USE, not just what the editor picked by hand.
    // Leaving this blank made a row read "the picture chose it" above a control
    // saying "Undecided" - and anyone tidying up that contradiction changes a
    // cut that was already right. Measured on a real run: two cuts were swapped
    // that way while the two that needed swapping were left alone.
    pick.value = v.chosen || "";
    pick.addEventListener("change", () => chooseVersion(v.key, pick.value));
    box.appendChild(pick);

    if (!v.byUser && v.chosen) line(box, "Using " + v.why + ".", "note");
    sec.appendChild(box);
  });
}

/** ArrayBuffer -> base64, so a rendered thumbnail can go straight into an img. */
function base64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    out += chars[a >> 2];
    out += chars[((a & 3) << 4) | ((b === undefined ? 0 : b) >> 4)];
    out += (b === undefined) ? "=" : chars[((b & 15) << 2) | ((c === undefined ? 0 : c) >> 6)];
    out += (c === undefined) ? "=" : chars[c & 63];
  }
  return out;
}

/**
 * Ask the helper for one frame out of the middle of each candidate.
 *
 * Deliberately not part of verification: it takes a second or two, so the
 * choice can be offered on every check - including one run with verification
 * off, which is the only way an ambiguous cut gets settled at all then.
 *
 * Failure here is silent by design. A missing thumbnail costs the editor a
 * picture; an error banner over a report that is otherwise correct costs them
 * confidence in the whole check.
 */
async function loadThumbs(run) {
  if (!run.versions || !run.versions.length) return;
  const wanted = [];
  run.versions.forEach((v) => v.candidates.forEach((c) => {
    if (!state.thumbs[c.path] && wanted.indexOf(c.path) === -1) wanted.push(c.path);
  }));
  if (!wanted.length) return;
  try {
    const res = await helper.thumbs(wanted, { skipStatusCheck: true });
    const map = (res && res.thumbs) || {};
    const folder = await helper.thumbsFolder();
    const formats = require("uxp").storage.formats;
    let got = 0;
    for (const path of Object.keys(map)) {
      try {
        const entry = await folder.getEntry(map[path]);
        const buf = await entry.read({ format: formats.binary });
        state.thumbs[path] = "data:image/jpeg;base64," + base64(buf);
        got++;
      } catch (e) { /* one missing picture is not a failed check */ }
    }
    if (got && state.run === run) renderChecks();
  } catch (e) { /* the report stands without pictures */ }
}

function renderVerification(run, el) {
  const c = run.verification.counts;

  if (c.resolved) {
    const sec = section(el, "Settled by the picture", c.resolved, "info");
    line(sec, "Matched the offline\u2019s own frame against each candidate export.", "rsec-lead");
    run.placements.filter((p) => p.verification && p.verification.verdict === "resolved")
      .forEach((p) => row(sec, { start: p.start, trackIndex: p.trackIndex, name: p.name,
                                 why: p.verification.note || "" }));
  }

  if (run.verification.unverified.length) {
    const sec = section(el, "Placed, but nothing could confirm them",
                        run.verification.unverified.length, "warn");
    line(sec, "Verification failing to prove something is not evidence against it \u2014 a " +
         "timecode offset is exact arithmetic, and a shot that cannot be matched is usually one " +
         "where the picture barely changes. These are the ones to spot-check.", "rsec-lead");
    run.verification.unverified.forEach((u) => {
      row(sec, { start: u.start, name: u.name, why: u.why, kind: "warn" });
    });
  }

  line(el, "Picture check: " + c.confirmed + " confirmed \u00b7 " + c.static + " static \u00b7 " +
       c.disputed + " disputed \u00b7 " + c.retimed + " retimed \u00b7 " +
       (c.inconclusive + c.unchecked) + " unproved", "note");
}

// ---------------------------------------------------------------------------
// Conform - the run
// ---------------------------------------------------------------------------

/**
 * Place the per-cut video run into a sequence that ALREADY EXISTS.
 *
 * Cloning is the orchestrator's job now: picture and sound go into ONE
 * sequence, and cloning twice would hand the editor two half-conforms to
 * merge by hand - exactly the job this is supposed to remove.
 */
async function placeMultiClipInto(targetId, run, report) {
  const result = { placed: [], failed: [], motion: { applied: 0, partial: [] },
                   audioRemoved: 0, audioErrors: [], target: null };
  try {
    // 2. import every distinct graded file once
    const imported = await ppro.importGradedFiles(run.files, String(state.settings.binName || "GRADED").trim());
    if (imported.failed.length) {
      imported.failed.forEach((p) => line(report, "Could not import " + plan.baseName(p), "bad"));
    }
    line(report, "Imported " + imported.importedCount + ", reused " + imported.reused + ".", "muted");

    // 3. the spare audio track, worked out ONCE. Recomputing it per clip would
    //    add a new audio track for every placement.
    const spareAudio = await ppro.spareAudioTrackIndex(targetId);

    // 4. place, one at a time. The in/out marks live on the shared project item,
    //    so two cuts from one file cannot be marked at the same time.
    const touchedItems = [];
    for (let i = 0; i < run.placements.length; i++) {
      const p = run.placements[i];
      setBusy(true, "Placing " + (i + 1) + " of " + run.placements.length + "…");
      const item = imported.items[p.gradedPath];
      if (!item) {
        result.failed.push({ at: p.start, name: p.name, error: "not in the project after import" });
        continue;
      }
      try {
        // Motion comes off the OFFLINE clip before it is overwritten - after the
        // swap it is gone, because a fresh placement carries no effects at all
        // (which is also what strips the temp grade).
        let captured = null;
        if (state.settings.carryMotion) {
          const existing = await ppro.findClipAt(targetId, p.trackIndex, p.startTicks, run.ticksPerFrame);
          if (existing) captured = await ppro.captureMotion(existing);
        }

        const placeResult = await ppro.placeClip(targetId, item, p, spareAudio);
        result.audioRemoved += placeResult.audioRemoved || 0;
        if (placeResult.audioError) {
          result.audioErrors.push({ at: p.start, name: p.name, error: placeResult.audioError });
        }
        if (touchedItems.indexOf(p.gradedPath) === -1) touchedItems.push(p.gradedPath);

        // FITTING IS NOT PART OF "CARRY MOTION" - it is the difference between
        // a placement and a 4x punch-in.
        //
        // A fresh placement gets Scale 100, and Premiere's Scale is a
        // percentage of the SOURCE's own pixels, so 8K media in an HD sequence
        // sits at 100 showing the centre sixteenth. Turning Motion off is a
        // request to drop the EDIT's reframing, not a request for a crop
        // nobody chose. So the fit is applied either way; only the editor's
        // own punch-ins and pushes ride on the checkbox.
        const fit = (p.scaleFix && typeof p.scaleFix.gradedFit === "number" &&
                     Math.abs(p.scaleFix.gradedFit - 100) > 0.01) ? p.scaleFix.gradedFit : null;
        let motionNote = "";
        if (captured || fit !== null) {
          const placed = await ppro.findClipAt(targetId, p.trackIndex, p.startTicks, run.ticksPerFrame);
          if (placed && captured) {
            // Only when the picture settled it - see plan.js placedScaleFor.
            const factor = (p.scaleFix && p.scaleFix.apply && p.scaleFix.scale && captured.params.length)
              ? p.scaleFix.scale / (p.reframe && p.reframe.Scale ? p.reframe.Scale.value : 100)
              : 1;
            const res = await ppro.applyMotion(placed, captured, p.sourceInTicks, factor);
            if (res.applied.length) result.motion.applied++;
            if (res.skipped.length) {
              result.motion.partial.push({ at: p.start, name: p.name, skipped: res.skipped });
              motionNote = "  (Motion: " + res.skipped.length + " not carried)";
            }
          } else if (placed) {
            const res = await ppro.applyMotion(placed, {
              srcInTicks: 0,
              params: [{ name: "Scale", timeVarying: false, value: fit, keyframes: [] },
                       { name: "Scale Width", timeVarying: false, value: fit, keyframes: [] }]
            }, p.sourceInTicks, 1);
            if (res.applied.length) {
              result.fitted = (result.fitted || 0) + 1;
              motionNote = "  (scaled to fit: " + fit + ")";
            }
          }
        }
        result.placed.push({ at: p.start, name: p.name, note: motionNote });
      } catch (e) {
        result.failed.push({ at: p.start, name: p.name, error: String(e.message || e) });
      }
    }

    // 5. put the bin back as we found it - the marks are shared state, and a
    //    graded clip left marked would open in the source monitor pre-trimmed.
    for (const path of touchedItems) {
      const item = imported.items[path];
      if (item) { try { await ppro.clearMarks(item); } catch (e) { /* not worth failing the run */ } }
    }

    renderRun(result, run, spareAudio);
  } catch (e) {
    line(report, String(e.message || e), "bad");
    result.fatal = String(e.message || e);
  }
  return result;
}

function renderRun(result, run, spareAudio) {
  const report = $("runReport");
  line(report, "Placed " + result.placed.length + " of " + run.placements.length + ".", "sublabel");

  if (result.failed.length) {
    line(report, "Failed (" + result.failed.length + "):", "sublabel");
    result.failed.forEach((f) => line(report, "  " + plan.formatSeconds(f.at) + "  " + f.name + " — " + f.error, "bad"));
  }
  if (result.fitted) {
    line(report, result.fitted + " clip" + (result.fitted === 1 ? " was" : "s were") +
         " scaled to fit the frame. Motion was not carried, but the graded media is larger " +
         "than the sequence, and Scale 100 on it would have shown a crop nobody chose.", "note");
  }
  if (state.settings.carryMotion) {
    line(report, "Motion carried across on " + result.motion.applied + " clip" +
         (result.motion.applied === 1 ? "" : "s") + ".", "muted");
    result.motion.partial.forEach((m) => {
      line(report, "  " + plan.formatSeconds(m.at) + "  " + m.name + ": " + m.skipped.join("; "), "warn");
    });
  }
  if (run.refused.length) {
    line(report, run.refused.length + " clip" + (run.refused.length === 1 ? " was" : "s were") +
         " refused at the check and still carry their offline media.", "warn");
  }
  // Say what was actually stripped. The first real run removed nothing at all -
  // Premiere had put the audio on a different track from the one it was told to
  // use - and a silent zero here is what let that through.
  line(report, "Stripped " + result.audioRemoved + " graded audio clip" +
       (result.audioRemoved === 1 ? "" : "s") + " from the spare tracks (A" + (spareAudio + 1) +
       " upward); those tracks stay, because Premiere cannot delete tracks.",
       result.audioErrors.length ? "warn" : "note");
  result.audioErrors.forEach((a) => {
    line(report, "  " + plan.formatSeconds(a.at) + "  " + a.name + " — audio not removed: " + a.error, "bad");
  });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function persist() {
  const controls = readControls();
  Object.keys(controls).forEach((k) => { state.settings[k] = controls[k]; });
  state.settings.trackIndex = state.trackIndices.join(",");
  prefs.save(state.settings);
}

function wire() {
  $("btnRefresh").addEventListener("click", async () => {
    setBusy(true, "Re-reading\u2026");
    try { await loadProject(); await refreshHelper(); setStatus("Ready."); }
    catch (e) { setStatus(String(e.message || e), "bad"); }
    finally { setBusy(false); }
  });

  $("sourceSelect").addEventListener("change", async (e) => {
    state.sourceId = e.target.value;
    await loadTracks();
    updateNamePreview();
    persist();
    invalidateCheck();
  });

  Object.keys(CONTROLS).forEach((id) => {
    const el = $(id);
    if (!el) return;
    const onChange = () => {
      persist();
      updateNamePreview();
      updateAlignRow();
      // Anything that changes what would be planned invalidates the Check.
      if (id === "align" || id === "handleFrames" || id === "verifyPicture" ||
          id === "muteOriginalAudio") invalidateCheck();
      // Switching mode changes what the panel is even asking for, so the whole
      // form is re-shaped and any existing Check stops meaning anything.
      if (id === "videoMode" || id === "audioMode") { applyMode(); invalidateCheck(); }
    };
    el.addEventListener("change", onChange);
    el.addEventListener("input", onChange);
  });

  $("btnPickGraded").addEventListener("click", async () => {
    try { await pickGraded(); }
    catch (e) { setStatus(String(e.message || e), "bad"); }
  });
  $("btnPickStems").addEventListener("click", async () => {
    try { await pickStems(); }
    catch (e) { setStatus(String(e.message || e), "bad"); }
  });
  $("btnCheck").addEventListener("click", check);
  $("btnRun").addEventListener("click", conform);
}

/** The handle-frames field only means anything for a fixed-handle convention. */
/**
 * Picture and sound are chosen INDEPENDENTLY.
 *
 * They come back from different people at different times, and they belong in
 * one sequence: an editor should not have to conform twice and then merge the
 * results by hand. Either axis may be "none" - but not both, which is the one
 * combination the Check refuses.
 */
function videoMode() {
  const m = state.settings.videoMode;
  return (m === "master" || m === "none") ? m : "multiclip";
}

function audioMode() {
  return state.settings.audioMode === "stems" ? "stems" : "none";
}

const VIDEO_MODES = {
  multiclip: {
    heading: "Graded Footage",
    button: "Choose folder\u2026",
    empty: "No folder chosen",
    note: "Where the colourist\u2019s exports are. Subfolders are searched, and where a shot " +
          "exists in two dated rounds the newer one wins.",
    note2: "One graded export per cut, matched back onto the cuts they came from. This is the " +
           "picture mode that needs the picture check."
  },
  master: {
    heading: "Graded Master",
    button: "Choose file\u2026",
    empty: "No file chosen",
    note: "One file covering the whole programme. It goes on a new video track above the " +
          "offline, which stays underneath untouched.",
    note2: "Nothing is matched \u2014 the file is supposed to BE this sequence. Its start " +
           "timecode against the sequence\u2019s own is what places it."
  },
  none: { note2: "The picture is left exactly as it is." }
};

/**
 * Show only what the chosen combination actually uses.
 *
 * Track selection, Motion and the picture check belong to per-cut video alone:
 * a master and a stem are one file laid over the whole programme, with no cuts
 * to match, no Motion to carry and nothing to frame-match against.
 */
function applyMode() {
  const v = videoMode();
  const a = audioMode();
  const cfg = VIDEO_MODES[v];
  const show = (id, on) => { const el = $(id); if (el) el.style.display = on ? "" : "none"; };

  show("videoSourceBlock", v !== "none");
  show("audioSourceBlock", a === "stems");
  if (v !== "none") {
    $("sourceHeading").textContent = cfg.heading;
    $("btnPickGraded").textContent = cfg.button;
    $("gradedNote").textContent = cfg.note;
    const chosen = v === "master" ? state.masterFile : state.gradedFolder;
    $("gradedLine").textContent = chosen ? chosen.nativePath : cfg.empty;
  }
  $("stemsLine").textContent = state.stemsFolder ? state.stemsFolder.nativePath : "No folder chosen";

  $("modeNote").textContent = cfg.note2 +
    (a === "stems" ? " Stems are laid flush to the start, one per new audio track, into the " +
                     "same sequence." : "");

  show("trackRow", v === "multiclip");
  show("motionRow", v === "multiclip");
  show("alignBlock", v === "multiclip");
  show("muteRow", a === "stems");

  $("btnRun").textContent = (v === "none") ? "Place the stems"
                          : (a === "stems") ? "Place the picture and the stems"
                          : (v === "master") ? "Place the master" : "Place the graded clips";

  updateAlignRow();
  updateNamePreview();
}

function updateAlignRow() {
  const row = $("handleRow");
  if (row) row.style.display = state.settings.align === "handle" ? "" : "none";
}

async function init() {
  writeControls(state.settings);
  wire();
  applyMode();
  if (!ppro.isAvailable()) {
    setStatus("This panel needs to run inside Premiere Pro.", "bad");
    return;
  }
  try {
    await loadProject();
    await restoreGradedFolder();
    await refreshHelper();
    setStatus("Ready.");
  } catch (e) {
    setStatus(String(e.message || e), "bad");
  }
  // The helper may be installed, or restarted, while the panel is open.
  setInterval(refreshHelper, 15000);
}

init();
