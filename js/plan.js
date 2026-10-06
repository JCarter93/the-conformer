/**
 * plan.js - everything the Conformer decides BEFORE it touches Premiere.
 *
 * This module never imports `premierepro`. It takes the plan written by
 * `plan_conform.py` / `find_offsets.py` and the clips actually on the timeline,
 * and works out three things:
 *
 *   1. which plan entries are placeable at all
 *   2. which timeline clip each one belongs to, RE-CHECKED against the
 *      sequence rather than trusted
 *   3. which are refused, and in words an editor can act on
 *
 * It is pure so it can be tested under jsc, which matters more here than
 * anywhere else in the panel: every bug in this file puts the wrong frames on
 * screen, and that is the one failure this tool must never produce silently.
 * See docs/API-FINDINGS.md section 20 for the live-API facts it encodes.
 */

/** Premiere's tick rate. 254,016,000,000 ticks to the second. */
var TICKS_PER_SECOND = 254016000000;

/**
 * Statuses that can carry a placeable clip.
 *
 * SUPERSEDED is placeable on purpose: plan_conform.py sets it when the same
 * shot exists in two dated grade rounds, takes the newest, and still computes a
 * sourceIn. It is a note about provenance, not a problem.
 *
 * RETRIMMED is NOT here. It means the cut moved after grading and the offset
 * has to come from find_offsets.py, which rewrites the entry to OK once it has
 * resolved it. A RETRIMMED entry reaching the panel means the frame-match step
 * was never run, and placing it on the plan's (absent) offset would be a guess.
 */
var PLACEABLE_STATUS = { OK: true, SUPERSEDED: true };

/**
 * Why each non-placeable status is refused, in the editor's language. The brief
 * is explicit that the panel flags these the way Onliner flags multicam - it
 * does not attempt to resolve them itself.
 */
var REFUSAL = {
  RETRIMMED: "re-trimmed since the grade, and the frame match has not been run - " +
             "run find_offsets.py and load the resolved plan",
  AMBIGUOUS: "two graded exports from the same round match this shot - " +
             "disambiguate by eye and pin one in the plan",
  MISSING: "no graded file matches this shot",
  SKIP: "the frame match could not place this one confidently"
};

/**
 * Normalise a media path before comparing two of them.
 *
 * Measured on the live API: a clip already in the project reports
 * `///Volumes/...` (three slashes) while the same file freshly imported reports
 * `/Volumes/...`. Comparing literally, a file does not match itself.
 *
 * Unicode normalisation matters for the same reason on this footage: macOS
 * hands back decomposed (NFD) filenames, and a plan written by Python may carry
 * composed ones, so an accented character compares unequal while looking
 * identical on screen.
 */
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

function baseName(p) {
  var s = normalisePath(p);
  var cut = s.lastIndexOf("/");
  return cut === -1 ? s : s.slice(cut + 1);
}

/** Seconds -> ticks, rounded. Ticks are the only exact currency here. */
function secondsToTicks(seconds) {
  return Math.round(Number(seconds) * TICKS_PER_SECOND);
}

/**
 * Snap a tick value to the sequence's frame grid.
 *
 * Placement snaps to the SEQUENCE's grid, not the media's - measured: a 25fps
 * graded file placed into a 23.976 scratch sequence landed a frame off what was
 * asked for in seconds. Rounding here, deliberately and visibly, beats letting
 * Premiere round somewhere we cannot see.
 *
 * `ticksPerFrame` comes from `sequence.getTimebase()`, which is exactly that:
 * 10594584000 for 23.976, 10160640000 for 25.
 */
function alignToFrame(ticks, ticksPerFrame) {
  var tpf = Number(ticksPerFrame);
  if (!tpf || tpf <= 0) return Math.round(ticks);
  return Math.round(ticks / tpf) * tpf;
}

/**
 * Parse the plan file. Returns entries plus any structural complaint.
 *
 * Deliberately strict about the shape: a plan that is not an array, or whose
 * entries lack the fields every downstream decision reads, is a wrong or
 * half-written file and should stop the run here rather than three steps later.
 */
function readPlan(text) {
  var parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch (e) {
    return { entries: [], error: "That file is not valid JSON: " + (e.message || e) };
  }
  if (!parsed || Object.prototype.toString.call(parsed) !== "[object Array]") {
    return { entries: [], error: "A conform plan is a JSON array of clips; this file is not." };
  }
  var required = ["source", "start", "dur"];
  for (var i = 0; i < parsed.length; i++) {
    var e = parsed[i];
    if (!e || typeof e !== "object") {
      return { entries: [], error: "Entry " + (i + 1) + " is not an object." };
    }
    for (var r = 0; r < required.length; r++) {
      if (e[required[r]] === undefined) {
        return { entries: [], error: "Entry " + (i + 1) + " has no \"" + required[r] +
                 "\" - is this a plan from plan_conform.py?" };
      }
    }
  }
  return { entries: parsed, error: null };
}

/**
 * Can this entry be placed, and if not, why not?
 *
 * The range check is the one that matters most, and it exists because of a
 * measured failure mode: marks set beyond the end of the media do NOT error.
 * A 6-frame file marked 2-4s placed a silent 2-second clip of nothing. The
 * plan carries `gradedDur` from ffmpeg, so the check is possible here, before
 * anything is written - and it is the only place it can be done, because
 * `Media.duration` in the UXP API returns an object whose seconds and ticks
 * are undefined.
 */
function classify(entry, opts) {
  var o = opts || {};
  var tol = o.toleranceSeconds === undefined ? 0.04 : o.toleranceSeconds;
  var status = String(entry.status || "");

  if (!PLACEABLE_STATUS[status]) {
    return { placeable: false, reason: REFUSAL[status] || ("status " + (status || "(none)") + " is not placeable") };
  }
  if (!entry.graded) {
    return { placeable: false, reason: "no graded file on the entry" };
  }
  if (typeof entry.sourceIn !== "number" || !isFinite(entry.sourceIn)) {
    return { placeable: false, reason: "no sourceIn - nothing says where the cut sits in the graded file" };
  }
  if (entry.sourceIn < -tol) {
    return { placeable: false, reason: "sourceIn is negative (" + entry.sourceIn + "s), which cannot be right" };
  }
  var dur = Number(entry.dur);
  if (!isFinite(dur) || dur <= 0) {
    return { placeable: false, reason: "the cut has no usable duration" };
  }
  if (typeof entry.gradedDur === "number" && isFinite(entry.gradedDur)) {
    if (entry.sourceIn + dur > entry.gradedDur + tol) {
      return {
        placeable: false,
        reason: "the cut runs past the end of the graded file (needs " +
                (Math.round((entry.sourceIn + dur) * 100) / 100) + "s of a " +
                (Math.round(entry.gradedDur * 100) / 100) + "s file) - Premiere would " +
                "place it anyway, with nothing on the end"
      };
    }
  } else {
    return { placeable: false, reason: "the plan has no gradedDur, so the range cannot be checked against the file" };
  }
  return { placeable: true, reason: null };
}

/**
 * Pair plan entries with the clips actually on the track, by position.
 *
 * The plan was written from a snapshot of the timeline, possibly days ago. The
 * sequence is the authority now - this is the same "re-scan rather than trust"
 * rule Onliner applies to multicam after the editor flattens by hand. A clip
 * that has moved since the plan was made is NOT placed; it is reported, because
 * placing a graded shot at a stale timecode is exactly the silent wrongness
 * this tool exists to avoid.
 *
 * Matching is on source path and start time together. Path alone is ambiguous
 * (one rush used five times), start alone is fragile (an insert shifts
 * everything). Where the path does not match but the position does exactly, the
 * pair is still refused, with a reason that names both files - that is a
 * relinked or renamed source, and it deserves a human.
 */
