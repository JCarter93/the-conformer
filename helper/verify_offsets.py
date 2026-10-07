#!/usr/bin/env python3
"""
Check a conform plan against the picture before anything is placed.

`plan_conform.py` derives each cut's `sourceIn` from timecode (exact, but it
trusts that the grade preserved source TC) or from handle arithmetic (an
assumption about the grading house). This script asks the only question that
actually matters: **does the frame the offline shows at this cut appear at that
offset in the graded file?**

WHY THE REFERENCE FRAMES COME FROM PREMIERE, NOT THE RUSHES
    ffmpeg cannot decode ProRes RAW - no decoder, and it fails as "Invalid
    argument" with zero bytes out, which reads like a broken command rather
    than an unsupported codec. The rushes on the job it was built on are 8K prores_raw, so
    matching against camera originals is simply not available. Premiere decodes
    them natively, so the panel renders the reference frames itself
    (Exporter.exportSequenceFrame on the offline sequence) and this script
    matches those against the graded export, which is ordinary ProRes and
    decodes fine.

WHAT IT CATCHES THAT NOTHING ELSE DOES
    - a timecode that looks plausible and is wrong (a re-graded file, a wrong
      match, a session TC that happens to fall in range)
    - TIME REMAPPING, which the Premiere API cannot see at all: a ramped clip
      shows up here as a match that slides steadily across the probes. Constant
      speed changes are caught by getSpeed(); ramps are not, and this is the
      only signal for them.

  python verify_offsets.py --kit <folder written by the panel> --out verdicts.json

The kit folder holds manifest.json plus the rendered reference PNGs.
"""
import argparse, concurrent.futures as cf, json, os, subprocess, sys
import numpy as np

W, H = 64, 36


def gray(ffmpeg, path, start=None, dur=None, fps=25.0, crop=None):
    """Downscaled luma. Greyscale structure survives grading; colour is exactly
    what changed, so matching on RGB would be matching on the difference.

    `crop` is a fraction in (0,1] applied centred before scaling, to undo a
    punch-in: the offline shows a crop of what the graded file holds, so
    without this a reframed shot simply does not correlate with its own grade.
    """
    out, err = gray_many(ffmpeg, path, [crop], start, dur, fps)
    return out[0], err


def gray_many(ffmpeg, path, crops, start=None, dur=None, fps=25.0):
    """
    The same window, decoded ONCE, returned at several framings.

    Full frame and punch-in used to be two ffmpeg runs over the identical
    window of the identical file, differing only by a crop in the filter
    chain - and on 8K ProRes over the network the decode is almost all of the
    cost, so that doubled the bill to learn nothing new. ffmpeg can split the
    decoded stream, run both chains itself, and stack the results into one tall
    frame that comes back through the single pipe rawvideo already gives us.

    Each branch runs the SAME crop-then-scale chain it ran when it had a
    process to itself, so no number here changes - this is the same arithmetic
    with half the file opens.
    """
    crops = list(crops) if crops else [None]
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error"]
    if start is not None:
        cmd += ["-ss", str(max(0, start))]
    cmd += ["-i", path]
    if dur is not None:
        cmd += ["-t", str(dur)]

    def branch(c):
        chain = ""
        if c and 0 < c < 0.999:
            chain += "crop=iw*%.6f:ih*%.6f," % (c, c)
        return chain + "scale=%d:%d,format=gray" % (W, H)

    if len(crops) == 1:
        cmd += ["-vf", "fps=%s,%s" % (fps, branch(crops[0]))]
    else:
        n = len(crops)
        graph = "[0:v]fps=%s,split=%d%s;" % (fps, n, "".join("[b%d]" % i for i in range(n)))
        graph += ";".join("[b%d]%s[s%d]" % (i, branch(c), i) for i, c in enumerate(crops))
        graph += ";" + "".join("[s%d]" % i for i in range(n)) + "vstack=inputs=%d[out]" % n
        cmd += ["-filter_complex", graph, "-map", "[out]"]
    cmd += ["-f", "rawvideo", "-"]

    r = subprocess.run(cmd, capture_output=True)
    buf = np.frombuffer(r.stdout, dtype=np.uint8)
    stride = W * H * len(crops)
    n_frames = len(buf) // stride
    if n_frames == 0:
        return ([np.zeros((0, W * H), dtype=np.float32) for _ in crops],
                r.stderr.decode("utf8", "replace")[-200:])
    # Each decoded frame arrives as the framings stacked vertically: rows
    # 0..H-1 are the first crop, H..2H-1 the second, and so on.
    block = buf[:n_frames * stride].reshape(n_frames, len(crops), H, W).astype(np.float32)
    return [block[:, i, :, :].reshape(n_frames, W * H) for i in range(len(crops))], ""


