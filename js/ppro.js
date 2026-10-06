/**
 * ppro.js - the ONLY module in the Conformer that talks to the premierepro API.
 *
 * Same rule as Onliner and the Consolidator: the UI and the planning logic deal
 * in plain objects, so when Adobe moves the API there is one file to fix.
 *
 * The facts this module is built on were established against the running app
 * (Premiere 26.3.2), not the type definitions - see the Onliner's
 * docs/API-FINDINGS.md, section 20 in particular. The short version:
 *
 *  - There is NO placement call that takes a source range. The route is: mark
 *    in/out on the ClipProjectItem, then overwrite. The overwrite reads the
 *    marks.
 *  - Marks are shared bin state, so two cuts from one graded file must be
 *    placed one at a time: mark, place, re-mark, place.
 *  - Marks past the end of the media do NOT error - they place a clip of the
 *    length you asked for, with nothing on the end. plan.js refuses those
 *    before we get here; this module never sets a range it was not given.
 *  - `audioTrackIndex: -1` does not suppress audio. See placeClip.
 *  - Every create*Action must be CREATED inside project.lockedAccess, and every
 *    handle and value it is built from must be fresh. If it came from an
 *    earlier `await`, assume it is dead.
 */

let _ppro = null;

/** Lazily require the host module so this file can be loaded outside Premiere. */
function ppro() {
  if (!_ppro) _ppro = require("premierepro");
  return _ppro;
}

function isAvailable() {
  try { return !!ppro(); } catch (e) { return false; }
}

async function getActiveProject() {
  const p = await ppro().Project.getActiveProject();
  if (!p) throw new Error("No project is open in Premiere.");
  return p;
}

/**
 * What the panel header shows.
 *
 * It names the project's PATH as well as its name, and that is not decoration:
 * the MCP bridge on this machine has been seen reporting a stale project name
 * for the open project, and a conform written into the wrong project is not
 * something an editor can easily unpick. The panel shows what the API says.
 */
async function readProjectSummary() {
  let project;
  try { project = await getActiveProject(); } catch (e) { return null; }
  const sequences = await project.getSequences();
  let active = null;
  try {
    const seq = await project.getActiveSequence();
    if (seq) active = { id: String(seq.guid), name: seq.name };
  } catch (e) { /* no sequence open is a normal state */ }
  return {
    projectId: String(project.guid),
    name: project.name,
    path: project.path,
    sequenceCount: sequences.length,
    activeSequence: active
  };
}

async function listSequences() {
  const project = await getActiveProject();
  const sequences = await project.getSequences();
  return sequences.map((s) => ({ id: String(s.guid), name: s.name }));
}

/**
 * Re-fetch a Sequence by GUID, every time.
 *
 * A Sequence does not survive being carried across a pipeline - Onliner lost a
 * run to exactly this, flattening 12 clips and then dying on the next call. The
 * Conformer passes GUID strings between stages and re-resolves at entry.
 */
async function resolveSequence(ref) {
  const P = ppro();
  const project = await getActiveProject();
  const id = (ref && ref.guid !== undefined) ? String(ref.guid) : String(ref);
  // getSequence(guid) returns a Promise despite the type defs declaring a plain
  // Sequence. Unawaited, every method is missing.
  const seq = await project.getSequence(P.Guid.fromString(id));
  if (!seq) throw new Error("Sequence " + id + " is no longer in the project.");
  return seq;
}

/**
 * The sequence's own frame grid, in ticks per frame.
 *
 * Placement snaps to the SEQUENCE's grid, not the media's: a 25fps file placed
 * into a 23.976 sequence lands a frame off what was asked for in seconds. All
 * the arithmetic in plan.js is done in ticks against this number.
 */
async function readTimebase(sequenceRef) {
  const sequence = await resolveSequence(sequenceRef);
  const raw = await sequence.getTimebase();
  return Number(raw);
}

async function readSequenceShape(sequenceRef) {
  const P = ppro();
  const seq = await resolveSequence(sequenceRef);
  const videoTrackCount = await seq.getVideoTrackCount();
  const audioTrackCount = await seq.getAudioTrackCount();
  const CLIP = P.Constants.TrackItemType.CLIP;
  const videoTracks = [];
  for (let i = 0; i < videoTrackCount; i++) {
    const items = await (await seq.getVideoTrack(i)).getTrackItems(CLIP, false);
    videoTracks.push({ index: i, label: "V" + (i + 1), clips: items.length });
  }
  // Frame size, so verification can work out what "fit" means: Premiere's
  // Scale is a percentage of the SOURCE's pixels, so 8K footage sits at 25 in
  // a 1080 sequence and anything above that is a punch-in.
  let frameWidth = null, frameHeight = null;
  try {
    const rect = await seq.getFrameSize();
    if (rect) { frameWidth = rect.width; frameHeight = rect.height; }
  } catch (e) { /* only verification needs it */ }

  return {
    id: String(seq.guid),
    name: seq.name,
    videoTrackCount,
    audioTrackCount,
    videoTracks,
    frameWidth,
    frameHeight,
    timebase: Number(await seq.getTimebase())
  };
}

/**
 * Read one video track's clips, in the shape plan.js matches against.
 *
 * Only camera rushes can be conformed, but this deliberately returns
 * EVERYTHING on the track, including graphics and stills, and lets plan.js
 * decide. A clip the plan does not mention is simply left alone - the skill is
 * explicit that AE comps, motion graphics, logos and stills were never graded,
 * and on the reference job they were a third of the track.
 */