function matchToTimeline(entries, clips, opts) {
  var o = opts || {};
  var startTol = o.startToleranceSeconds === undefined ? 0.04 : o.startToleranceSeconds;
  var durTol = o.durToleranceSeconds === undefined ? 0.04 : o.durToleranceSeconds;

  var rows = [];
  var usedClipKeys = {};

  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var wantPath = normalisePath(e.source);
    var wantBase = baseName(e.source).toLowerCase();
    var best = null;
    // The planner copies unknown fields straight through, so an entry carries
    // back the track it came from. Honour it: conforming several tracks at
    // once, the same rush can sit at the same moment on two of them, and
    // matching across tracks would put a graded clip on the wrong layer.
    var wantTrack = (typeof e.trackIndex === "number") ? e.trackIndex : null;

    for (var c = 0; c < clips.length; c++) {
      var clip = clips[c];
      var key = clip.trackIndex + ":" + c;
      if (usedClipKeys[key]) continue;
      if (wantTrack !== null && Number(clip.trackIndex) !== wantTrack) continue;
      var dStart = Math.abs(Number(clip.start) - Number(e.start));
      if (dStart > startTol) continue;
      var samePath = normalisePath(clip.path) === wantPath ||
                     baseName(clip.path).toLowerCase() === wantBase;
      var dDur = Math.abs(Number(clip.dur) - Number(e.dur));
      var candidate = { clip: clip, key: key, dStart: dStart, dDur: dDur, samePath: samePath };
      // Prefer a same-path match; among those, the closest start.
      if (!best) best = candidate;
      else if (candidate.samePath !== best.samePath) best = candidate.samePath ? candidate : best;
      else if (candidate.dStart < best.dStart) best = candidate;
    }

    var row = { entry: e, clip: null, matched: false, reason: null };
    if (!best) {
      row.reason = "nothing sits at " + formatSeconds(e.start) + " on this track any more - " +
                   "the edit has changed since the plan was made";
    } else if (!best.samePath) {
      row.reason = "the clip at " + formatSeconds(e.start) + " is now \"" + baseName(best.clip.path) +
                   "\", not \"" + baseName(e.source) + "\"";
    } else if (best.dDur > durTol) {
      row.reason = "the cut at " + formatSeconds(e.start) + " is " + round2(best.clip.dur) +
                   "s on the timeline but " + round2(e.dur) + "s in the plan - it has been " +
                   "re-trimmed since, so the graded offset no longer lines up";
    } else if (isRetimed(best.clip)) {
      // A retimed clip cannot be conformed, and this is a hard limit of the
      // API rather than a policy: TrackItem exposes getSpeed but nothing that
      // SETS speed, so a replacement lands at 100% and runs at the wrong speed
      // against picture - drifting further out of sync the longer the shot.
      //
      // Measured on the job it was built on: one clip at speed 1.05. Frame-matching it
      // showed the give-away, a match that slid by a frame every ten - and the
      // editor's own conform carried the 1.0489 speed through by hand.
      //
      // Matched on purpose, so it is reported as a clip the plan knows about
      // and refuses, not as one nobody mentioned.
      row.matched = true;
      row.clip = best.clip;
      usedClipKeys[best.key] = true;
      row.retimed = true;
      row.reason = "the cut at " + formatSeconds(e.start) + " is retimed to " +
                   Math.round(Number(best.clip.speed) * 1000) / 10 + "%" +
                   (best.clip.reversed ? " and reversed" : "") +
                   " - Premiere's API cannot set a clip's speed, so a graded " +
                   "replacement would play at 100% and drift against picture. " +
                   "Place this one by hand.";
    } else {
      row.matched = true;
      row.clip = best.clip;
      usedClipKeys[best.key] = true;
    }
    rows.push(row);
  }
  return rows;
}

function round2(n) { return Math.round(Number(n) * 100) / 100; }

/**
 * What Premiere's Scale would have to be for this media to exactly fill the
 * frame. 8K footage in an HD sequence fits at 25.
 */
function fitScale(mediaWidth, mediaHeight, frameWidth, frameHeight) {
  if (!mediaWidth || !mediaHeight || !frameWidth || !frameHeight) return null;
  return Math.min(frameWidth / mediaWidth, frameHeight / mediaHeight) * 100;
}

/**
 * The Scale a placed graded clip needs to show what the offline showed.
 *
 * **"Set to Frame Size" is the trap.** A clip with it applied reads Scale 100
 * in the Motion panel while showing the whole frame, because the fit happens
 * outside Motion. A fresh placement does NOT inherit it, so copying that 100
 * across puts 8K media at native size in an HD sequence - a 4x zoom into the
 * top-left of the picture. Measured on a real conform: the offline frame and
 * the placed frame correlated -0.007, which is to say they were different
 * shots entirely, while a genuine punch-in on the same run matched at 0.959.
 *
 * The arithmetic is unambiguous once the media's real size is known:
 *
 *   zoom = how much the offline was magnified relative to filling the frame
 *   placedScale = the graded media's own fit x that zoom
 *
 * A clip reading exactly 100 where fit is far from 100 is taken to be fitted -
 * the alternative reading, a deliberate 4x punch-in landing on exactly 100.00,
 * is possible but rare, and `verifiedFraming` settles it where verification
 * has run: if the picture matched at FULL frame, the clip was fitted.
 *
 * Where the graded export matches the source's dimensions and no fit flag is
 * involved, this returns the offline's own Scale unchanged - the correction
 * only bites where it should.
 */
function placedScaleFor(opts) {
  var o = opts || {};
  var offlineScale = Number(o.offlineScale);
  if (!isFinite(offlineScale)) return null;
  var offlineFit = fitScale(o.sourceWidth, o.sourceHeight, o.frameWidth, o.frameHeight);
  var gradedFit = fitScale(o.gradedWidth, o.gradedHeight, o.frameWidth, o.frameHeight);
  if (offlineFit === null || gradedFit === null) return null;

  var fitted;
  if (o.verifiedFraming === "full frame" && offlineScale > offlineFit + 0.5) fitted = true;
  else if (o.verifiedFraming === "punch-in") fitted = false;
  else fitted = Math.abs(offlineScale - 100) < 0.01 && offlineFit < 99;

  var zoom = fitted ? offlineScale / 100 : offlineScale / offlineFit;
  var fromPicture = (o.verifiedFraming === "full frame" || o.verifiedFraming === "punch-in");
  var scale = Math.round(gradedFit * zoom * 1000) / 1000;
  var changes = Math.abs(scale - offlineScale) > 0.01;

  // THE ONLY THING THAT IS EVER A GUESS is a clip reading exactly 100 on media
  // far larger than the frame: "Set to Frame Size" and a deliberate 4x
  // punch-in are indistinguishable there, and measured, one clip of three was
  // the punch-in - refitting it replaced a close-up with the wide shot.
  //
  // Nothing else here is ambiguous. A clip at Scale 27 is a punch-in, full
  // stop; and where the graded export is a DIFFERENT SIZE from the source -
  // measured, an HD comp whose graded export came back 8K - the offline's
  // Scale simply means something else on the new media, whatever the offline
  // was doing. Gating that arithmetic behind the picture left a clip to be
  // placed at 4x with nothing flagged, because it never looked "fitted".
  var guessing = !fromPicture && Math.abs(offlineScale - 100) < 0.01 && offlineFit < 99;
  return {
    fitted: fitted,
    evidence: fromPicture ? "picture" : "arithmetic",
    // True where the arithmetic is certain; the one uncertain case is reported
    // instead, and the offline's own Scale is carried across unchanged.
    apply: changes && !guessing,
    guessing: guessing,
    why: !changes ? "the offline's Scale already means the same thing on the graded media"
       : guessing ? "Scale 100 on media far larger than the frame - either Set to Frame Size "
                    + "or a deliberate punch-in, and only the picture can tell"
       : fitted ? "the picture matched at full frame, so the offline was fitted rather than "
                  + "punched in"
       : "the graded export is a different size from the source, so the same framing needs a "
         + "different Scale",
    offlineFit: Math.round(offlineFit * 1000) / 1000,
    gradedFit: Math.round(gradedFit * 1000) / 1000,
    zoom: Math.round(zoom * 10000) / 10000,
    scale: scale
  };
}