def is_blank(img):
    """
    A reference frame with no picture in it.

    A blank frame correlates with nothing, so it reports as "nothing matched" -
    indistinguishable from genuinely hard footage. But it means something quite
    different: the track was hidden when the frame rendered, which is a bug in
    the caller, not a property of the shot. Measured: a 4 KB PNG against ~330 KB
    for a real frame.
    """
    return float(np.std(img)) < 1.0


def nm(x):
    x = x - x.mean(-1, keepdims=True)
    return x / (np.linalg.norm(x, axis=-1, keepdims=True) + 1e-6)


_INFO = {}


def media_info(ffprobe, path):
    """Duration and pixel size, in one launch, remembered.

    These were two ffprobe launches each, repeated for every candidate and for
    every cut that shares a graded file. Over the network a launch costs far
    more than the answer it returns.
    """
    hit = _INFO.get(path)
    if hit is not None:
        return hit
    r = subprocess.run([ffprobe, "-v", "error", "-select_streams", "v:0",
                        "-show_entries", "stream=width,height:format=duration",
                        "-of", "json", path], capture_output=True, text=True)
    dur = w = h = None
    try:
        doc = json.loads(r.stdout)
        stream = (doc.get("streams") or [{}])[0]
        w = int(stream["width"]) if stream.get("width") else None
        h = int(stream["height"]) if stream.get("height") else None
        dur = float(doc.get("format", {}).get("duration"))
    except Exception:
        pass
    _INFO[path] = (dur, w, h)
    return dur, w, h


def probe_duration(ffprobe, path):
    """A file's duration in seconds, for working out an ambiguous candidate's
    valid offset range without the plan having told us."""
    return media_info(ffprobe, path)[0]


def probe_size(ffprobe, path):
    """The graded file's pixel size, for working out what 'fit' means."""
    return media_info(ffprobe, path)[1], media_info(ffprobe, path)[2]


def crop_for_reframe(reframe, seq_w, seq_h, src_w, src_h):
    """
    How much of the graded frame the offline was actually showing.

    Premiere's Scale is a percentage of the source's own pixels, so a clip
    "fits" the sequence at fit = min(seqW/srcW, seqH/srcH) * 100 - for 8K
    footage in a 1080 sequence, 25. Anything above that is a punch-in, and the
    offline reference frame is a centred crop of fit/scale of the graded frame.

    Measured: a clip at Scale 27 where fit was 25 scored 0.47 against its own
    graded export, while clips at exactly 25 on the same track scored 0.95+.
    An 8% punch-in is enough to stop a shot matching itself.

    **This is a CANDIDATE, not an answer.** Premiere's "Scale to Frame Size"
    makes a fitted clip report Scale 100 as well, and nothing in the API says
    which meaning is in play - measured, a clip reading Scale 100 was fitted,
    not punched in 4x, and cropping to the implied 25% took it from a 0.93
    match to no match at all. So the caller tries both framings and keeps
    whichever actually matches the picture.

    Returns (crop_fraction, note). Off-centre reframes are NOT compensated -
    the crop would have to move with the position, and a wrong compensation
    would be worse than none - so they are reported instead.
    """
    if not reframe or not seq_w or not src_w:
        return None, None
    scale = reframe.get("Scale", {}).get("value")
    position = reframe.get("Position", {}).get("value")
    if not isinstance(scale, (int, float)):
        return None, None
    if reframe.get("Scale", {}).get("keyframed"):
        return None, "the punch-in is animated, so no single crop matches the whole cut"
    fit = min(float(seq_w) / src_w, float(seq_h) / src_h) * 100.0
    if scale <= fit + 0.01:
        return None, None                    # no punch-in, nothing to undo
    if isinstance(position, (list, tuple)) and len(position) >= 2:
        if abs(position[0] - 0.5) > 0.01 or abs(position[1] - 0.5) > 0.01:
            return None, ("the shot is reframed off-centre (position %.2f, %.2f), which this "
                          "check cannot undo - a low score here is expected"
                          % (position[0], position[1]))
    return fit / float(scale), ("compensated for a %.0f%% punch-in" % (scale / fit * 100 - 100))


