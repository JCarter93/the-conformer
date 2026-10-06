#!/usr/bin/env python3
"""
Find where a re-trimmed cut sits inside its graded file, by frame matching.

Two rules make this trustworthy, and both were learned by getting it wrong:

1. CONSTRAIN THE SEARCH. The offset is not free — for a cut at source in-point
   `ci` lasting `cd`, from a graded file of length `gd`:

       offset must lie in [ ci + cd - gd , ci ]

   An unconstrained search returns confident-looking nonsense: it produced a
   negative sourceIn for one clip and a match past the end of file for another,
   both at >0.98 correlation. Searching only the valid range makes the score
   mean something.

2. MATCH ON GREYSCALE STRUCTURE, NOT COLOUR. The whole point is that the graded
   file looks different. Downscaled luma survives grading; RGB does not.

Multiple probe frames vote. If they disagree, or the score is low, the clip is
marked SKIP — leave it for the editor. A wrong frame silently in the timeline is
far worse than an unconformed clip that is clearly flagged.

A match pinned to the very edge of the valid range with a mediocre score is the
signature of a cut whose frames are NOT in the graded file at all.

  python find_offsets.py --plan plan.json --out plan_resolved.json
"""
import argparse, json, subprocess, sys
import numpy as np

W, H = 64, 36


def frames(ffmpeg, path, start, dur, fps):
    r = subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error",
                        "-ss", str(max(0, start)), "-i", path, "-t", str(dur),
                        "-vf", f"fps={fps},scale={W}:{H},format=gray",
                        "-f", "rawvideo", "-"], capture_output=True)
    a = np.frombuffer(r.stdout, dtype=np.uint8)
    n = len(a) // (W * H)
    return a[:n * W * H].reshape(n, W * H).astype(np.float32)


def nm(x):
    x = x - x.mean(-1, keepdims=True)
    return x / (np.linalg.norm(x, axis=-1, keepdims=True) + 1e-6)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--ffmpeg", default="ffmpeg", help="ffmpeg binary (the helper passes its own)")
    ap.add_argument("--fps", type=float, default=25.0)
    ap.add_argument("--min-score", type=float, default=0.90)
    ap.add_argument("--max-spread", type=float, default=0.12)
    a = ap.parse_args()
    step = 1.0 / a.fps

    plan = json.load(open(a.plan))
    # group by graded file: one file may serve several cuts, and their valid
    # ranges must intersect or the file cannot cover them all
    byfile = {}
    for e in plan:
        if e.get("status") == "RETRIMMED" and e.get("graded"):
            byfile.setdefault(e["graded"], []).append(e)

    for gf, uses in byfile.items():
        gd = uses[0]["gradedDur"]
        lo = max(u["in"] + u["dur"] - gd for u in uses)
        hi = min(u["in"] for u in uses)
        name = gf.rsplit("/", 1)[-1]
        if lo > hi + 1e-6:
            for u in uses:
                u["status"] = "SKIP"
                u["reason"] = (f"one graded file cannot cover all {len(uses)} cuts "
                               f"(needs {hi:.2f}..{lo:.2f}s, file is {gd:.2f}s)")
            print(f"{name:<44} IMPOSSIBLE — cannot cover {len(uses)} cuts")
            continue

        gt = frames(a.ffmpeg, gf, 0, gd, a.fps)
        cand = frames(a.ffmpeg, uses[0]["source"], lo - 0.6, (hi - lo) + 1.6, a.fps)
        if len(gt) == 0 or len(cand) < 3:
            for u in uses:
                u["status"] = "SKIP"; u["reason"] = "could not decode for matching"
            print(f"{name:<44} decode failed")
            continue
        # A locked-off shot cannot be matched — every frame correlates with every
        # other — but it also does not NEED matching: any offset shows the same
        # picture. Detect that before treating disagreement as danger.
        gn_all = nm(gt)
        self_sim = (gn_all @ gn_all[len(gn_all) // 2:len(gn_all) // 2 + 1].T).ravel()
        static_frac = float((self_sim > 0.98).mean())
        motion = float(np.abs(np.diff(gt, axis=0)).mean()) if len(gt) > 1 else 0.0
        if static_frac > 0.80 and motion < 1.0:
            mid = (lo + hi) / 2
            for u in uses:
                si = round(min(max(u["in"] - mid, 0.0), gd - u["dur"]), 3)
                u["sourceIn"] = si
                u["status"] = "OK"
                u["method"] = (f"static shot ({static_frac*100:.0f}% self-similar, "
                               f"motion {motion:.2f}/255) — any offset is equivalent")
            print(f"{name:<44} STATIC shot — offset immaterial, placed at {mid:.2f}")
            continue

        cn = nm(cand)
        votes = []
        for p in (0.20, 0.40, 0.60, 0.80, 1.00):
            gi = int(round(p * a.fps))
            if gi >= len(gt):
                continue
            sim = (cn @ nm(gt[gi:gi + 1]).T).ravel()
            j = int(np.argmax(sim))
            off = (lo - 0.6) + j * step - p
            votes.append((min(max(off, lo), hi), float(sim[j])))
        vals = [v for v, _ in votes]
        off = float(np.median(vals))
        spread = max(vals) - min(vals)
        score = float(np.median([s for _, s in votes]))
        edge = min(abs(off - lo), abs(off - hi)) < step
        good = score >= a.min_score and spread <= a.max_spread and not edge
        # Cross-check against plan_conform.py's embedded-timecode signal, when
        # it found one and it validated against the same offset range. This
        # doesn't change the outcome either way — a contradiction is worth a
        # human's attention, not a reason to silently prefer one signal over
        # the other, since a wrong-convention TC (session time rather than
        # source time) is entirely possible and looks identical to a genuine
        # mismatch from here.
        tc = uses[0].get("tcCheck")
        tc_note = ""
        if tc and tc.get("inRange"):
            tc_off = tc["impliedOffset"]
            agree = abs(off - tc_off) <= step * 2
            tc_note = f"  tc {'agrees' if agree else 'DISAGREES'} (implied {tc_off:.2f})"

        for u in uses:
            si = round(u["in"] - off, 3)
            if good and 0 <= si and si + u["dur"] <= gd + 1e-6:
                u["sourceIn"] = si
                u["status"] = "OK"
                u["method"] = f"frame match (score {score:.2f})"
                if tc_note:
                    u["method"] += tc_note.strip().replace("  ", " ")
            else:
                u["status"] = "SKIP"
                u["reason"] = (f"score {score:.2f}, spread {spread:.2f}"
                               + (", pinned to range edge — frames likely not in the graded file"
                                  if edge else ""))
        print(f"{name:<44} offset {off:7.2f} score {score:.2f} spread {spread:.2f} "
              f"{'OK' if good else 'SKIP'}{tc_note}")

    json.dump(plan, open(a.out, "w"), indent=1)
    ok = [e for e in plan if e.get("status") == "OK" and e.get("sourceIn") is not None]
    skip = [e for e in plan if e.get("status") in ("SKIP", "MISSING", "AMBIGUOUS")]
    print(f"\nplaceable: {len(ok)}   needs a human: {len(skip)}")
    for e in skip:
        print(f"  {e['start']:6.2f}  {e['source'].rsplit('/',1)[-1]:<34} "
              f"{e.get('reason', e['status'])}")
    print(f"\n-> {a.out}")


if __name__ == "__main__":
    main()