/**
 * A clip whose speed is not 100%.
 *
 * The tolerance is deliberately tight. Premiere reported 1.05 for a clip the
 * editor had retimed and 1 exactly for every clip they had not, so there is no
 * fuzz to allow for - and a "nearly 100%" clip is still one that drifts.
 */
function isRetimed(clip) {
  if (!clip) return false;
  if (clip.reversed) return true;
  var speed = Number(clip.speed);
  if (!isFinite(speed)) return false;     // unreadable speed is not evidence of a retime
  return Math.abs(speed - 1) > 0.001;
}

/** 75.5 -> "1:15.50", because an editor reads position, not a float. */
function formatSeconds(s) {
  var v = Number(s);
  if (!isFinite(v)) return String(s);
  var sign = v < 0 ? "-" : "";
  v = Math.abs(v);
  var m = Math.floor(v / 60);
  var rem = v - m * 60;
  var padded = (rem < 10 ? "0" : "") + rem.toFixed(2);
  return sign + m + ":" + padded;
}

/**
 * The whole decision, in one call: what to place, what to refuse, and why.
 *
 * `clips` are the track items read off the sequence being conformed, each
 * { trackIndex, start, dur, srcIn, path, name }. `ticksPerFrame` is the
 * sequence's own timebase.
 *
 * Placements come back in TIMELINE ORDER and carry ticks, not seconds, so the
 * caller never converts twice.
 */
/**
 * The candidate the editor picked for this cut, if any.
 *
 * Paths are compared normalised because the plan's come from a Python script
 * walking a network volume and the panel's come back through a UXP control -
 * measured, the same file arrived as `///Volumes/...` from one and
 * `/Volumes/...` from the other, and a raw string compare quietly picked
 * nothing.
 */
function pickedVersion(candidates, path) {
  if (!path) return null;
  var want = normalisePath(path);
  var list = candidates || [];
  for (var i = 0; i < list.length; i++) {
    if (normalisePath(list[i].path || list[i]) === want) return list[i];
  }
  return null;
}

/**
 * The plan entry as it reads once a hand-picked version replaces the default.
 *
 * A copy, never a mutation: `matchToTimeline` hands out the caller's own plan
 * objects, and editing one in place would make the choice stick to a plan that
 * outlives the run it was made for.
 *
 * A candidate with a known offset simply becomes the entry's answer. One
 * without keeps the entry unplaceable, which routes it to `unresolved` where
 * verification can measure it - choosing a file and knowing where the cut sits
 * inside it are two different questions.
 */
function withVersion(entry, cand) {
  var e = {};
  for (var k in entry) if (Object.prototype.hasOwnProperty.call(entry, k)) e[k] = entry[k];
  e.graded = cand.path;
  e.gradedDur = (typeof cand.gradedDur === "number") ? cand.gradedDur : null;
  e.gradedWidth = cand.gradedWidth;
  e.gradedHeight = cand.gradedHeight;
  e.sourceIn = (typeof cand.sourceIn === "number") ? cand.sourceIn : null;
  e.chosenByUser = true;
  if (typeof cand.sourceIn === "number") {
    e.status = "OK";
    e.method = (cand.method || "the plan") + ", version chosen by hand";
  } else {
    e.method = null;
  }
  return e;
}

/**
 * One contested cut, as the panel offers it.
 *
 * Listed for EVERY cut with more than one export, not only the ambiguous ones.
 * A SUPERSEDED cut has already been decided by folder date - a good default
 * and an invisible one - and the editor who knows the job may know the newest
 * round is not the one to use.
 *
 * `holds` is the cheap disqualifier: a file shorter than the cut cannot be it,
 * whatever it looks like. It is the same test the matcher applies before it
 * scores anything, and it settles most of these without a frame being decoded
 * - which is what makes this usable with verification switched off.
 */
function versionRow(entry, clip, candidates, picked, frameSeconds) {
  var cut = Number(clip.dur);
  var slack = frameSeconds || 0;
  var chosenPath = picked ? normalisePath(picked.path)
                          : (entry.graded ? normalisePath(entry.graded) : null);
  return {
    key: keyFor(clip),
    start: Number(clip.start),
    dur: cut,
    trackIndex: Number(clip.trackIndex),
    name: baseName(entry.source),
    status: entry.status || null,
    chosen: chosenPath,
    byUser: !!picked,
    why: picked ? "you chose this one"
       : (String(entry.status) === "SUPERSEDED" ? "newest grade round"
       : (chosenPath ? "the only one that matched" : "nothing chosen yet")),
    candidates: (candidates || []).map(function (c) {
      var path = normalisePath(c.path || c);
      var dur = (typeof c.gradedDur === "number") ? c.gradedDur : null;
      return {
        path: path,
        name: baseName(path),
        folder: c.folder || null,
        gradedDur: dur,
        sourceIn: (typeof c.sourceIn === "number") ? c.sourceIn : null,
        method: c.method || null,
        holds: (dur === null) ? null : (dur + slack >= cut),
        chosen: path === chosenPath
      };
    })
  };
}

