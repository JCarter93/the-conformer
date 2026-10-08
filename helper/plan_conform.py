#!/usr/bin/env python3
"""
Plan an offline -> graded conform: match each timeline clip to its graded file
and work out where the cut sits inside it.

Input `clips.json` is derived from get_timeline_state — one entry per clip on
the track you are conforming:

  [{"start": 15.56, "in": 8.56, "dur": 0.84,
    "source": "/abs/path/FX6_4020.MXF"}, ...]

Graded files are matched by TOKEN, not by a known prefix convention: the
offline clip's own filename (minus extension) must appear in the graded
file's name as a whole token — not as a partial hit inside a longer run of
digits or letters (`FX6_402` must not match `FX6_4020`). This replaces
guessing at each grading system's naming convention — DaVinci prepends,
Baselight may not, the next one will do something else — with a check that
holds regardless of what gets stuck on either side of the original name.

THE STRONGEST SIGNAL IS TIMECODE, because it assumes nothing. Where the grade
preserved the camera original's timecode, both files carry one, and:

    G      = graded_start_tc - rush_start_tc    # where the export begins,
                                                 measured in the rush
    offset = cut_in_point - G                    # so where the cut begins,
                                                 measured in the export

That is exact, per clip, and needs no convention. It matters because handle
conventions are not reliable: measured on the job it was built on, one round of
DaVinci exports carried 22, 7, 0, 2 and 10 frames of handle on different
clips. No single "head / tail / centred / 12 frames" setting describes that,
and any of them would have placed most clips a few frames out - the error
nobody notices until the grade is signed off.

THE OLD SIGNAL still works where it applies. Fixed-handle exports mean:

    graded_duration - cut_duration == 2 * handle    ->  sourceIn = handle

and the zero case is self-proving: where the graded file IS the cut, to the
frame, there is exactly one offset that can be right.

So, per clip, in order:

    1. timecode, if both files carry a usable one and the answer fits
    2. fixed handles, if --handle-frames happens to match
    3. no handles at all, if the durations are equal
    4. otherwise RETRIMMED - hand it to find_offsets.py

`--align head|tail|centre|handle` overrides all of that for grades that burned
a fresh session timecode rather than preserving the source's. It is a last
resort, not a first question: being told the wrong convention is worse than
being told nothing, because nothing gets frame-matched instead.

  python plan_conform.py --graded <dir> --clips clips.json --out plan.json
"""
import argparse, collections, glob, json, os, re, subprocess, sys


def probe(ffmpeg, path):
    """Run ffmpeg -i once and hand back its stderr for both duration and
    timecode parsing, so a file shared by several cuts is only probed once."""
    return subprocess.run([ffmpeg, "-hide_banner", "-i", path],
                          capture_output=True, text=True).stderr


def parse_duration(stderr):
    m = re.search(r"Duration: (\d+):(\d\d):(\d\d\.\d+)", stderr)
    if not m:
        return None
    h, mi, s = m.groups()
    return int(h) * 3600 + int(mi) * 60 + float(s)


def parse_dims(stderr):
    """
    A file's pixel size, read from the same ffmpeg probe as everything else.

    This is what makes "Set to Frame Size" detectable. Premiere's Scale is a
    percentage of the SOURCE's own pixels, so 8K footage sits at 25 in an HD
    sequence - but a clip with Set to Frame Size applied reads 100 while
    showing the whole frame. Without the media's real size there is no way to
    tell that from a genuine 4x punch-in.
    """
    m = re.search(r"Stream #\d+:\d+.*?, (\d{2,5})x(\d{2,5})", stderr, re.S)
    return (int(m.group(1)), int(m.group(2))) if m else (None, None)


def parse_fps(stderr, fallback):
    """
    A file's own frame rate, for converting ITS timecode.

    The graded export and the camera original need not share a rate, and the
    sequence rate (--fps) need not match either. A timecode converted at the
    wrong rate is wrong by up to a second per minute, so each file's timecode
    is converted using the rate ffmpeg reports for that file.
    """
    m = re.search(r"(\d+(?:\.\d+)?) fps", stderr)
    return float(m.group(1)) if m else fallback