def static_fraction(cand):
    """
    How self-similar the graded file is across its own valid range.

    A locked-off shot defeats matching because every frame correlates with
    every other - but it also does not NEED matching, since any offset shows
    the same picture. Reporting that as a failure sends an editor hunting for a
    problem that does not exist.
    """
    if len(cand) < 2:
        return 0.0
    n = nm(cand)
    sims = n @ n[0]
    return float((sims > 0.98).mean())


def resolve_candidates(clip, a, fps, frame):
    """
    Which candidate is this cut, and where does it sit in it?

    Every candidate is matched against the same reference frames. A winner has
    to beat the runner-up clearly - a narrow win between two exports of the
    same shot is not evidence, it is noise, and placing the wrong one would be
    the exact silent failure this tool exists to avoid.
    """
    row = {"key": clip["key"], "start": clip.get("start"), "name": "(ambiguous)",
           "planned": None, "method": "candidate bake-off", "probes": [], "candidates": []}

    refs = []
    for ref in clip.get("refs", []):
        path = os.path.join(a.kit, ref["file"])
        if not os.path.exists(path):
            continue
        img, _ = gray(a.ffmpeg, path, fps=fps)
        if not len(img):
            continue
        if is_blank(img[0]):
            row.setdefault("blankFrames", 0)
            row["blankFrames"] += 1
            continue
        refs.append((float(ref["probe"]), img))
    if not refs:
        row["verdict"] = "inconclusive"
        row["note"] = ("every reference frame for this cut is blank - the track was hidden when "
                       "they rendered, so nothing could be compared"
                       if row.get("blankFrames") else
                       "no reference frames were rendered for this cut")
        return row

    # Identical frames are one vote, not two - see the main loop.
    unique = []
    for probe_t, img in refs:
        if not any(float(nm(img)[0] @ nm(kept)[0]) > 0.999 for _, kept in unique):
            unique.append((probe_t, img))
    refs = unique

    cut = float(clip.get("dur") or 0)
    results = []
    # Kept alongside, keyed by file, so the winner can be checked for DRIFT
    # without an internal field leaking into the report.
    votes_by_file = {}
    for path in clip["candidates"]:
        entry = {"file": os.path.basename(path), "path": path}
        dur = probe_duration(a.ffprobe, path)
        entry["duration"] = round(dur, 3) if dur else None
        if not dur or dur + frame < cut:
            entry["skipped"] = "too short to hold this cut"
            results.append(entry)
            continue
        room = max(0.0, dur - cut)
        span = room + (max(t for t, _ in refs) if refs else 0) + frame * 2
        src_w, src_h = probe_size(a.ffprobe, path)
        crop, _note = crop_for_reframe(clip.get("reframe"), None, None, src_w, src_h)

        framings = [("full frame", None)]
        if crop is not None:
            framings.append(("punch-in", crop))
        decoded, _err = gray_many(a.ffmpeg, path, [f for _, f in framings], 0, span, fps)

        best_overall = None
        for (framing, _factor), cand in zip(framings, decoded):
            if len(cand) < 2:
                continue
            votes, top = [], -1.0
            for probe_t, img in refs:
                sims = nm(cand) @ nm(img)[0]
                b = int(np.argmax(sims))
                score = float(sims[b])
                top = max(top, score)
                if score >= a.min_score:
                    votes.append((probe_t, b / fps - probe_t))
            if best_overall is None or (len(votes), top) > (len(best_overall["votes"]), best_overall["top"]):
                best_overall = {"framing": framing, "votes": votes, "top": top}
        if best_overall:
            votes_by_file[path] = best_overall["votes"]
            entry["framing"] = best_overall["framing"]
            entry["bestScore"] = round(best_overall["top"], 4)
            entry["votes"] = len(best_overall["votes"])
            if best_overall["votes"]:
                offset = float(np.median([o for _, o in best_overall["votes"]]))
                entry["offset"] = round(offset, 4)
                # An offset that cannot physically be right disqualifies the
                # candidate however well it scored. Two exports of one shot look
                # alike, so scores alone can sit within a few points of each
                # other - measured, 0.93 against 0.89 - while one of them puts
                # the cut BEFORE the file starts. That is not a close call, it
                # is an impossible one.
                if offset < -frame:
                    entry["impossible"] = ("the cut would start %.2fs before this file does" % -offset)
                    entry.pop("offset", None)
                    entry["bestScore"] = None
                elif offset + cut > dur + frame:
                    entry["impossible"] = ("the cut would run %.2fs past the end of this file"
                                           % (offset + cut - dur))
                    entry.pop("offset", None)
                    entry["bestScore"] = None
        results.append(entry)

    row["candidates"] = results
    scored = [r for r in results if r.get("bestScore") is not None]
    scored.sort(key=lambda r: (r.get("votes", 0), r["bestScore"]), reverse=True)
    if not scored or scored[0].get("offset") is None:
        row["verdict"] = "inconclusive"
        row["note"] = "no candidate matched the picture well enough to choose between them"
        return row

    winner = scored[0]
    runner = scored[1] if len(scored) > 1 else None
    margin = winner["bestScore"] - (runner["bestScore"] if runner else 0.0)
    row["margin"] = round(margin, 4)
    if winner["bestScore"] < a.min_score:
        row["verdict"] = "inconclusive"
        row["note"] = "the best candidate only scored %.2f - not enough to choose on" % winner["bestScore"]
        return row
    if runner is not None and margin < a.candidate_margin:
        row["verdict"] = "inconclusive"
        row["note"] = ("%s and %s match almost equally well (%.2f vs %.2f) - too close to call, "
                       "so neither is placed" % (winner["file"], runner["file"],
                                                 winner["bestScore"], runner["bestScore"]))
        return row

    # THE WINNER STILL HAS TO NOT BE RETIMED.
    #
    # This path only ever answered "which file"; the drift check lived in the
    # single-candidate path, so an AMBIGUOUS cut was placed without anyone
    # asking whether the match slid across it. Measured on a real job: a cut
    # resolved here at 0.95 was refused as retimed the moment the same file was
    # pinned by hand and went through the other path. Three of eleven cuts were
    # going in unchecked.
    votes = votes_by_file.get(winner["path"]) or []
    times = [t for t, _ in votes]
    offsets = [o for _, o in votes]
    if len(votes) >= 2 and max(times) - min(times) > 1e-6:
        slope = float(np.polyfit(times, offsets, 1)[0])
        row["driftPerSecond"] = round(slope, 4)
        row["spread"] = round(max(offsets) - min(offsets), 4)
        if abs(slope) > a.drift_per_second:
            row["verdict"] = "retimed"
            row["name"] = winner["file"]
            row["measured"] = winner["offset"]
            row["note"] = ("%s matched at %.2f, but the match slides %.1f%% across the cut - this "
                           "clip is retimed, and a graded replacement would play at 100%% and "
                           "drift against picture"
                           % (winner["file"], winner["bestScore"], slope * 100))
            return row

    row["verdict"] = "resolved"
    row["name"] = winner["file"]
    row["chosenGraded"] = winner["path"]
    row["chosenDur"] = winner["duration"]
    row["measured"] = winner["offset"]
    row["score"] = winner["bestScore"]
    # Say WHY the others lost: a rival that scored badly and a rival that was
    # impossible are different kinds of answer, and the second is the stronger.
    others = [r for r in results if r is not winner]
    if runner is not None:
        row["note"] = ("the picture chose %s over %s (%.2f vs %.2f)"
                       % (winner["file"], runner["file"], winner["bestScore"], runner["bestScore"]))
    elif others:
        why = others[0].get("impossible") or others[0].get("skipped") or "did not match"
        row["note"] = ("%s is the only candidate that can be right - %s %s (it matched at %.2f)"
                       % (winner["file"], others[0]["file"], why, winner["bestScore"]))
    else:
        row["note"] = "%s matched at %.2f" % (winner["file"], winner["bestScore"])
    return row