function buildRun(entries, clips, opts) {
  var o = opts || {};
  var ticksPerFrame = o.ticksPerFrame;
  var matched = matchToTimeline(entries, clips, o);
  // { key: gradedPath } - a version the editor picked by hand, which replaces
  // whatever the plan chose for that cut.
  var chosen = o.chosen || {};

  var placements = [];
  var refused = [];
  var unresolved = [];
  var versions = [];
  var matchedClips = 0;

  for (var i = 0; i < matched.length; i++) {
    if (matched[i].matched) matchedClips++;
    var row = matched[i];
    var e = row.entry;
    var key = row.clip ? keyFor(row.clip) : null;
    var cands = e.candidates || [];

    // EVERY cut with more than one export is offered, whatever the plan did
    // with it. SUPERSEDED took the newest folder and AMBIGUOUS took nothing;
    // both are defaults, and an editor who knows the job may want the other
    // file. plan_conform solves every candidate, so a different pick needs no
    // re-plan and no verification - the durations alone often settle it.
    var picked = pickedVersion(cands, key ? chosen[key] : null);
    if (row.matched && cands.length > 1) {
      versions.push(versionRow(e, row.clip, cands, picked,
                               ticksPerFrame ? ticksPerFrame / TICKS_PER_SECOND : 0));
    }
    if (picked) e = withVersion(e, picked);

    var verdict = classify(e, o);

    // A retimed clip is refused whatever the plan says about it: the reason is
    // the timeline's, not the plan's, and it is the more actionable one.
    if (row.retimed) {
      refused.push({ key: keyFor(row.clip), start: Number(e.start), name: baseName(e.source),
                     status: e.status || null, reason: row.reason });
      continue;
    }

    // AMBIGUOUS is not a dead end when verification is on: the candidates are
    // different shots, so the picture can say which one belongs here. Kept as
    // a candidate placement AND refused, so a run without verification behaves
    // exactly as before.
    // A cut with candidates but no offset yet. Normally that is AMBIGUOUS -
    // two exports of one shot, and the picture says which. It is also where a
    // hand-picked version lands when the plan could not derive an offset for
    // it: the choice narrows the list to one, so verification only has to
    // measure where the cut sits, not decide which file it is.
    var pool = picked ? [picked] : cands;
    if (row.matched && !row.retimed && typeof e.sourceIn !== "number" && pool.length &&
        (picked || (String(e.status) === "AMBIGUOUS" && pool.length > 1))) {
      var clipA = row.clip;
      unresolved.push({
        key: keyFor(clipA),
        start: Number(clipA.start),
        dur: Number(clipA.dur),
        trackIndex: Number(clipA.trackIndex),
        startTicks: alignToFrame(secondsToTicks(clipA.start), ticksPerFrame),
        name: baseName(e.source),
        reframe: clipA.motion || null,
        sourceWidth: e.sourceWidth,
        sourceHeight: e.sourceHeight,
        status: e.status,
        candidates: pool.map(function (c) { return normalisePath(c.path || c); }),
        // The candidates' own sizes and durations, keyed by path. The verdict
        // that comes back names a FILE, not its dimensions, so without this
        // the scale correction has nothing to work from and silently returns
        // null - which is how two resolved cuts were placed at Scale 100 on 8K
        // media while every other clip in the run was fitted correctly.
        candidateInfo: pool.reduce(function (acc, c) {
          if (!c || !c.path) return acc;
          acc[normalisePath(c.path)] = {
            gradedWidth: c.gradedWidth, gradedHeight: c.gradedHeight, gradedDur: c.gradedDur
          };
          return acc;
        }, {})
      });
      refused.push({
        key: keyFor(clipA), start: Number(e.start), name: baseName(e.source), status: e.status,
        reason: picked
          ? ("you chose " + baseName(picked.path) + ", but the plan could not work out where "
             + "this cut sits in it. Verification can measure that; otherwise pick a version "
             + "whose offset is known.")
          : REFUSAL.AMBIGUOUS + " (pick a version below, or let verification match the frame "
            + "against each candidate)"
      });
      continue;
    }
    if (!verdict.placeable) {
      refused.push({ key: row.clip ? keyFor(row.clip) : null, start: Number(e.start),
                     name: baseName(e.source), status: e.status || null, reason: verdict.reason });
      continue;
    }
    if (!row.matched) {
      refused.push({ key: null, start: Number(e.start), name: baseName(e.source),
                     status: e.status || null, reason: row.reason });
      continue;
    }

    // The timeline is the authority on WHERE and HOW LONG; the plan is the
    // authority on WHICH FRAMES. Taking start and duration from the clip means
    // a plan rounded to 2dp cannot nudge a cut off its frame.
    var clip = row.clip;
    placements.push({
      // A stable id for this placement, shared by the panel's reference frames,
      // the verification kit's manifest and the verdicts that come back.
      // TRACK AND start time together: conforming several tracks at once means
      // two clips can begin at the same moment, and a key that collided would
      // hand one clip's verdict to another.
      key: keyFor(clip),
      start: Number(clip.start),
      dur: Number(clip.dur),
      trackIndex: Number(clip.trackIndex),
      name: baseName(e.graded),
      gradedPath: normalisePath(e.graded),
      sourceIn: Number(e.sourceIn),
      startTicks: alignToFrame(secondsToTicks(clip.start), ticksPerFrame),
      sourceInTicks: alignToFrame(secondsToTicks(e.sourceIn), ticksPerFrame),
      sourceOutTicks: alignToFrame(secondsToTicks(Number(e.sourceIn) + Number(clip.dur)), ticksPerFrame),
      gradedDur: (typeof e.gradedDur === "number") ? e.gradedDur : null,
      method: e.method || null,
      // The offline clip's framing. Placement does not use it - Motion is
      // captured and restored by ppro.js - but verification does: a punch-in
      // means the offline shows a crop of what the graded file holds, and the
      // matcher has to crop to match.
      reframe: clip.motion || null,
      // How the placed clip's Scale must differ from the offline's. Normally
      // 1, and only not 1 when the offline clip was fitted with "Set to Frame
      // Size" (reads 100, shows the whole frame) or the graded export is a
      // different size from the source.
      scaleFix: placedScaleFor({
        offlineScale: clip.motion && clip.motion.Scale ? clip.motion.Scale.value : null,
        sourceWidth: e.sourceWidth, sourceHeight: e.sourceHeight,
        gradedWidth: e.gradedWidth, gradedHeight: e.gradedHeight,
        frameWidth: o.frameWidth, frameHeight: o.frameHeight
      }),
      // Kept so the Scale can be worked out AGAIN once verification has said
      // which framing the picture shows. Without them the verdict arrives with
      // nowhere to be applied.
      dims: { sourceWidth: e.sourceWidth, sourceHeight: e.sourceHeight,
              gradedWidth: e.gradedWidth, gradedHeight: e.gradedHeight },
      status: e.status,
      warnings: e.warnings || []
    });
  }

  placements.sort(function (a, b) { return a.start - b.start; });
  refused.sort(function (a, b) { return a.start - b.start; });
  // In TIMECODE order, like every other list in the report. They were coming
  // out in track order - 0:07, 0:25, 1:05, 0:25, 0:13, 0:11 - so picking "the
  // second one" or scanning down the column lands on the wrong cut.
  versions.sort(function (a, b) { return a.start - b.start; });

  // One import per distinct file, however many cuts it serves. Re-importing the
  // same path makes a DUPLICATE project item (measured), so the caller must
  // import this list, not one file per placement.
  var seen = {};
  var files = [];
  for (var p = 0; p < placements.length; p++) {
    var path = placements[p].gradedPath;
    if (seen[path]) continue;
    seen[path] = true;
    files.push(path);
  }

  return {
    placements: placements,
    refused: refused,
    unresolved: unresolved,
    versions: versions,
    files: files,
    ticksPerFrame: ticksPerFrame,
    summary: {
      planned: entries.length,
      placeable: placements.length,
      refused: refused.length,
      files: files.length,
      reused: placements.length - files.length,
      // Clips the plan accounted for, placed or not. The panel subtracts this
      // from the track's clip count to say how many clips it is leaving alone -
      // a refused clip is NOT one of those, it is one the plan knows about and
      // cannot place, and saying otherwise buries the refusals.
      matchedClips: matchedClips,
      unresolved: unresolved.length,
      versions: versions.length
    }
  };
}

/**
 * The key a placement, its kit entry and its verdict all share.
 *
 * Track AND start: conforming several tracks at once, two clips can begin at
 * the same moment, and a key that collided would hand one clip's verdict to
 * another.
 */
function keyFor(clip) {
  return "t" + Number(clip.trackIndex) + "c" + Math.round(Number(clip.start) * 1000);
}