async function readTrackClips(sequenceRef, trackIndex) {
  const P = ppro();
  const sequence = await resolveSequence(sequenceRef);
  const CLIP = P.Constants.TrackItemType.CLIP;
  const track = await sequence.getVideoTrack(trackIndex);
  if (!track) throw new Error("There is no V" + (trackIndex + 1) + " on this sequence.");
  const items = await track.getTrackItems(CLIP, false);

  const rows = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const row = {
      trackIndex: trackIndex,
      index: i,
      name: await item.getName(),
      start: (await item.getStartTime()).seconds,
      dur: (await item.getDuration()).seconds,
      srcIn: (await item.getInPoint()).seconds,
      startTicks: Number((await item.getStartTime()).ticks),
      path: null,
      disabled: false,
      adjustmentLayer: false,
      // Speed matters more than it looks: a retimed clip cannot be conformed
      // at all (see plan.js), and TrackItem has getSpeed but NO setter - the
      // complete method list has createSetInPoint/OutPoint/Start/End/Move/
      // Disabled/Name and nothing about speed. So a replacement would land at
      // 100% and run at the wrong speed against picture.
      speed: 1,
      reversed: false
    };
    try { row.speed = await item.getSpeed(); } catch (e) { row.speed = 1; }
    try { row.reversed = !!(await item.isSpeedReversed()); } catch (e) { /* not fatal */ }
    try { row.disabled = await item.isDisabled(); } catch (e) { /* not fatal */ }
    try { row.adjustmentLayer = await item.isAdjustmentLayer(); } catch (e) { /* not fatal */ }
    try {
      const projectItem = await item.getProjectItem();
      const clip = projectItem ? P.ClipProjectItem.cast(projectItem) : null;
      if (clip) row.path = await clip.getMediaFilePath();
    } catch (e) { /* a graphic with no backing file - plan.js will not match it */ }

    // The clip's framing, for verification rather than for placement.
    //
    // A punch-in makes the offline show a CROP of what the graded file holds,
    // so the two do not correlate: measured, a clip at Scale 27 where fit is
    // 25 scored 0.47 against its own graded export while unreframed clips on
    // the same track scored 0.95+. The matcher can compensate, but only if it
    // is told the framing.
    try {
      const chain = await item.getComponentChain();
      const count = await chain.getComponentCount();
      for (let c = 0; c < count; c++) {
        const comp = await chain.getComponentAtIndex(c);
        if ((await comp.getMatchName()) !== "AE.ADBE Motion") continue;
        const paramCount = comp.getParamCount();
        for (let p = 0; p < paramCount; p++) {
          const param = comp.getParam(p);
          let name = "";
          try { name = param.displayName; } catch (e) { name = ""; }
          if (name !== "Scale" && name !== "Position") continue;
          let varying = false;
          try { varying = param.isTimeVarying(); } catch (e) { varying = false; }
          let value = null;
          try {
            const v = await param.getValueAtTime(P.TickTime.TIME_ZERO);
            value = (v && v.value !== undefined) ? v.value : v;
          } catch (e) { value = null; }
          row.motion = row.motion || {};
          row.motion[name] = { value: value, keyframed: varying };
        }
        break;
      }
    } catch (e) { /* no readable Motion just means no compensation */ }
    rows.push(row);
  }
  return rows;
}

/**
 * Duplicate the sequence being conformed, and hand back the copy's GUID.
 *
 * The conform always runs on a copy. The locked offline is never written to -
 * the same reason Onliner clones before it strips anything.
 */
async function cloneSequence(sourceSequenceRef) {
  const project = await getActiveProject();
  const src = await resolveSequence(sourceSequenceRef);

  const before = {};
  (await project.getSequences()).forEach((s) => { before[String(s.guid)] = true; });

  project.lockedAccess(() => {
    const action = src.createCloneAction();
    project.executeTransaction((c) => { c.addAction(action); }, "Duplicate for conform");
  });

  // The clone action does not hand back the clone, and Premiere names it
  // itself, so identify it by difference rather than by name.
  const after = await project.getSequences();
  const fresh = after.filter((s) => !before[String(s.guid)]);
  if (fresh.length !== 1) {
    throw new Error("Expected exactly one new sequence from the duplicate, got " + fresh.length + ".");
  }
  return { id: String(fresh[0].guid), name: fresh[0].name };
}

async function renameSequence(sequenceRef, newName) {
  const project = await getActiveProject();
  const sequence = await resolveSequence(sequenceRef);
  const item = await sequence.getProjectItem();
  project.lockedAccess(() => {
    const action = item.createSetNameAction(newName);
    project.executeTransaction((c) => { c.addAction(action); }, "Rename conform sequence");
  });
}

// ---------------------------------------------------------------------------
// Bins and import
// ---------------------------------------------------------------------------

async function findFolderByName(root, name) {
  const P = ppro();
  const wanted = String(name).toLowerCase();
  let frontier = [root];
  let budget = 20000;
  while (frontier.length && budget > 0) {
    const next = [];
    for (const node of frontier) {
      let items;
      try { items = await node.getItems(); } catch (e) { continue; }
      for (const item of items) {
        if (--budget <= 0) break;
        let folder = null;
        try { folder = P.FolderItem.cast(item); } catch (e) { folder = null; }
        if (!folder) continue;
        if (String(item.name).toLowerCase() === wanted) return folder;
        next.push(folder);
      }
    }
    frontier = next;
  }
  return null;
}