def verify_clip(clip, a, fps, frame, tol, manifest):
    """
    One cut, checked against the picture.

    Split out of main() so the clips can be checked CONCURRENTLY. Each clip
    reads its own reference frames and its own graded file and shares nothing
    mutable, and nearly all of its wall time is spent waiting on an ffmpeg
    process - so threads, which do not have to pickle a manifest out to a
    worker, are the right shape for it.
    """
    row = {"key": clip["key"], "start": clip.get("start"), "name": os.path.basename(clip["graded"]),
           "planned": clip.get("sourceIn"), "method": clip.get("method"), "probes": []}
    room = float(clip.get("room") or 0.0)
    probe_times = [float(r["probe"]) for r in clip.get("refs", [])]
    span = room + (max(probe_times) if probe_times else 0.0) + frame * 2

    # The offline may be showing a punch-in, in which case its frame is a
    # crop of what the graded file holds. Scale alone cannot say - "Scale
    # to Frame Size" makes a fitted clip read 100 too - so BOTH framings
    # are tried and the one that actually matches the picture wins. The
    # offset is what matters here, not the framing.
    src_w, src_h = probe_size(a.ffprobe, clip["graded"])
    crop, crop_note = crop_for_reframe(clip.get("reframe"), manifest.get("sequenceWidth"),
                                       manifest.get("sequenceHeight"), src_w, src_h)
    if crop_note:
        row["reframeNote"] = crop_note

    # Load every reference frame once; they are the same whichever framing
    # the graded file is compared at.
    refs = []
    for ref in clip.get("refs", []):
        path = os.path.join(a.kit, ref["file"])
        if not os.path.exists(path):
            row["probes"].append({"probe": float(ref["probe"]), "error": "missing reference frame"})
            continue
        refimg, referr = gray(a.ffmpeg, path, fps=fps)
        if not len(refimg):
            row["probes"].append({"probe": float(ref["probe"]),
                                  "error": "could not decode the reference frame" +
                                           (": " + referr if referr else "")})
            continue
        if is_blank(refimg[0]):
            row["probes"].append({"probe": float(ref["probe"]),
                                  "error": "the reference frame is blank - the track was "
                                           "probably hidden when it rendered"})
            continue
        refs.append((float(ref["probe"]), refimg))

    # DE-DUPLICATE the probes before they vote.
    #
    # Two probes can render the identical frame - measured, byte-identical
    # PNGs at +0.12s and +0.48s of a 15.9s shot, reproducibly, because the
    # head of that shot is held. Two identical frames are not two votes,
    # they are one vote counted twice, and the whole "two probes must
    # agree" rule rests on them being independent.
    unique = []
    duplicates = 0
    for probe_t, refimg in refs:
        twin = None
        for kept_t, kept_img in unique:
            if float(nm(refimg)[0] @ nm(kept_img)[0]) > 0.999:
                twin = kept_t
                break
        if twin is None:
            unique.append((probe_t, refimg))
        else:
            duplicates += 1
    if duplicates:
        row["duplicateProbes"] = duplicates
        row.setdefault("notes", []).append(
            "%d probe(s) rendered the same frame as another and were counted once" % duplicates)
    refs = unique
    if not refs:
        # Without this the loop below never runs and the verdict blamed the
        # GRADED file ("could not decode the graded file: ") for frames that
        # were never rendered - which sent the first Premiere 2025 run looking
        # at the wrong half of the pipeline.
        row["verdict"] = "inconclusive"
        row["note"] = "no reference frames were rendered for this cut - nothing to compare against"
        return row

    # Decode a WINDOW PER PROBE, not one span from the file's start.
    #
    # The cut sits at some offset s in [0, room], so a probe at cut time t
    # matches graded time t + s: a window of [t, t + room] is all that has
    # ever needed decoding. Reading from zero instead made a late probe
    # cost the whole file, which is why probes were once crammed into the
    # first second - and clustered probes then agreed on the wrong framing.
    # ONE DECODE PER PROBE, BOTH FRAMINGS.
    #
    # Full frame and punch-in ask about the SAME window of the SAME file and
    # differ only by a crop, so decoding twice bought nothing - and on 8K
    # ProRes over the network the decode is nearly all of the cost. ffmpeg
    # applies both chains to a single decode instead. The comparisons below are
    # unchanged; only the number of times the file is opened is.
    framings = [("full frame", None)]
    if crop is not None:
        framings.append(("punch-in", crop))
    window = room + frame * 2
    per = {name: {"framing": name, "probes": [], "votes": [], "best": -1.0, "cand": None}
           for name, _ in framings}
    for probe_t, refimg in refs:
        decoded, _err = gray_many(a.ffmpeg, clip["graded"], [f for _, f in framings],
                                  probe_t, window, fps)
        for (name, _factor), cand in zip(framings, decoded):
            slot = per[name]
            if len(cand) < 1:
                slot["probes"].append({"probe": probe_t,
                                       "error": "could not decode the graded file here"})
                continue
            # Keep the last frames that actually decoded, not merely the last
            # ones attempted - static_fraction reads these, and measuring the
            # self-similarity of an empty array said nothing useful.
            slot["cand"] = cand
            sims = nm(cand) @ nm(refimg)[0]
            best = int(np.argmax(sims))
            score = float(sims[best])
            offset = best / fps
            slot["probes"].append({"probe": probe_t, "offset": round(offset, 4),
                                   "score": round(score, 4)})
            slot["best"] = max(slot["best"], score)
            if score >= a.min_score:
                slot["votes"].append((probe_t, offset))
    attempts = [per[name] for name, _ in framings]

    usable = [x for x in attempts if x.get("cand") is not None]
    if not usable:
        row["verdict"] = "inconclusive"
        row["note"] = "could not decode the graded file" + (
            ": " + (attempts[0].get("error") or "") if attempts else "")
        return row

    # Most votes wins; a tie goes to the higher-scoring framing.
    chosen = sorted(usable, key=lambda x: (len(x["votes"]), x["best"]))[-1]
    row["framing"] = chosen["framing"]
    if len(usable) > 1:
        row["framingTried"] = {x["framing"]: round(x["best"], 4) for x in usable}
    if chosen["framing"] == "punch-in":
        row["crop"] = round(crop, 4)
    row["probes"].extend(chosen["probes"])
    votes = chosen["votes"]
    cand = chosen["cand"]

    stat = static_fraction(cand)
    row["staticFraction"] = round(stat, 3)

    # A static shot needs no verification: every offset shows the same
    # picture, so agreement proves nothing and disagreement means nothing.
    # Where the graded file IS the cut there is only one offset it can
    # have, so "static" (every frame looks alike) would be a confusing way
    # to report a forced answer.
    if room <= frame:
        row["verdict"] = "confirmed"
        row["measured"] = 0.0
        row.setdefault("notes", []).append(
            "the graded file is exactly the cut, so the offset can only be 0")
        return row

    if stat > 0.80:
        row["verdict"] = "static"
        row["note"] = ("the graded file is %d%% self-similar - a locked-off shot, so any "
                       "offset shows the same picture and the plan's is as good as any"
                       % round(stat * 100))
        return row

    if len(votes) < 2:
        # One strong probe is not enough to DECIDE an offset - a single
        # frame can hit a false match, which is why two must agree - but a
        # high-confidence probe that lands exactly on the plan's answer is
        # real corroboration, and saying so is more useful than filing it
        # with the clips nothing could tell you about.
        single = max(
            ((p_["score"], p_["offset"]) for p_ in chosen["probes"] if "score" in p_),
            default=(0.0, None))
        planned = clip.get("sourceIn")
        if (len(votes) == 1 and single[0] >= 0.90 and stat <= 0.80
                and isinstance(planned, (int, float))
                and abs(single[1] - float(planned)) <= tol):
            row["verdict"] = "corroborated"
            row["measured"] = round(single[1], 4)
            row["note"] = ("one probe matched strongly (%.2f) and agrees with the plan; "
                           "the others could not match" % single[0])
        else:
            row["verdict"] = "inconclusive"
            row["note"] = "fewer than two probes matched confidently - nothing was proved either way"
        return row

    offsets = [o for _, o in votes]
    measured = float(np.median(offsets))
    spread = max(offsets) - min(offsets)
    row["measured"] = round(measured, 4)
    row["spread"] = round(spread, 4)

    # Drift: the same shot matched later and later (or earlier and earlier)
    # as the probe moves through the cut. That is a speed change, and a
    # ramped one is invisible to getSpeed().
    times = [t for t, _ in votes]
    if max(times) - min(times) > 1e-6:
        slope = float(np.polyfit(times, offsets, 1)[0])
        row["driftPerSecond"] = round(slope, 4)
        if abs(slope) > a.drift_per_second:
            row["verdict"] = "retimed"
            row["note"] = ("the match slides %.1f%% across the cut - this clip is retimed, and "
                           "a graded replacement would play at 100%% and drift against picture"
                           % (slope * 100))
            return row

    if spread > 2 * tol:
        row["verdict"] = "inconclusive"
        row["note"] = ("probes disagree by %.2fs - a coin toss dressed as certainty, so it is "
                       "not usable either way" % spread)
    elif clip.get("sourceIn") is None:
        row["verdict"] = "measured"
        row["note"] = "the plan had no offset; this one came from the picture"
    elif abs(measured - float(clip["sourceIn"])) <= tol:
        row["verdict"] = "confirmed"
    else:
        row["verdict"] = "disputed"
        row["note"] = ("the picture puts the cut at %.3fs, the plan says %.3fs - %.1f frames apart"
                       % (measured, float(clip["sourceIn"]),
                          abs(measured - float(clip["sourceIn"])) * fps))
    return row


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--kit", required=True, help="folder holding manifest.json and the reference PNGs")
    ap.add_argument("--out", default=None, help="default: <kit>/verdicts.json")
    ap.add_argument("--ffmpeg", default="ffmpeg", help="ffmpeg binary (the helper passes its own)")
    ap.add_argument("--ffprobe", default="ffprobe", help="ffprobe binary (the helper passes its own)")
    ap.add_argument("--min-score", type=float, default=0.60,
                    help="a probe scoring below this is not counted as a vote")
    ap.add_argument("--tolerance-frames", type=float, default=1.0,
                    help="how far the measured offset may sit from the plan's and still confirm it")
    ap.add_argument("--candidate-margin", type=float, default=0.15,
                    help="how far ahead the winning candidate must be before an ambiguous cut is "
                         "resolved; a narrow win between two exports of one shot is noise")
    ap.add_argument("--jobs", type=int, default=6,
                    help="how many clips to check at once; the time is file opens and process "
                         "startup, not arithmetic, so these overlap well. 1 to check in order")
    ap.add_argument("--drift-per-second", type=float, default=0.02,
                    help="offset sliding faster than this across the probes means the clip is "
                         "retimed - a ramp the Premiere API cannot report at all")
    a = ap.parse_args()

    manifest_path = os.path.join(a.kit, "manifest.json")
    if not os.path.exists(manifest_path):
        sys.exit("No manifest.json in %s - render the reference frames from the panel first." % a.kit)
    manifest = json.load(open(manifest_path))
    fps = float(manifest.get("fps") or 25.0)
    frame = 1.0 / fps
    tol = a.tolerance_frames * frame

    clips = manifest.get("clips", [])

    def verdict_for(clip):
        # An AMBIGUOUS cut arrives with several candidate files and no offset.
        # The candidates are different shots, so the offline's own frame can say
        # which one belongs here - better evidence than the filename, whose
        # DaVinci prefix encodes the TRACK at grade time and points at the wrong
        # export once a timeline has been rearranged.
        if clip.get("candidates") and not clip.get("graded"):
            return resolve_candidates(clip, a, fps, frame)
        return verify_clip(clip, a, fps, frame, tol, manifest)

    # CHECK THE CLIPS CONCURRENTLY.
    #
    # Measured on an 11-clip, 4-track job: ~113 ffmpeg/ffprobe launches, each
    # opening a large ProRes file over the network to read a handful of frames.
    # The correlations themselves are on 64x36 greyscale and cost nothing - the
    # time is process startup and file opens, which is exactly the kind of wait
    # that overlaps. The clips are independent, so this changes no arithmetic;
    # map() keeps the results in manifest order.
    if a.jobs > 1 and len(clips) > 1:
        with cf.ThreadPoolExecutor(max_workers=a.jobs) as pool:
            verdicts = list(pool.map(verdict_for, clips))
    else:
        verdicts = [verdict_for(c) for c in clips]

    out_path = a.out or os.path.join(a.kit, "verdicts.json")
    json.dump({"fps": fps, "verdicts": verdicts}, open(out_path, "w"), indent=1)

    order = ["confirmed", "corroborated", "resolved", "static", "measured", "disputed", "retimed", "inconclusive"]
    counts = {k: 0 for k in order}
    for v in verdicts:
        counts[v["verdict"]] = counts.get(v["verdict"], 0) + 1
    print("checked %d clips against the picture\n" % len(verdicts))
    for k in order:
        if counts.get(k):
            print("  %-13s %d" % (k, counts[k]))
    for k in ("disputed", "retimed", "inconclusive"):
        rows = [v for v in verdicts if v["verdict"] == k]
        if not rows:
            continue
        print("\n%s:" % k)
        for v in rows:
            print("  %6.2f  %-42s %s" % (v.get("start") or 0, v["name"][:42], v.get("note", "")))
    print("\n-> %s" % out_path)


if __name__ == "__main__":
    main()