/**
 * Refusals for clips that were never sent to the planner because they are
 * retimed.
 *
 * Filtering them out up front is not just tidiness: a retimed clip has no
 * offset that can be right, but frame matching does not know that and will
 * spend minutes failing on it - measured, most of a 140-second run - and then
 * report "frames likely not in the graded file", which is a misleading reason
 * for what is actually a speed change.
 */
function retimedRefusals(clips) {
  var rows = [];
  for (var i = 0; i < clips.length; i++) {
    var clip = clips[i];
    if (!isRetimed(clip)) continue;
    rows.push({
      key: keyFor(clip),
      start: Number(clip.start),
      name: baseName(clip.path || clip.name),
      status: null,
      reason: "the cut at " + formatSeconds(clip.start) + " is retimed to " +
              Math.round(Number(clip.speed) * 1000) / 10 + "%" +
              (clip.reversed ? " and reversed" : "") +
              " - Premiere's API cannot set a clip's speed, so a graded replacement " +
              "would play at 100% and drift against picture. Place this one by hand."
    });
  }
  return rows;
}

/** Fold extra refusals into a run, keeping the order and the counts honest. */
function mergeRefusals(run, rows) {
  var refused = run.refused.concat(rows || []);
  refused.sort(function (a, b) { return a.start - b.start; });
  run.refused = refused;
  run.summary.refused = refused.length;
  return run;
}

/**
 * What the verification kit hands the matcher: one entry per placement, with
 * the probe times whose frames the panel renders.
 *
 * Probes are spaced across the cut rather than bunched at its head, for two
 * reasons: one frame can hit a false match in a near-static shot, and probes
 * that are spread out are what expose a RETIME - the match slides steadily
 * across them. That is the only available signal for a ramped speed change,
 * because the Premiere API cannot see time remapping at all and `getSpeed()`
 * reports 1 for a ramp that nets out.
 *
 * A very short cut gets fewer probes; there is nowhere to put them.
 */
function verificationKit(run, opts) {
  var o = opts || {};
  var frameSeconds = o.frameSeconds || 0.04;
  var clips = [];
  var entries = run.placements.concat(run.unresolved || []);
  for (var i = 0; i < entries.length; i++) {
    var p = entries[i];
    // Spread the probes ACROSS the cut, and never on its first frame.
    //
    // Two lessons, pulling in opposite directions. The head of a cut is often
    // a dissolve, so a probe at 0.0 matches nothing (measured: 0.15 and 0.34
    // where probes a few frames later scored 0.93 and 0.96). But probes
    // CLUSTERED at the head are worse: on a 8.92s comp whose first second is
    // transitional, three probes inside that second agreed on the wrong
    // framing and "confirmed" a 4x punch-in as a full-frame clip. The picture
    // only separated the two readings from 1.5s onward.
    //
    // So: a few frames in, then spread. The matcher decodes a small window per
    // probe rather than one long span, so a late probe costs no more than an
    // early one.
    var earliest = 3 * frameSeconds;
    var latest = p.dur - 2 * frameSeconds;
    var probes = [];
    [0.15, 0.45, 0.75].forEach(function (fraction) {
      var t = p.dur * fraction;
      if (t < earliest) t = earliest;
      if (t > latest) t = latest;
      if (t < 0) t = 0;
      if (probes.indexOf(t) === -1) probes.push(t);
    });

    clips.push({
      key: p.key,
      start: p.start,
      dur: p.dur,
      graded: p.gradedPath || null,
      // An ambiguous cut goes out with every candidate and no offset: the
      // matcher decides which file it is AND where the cut sits in it.
      candidates: p.candidates || null,
      sourceIn: (p.sourceIn === undefined) ? null : p.sourceIn,
      // Room is the graded file's spare length. It is legitimately ZERO when
      // the file is exactly the cut, so this cannot lean on `||` - that turned
      // a real 0 into null and the matcher then had no range to search.
      room: (typeof p.gradedDur === "number" && isFinite(p.gradedDur))
        ? Math.max(0, p.gradedDur - p.dur)
        : (typeof p.room === "number" ? p.room : null),
      method: p.method,
      reframe: p.reframe || null,
      probes: probes
    });
  }
  return {
    fps: o.fps || null,
    frameSeconds: frameSeconds,
    sequenceWidth: o.sequenceWidth || null,
    sequenceHeight: o.sequenceHeight || null,
    clips: clips
  };
}

/**
 * Fold the matcher's verdicts back into a run.
 *
 * The policy, and the reasoning for each:
 *
 *  - **disputed** -> REFUSED. The picture and the plan disagree about which
 *    frames these are. Placing either answer would be a guess, and the wrong
 *    guess is invisible until the grade is signed off.
 *  - **retimed** -> REFUSED. The match slid across the cut, so the clip is
 *    ramped. `getSpeed()` cannot see that, which makes this the only warning
 *    anyone gets, and the API has no way to set a clip's speed anyway.
 *  - **confirmed** / **static** -> placed. Static means every offset shows the
 *    same picture, so the plan's is as good as any - not a failure.
 *  - **inconclusive** or missing -> PLACED, and listed. Verification failing to
 *    prove something is not evidence against it: the timecode answer is still
 *    exact arithmetic. But the editor is told exactly which ones nothing could
 *    confirm, so the check list stays short and worth reading.
 */