/** Find a bin by name anywhere in the tree, or create one at the root. */
async function ensureBin(name) {
  const project = await getActiveProject();
  const root = await project.getRootItem();
  const existing = await findFolderByName(root, name);
  if (existing) return { folder: existing, created: false };
  project.lockedAccess(() => {
    const action = root.createBinAction(name, true);
    project.executeTransaction((c) => { c.addAction(action); }, "Create " + name + " bin");
  });
  const made = await findFolderByName(await project.getRootItem(), name);
  if (!made) throw new Error("Could not create the \"" + name + "\" bin.");
  return { folder: made, created: true };
}

function normalisePath(p) {
  if (p === null || p === undefined) return "";
  var s = String(p).trim();
  if (s.indexOf("file://") === 0) s = s.slice("file://".length);
  // Windows native paths arrive with backslashes; the plan, the helper and the
  // comparisons all speak forward slashes, which Windows itself accepts. A
  // UNC path (\\server\share) keeps its double lead, or it stops resolving.
  // Premiere on Windows reports project.path (and may report media paths)
  // in extended-length form: \\?\C:\... or \\?\UNC\server\share\...
  // Seen on 26.5.2. Strip it, or the UNC rule below misreads a local drive.
  if (s.indexOf("\\\\?\\UNC\\") === 0) s = "\\\\" + s.slice(8);
  else if (s.indexOf("\\\\?\\") === 0) s = s.slice(4);
  var unc = s.indexOf("\\\\") === 0;
  s = s.replace(/\\/g, "/");
  s = s.replace(/\/{2,}/g, "/");
  if (unc) s = "/" + s;
  // One drive letter case, so C:/ and c:/ are the same file.
  if (/^[a-z]:\//.test(s)) s = s.charAt(0).toUpperCase() + s.slice(1);
  if (typeof s.normalize === "function") s = s.normalize("NFC");
  return s;
}

/**
 * Import the graded files and hand back a path -> ProjectItem map.
 *
 * Three measured facts shape this:
 *
 *  1. `importFiles` returns a bare `true`, not the items. The new items are
 *     found by DIFFING the target bin before and after.
 *  2. `findItemsMatchingMediaPath` did not find items that had just been
 *     imported - it returned only the pre-existing one - so it is not used.
 *  3. Importing the same path twice makes a DUPLICATE project item. So
 *     anything already in the bin is reused, and only genuinely new paths are
 *     imported. Without this, a second conform run silently doubles the bin.
 *
 * Paths are compared normalised: an item already in the project reports
 * `///Volumes/...` while the same file freshly imported reports `/Volumes/...`.
 */
async function importGradedFiles(paths, binName) {
  const P = ppro();
  const project = await getActiveProject();
  const bin = (await ensureBin(binName)).folder;

  const indexBin = async () => {
    const map = {};
    for (const item of await bin.getItems()) {
      try {
        const clip = P.ClipProjectItem.cast(item);
        if (!clip) continue;
        const path = normalisePath(await clip.getMediaFilePath());
        if (path && !map[path]) map[path] = item;
      } catch (e) { /* a bin inside the bin - not ours */ }
    }
    return map;
  };

  const before = await indexBin();
  const wanted = paths.map(normalisePath);
  const missing = wanted.filter((p) => !before[p]);

  let imported = false;
  if (missing.length) {
    imported = await project.importFiles(missing, true, bin, false);
  }

  const after = missing.length ? await indexBin() : before;
  const map = {};
  const failed = [];
  for (const path of wanted) {
    if (after[path]) map[path] = after[path];
    else failed.push(path);
  }
  return {
    items: map,
    reused: wanted.length - missing.length,
    importedCount: missing.length - failed.length,
    failed: failed,
    importReturned: imported
  };
}

// ---------------------------------------------------------------------------
// Motion transplant
// ---------------------------------------------------------------------------

/**
 * Read a clip's Motion settings so they can be put back after the swap.
 *
 * "Remove the effects" never means remove Motion: scale and position are the
 * EDIT - punch-ins and reframes - and the colourist graded the full frame, so
 * dropping them changes the shot. A fresh placement carries no effects at all,
 * which is what strips the offline's temp grade; Motion has to be carried over
 * deliberately.
 *
 * Keyframe positions are read as ticks and returned verbatim, along with the
 * clip's source in-point. They cannot be written back verbatim - see
 * applyMotion - because the graded file's in-point is different.
 *
 * Point parameters read as a plain Array and must be written as a PointF.
 * Feeding back the exact value just read throws "Illegal Parameter type", and
 * one bad parameter aborts the whole transaction, taking the good ones with it.
 */
async function captureMotion(trackItem) {
  const P = ppro();
  const chain = await trackItem.getComponentChain();
  const count = await chain.getComponentCount();
  let motion = null;
  for (let i = 0; i < count; i++) {
    const c = await chain.getComponentAtIndex(i);
    if ((await c.getMatchName()) === "AE.ADBE Motion") { motion = c; break; }
  }
  if (!motion) return null;

  const srcInTicks = Number((await trackItem.getInPoint()).ticks);
  const params = [];
  const paramCount = motion.getParamCount();
  for (let p = 0; p < paramCount; p++) {
    const param = motion.getParam(p);
    let name = "";
    try { name = param.displayName; } catch (e) { name = ""; }
    // Index 3 carries a blank display name - it is Uniform Scale, and writing
    // it would unlink width from height.
    //
    // It is not empty, it is a SINGLE SPACE, so `if (!name)` lets it through:
    // measured, the first live run captured and re-applied a param called " "
    // on every clip. Trim before testing.
    if (!String(name).trim()) continue;

    const row = { name: name, timeVarying: false, value: null, keyframes: [] };
    try { row.timeVarying = param.isTimeVarying(); } catch (e) { row.timeVarying = false; }

    if (row.timeVarying) {
      try {
        const times = await param.getKeyframeListAsTickTimes();
        for (const t of times) {
          const kf = await param.getKeyframePtr(t);
          row.keyframes.push({ ticks: Number(t.ticks), value: kf && kf.value ? kf.value.value : null });
        }
      } catch (e) { row.keyframeError = String(e.message || e); }
    } else {
      try {
        const v = await param.getValueAtTime(P.TickTime.TIME_ZERO);
        row.value = (v && v.value !== undefined) ? v.value : v;
      } catch (e) { row.valueError = String(e.message || e); }
    }
    params.push(row);
  }
  return { srcInTicks: srcInTicks, params: params };
}

/** Turn a captured value back into something createKeyframe will accept. */
function motionValue(P, raw) {
  if (Object.prototype.toString.call(raw) === "[object Array]" && raw.length >= 2) {
    return new P.PointF(raw[0], raw[1]);
  }
  return raw;
}

/**
 * Put captured Motion back onto the newly placed clip.
 *
 * THE REBASE IS THE POINT. Keyframes live in the clip's SOURCE time, and the
 * graded file's in-point is not the offline's - the whole reason this tool
 * exists is that the two files are cut differently. A keyframe copied verbatim
 * would land at the offline's source time, which on the graded file is a
 * different moment, or outside the clip entirely. Premiere then clamps to the
 * nearest keyframe and the parameter reads FLAT while reporting two keyframes.
 *
 *     newTicks = oldTicks - offlineSourceIn + gradedSourceIn
 *
 * (The Onliner-era transplant copied ticks verbatim, correctly, because both
 * clips shared a source range. Here they do not.)
 *
 * Everything is built inside lockedAccess: the action, the handles it comes
 * from, and the PointF values. A PointF constructed outside and used inside
 * dies as "The script object is no longer valid".
 */
async function applyMotion(trackItem, captured, gradedSourceInTicks, scaleFactor) {
  const P = ppro();
  const project = await getActiveProject();
  if (!captured || !captured.params.length) return { applied: [], skipped: [] };

  const shift = Number(gradedSourceInTicks) - Number(captured.srcInTicks);

  /**
   * Fetch the parameter FRESH, immediately before it is written.
   *
   * A map of params built once at the top goes stale: each parameter is
   * written in its own transaction, so by the eighth the handles have survived
   * seven transactions and a dozen awaits. Measured on the first live run -
   * Position through Anti-flicker Filter applied, then Crop Left/Top/Right/
   * Bottom all failed with "The script object is no longer valid" on the same
   * clip. The fifth face of the rule, on parameters this time.
   */
  const freshParam = async (name) => {
    const chain = await trackItem.getComponentChain();
    const count = await chain.getComponentCount();
    for (let i = 0; i < count; i++) {
      const c = await chain.getComponentAtIndex(i);
      if ((await c.getMatchName()) !== "AE.ADBE Motion") continue;
      const paramCount = c.getParamCount();
      for (let p = 0; p < paramCount; p++) {
        const param = c.getParam(p);
        let display = "";
        try { display = param.displayName; } catch (e) { display = ""; }
        if (display === name) return param;
      }
    }
    return null;
  };

  const probe = await freshParam("Scale");
  if (!probe) return { applied: [], skipped: ["no Motion component on the placed clip"] };

  const applied = [];
  const skipped = [];

  /**
   * Scale is the one captured value that may need changing on the way across.
   *
   * A clip with "Set to Frame Size" applied reads Scale 100 while showing the
   * whole frame - the fit happens outside Motion, and a fresh placement does
   * not inherit it. Copying that 100 onto 8K media in an HD sequence is a 4x
   * zoom. plan.js works out the factor from the real media dimensions; here it
   * is applied to the static value and to every keyframe alike, so an animated
   * push-in keeps its shape.
   */
  const factor = (typeof scaleFactor === "number" && isFinite(scaleFactor) && scaleFactor > 0)
    ? scaleFactor : 1;
  const scaleParam = (name) => name === "Scale" || name === "Scale Width";
  const adjust = (name, value) =>
    (factor !== 1 && scaleParam(name) && typeof value === "number") ? value * factor : value;

  for (const row of captured.params) {
    const param = await freshParam(row.name);
    if (!param) { skipped.push(row.name + " (not on the placed clip)"); continue; }

    if (!row.timeVarying) {
      if (row.value === null || row.value === undefined) { skipped.push(row.name + " (unreadable)"); continue; }
      try {
        // Each parameter gets its OWN transaction. One bad parameter aborts the
        // transaction it is in, and batching them means a single failing
        // Position write silently loses Scale and Rotation alongside it - which
        // is how Onliner came back with 49 clips unreset.
        project.lockedAccess(() => {
          const value = motionValue(P, adjust(row.name, row.value));
          const action = param.createSetValueAction(param.createKeyframe(value), true);
          project.executeTransaction((c) => { c.addAction(action); }, "Restore " + row.name);
        });
        applied.push(row.name + (factor !== 1 && scaleParam(row.name) ? " (refitted)" : ""));
      } catch (e) { skipped.push(row.name + " (" + (e.message || e) + ")"); }
      continue;
    }

    if (!row.keyframes.length) { skipped.push(row.name + " (animated, but no keyframes could be read)"); continue; }
    try {
      project.lockedAccess(() => {
        const on = param.createSetTimeVaryingAction(true);
        project.executeTransaction((c) => { c.addAction(on); }, "Animate " + row.name);
      });
      for (const kf of row.keyframes) {
        if (kf.value === null || kf.value === undefined) continue;
        project.lockedAccess(() => {
          const value = motionValue(P, adjust(row.name, kf.value));
          const keyframe = param.createKeyframe(value);
          keyframe.position = P.TickTime.createWithTicks(String(kf.ticks + shift));
          const action = param.createAddKeyframeAction(keyframe);
          project.executeTransaction((c) => { c.addAction(action); }, "Restore " + row.name + " keyframe");
        });
      }
      applied.push(row.name + " (" + row.keyframes.length + " keyframes, rebased)");
    } catch (e) { skipped.push(row.name + " (" + (e.message || e) + ")"); }
  }
  return { applied: applied, skipped: skipped };
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/**
 * Place one graded clip over its cut.
 *
 *   1. mark the range on the project item  (this is what carries sourceIn)
 *   2. overwrite at the cut's start
 *   3. remove the audio the overwrite brought with it
 *
 * Step 3 is not optional and not cosmetic. `audioTrackIndex: -1` does NOT
 * suppress audio - measured, it lands on A1 regardless - and A1 in a conform
 * is where the mix lives. So the placement is aimed at a SPARE audio track and
 * the audio that lands there is removed immediately afterwards. Ripple is
 * false throughout: rippling would shift everything after each removal and the
 * conform would no longer line up with picture.
 *
 * **The caller must work the spare index out ONCE, before the run, and pass the
 * same one every time.** Measured: an index at or beyond the audio track count
 * creates a new track (an index far beyond creates exactly one, not the
 * difference). Recomputing it per clip would therefore add a fresh audio track
 * per placement - 23 clips, 23 tracks. Passing `audioTrackCount` on the first
 * placement creates the spare; from then on that index exists and is empty,
 * so every later placement reuses it. The empty track is left behind at the end
 * of the run because Premiere has no track delete; the report says so.
 *
 * The marks are left set on the project item; the caller clears them once the
 * run is done. They are shared bin state, which is exactly why placement is
 * sequential: mark, place, re-mark, place.
 */
async function placeClip(sequenceRef, projectItem, placement, audioTrackIndex) {
  const P = ppro();
  const project = await getActiveProject();
  const sequence = await resolveSequence(sequenceRef);
  const clip = P.ClipProjectItem.cast(projectItem);
  if (!clip) throw new Error("\"" + placement.name + "\" is not usable as media.");

  // 1. mark
  project.lockedAccess(() => {
    const action = clip.createSetInOutPointsAction(
      P.TickTime.createWithTicks(String(placement.sourceInTicks)),
      P.TickTime.createWithTicks(String(placement.sourceOutTicks)));
    project.executeTransaction((c) => { c.addAction(action); }, "Mark graded range");
  });

  // Read the marks back. In range they are exact; out of range Premiere clamps
  // them silently and places a clip with nothing on the end. plan.js refuses
  // those before we get here, so a mismatch now means something is wrong with
  // the media itself - stop rather than place.
  const marked = P.ClipProjectItem.cast(projectItem);
  const readIn = Number((await marked.getInPoint(P.Constants.MediaType.VIDEO)).ticks);
  const readOut = Number((await marked.getOutPoint(P.Constants.MediaType.VIDEO)).ticks);
  const slack = 2 * 10594584000;   // a couple of frames at any sane rate
  if (Math.abs(readIn - placement.sourceInTicks) > slack ||
      Math.abs(readOut - placement.sourceOutTicks) > slack) {
    throw new Error("\"" + placement.name + "\": Premiere clamped the marked range, which means " +
                    "the graded file is shorter than the plan says. Nothing was placed.");
  }

  // 2. overwrite
  //
  // Re-resolved here rather than reusing the sequence from the top of the
  // function: the marking transaction and the read-back sit between them, and
  // a handle that has survived that many awaits is the classic stale one -
  // which fails by doing nothing, not by throwing something useful.
  const placeSeq = await resolveSequence(sequenceRef);
  project.lockedAccess(() => {
    const editor = P.SequenceEditor.getEditor(placeSeq);
    const action = editor.createOverwriteItemAction(
      projectItem, P.TickTime.createWithTicks(String(placement.startTicks)),
      placement.trackIndex, audioTrackIndex);
    project.executeTransaction((c) => { c.addAction(action); }, "Place graded clip");
  });

  // 3. strip the audio that came with it
  //
  // **Do not assume the audio landed on the index we asked for.** Measured: a
  // placement aimed at A2 put its audio on A3 - Premiere creates whatever
  // tracks the clip's channel layout needs and uses those. Removing from A2
  // then "succeeded" against an empty track and left the graded audio sitting
  // on A3, silently, on every clip that had any.
  //
  // So every audio track from the spare index upward is swept. Those tracks
  // did not exist before this run - the spare index is the original track
  // count - so anything on them arrived with a placement and belongs to us.
  // The editor's own mix, on A1..A<spare>, is never touched.
  let audioRemoved = 0;
  try {
    const seq = await resolveSequence(sequenceRef);
    const audioCount = await seq.getAudioTrackCount();
    for (let t = audioTrackIndex; t < audioCount; t++) {
      // Re-resolve immediately before the write: the sequence resolved at the
      // top of this function is several awaits and two transactions old by now,
      // and a stale handle here removes nothing while reporting success.
      const freshSeq = await resolveSequence(sequenceRef);
      const freshTrack = await freshSeq.getAudioTrack(t);
      if (!freshTrack) continue;
      const items = await freshTrack.getTrackItems(P.Constants.TrackItemType.CLIP, false);
      if (!items.length) continue;
      project.lockedAccess(() => {
        const editor = P.SequenceEditor.getEditor(freshSeq);
        let selection = null;
        P.TrackItemSelection.createEmptySelection((sel) => { selection = sel; });
        items.forEach((it) => { try { selection.addItem(it, true); } catch (e) { /* already in */ } });
        const action = editor.createRemoveItemsAction(selection, false, P.Constants.MediaType.AUDIO, false);
        project.executeTransaction((c) => { c.addAction(action); }, "Remove graded audio");
      });
      audioRemoved += items.length;
    }
  } catch (e) {
    return { placed: true, audioRemoved: 0, audioError: String(e.message || e) };
  }
  return { placed: true, audioRemoved: audioRemoved };
}

/**
 * The audio track index to aim placements at: one past the last existing track.
 *
 * Call this ONCE per run, before placing anything, and pass the result to every
 * placeClip. See placeClip for why recomputing it per clip would grow a new
 * audio track for every clip in the conform.
 */
/**
 * How long the sequence is, and what timecode it starts at.
 *
 * `getZeroPoint()` is the one that matters and is easy to miss: measured on
 * this job it returns 3600s, which is 01:00:00:00 - the sequence's start
 * timecode. A master rendered from the sequence carries that same start TC, so
 * the difference between the two IS the offset, exactly, with no assumption
 * about how the render was set up. Without it the only evidence left is "the
 * lengths match", and a file with handles has no way to declare itself.
 */
async function readSequenceSpan(sequenceRef) {
  const seq = await resolveSequence(sequenceRef);
  const end = await seq.getEndTime();
  let zero = null;
  try {
    const z = await seq.getZeroPoint();
    if (z && typeof z.seconds === "number") zero = z.seconds;
  } catch (e) { /* a sequence starting at 0 is still perfectly placeable */ }
  return {
    durationSeconds: end ? end.seconds : null,
    durationTicks: end ? String(end.ticks) : null,
    zeroPointSeconds: zero,
    videoTrackCount: await seq.getVideoTrackCount(),
    audioTrackCount: await seq.getAudioTrackCount(),
    timebase: Number(await seq.getTimebase())
  };
}

/**
 * Place one WHOLE file - a graded master or a mix stem - onto a spare track.
 *
 * The same mark-then-overwrite primitive the multi-clip mode uses, and verified
 * the same way: on an audio-only WAV marked 0 -> 85.04 and overwritten at 0, it
 * landed on exactly the requested audio track and created no video track; on a
 * video-only ProRes it landed on the requested video track and created no audio
 * track. Neither disturbed the sequence's own duration.
 *
 * `trackIndex` at or beyond the current count creates the track, which is how
 * both modes get a fresh track to land on without destroying anything the
 * editor already has.
 */
async function placeWhole(sequenceRef, projectItem, placement, opts) {
  const P = ppro();
  const o = opts || {};
  const project = await getActiveProject();
  const clip = P.ClipProjectItem.cast(projectItem);
  if (!clip) throw new Error("\"" + placement.name + "\" is not usable as media.");

  project.lockedAccess(() => {
    const action = clip.createSetInOutPointsAction(
      P.TickTime.createWithTicks(String(placement.sourceInTicks)),
      P.TickTime.createWithTicks(String(placement.sourceOutTicks)));
    project.executeTransaction((c) => { c.addAction(action); }, "Mark whole file");
  });

  // Read the marks back before placing. Out of range Premiere CLAMPS silently
  // and places a clip that runs out partway through, which on a whole-programme
  // master is a black tail nobody notices until the end of a review.
  const marked = P.ClipProjectItem.cast(projectItem);
  const mediaType = o.audioOnly ? P.Constants.MediaType.AUDIO : P.Constants.MediaType.VIDEO;
  const readIn = Number((await marked.getInPoint(mediaType)).ticks);
  const readOut = Number((await marked.getOutPoint(mediaType)).ticks);
  const slack = 2 * 10594584000;
  if (Math.abs(readIn - placement.sourceInTicks) > slack ||
      Math.abs(readOut - placement.sourceOutTicks) > slack) {
    throw new Error("\"" + placement.name + "\": Premiere clamped the marked range, so this file " +
                    "is shorter than it reported. Nothing was placed.");
  }

  // Re-resolved rather than reused: the marking transaction and the read-back
  // sit between, and a handle that old is the classic stale one - which fails
  // by doing nothing rather than by throwing.
  const placeSeq = await resolveSequence(sequenceRef);
  project.lockedAccess(() => {
    const editor = P.SequenceEditor.getEditor(placeSeq);
    const action = editor.createOverwriteItemAction(
      projectItem, P.TickTime.createWithTicks(String(placement.startTicks)),
      Number(o.videoTrackIndex), Number(o.audioTrackIndex));
    project.executeTransaction((c) => { c.addAction(action); }, "Place whole file");
  });
  return { placed: true };
}

/**
 * Name a track after the stem sitting on it.
 *
 * Worth doing rather than leaving four tracks called "Audio 4..7": the whole
 * point of stems is that a mixer can pull one of them, and an unlabelled set
 * makes that a guessing game in the very panel that just placed them.
 */
async function setTrackName(sequenceRef, isAudio, trackIndex, name) {
  const project = await getActiveProject();
  const sequence = await resolveSequence(sequenceRef);
  const track = isAudio ? await sequence.getAudioTrack(trackIndex)
                        : await sequence.getVideoTrack(trackIndex);
  if (!track) return false;
  project.lockedAccess(() => {
    const action = track.createSetNameAction(name, true);
    project.executeTransaction((c) => { c.addAction(action); }, "Name track");
  });
  return true;
}

/**
 * Mute the offline's own audio tracks once stems are laid over them.
 *
 * Without this the stems play ON TOP of the scratch mix rather than instead of
 * it, which sounds like a bad mix rather than like a mistake - the worst kind
 * of failure to spot. Muting is reversible from the timeline, so this takes
 * nothing away.
 */
async function muteAudioTracks(sequenceRef, indices, muted) {
  const sequence = await resolveSequence(sequenceRef);
  const done = [];
  for (const index of indices) {
    const track = await sequence.getAudioTrack(index);
    if (!track) continue;
    try {
      await track.setMute(muted !== false);
      done.push(index);
    } catch (e) { /* a track that will not mute is not worth failing the run for */ }
  }
  return done;
}

/**
 * What actually landed, read back off the timeline.
 *
 * The overwrite reports nothing, and `audioTrackIndex` has already been shown
 * to be where audio is AIMED rather than where it lands, so both whole-file
 * modes confirm their own work instead of trusting the call.
 */
async function readTrackSummary(sequenceRef) {
  const P = ppro();
  const seq = await resolveSequence(sequenceRef);
  const CLIP = P.Constants.TrackItemType.CLIP;
  const video = [], audio = [];
  const vCount = await seq.getVideoTrackCount();
  for (let t = 0; t < vCount; t++) {
    const track = await seq.getVideoTrack(t);
    const items = await track.getTrackItems(CLIP, false);
    video.push({ index: t, label: "V" + (t + 1), name: track.name, clips: items.length });
  }
  const aCount = await seq.getAudioTrackCount();
  for (let t = 0; t < aCount; t++) {
    const track = await seq.getAudioTrack(t);
    const items = await track.getTrackItems(CLIP, false);
    const first = items.length ? {
      start: (await items[0].getStartTime()).seconds,
      end: (await items[0].getEndTime()).seconds
    } : null;
    audio.push({ index: t, label: "A" + (t + 1), name: track.name, clips: items.length,
                 muted: await track.isMuted(), first: first });
  }
  return { video: video, audio: audio,
           durationSeconds: (await seq.getEndTime()).seconds };
}

async function spareAudioTrackIndex(sequenceRef) {
  const sequence = await resolveSequence(sequenceRef);
  return await sequence.getAudioTrackCount();
}

/** Clear the in/out marks left on a graded clip, so the bin is as we found it. */
async function clearMarks(projectItem) {
  const P = ppro();
  const project = await getActiveProject();
  const clip = P.ClipProjectItem.cast(projectItem);
  if (!clip) return false;
  project.lockedAccess(() => {
    const action = clip.createClearInOutPointsAction();
    project.executeTransaction((c) => { c.addAction(action); }, "Clear graded marks");
  });
  return true;
}

/**
 * The names currently in a folder.
 *
 * Deliberately NOT `getEntryWithUrl("file:" + path)`: that threw for every one
 * of twelve files that were demonstrably on disk, because the folder sat
 * outside the plugin's granted scope. A false negative there is worse than no
 * check at all - it makes every render look failed. Listing the folder ENTRY
 * the user picked stays inside the scope the picker granted.
 */
async function folderContents(folder) {
  const names = {};
  try {
    const entries = await folder.getEntries();
    entries.forEach((e) => { names[e.name] = true; });
  } catch (e) { /* an unreadable folder is reported by the caller as missing files */ }
  return names;
}

/**
 * Render the reference frames that verification matches against.
 *
 * These come from Premiere rather than from the camera originals for a reason
 * that is not a preference: **ffmpeg cannot decode ProRes RAW**. It fails as
 * "Invalid argument" with zero bytes out, which reads like a broken command,
 * and these rushes are 8K prores_raw. Premiere decodes them natively, so the
 * panel renders what the offline actually shows at each cut and the external
 * matcher correlates those against the graded export.
 *
 * Several probes per cut, deliberately: one frame can hit a false match in a
 * static shot, and probes that disagree are the signal that the answer is not
 * usable. Their spacing is also what exposes a retime - the match slides
 * steadily across them - which is the only way to see a RAMPED speed change,
 * since the API cannot report time remapping at all.
 *
 * A frame is rendered a hair INTO the cut (half a frame), not exactly on its
 * first frame: on a cut boundary Premiere can hand back the outgoing shot.
 *
 * The filename must carry an extension or Premiere fails with "Internal error :
 * File Format is not supported".
 */
async function exportReferenceFrames(sequenceRef, jobs, folder, size, isolateTrackIndex) {
  const P = ppro();
  const w = (size && size.width) || 640;
  const h = (size && size.height) || 360;
  const folderPath = folder.nativePath;

  /**
   * ISOLATE the track being verified.
   *
   * A rendered frame shows the programme - whatever is on top at that moment.
   * Conforming V1 while a V2 clip covers it would render V2's picture and then
   * "verify" the V1 cut against a shot it has nothing to do with: at best
   * inconclusive, at worst a confident match on the wrong clip.
   *
   * So every other video track is muted for the render, and caption tracks
   * with them - captions burn into an exported frame and would sit on top of
   * the picture being matched.
   *
   * The restore runs in a `finally`: leaving an editor's tracks muted would be
   * a far worse bug than a failed verification.
   */
  const muted = [];
  const isolate = async () => {
    if (typeof isolateTrackIndex !== "number") return;
    const seq = await resolveSequence(sequenceRef);
    const videoCount = await seq.getVideoTrackCount();
    for (let t = 0; t < videoCount; t++) {
      if (t === isolateTrackIndex) continue;
      const track = await seq.getVideoTrack(t);
      let was = false;
      try { was = await track.isMuted(); } catch (e) { was = false; }
      if (!was) {
        try { await track.setMute(true); muted.push({ kind: "video", index: t }); } catch (e) { /* leave it */ }
      }
    }
    let captionCount = 0;
    try { captionCount = await seq.getCaptionTrackCount(); } catch (e) { captionCount = 0; }
    for (let c = 0; c < captionCount; c++) {
      try {
        const track = await seq.getCaptionTrack(c);
        if (track && !(await track.isMuted())) {
          await track.setMute(true);
          muted.push({ kind: "caption", index: c });
        }
      } catch (e) { /* older builds throw rather than reporting zero */ }
    }
  };

  const restore = async () => {
    const seq = await resolveSequence(sequenceRef);
    for (const row of muted) {
      try {
        const track = row.kind === "video"
          ? await seq.getVideoTrack(row.index)
          : await seq.getCaptionTrack(row.index);
        if (track) await track.setMute(false);
      } catch (e) { /* reported by the caller as a restore failure */ }
    }
    const left = [];
    try {
      const videoCount = await seq.getVideoTrackCount();
      for (let t = 0; t < videoCount; t++) {
        const track = await seq.getVideoTrack(t);
        if (await track.isMuted()) left.push("V" + (t + 1));
      }
    } catch (e) { /* nothing more to say */ }
    return left;
  };

  const wanted = [];
  for (const job of jobs) {
    for (const probe of job.probes) {
      wanted.push({
        key: job.key,
        probe: probe,
        file: "ref_" + job.key + "_" + String(Math.round(probe * 1000)) + ".png",
        at: Number(job.start) + Number(probe) + (job.frameSeconds || 0.02) / 2,
        error: null
      });
    }
  }

  // The filename must carry an extension or Premiere fails with
  // "Internal error : File Format is not supported".
  const render = async (row) => {
    try {
      const sequence = await resolveSequence(sequenceRef);
      await P.Exporter.exportSequenceFrame(
        sequence, P.TickTime.createWithSeconds(row.at), row.file, folderPath, w, h);
    } catch (e) {
      row.error = String(e.message || e);
    }
  };

  /**
   * WAIT for the frames to appear, do not just look once.
   *
   * `exportSequenceFrame` returns before the file is on disk. Checking
   * immediately after the call found ONE of twelve files that all arrived
   * moments later - so the first version of this declared eleven failures,
   * re-rendered all of them, and still shipped a kit with a single reference
   * frame in it. The verification then came back "inconclusive" on three
   * clips, which reads like hard-to-match footage rather than like a bug.
   *
   * (That also corrects an earlier reading of the same symptom: Premiere is
   * not reporting success for files it never writes. It writes them a moment
   * after it says so.)
   */
  const settle = async (rows, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    let seen = await folderContents(folder);
    while (rows.some((row) => !seen[row.file]) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      seen = await folderContents(folder);
    }
    return seen;
  };

  await isolate();
  let stillMuted = [];
  let present = {};
  let missing = [];
  try {
    for (const row of wanted) await render(row);
    // The settle-and-retry happens INSIDE the isolation window. It used to run
    // after the tracks were restored, so any frame that needed a second
    // attempt was re-rendered against the whole programme - the very thing
    // isolation exists to prevent.
    present = await settle(wanted, 20000);
    missing = wanted.filter((row) => !present[row.file]);
    for (const row of missing) await render(row);
    if (missing.length) present = await settle(missing, 10000);
  } finally {
    stillMuted = await restore();
  }

  const frames = wanted.map((row) => ({
    key: row.key, probe: row.probe, file: row.file,
    ok: !!present[row.file],
    retried: missing.indexOf(row) !== -1,
    error: present[row.file] ? null : (row.error || "the frame never appeared on disk")
  }));
  // A track left muted is the one failure here that damages the edit rather
  // than the verification, so it is returned rather than swallowed.
  frames.stillMuted = stillMuted;
  return frames;
}

/** Find the track item now sitting at a given start on a given video track. */
async function findClipAt(sequenceRef, trackIndex, startTicks, toleranceTicks) {
  const P = ppro();
  const sequence = await resolveSequence(sequenceRef);
  const items = await (await sequence.getVideoTrack(trackIndex))
    .getTrackItems(P.Constants.TrackItemType.CLIP, false);
  const tol = toleranceTicks || 10594584000;   // one frame, generously
  let best = null, bestDelta = null;
  for (const item of items) {
    const delta = Math.abs(Number((await item.getStartTime()).ticks) - Number(startTicks));
    if (delta <= tol && (bestDelta === null || delta < bestDelta)) { best = item; bestDelta = delta; }
  }
  return best;
}

/** Colour label for conformed clips' bin, matching the house scheme. */
var COLOUR = { GRADED: 0 /* VIOLET */ };

module.exports = {
  isAvailable,
  readProjectSummary,
  listSequences,
  resolveSequence,
  readTimebase,
  readSequenceShape,
  readTrackClips,
  cloneSequence,
  renameSequence,
  ensureBin,
  importGradedFiles,
  captureMotion,
  applyMotion,
  placeClip,
  placeWhole,
  readSequenceSpan,
  setTrackName,
  muteAudioTracks,
  readTrackSummary,
  spareAudioTrackIndex,
  clearMarks,
  findClipAt,
  exportReferenceFrames,
  normalisePath,
  COLOUR
};