def timecode_to_seconds(h, mi, s, f, drop_frame, fps):
    """
    Turn parsed HH:MM:SS:FF fields into elapsed seconds.

    Non-drop: frame count is exactly fps * elapsed_seconds, so this is h:m:s
    plus f/fps — using whatever TRUE rate --fps was given as (29.97, not the
    rounded 30; see the --fps help text).

    Drop-frame (semicolon separator — only defined at 29.97/59.94): frame
    LABELS 0 and 1 (30fps-based) or 0-3 (60fps-based) are skipped at the
    start of every minute not divisible by ten, to keep the label in step
    with real time despite the true frame rate running at 1000/1001 of the
    nominal one. No video frames are actually dropped — only the numbers.
    This is the standard SMPTE 12M conversion: count frames as if nothing
    were skipped, subtract the labels that were actually skipped up to this
    point, then divide by the TRUE rate to get elapsed seconds.

    Verified against the standard's own reference point: 01:00:00;00 at
    29.97 drop-frame comes back as 3599.9964s, not exactly 3600 — a ~3.6ms
    residual per hour is drop-frame's known, correct behaviour (it
    approximates real time to about a frame a day; it was never exact). A
    NON-drop-frame reading of the same nominal rate would be off by whole
    seconds, not milliseconds — which is the entire reason drop-frame
    timecode exists in the first place.

    Returns None if `drop_frame` is set but the nominal rate isn't 30 or 60
    — drop-frame isn't defined at any other rate, so a file claiming it at,
    say, 25fps is a labelling inconsistency worth flagging, not a case to
    guess a conversion for.
    """
    if not drop_frame:
        return h * 3600 + mi * 60 + s + f / fps

    nominal = round(fps)
    if nominal not in (30, 60):
        return None

    drop_per_min = 2 if nominal == 30 else 4
    total_minutes = 60 * h + mi
    frame_number = (h * 3600 + mi * 60 + s) * nominal + f
    frame_number -= drop_per_min * (total_minutes - total_minutes // 10)
    true_fps = nominal * 1000 / 1001
    return frame_number / true_fps


def parse_start_tc(stderr, fps):
    """
    Embedded start timecode from ffmpeg's own metadata dump — a
    "timecode  : 09:12:34:05" (or "...;05" for drop-frame) line under a
    stream or format Metadata block. Returns None if the file carries no
    timecode tag at all.
    """
    m = re.search(r"timecode\s*:\s*(\d{2}):(\d{2}):(\d{2})([:;])(\d{2})", stderr)
    if not m:
        return None
    h, mi, s, sep, f = m.groups()
    h, mi, s, f = int(h), int(mi), int(s), int(f)
    drop_frame = sep == ";"
    raw = m.group(0).split(":", 1)[-1].strip()
    seconds = timecode_to_seconds(h, mi, s, f, drop_frame, fps)
    if seconds is None:
        return {"seconds": None, "dropFrame": drop_frame, "raw": raw,
                "unreliable": f"marked drop-frame at a nominal {round(fps)}fps — "
                              "drop-frame is only defined at 30/60-based rates"}
    return {"seconds": seconds, "dropFrame": drop_frame, "raw": raw}


def timecode_offset(clip, graded_stderr, source_stderr, fallback_fps):
    """
    Where the cut starts inside the graded file, derived from timecode alone.

    This is the signal that needs no convention and no guessing, and it is
    exact when it applies. Both files carry a start timecode; the graded export
    preserves the camera original's, so:

        G = graded_start_tc - rush_start_tc      # where the export begins,
                                                 # measured in the rush
        offset = cut_in_point - G                # ...so where the cut begins,
                                                 # measured in the export

    Nothing here assumes handles are fixed, centred, or present at all.
    Measured on the job it was built on, the same round of exports gave offsets of 4
    frames, 3 frames, 0 and 0 - no convention describes that, and any fixed
    assumption would have placed three of the four a few frames out. A few
    frames out is the error nobody catches until the grade is signed off.

    Returns (offset_or_None, detail_dict). The detail is recorded either way,
    so a file that does NOT preserve source timecode is visible rather than
    silently ignored.

    NOTE the arithmetic this replaces: the previous version compared the graded
    file's timecode against the cut's in-point directly, as if the rush started
    at 00:00:00:00. These cameras start at 00:05, so every clip looked like a
    contradiction. The warning was real; the sum was wrong.
    """
    g_fps = parse_fps(graded_stderr, fallback_fps)
    g_tc = parse_start_tc(graded_stderr, g_fps)
    if not g_tc:
        return None, {"usable": False, "why": "the graded file carries no timecode"}
    if g_tc["seconds"] is None:
        return None, {"usable": False, "startTc": g_tc["raw"], "why": g_tc["unreliable"]}

    if source_stderr is None:
        return None, {"usable": False, "startTc": g_tc["raw"],
                      "why": "the camera original could not be read, so its timecode is unknown"}
    s_fps = parse_fps(source_stderr, fallback_fps)
    s_tc = parse_start_tc(source_stderr, s_fps)
    if not s_tc or s_tc["seconds"] is None:
        return None, {"usable": False, "startTc": g_tc["raw"],
                      "why": "the camera original carries no usable timecode"}

    covers_from = g_tc["seconds"] - s_tc["seconds"]
    offset = clip["in"] - covers_from
    return offset, {
        "usable": True,
        "startTc": g_tc["raw"],
        "sourceStartTc": s_tc["raw"],
        "dropFrame": g_tc["dropFrame"] or s_tc["dropFrame"],
        "impliedOffset": round(offset, 3)
    }


def convention_offset(mode, room, handle):
    """
    Where the cut starts, if you are TOLD the convention instead of deriving it.

    `room` is graded_duration - cut_duration: all the spare frames, wherever
    they sit. The fallback for grades that did not preserve source timecode.
    """
    if mode == "head":
        return 0.0
    if mode == "tail":
        return room
    if mode == "centre":
        return room / 2.0
    if mode == "handle":
        return handle
    return None


def token_match(offline_stem, graded_name):
    """
    True if offline_stem appears in graded_name as a whole token — not as a
    partial hit inside a longer run of letters/digits. Rejects the FX6_402 /
    FX6_4020 collision (the character right after "402" in "FX6_4020" is "0",
    which is alphanumeric, so the lookahead fails) while matching regardless
    of what a given grading house sticks on either side of the original name.
    """
    pattern = r'(?<![A-Za-z0-9])' + re.escape(offline_stem) + r'(?![A-Za-z0-9])'
    return re.search(pattern, graded_name, re.IGNORECASE) is not None




def solve(c, graded_path, get_stderr, a, handle, tol):
    """
    Where this cut begins inside ONE graded file.

    Pulled out of the main loop so it can be asked about any candidate, not
    only the one the plan picked. Where a shot was exported more than once -
    two grade rounds, or two instances of the same shot in one round - the
    editor may want a different file from the one the folder date chose, and
    an offset they cannot place is no use to them. Every candidate is solved,
    so switching between them in the panel needs no re-plan.

    Returns only the keys it actually worked out, plus `retrimmed` when no
    offset could be derived at all; the caller merges them.
    """
    r = {}
    stderr = get_stderr(graded_path)
    gd = parse_duration(stderr)
    r["gradedDur"] = round(gd, 3) if gd else None
    # The graded export's own pixel size. Without it the panel cannot work out
    # what "fits the frame" means for this media, and the whole Set-to-Frame-
    # Size correction quietly does nothing - placedScaleFor returns null the
    # moment either dimension is missing, so every clip looked like it needed
    # no correction whether it did or not.
    gw, gh = parse_dims(stderr)
    if gw and gh:
        r["gradedWidth"], r["gradedHeight"] = gw, gh
    if gd:
        diff = gd - c["dur"]
        r["handleDiff"] = round(diff, 3)
        room = max(0.0, diff)          # every spare frame, wherever it sits

        # --- 1. timecode: exact, per clip, assumes nothing -----------
        source_stderr = get_stderr(c["source"]) if os.path.exists(c["source"]) else None
        if source_stderr:
            sw, sh = parse_dims(source_stderr)
            r["sourceWidth"], r["sourceHeight"] = sw, sh
        tc_offset, tc_detail = timecode_offset(c, stderr, source_stderr, a.fps)
        r["tcCheck"] = tc_detail
        tc_usable = None
        if tc_offset is not None:
            # It still has to fit: the cut cannot start before the file
            # does, nor run off the end of it. A grade that burned a
            # fresh session timecode usually - not always - lands
            # outside this, which is what the range check is for.
            if -tol <= tc_offset <= room + tol:
                tc_usable = min(max(tc_offset, 0.0), room)
                r["tcCheck"]["inRange"] = True
            else:
                r["tcCheck"]["inRange"] = False
                r.setdefault("warnings", []).append(
                    "timecode implies the cut starts %.2fs into a file with only "
                    "%.2fs of room - this grade probably did not preserve source "
                    "timecode, so the offset came from elsewhere" % (tc_offset, room))

        # --- 2. an explicit convention overrides everything ----------
        forced = convention_offset(a.align, room, handle) if a.align != "auto" else None

        if forced is not None:
            r["sourceIn"] = round(min(max(forced, 0.0), room), 3)
            r["method"] = "%s (told, not derived)" % a.align
        elif tc_usable is not None:
            r["sourceIn"] = round(tc_usable, 3)
            r["method"] = "timecode"
        elif abs(diff - 2 * handle) < tol:
            r["sourceIn"] = round(handle, 3)
            r["method"] = "handles"
        elif abs(diff) < tol:
            # No handles at all: the graded file IS the cut, to the
            # frame. There is exactly one offset that can be right, so
            # this needs no frame search and no assumption about the
            # grading house's handle length - unlike the branch above,
            # which only holds if --handle-frames was given correctly.
            # Measured on the job it was built on, where the exports carry
            # 22, 7, 0, 2 and 10 frames of handle on different clips:
            # a fixed-handle convention is not safe to assume, but a
            # zero difference is self-proving.
            r["sourceIn"] = 0.0
            r["method"] = "no handles (the file is exactly the cut)"
        else:
            r["retrimmed"] = True
            r["method"] = "needs frame match"
            r["offsetRange"] = [round(c["in"] + c["dur"] - gd, 3), round(c["in"], 3)]

        # Where timecode was available but something else decided the
        # offset, say so - the two disagreeing is worth an editor's eye
        # even when the chosen answer is defensible.
        if (tc_usable is not None and r.get("method") not in ("timecode", None)
                and abs(tc_usable - r.get("sourceIn", tc_usable)) > tol):
            r.setdefault("warnings", []).append(
                "timecode says %.2fs but %s was used (%.2fs)"
                % (tc_usable, r["method"], r["sourceIn"]))
    return r

def settle_by_timecode(e, cands):
    """
    Let timecode decide between same-round exports where it can.

    Two cuts from one rush mean two graded files that both match its name, so
    the cut is AMBIGUOUS - but where the grade kept source timecode, each file
    covers a different stretch of the rush, and only one of them can hold this
    cut. When at least one candidate's timecode puts the cut inside it, every
    candidate whose timecode puts it OUTSIDE is the wrong shot, not a fallback:
    its "handles" offset would place another part of the rush. And when exactly
    one candidate is left, timecode has answered the question the picture was
    being asked, so the cut is settled here (and still verified like any other
    timecode placement).

    Nothing changes where no candidate's timecode lands in range - a grade that
    burned a fresh session timecode - or where any candidate has no timecode:
    the picture still decides those.
    """
    if not any(h.get("tcInRange") is True for h in cands):
        return
    for h in cands:
        if h.get("tcInRange") is False:
            h["excludedByTimecode"] = True
            h["sourceIn"] = None
            h["method"] = "timecode puts this cut outside the file"
    live = [h for h in cands if h.get("tcInRange") is True]
    # SUPERSEDED took the newest round by folder name; if timecode says that
    # file holds a different stretch of the rush, take the newest one that
    # does hold the cut instead.
    picked = [h for h in cands if h.get("path") == e.get("graded")]
    if picked and picked[0].get("excludedByTimecode") and live:
        best = sorted(live, key=lambda h: (h.get("folder") or "", h.get("name") or ""))[-1]
        e["graded"] = best["path"]
        e["resolvedBy"] = "timecode"
        e.setdefault("warnings", []).append(
            "the newest round's file does not hold this cut by timecode - used %s" % best["name"])
        for h in cands:
            h["chosen"] = h is best
        return
    if (e.get("status") == "AMBIGUOUS" and len(live) == 1
            and all(h.get("tcInRange") is not None for h in cands)):
        e["status"] = "OK"
        e["graded"] = live[0]["path"]
        e["resolvedBy"] = "timecode"
        for h in cands:
            h["chosen"] = h is live[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--graded", required=True)
    ap.add_argument("--clips", required=True)
    ap.add_argument("--out", default="plan.json")
    ap.add_argument("--fps", type=float, default=25.0,
                    help="TRUE playback rate — 29.97, not 30; 59.94, not 60. "
                         "Drop-frame detection reads the nominal rate off this "
                         "by rounding, so passing the rounded value here would "
                         "silently break the drop-frame conversion, not just "
                         "the handle-length math.")
    ap.add_argument("--handle-frames", type=int, default=12,
                    help="Only used by --align handle, or as a last-resort guess in auto "
                         "mode when a file carries no timecode.")
    ap.add_argument("--align", default="auto",
                    choices=["auto", "head", "tail", "centre", "handle"],
                    help="Where the cut sits inside the graded file. AUTO (the default) "
                         "derives it per clip from timecode and needs no convention at "
                         "all; it falls back to the self-proving zero-handle case, then "
                         "to --handle-frames, then asks for a frame match. The others "
                         "TELL it instead, for grades that did not preserve source "
                         "timecode: head = the export starts at the cut, tail = it ends "
                         "at the cut, centre = spare frames split evenly, handle = "
                         "exactly --handle-frames each side. A told convention overrides "
                         "timecode, so only use one when you know it.")
    # Use ONE pinned ffmpeg build everywhere. Two builds on the same machine
    # disagreed about the same 8K ProRes 4444 export - 17.64s from a 2016
    # build against 17.71s from a current one, 1.75 frames, which moves
    # `room`, the verification window and the timecode range check with it.
    # The helper always passes an explicit path; this default is for hand runs.
    ap.add_argument("--ffmpeg", default="ffmpeg", help="ffmpeg binary (the helper passes its own)")
    a = ap.parse_args()

    handle = a.handle_frames / a.fps
    tol = 1.5 / a.fps                       # allow a frame or so of slop

    # Every graded file, stripped of AppleDouble sidecars. No prefix regex —
    # matching now happens per-clip, by token, against this flat list.
    graded_files = []
    for p in sorted(glob.glob(a.graded + "/**/*", recursive=True)):
        b = os.path.basename(p)
        if b.startswith("._") or not b.lower().endswith((".mov", ".mxf", ".mp4")):
            continue
        graded_files.append({"path": p, "name": b, "folder": os.path.basename(os.path.dirname(p))})

    clips = json.load(open(a.clips))
    plan, counts = [], collections.Counter()
    probe_cache = {}   # path -> ffmpeg stderr, so a shared file is probed once

    def get_stderr(path):
        if path not in probe_cache:
            probe_cache[path] = probe(a.ffmpeg, path)
        return probe_cache[path]

    for c in clips:
        stem = os.path.splitext(os.path.basename(c["source"]))[0]
        # COPIES, one set per cut. These dicts are written to below (each
        # candidate's offset for THIS cut), and the same graded file is a
        # candidate for every cut from its rush - sharing the objects meant the
        # last cut solved overwrote every other cut's offsets, so two cuts from
        # one rush showed one identical, half-wrong candidate list.
        hits = [dict(g) for g in graded_files if token_match(stem, g["name"])]
        e = dict(c, stem=stem)
        if not hits:
            e["status"] = "MISSING"
        else:
            folders = {h["folder"] for h in hits}
            if len(folders) > 1:
                # Newest folder wins when the same shot was re-graded. Folder
                # names sort the same way DaVinci and Baselight both name
                # round folders (date or round number), so a plain sort holds.
                hits = sorted(hits, key=lambda h: (h["folder"], h["name"]))
                e["status"] = "SUPERSEDED"
                e["graded"] = hits[-1]["path"]
                e["candidates"] = hits
            elif len(hits) > 1:
                e["status"] = "AMBIGUOUS"          # same round, genuinely two exports
                e["candidates"] = sorted(hits, key=lambda h: h["name"])
            else:
                e["status"] = "OK"
                e["graded"] = hits[0]["path"]
                e["candidates"] = hits

        # THE SOURCE'S OWN SIZE IS A PROPERTY OF THE SOURCE, not of whichever
        # graded file was chosen for it. It used to be recorded inside solve(),
        # which only runs for an entry that already HAS a chosen file - so
        # every AMBIGUOUS cut came back with sourceWidth null, and the panel's
        # scale correction returns nothing the moment a dimension is missing.
        # Measured: two resolved cuts placed at Scale 100 on 8K media.
        if os.path.exists(c["source"]):
            sw0, sh0 = parse_dims(get_stderr(c["source"]))
            if sw0 and sh0:
                e["sourceWidth"], e["sourceHeight"] = sw0, sh0

        if e.get("graded"):
            solved = solve(c, e["graded"], get_stderr, a, handle, tol)
            if solved.pop("retrimmed", False):
                e["status"] = "RETRIMMED"
            for w in solved.pop("warnings", []):
                e.setdefault("warnings", []).append(w)
            e.update(solved)

        # Solve the ALTERNATIVES too, so the panel can offer them.
        #
        # A shot exported twice leaves a choice the plan currently makes
        # silently: the newest folder for SUPERSEDED, and nothing at all for
        # AMBIGUOUS. Both are reasonable defaults and both are sometimes wrong,
        # so every candidate carries its own offset and duration and can be
        # swapped in without re-planning. The probe cache means each extra file
        # costs a single ffprobe.
        cands = e.get("candidates") or []
        if len(cands) > 1:
            for h in cands:
                if h["path"] == e.get("graded"):
                    h["chosen"] = True
                alt = solve(c, h["path"], get_stderr, a, handle, tol)
                h["retrimmed"] = bool(alt.pop("retrimmed", False))
                alt.pop("warnings", None)
                # None = no usable timecode; True/False = it covers the cut or not.
                h["tcInRange"] = (alt.pop("tcCheck", None) or {}).get("inRange")
                for k in ("sourceIn", "method", "gradedDur", "gradedWidth", "gradedHeight"):
                    if k in alt:
                        h[k] = alt[k]
            settle_by_timecode(e, cands)
            if e.get("resolvedBy") == "timecode":
                solved = solve(c, e["graded"], get_stderr, a, handle, tol)
                if not solved.pop("retrimmed", False) and e.get("status") == "RETRIMMED":
                    e["status"] = "SUPERSEDED"   # the first pick was the wrong file, not a retrim
                for w in solved.pop("warnings", []):
                    e.setdefault("warnings", []).append(w)
                e.update(solved)

        counts[e["status"]] += 1
        plan.append(e)

    json.dump(plan, open(a.out, "w"), indent=1)
    print(f"clips: {len(clips)}   handle = {handle:.2f}s ({a.handle_frames}f @ {a.fps}fps)\n")
    for k in ("OK", "SUPERSEDED", "RETRIMMED", "AMBIGUOUS", "MISSING"):
        if counts[k]:
            print(f"  {k:<11} {counts[k]}")
    ready = [e for e in plan if e.get("sourceIn") is not None]
    if ready:
        by_method = collections.Counter(e["method"].split(" (")[0] for e in ready)
        print("\nready to place (" + ", ".join(f"{n} by {k}" for k, n in by_method.most_common()) + "):")
        for e in ready:
            print(f"  {e['start']:6.2f}  {os.path.basename(e['graded'])[:40]:<40} "
                  f"sourceIn {e['sourceIn']:<7} {e['method']}")
    for k, label in (("RETRIMMED", "re-trimmed since grade — run find_offsets.py"),
                     ("AMBIGUOUS", "two graded exports, same round — disambiguate visually"),
                     ("SUPERSEDED", "multiple grade rounds — took the newest folder"),
                     ("MISSING", "no graded file")):
        rows = [e for e in plan if e["status"] == k]
        if rows:
            print(f"\n{label}:")
            for e in rows:
                print(f"  {e['start']:6.2f}  {os.path.basename(e['source'])}")
    warned = [e for e in plan if e.get("warnings")]
    if warned:
        print(f"\ntimecode contradictions ({len(warned)}) — not necessarily wrong, worth a look:")
        for e in warned:
            for w in e["warnings"]:
                print(f"  {e['start']:6.2f}  {os.path.basename(e['source'])}: {w}")
    print(f"\n-> {a.out}")


if __name__ == "__main__":
    main()