function applyVerification(run, doc, opts) {
  var o = opts || {};
  var byKey = {};
  var rows = (doc && doc.verdicts) || [];
  for (var i = 0; i < rows.length; i++) byKey[rows[i].key] = rows[i];

  var kept = [];
  var refused = run.refused.slice();
  var counts = { confirmed: 0, corroborated: 0, static: 0, inconclusive: 0,
                 disputed: 0, retimed: 0, unchecked: 0, resolved: 0 };
  var unverified = [];
  var ticksPerFrame = run.ticksPerFrame || o.ticksPerFrame;

  /**
   * An ambiguous cut the picture settled.
   *
   * The matcher compared the offline's own frame against every candidate and
   * one of them won clearly. That is better evidence than the filename: the
   * DaVinci prefix encodes the TRACK at grade time, and a timeline rearranged
   * since would make that prefix point at the wrong export.
   */
  for (var u = 0; u < (run.unresolved || []).length; u++) {
    var cand = run.unresolved[u];
    var verdict = byKey[cand.key];
    if (!verdict || verdict.verdict !== "resolved") continue;
    if (typeof verdict.measured !== "number" || !verdict.chosenGraded) continue;
    var chosenInfo = (cand.candidateInfo || {})[normalisePath(verdict.chosenGraded)] || {};
    counts.resolved++;
    kept.push({
      key: cand.key,
      start: cand.start,
      dur: cand.dur,
      trackIndex: cand.trackIndex,
      name: baseName(verdict.chosenGraded),
      gradedPath: normalisePath(verdict.chosenGraded),
      gradedDur: (typeof verdict.chosenDur === "number") ? verdict.chosenDur : chosenInfo.gradedDur,
      sourceIn: verdict.measured,
      startTicks: cand.startTicks,
      sourceInTicks: alignToFrame(secondsToTicks(verdict.measured), ticksPerFrame),
      sourceOutTicks: alignToFrame(secondsToTicks(Number(verdict.measured) + Number(cand.dur)), ticksPerFrame),
      method: "resolved by picture (score " + (verdict.score || "?") + ")",
      // The verdict names a FILE, not its size, so the dimensions come from the
      // candidate table the plan already built. This used to read
      // `verdict.chosenWidth` - a field the matcher has never emitted - which
      // made placedScaleFor return null and the fit silently not happen.
      scaleFix: placedScaleFor({
        offlineScale: cand.reframe && cand.reframe.Scale ? cand.reframe.Scale.value : null,
        sourceWidth: cand.sourceWidth, sourceHeight: cand.sourceHeight,
        gradedWidth: chosenInfo.gradedWidth, gradedHeight: chosenInfo.gradedHeight,
        frameWidth: o.frameWidth, frameHeight: o.frameHeight,
        verifiedFraming: verdict.framing
      }),
      dims: { sourceWidth: cand.sourceWidth, sourceHeight: cand.sourceHeight,
              gradedWidth: chosenInfo.gradedWidth, gradedHeight: chosenInfo.gradedHeight },
      status: cand.status,
      warnings: [],
      reframe: cand.reframe || null,
      verification: verdict
    });
    // It was refused pending this answer; it is not refused any more.
    refused = refused.filter(function (r) { return r.key !== cand.key; });
  }

  for (var p = 0; p < run.placements.length; p++) {
    var placement = run.placements[p];
    var v = byKey[placement.key];
    if (!v) {
      counts.unchecked++;
      placement.verification = { verdict: "unchecked" };
      unverified.push({ start: placement.start, name: placement.name, why: "no verdict for this cut" });
      kept.push(placement);
      continue;
    }
    placement.verification = v;

    // RE-WORK THE SCALE NOW THE PICTURE HAS SPOKEN.
    //
    // buildRun had to decide this before any frame was compared, so the one
    // ambiguous case - Scale 100 on media far larger than the frame, which is
    // either "Set to Frame Size" or a deliberate punch-in - was left flagged
    // and uncorrected. That is the whole reason the framing is measured.
    //
    // Recomputing it here was missing, so the verdict never reached the
    // correction it was gathered for: a clip that matched at FULL FRAME was
    // still placed at the offline's Scale 100, which on 8K media in an HD
    // sequence is a 4x zoom. Verification appeared to run and changed nothing.
    if (v.framing && placement.dims) {
      var refit = placedScaleFor({
        offlineScale: placement.reframe && placement.reframe.Scale
          ? placement.reframe.Scale.value : null,
        sourceWidth: placement.dims.sourceWidth, sourceHeight: placement.dims.sourceHeight,
        gradedWidth: placement.dims.gradedWidth, gradedHeight: placement.dims.gradedHeight,
        frameWidth: o.frameWidth, frameHeight: o.frameHeight,
        verifiedFraming: v.framing
      });
      if (refit) placement.scaleFix = refit;
    }

    if (v.verdict === "disputed") {
      counts.disputed++;
      refused.push({
        start: placement.start, name: placement.name, status: placement.status,
        reason: "the picture disagrees with the plan — " + (v.note || "") +
                ". Nothing is placed until they agree."
      });
      continue;
    }
    if (v.verdict === "retimed") {
      counts.retimed++;
      refused.push({
        start: placement.start, name: placement.name, status: placement.status,
        reason: "frame matching shows this clip is retimed (" + (v.note || "") +
                "), and Premiere's API cannot set a clip's speed. Place it by hand."
      });
      continue;
    }
    if (v.verdict === "confirmed") counts.confirmed++;
    else if (v.verdict === "static") counts.static++;
    // One strong probe agreeing with the plan. Not proof on its own - two must
    // agree for that - but it is corroboration, and filing it with the clips
    // nothing could tell you about would waste the editor's attention.
    else if (v.verdict === "corroborated") counts.corroborated++;
    else {
      counts.inconclusive++;
      unverified.push({ start: placement.start, name: placement.name, why: v.note || v.verdict });
    }
    kept.push(placement);
  }

  refused.sort(function (a, b) { return a.start - b.start; });

  var seen = {};
  var files = [];
  for (var k = 0; k < kept.length; k++) {
    if (seen[kept[k].gradedPath]) continue;
    seen[kept[k].gradedPath] = true;
    files.push(kept[k].gradedPath);
  }

  kept.sort(function (a, b) { return a.start - b.start; });

  // CARRY THE VERSION LIST THROUGH.
  //
  // This is a fresh object, and leaving `versions` off it meant the picker
  // vanished the moment verification ran - which is to say, on every real run,
  // because verification is on by default. The feature looked built and could
  // not be reached.
  //
  // Where the picture settled an ambiguous cut, the row is marked as decided
  // rather than still saying "nothing chosen yet": something DID choose, and
  // the editor is overriding a decision, not making a first one.
  var resolvedBy = {};
  for (var r2 = 0; r2 < kept.length; r2++) {
    var v2 = kept[r2].verification;
    if (v2 && v2.verdict === "resolved" && kept[r2].gradedPath) {
      resolvedBy[kept[r2].key] = kept[r2].gradedPath;
    }
  }
  var versions = (run.versions || []).map(function (row) {
    var pickedPath = resolvedBy[row.key];
    if (!pickedPath || row.byUser) return row;
    var copy = {};
    for (var f2 in row) if (Object.prototype.hasOwnProperty.call(row, f2)) copy[f2] = row[f2];
    copy.chosen = pickedPath;
    copy.why = "the picture chose it";
    copy.candidates = row.candidates.map(function (c) {
      var cc = {};
      for (var f3 in c) if (Object.prototype.hasOwnProperty.call(c, f3)) cc[f3] = c[f3];
      cc.chosen = normalisePath(c.path) === normalisePath(pickedPath);
      return cc;
    });
    return copy;
  });

  return {
    placements: kept,
    refused: refused,
    unresolved: [],
    versions: versions,
    files: files,
    ticksPerFrame: run.ticksPerFrame,
    verification: { counts: counts, unverified: unverified, checked: rows.length },
    summary: {
      planned: run.summary.planned,
      placeable: kept.length,
      refused: refused.length,
      files: files.length,
      reused: kept.length - files.length,
      matchedClips: run.summary.matchedClips,
      versions: versions.length
    }
  };
}

/**
 * ONE WHOLE FILE laid flush against a sequence.
 *
 * Shared by the two modes that place a file covering the entire programme - a
 * single graded master, and each audio stem - because it is the same question
 * both times: the file is supposed to BE this sequence, so where does the
 * sequence's first frame sit inside it, and does the file reach the end?
 *
 * There is no matching to do here and nothing to search for. What there IS is
 * a way to be silently one handle out, which is exactly the failure this panel
 * exists to prevent, so the evidence is ranked:
 *
 *  1. **Timecode.** A sequence carries a zero point - measured, 3600s on this
 *     job, which is 01:00:00:00 - and a render of it carries that same start
 *     timecode. The difference is the offset, exactly, and it needs no
 *     assumption about how the file was rendered.
 *  2. **An exact length match.** Where the file is the sequence to the frame,
 *     only one offset can be right, so it proves itself.
 *  3. **Nothing.** A longer file with no timecode gets placed from its first
 *     frame and SAID SO, because a head handle would put every frame of it out
 *     and nothing else here can tell.
 */
function alignWhole(opts) {
  var o = opts || {};
  var tol = (o.frameSeconds || 0.04) * (o.toleranceFrames || 1);
  var seqDur = Number(o.seqDur);
  var fileDur = Number(o.fileDur);
  var warnings = [];

  if (!isFinite(fileDur) || fileDur <= 0) {
    return { ok: false, reason: "could not read this file's duration, so there is no way to " +
                                "know whether it covers the sequence" };
  }
  if (!isFinite(seqDur) || seqDur <= 0) {
    return { ok: false, reason: "the sequence has no duration to match against" };
  }

  var hasTC = (typeof o.fileStartTC === "number" && isFinite(o.fileStartTC) &&
               typeof o.seqZero === "number" && isFinite(o.seqZero));

  var sourceIn, method;
  if (hasTC) {
    sourceIn = o.seqZero - o.fileStartTC;
    if (sourceIn < -tol) {
      return { ok: false, reason: "timecode says this file starts " + formatSeconds(-sourceIn) +
               " AFTER the sequence does, so it cannot cover the opening" };
    }
    if (sourceIn < 0) sourceIn = 0;
    method = "timecode";
  } else {
    sourceIn = 0;
    if (Math.abs(fileDur - seqDur) <= tol) {
      method = "exact length (the file is the sequence, to the frame)";
    } else if (fileDur > seqDur) {
      method = "assumed flush to the start";
      warnings.push("this file is " + formatSeconds(fileDur - seqDur) + " longer than the " +
                    "sequence and carries no timecode, so it is placed from its first frame. " +
                    "If it was rendered with a handle at the head, every frame of it is out by " +
                    "that handle.");
    }
  }

  // Whatever decided the offset, the file still has to reach the end.
  if (sourceIn + seqDur > fileDur + tol) {
    var short = sourceIn + seqDur - fileDur;
    return { ok: false, reason: "this file is " + formatSeconds(short) + " too short to cover " +
             "the sequence from that point (" + formatSeconds(fileDur) + " of media, " +
             formatSeconds(seqDur) + " of programme" +
             (sourceIn > tol ? " starting " + formatSeconds(sourceIn) + " in" : "") + ")" };
  }
  if (!hasTC && fileDur > seqDur + tol) {
    // Reported either way, but only interesting once it is going to be placed.
    warnings.push("only the first " + formatSeconds(seqDur) + " of it is used");
  }

  return { ok: true, sourceIn: sourceIn, method: method, warnings: warnings };
}

// The stem names that turn up in practice, checked in this order.
//
// SPECIFIC BEFORE GENERIC, which is not a tidiness preference. Delivery names
// routinely carry "MIX" as a separator - `..._MIX_VO_V1.wav` is the set this
// was built against - so a generic "mix" tested first labels every stem in the
// set "Full Mix", including the VO. The generic words are a last resort, for a
// file that says nothing more specific than "mix".
var STEM_WORDS = [
  ["full mix", "Full Mix"], ["fullmix", "Full Mix"], ["mixfull", "Full Mix"],
  ["dialogue", "Dialogue"], ["dialog", "Dialogue"], ["voiceover", "VO"],
  ["music", "Music"], ["atmos", "Atmos"], ["ambience", "Ambience"], ["ambient", "Ambience"],
  ["effects", "SFX"], ["sfx", "SFX"],
  ["backgrounds", "Ambience"], ["sync", "Dialogue"],
  ["amb", "Ambience"], ["dx", "Dialogue"], ["mx", "Music"], ["vo", "VO"], ["fx", "SFX"],
  // Last: only reached when nothing more specific appeared anywhere in the name.
  ["stereo", "Full Mix"], ["mix", "Full Mix"]
];

// The order a mixer hands them over in, and the order they belong on the
// timeline. Anything unrecognised keeps its own name and sorts after these.
var STEM_ORDER = ["Full Mix", "Dialogue", "VO", "Music", "SFX", "Ambience", "Atmos"];

/**
 * What to call a stem, from its filename.
 *
 * Matched on word boundaries, so `VO` is found in `..._MIX_VO_V1.wav` but not
 * inside `..._PROVO_...`. A file nobody can classify keeps its own name rather
 * than being forced into a category - guessing wrong here mislabels a track an
 * editor then mixes against.
 */
function stemLabel(path) {
  var name = baseName(path).replace(/\.[^.]+$/, "");
  var hay = " " + name.toLowerCase().replace(/[_\-.]+/g, " ").replace(/\s+/g, " ") + " ";
  for (var i = 0; i < STEM_WORDS.length; i++) {
    if (hay.indexOf(" " + STEM_WORDS[i][0] + " ") !== -1) return STEM_WORDS[i][1];
  }
  return name;
}

function isSeparator(ch) {
  return ch === " " || ch === "_" || ch === "-" || ch === "." || ch === undefined;
}

/**
 * Name each stem after the part of its filename that DIFFERS from the others.
 *
 * Real delivery names defeat a vocabulary. Measured on an actual mix:
 *
 *     Film Title - V3 MIX MINUS MUSIC.wav   ->  "Music"
 *     Film Title - V3 MUSIC DIPPED.wav      ->  "Music"
 *     Film Title - V3 MUSIC UNDIPPED.wav    ->  "Music"
 *
 * Three different stems with one name, and the first of them is the mix with
 * the music TAKEN OUT - so a mixer pulling the track labelled "Music" would
 * get the opposite of what they asked for. No word list fixes that, because
 * the word really is in the name.
 *
 * What the set itself says is unambiguous: they share "Film Title - V3 "
 * and differ after it. So the shared prefix and suffix are stripped and what
 * is left becomes the name - BACKGROUNDS, M+E, MIX MINUS MUSIC, MUSIC DIPPED,
 * MUSIC UNDIPPED, SFX, SYNC. Faithful, never invented, never collides.
 *
 * An affix is only stripped where it lands on a separator in EVERY name.
 * Without that rule "MUSIC DIPPED" and "MUSIC UNDIPPED" share the ending
 * "DIPPED" and come out as "" and "UN".
 */
function stemLabels(paths) {
  var names = (paths || []).map(function (p) {
    return baseName(p).replace(/\.[^.]+$/, "");
  });
  if (names.length < 2) return names.map(function (n, i) { return stemLabel(paths[i]); });

  var shortest = Math.min.apply(null, names.map(function (n) { return n.length; }));
  var pre = 0;
  while (pre < shortest && names.every(function (n) { return n[pre] === names[0][pre]; })) pre++;
  // Back off to a separator, so a name is never cut through the middle of a word.
  while (pre > 0 && !names.every(function (n) { return isSeparator(n[pre]) || isSeparator(n[pre - 1]); })) pre--;

  var suf = 0;
  while (suf < shortest - pre &&
         names.every(function (n) { return n[n.length - 1 - suf] === names[0][names[0].length - 1 - suf]; })) suf++;
  while (suf > 0 && !names.every(function (n) { return isSeparator(n[n.length - suf - 1]); })) suf--;

  var out = names.map(function (n) {
    return n.slice(pre, n.length - suf).replace(/^[\s_\-.]+|[\s_\-.]+$/g, "");
  });
  // If stripping leaves anything blank or makes two stems share a name, the
  // full filename is the honest answer - verbose beats wrong.
  var seen = {};
  var bad = out.some(function (x) {
    if (!x || seen[x]) return true;
    seen[x] = true;
    return false;
  });
  return bad ? names : out;
}

// "MIX MINUS MUSIC" is not the music stem. A word list cannot tell, so any
// label that takes something AWAY is left uncategorised rather than sorted in
// beside the thing it excludes.
var STEM_NEGATIONS = ["minus", "less", "without", "no", "excl", "except"];

/**
 * Where a stem belongs in the running order. Ordering ONLY - the label itself
 * is whatever the filename said, because a name is something an editor acts on
 * and a running order is not.
 */
function stemRank(label) {
  var exact = STEM_ORDER.indexOf(label);
  if (exact !== -1) return exact;
  var hay = " " + String(label).toLowerCase().replace(/[_\-.+]+/g, " ").replace(/\s+/g, " ") + " ";
  for (var n = 0; n < STEM_NEGATIONS.length; n++) {
    if (hay.indexOf(" " + STEM_NEGATIONS[n] + " ") !== -1) return STEM_ORDER.length;
  }
  for (var i = 0; i < STEM_WORDS.length; i++) {
    if (hay.indexOf(" " + STEM_WORDS[i][0] + " ") !== -1) {
      var at = STEM_ORDER.indexOf(STEM_WORDS[i][1]);
      if (at !== -1) return at;
    }
  }
  return STEM_ORDER.length;
}

/**
 * A single graded master laid over the whole programme.
 *
 * It goes on a NEW top video track rather than replacing anything: the offline
 * stays underneath, untouched and available to cut back to, and the graded
 * picture is what plays. Nothing about the edit is destroyed by a conform that
 * turns out to be one frame out.
 */
function masterPlan(opts) {
  var o = opts || {};
  var ticksPerFrame = o.ticksPerFrame;
  var frameSeconds = ticksPerFrame ? ticksPerFrame / TICKS_PER_SECOND : 0.04;
  var fit = alignWhole({
    fileDur: o.fileDur, fileStartTC: o.fileStartTC,
    seqDur: o.seqDur, seqZero: o.seqZero, frameSeconds: frameSeconds
  });
  var name = baseName(o.path);

  if (!fit.ok) {
    return { mode: "master", placements: [], refused: [{ start: 0, name: name, reason: fit.reason }],
             files: [], ticksPerFrame: ticksPerFrame,
             summary: { planned: 1, placeable: 0, refused: 1, files: 0 } };
  }

  var placement = {
    key: "master",
    start: 0,
    dur: o.seqDur,
    trackIndex: o.trackIndex,
    name: name,
    gradedPath: normalisePath(o.path),
    sourceIn: fit.sourceIn,
    startTicks: 0,
    sourceInTicks: alignToFrame(secondsToTicks(fit.sourceIn), ticksPerFrame),
    sourceOutTicks: alignToFrame(secondsToTicks(fit.sourceIn + o.seqDur), ticksPerFrame),
    gradedDur: o.fileDur,
    method: fit.method,
    warnings: fit.warnings
  };
  return {
    mode: "master",
    placements: [placement],
    refused: [],
    files: [placement.gradedPath],
    ticksPerFrame: ticksPerFrame,
    summary: { planned: 1, placeable: 1, refused: 0, files: 1 }
  };
}

/**
 * Mix stems laid flush to the start, one per new audio track.
 *
 * Every stem is the same length as the programme, so each one is the same
 * question as the master and gets the same evidence ranking. What is different
 * is that they come as a SET: a stem that disagrees with the others about its
 * own length is worth saying out loud, because one short stem in a set of four
 * is a failed render, not a convention.
 */
function stemsPlan(opts) {
  var o = opts || {};
  var ticksPerFrame = o.ticksPerFrame;
  var frameSeconds = ticksPerFrame ? ticksPerFrame / TICKS_PER_SECOND : 0.04;
  var files = (o.files || []).slice();
  var placements = [];
  var refused = [];

  var setLabels = stemLabels(files.map(function (f) { return f.path; }));
  files.forEach(function (f, fi) {
    var label = setLabels[fi];
    var fit = alignWhole({
      fileDur: f.dur, fileStartTC: f.startTC,
      seqDur: o.seqDur, seqZero: o.seqZero, frameSeconds: frameSeconds
    });
    if (!fit.ok) {
      refused.push({ start: 0, name: baseName(f.path), label: label, reason: fit.reason });
      return;
    }
    placements.push({
      key: "stem:" + label + ":" + baseName(f.path),
      label: label,
      start: 0,
      dur: o.seqDur,
      name: baseName(f.path),
      gradedPath: normalisePath(f.path),
      sourceIn: fit.sourceIn,
      startTicks: 0,
      sourceInTicks: alignToFrame(secondsToTicks(fit.sourceIn), ticksPerFrame),
      sourceOutTicks: alignToFrame(secondsToTicks(fit.sourceIn + o.seqDur), ticksPerFrame),
      gradedDur: f.dur,
      channels: f.channels,
      method: fit.method,
      warnings: fit.warnings
    });
  });

  // Mixer's order, not the order the file picker happened to hand them over.
  placements.sort(function (a, b) {
    var r = stemRank(a.label) - stemRank(b.label);
    return r !== 0 ? r : (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
  });
  // The track each one lands on: the first spare, then upward.
  var base = Number(o.trackIndex) || 0;
  placements.forEach(function (p, i) { p.trackIndex = base + i; });

  // A stem that disagrees with the rest of the set about its own length.
  var lengths = placements.map(function (p) { return p.gradedDur; })
                          .filter(function (d) { return typeof d === "number"; });
  if (lengths.length > 1) {
    var longest = Math.max.apply(null, lengths);
    var shortest = Math.min.apply(null, lengths);
    if (longest - shortest > frameSeconds) {
      placements.forEach(function (p) {
        if (typeof p.gradedDur === "number" && longest - p.gradedDur > frameSeconds) {
          p.warnings = (p.warnings || []).concat(
            "this stem is " + formatSeconds(longest - p.gradedDur) + " shorter than the longest " +
            "one in the set - one short stem among several is usually a render that stopped early");
        }
      });
    }
  }

  return {
    mode: "stems",
    placements: placements,
    refused: refused,
    files: placements.map(function (p) { return p.gradedPath; }),
    ticksPerFrame: ticksPerFrame,
    summary: { planned: files.length, placeable: placements.length,
               refused: refused.length, files: placements.length }
  };
}

/**
 * Cuts whose graded file serves more than one placement.
 *
 * Not a problem - it is the normal "one export, two cuts" case - but it is the
 * reason placement is sequential: the in/out marks live on the shared project
 * item, so two cuts from one file cannot be marked at the same time. The caller
 * must mark, place, re-mark, place.
 */
function sharedFiles(placements) {
  var byPath = {};
  for (var i = 0; i < placements.length; i++) {
    var p = placements[i];
    (byPath[p.gradedPath] = byPath[p.gradedPath] || []).push(p.start);
  }
  var out = [];
  Object.keys(byPath).forEach(function (path) {
    if (byPath[path].length > 1) out.push({ path: path, name: baseName(path), starts: byPath[path] });
  });
  return out;
}

module.exports = {
  pickedVersion: pickedVersion,
  withVersion: withVersion,
  versionRow: versionRow,
  TICKS_PER_SECOND: TICKS_PER_SECOND,
  PLACEABLE_STATUS: PLACEABLE_STATUS,
  REFUSAL: REFUSAL,
  normalisePath: normalisePath,
  baseName: baseName,
  secondsToTicks: secondsToTicks,
  alignToFrame: alignToFrame,
  readPlan: readPlan,
  classify: classify,
  matchToTimeline: matchToTimeline,
  buildRun: buildRun,
  fitScale: fitScale,
  placedScaleFor: placedScaleFor,
  keyFor: keyFor,
  isRetimed: isRetimed,
  retimedRefusals: retimedRefusals,
  mergeRefusals: mergeRefusals,
  verificationKit: verificationKit,
  applyVerification: applyVerification,
  alignWhole: alignWhole,
  stemLabel: stemLabel,
  stemLabels: stemLabels,
  masterPlan: masterPlan,
  stemsPlan: stemsPlan,
  sharedFiles: sharedFiles,
  formatSeconds: formatSeconds
};
