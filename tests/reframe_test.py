"""
Off-centre and vertical reframes are checked on the part of the shot on screen.

A 16:9 shot reframed for a 9:16 cut shows a tall slice of the source, often
not the middle one. The verifier only knew a CENTRED crop of the same shape as
the source, so it compared the whole 16:9 graded frame against a 9:16
reference and scored ~0.3 - every reframed shot on a vertical cut came back
"inconclusive", right offset or wrong.

The geometry is checked first (pure), then end to end: a tiny moving rush is
placed off-centre in a 9:16 frame exactly as Motion would place it, the
references are rendered from that, and the real verify_offsets.py has to
confirm the right offset, dispute a wrong one, and still try nothing new on an
ordinary 16:9 job. Skips the end-to-end half if there is no ffmpeg.

Run: python3 tests/reframe_test.py   (scripts/run-tests.sh runs it too)
"""
import json, os, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "helper"))
import verify_offsets as V  # noqa: E402
import conform_helper as H  # noqa: E402  (for its ffmpeg search)

failed = 0
def ok(cond, label):
    global failed
    if not cond:
        failed += 1
        print("FAIL  " + label)

def close(a, b, tol=0.002):
    return a is not None and b is not None and all(abs(p - q) < tol for p, q in zip(a, b))

def motion(pos, scale, rotation=0, keyframed=False):
    return {"Position": {"value": list(pos), "keyframed": keyframed},
            "Scale": {"value": scale, "keyframed": False},
            "Anchor Point": {"value": [0.5, 0.5], "keyframed": False},
            "Rotation": {"value": rotation, "keyframed": False}}

FILL = 1920 / 2160 * 100   # a 3840x2160 shot filling the height of 1080x1920

# --- geometry ---------------------------------------------------------------

# Centred: the middle 1080/3413 of the width, all of the height, all of the frame.
win, note = V.placed_window(motion((0.5, 0.5), FILL), 1080, 1920, 3840, 2160)
w = 1080 / (3840 * FILL / 100)
ok(close(win[0], (0.5 - w / 2, 0, 0.5 + w / 2, 1)), "centred 9x16: the middle slice of the source (%s)" % (win,))
ok(close(win[1], (0, 0, 1, 1)), "and the whole of the frame")
ok("1080x1920" in (note or ""), "and says it compared the part the frame shows (%s)" % note)

# Off-centre: Position 0.213 puts the source centre 230px from the left, so the
# frame shows source x from 1920 - 230/k to 1920 + 850/k.
k = FILL / 100
win, note = V.placed_window(motion((0.213, 0.5), FILL), 1080, 1920, 3840, 2160)
ok(close(win[0], ((1920 - 0.213 * 1080 / k) / 3840, 0, (1920 + (1 - 0.213) * 1080 / k) / 3840, 1)),
   "off-centre: the slice moves with Position (%s)" % (win,))
ok("off-centre" in (note or ""), "and says so (%s)" % note)

# Position 1.095 at Scale 100, as on the real cut: native 4K is so much wider
# than the frame that it still covers all of it, just from further right.
win, _ = V.placed_window(motion((1.095, 0.5), 100), 1080, 1920, 3840, 2160)
ok(win is not None and close(win[1], (0, 0, 1, 1)) and
   close((win[0][0], win[0][2]), ((1920 - 1.095 * 1080) / 3840, (1920 + (1 - 1.095) * 1080) / 3840)),
   "pushed right at Scale 100: still fills the frame, from further along the source (%s)" % (win,))

# Pushed far enough that the frame's left side is black: both sides are cut
# back to the part with picture in it.
win, _ = V.placed_window(motion((2.0, 0.5), FILL), 1080, 1920, 3840, 2160)
edge = (2.0 * 1080 - 3840 * k / 2) / 1080
ok(win is not None and close(win[1], (edge, 0, 1, 1)), "pushed off the edge: only the frame's right part (%s)" % (win,))
ok(win is not None and close((win[0][0], win[0][2]), (0, (1920 - 1080 / k) / 3840)),
   "holds only the source's left part (%s)" % (win,))

# Things it must not pretend to undo.
ok(V.placed_window(motion((0.3, 0.5), FILL, keyframed=True), 1080, 1920, 3840, 2160)[0] is None,
   "animated framing: no single window")
win, note = V.placed_window(motion((0.3, 0.5), FILL, rotation=12), 1080, 1920, 3840, 2160)
ok(win is None and "rotated" in note, "a real rotation is refused, and said")
ok(V.placed_window(motion((0.575, 0.5), 100, rotation=-0.5), 1080, 1920, 3840, 2160)[0] is not None,
   "a half-degree levelling tilt is not (measured on a real cut)")
ok(V.placed_window(motion((3.0, 0.5), 100), 1080, 1920, 3840, 2160)[0] is None, "a shot pushed out of frame")

# Premiere fits the sequence into the size it is asked to render at: a 9:16
# frame rendered at 640x360 is a centred 202.5px strip.
box = V.picture_box(640, 360, 1080, 1920)
ok(close(box, ((1 - 202.5 / 640) / 2, 0, (1 + 202.5 / 640) / 2, 1)), "9:16 at 640x360: the middle strip (%s)" % (box,))
ok(V.picture_box(360, 640, 1080, 1920) == V.FULL, "9:16 at 360x640: the whole image")
ok(V.picture_box(640, 360, 1920, 1080) == V.FULL, "16:9 at 640x360: the whole image, as before")
ok(close(V.within(box, (0.5, 0, 1, 1)), (0.5, 0, box[2], 1)), "a window of the frame lands inside the strip")

# A plain 16:9 job tries exactly what it always did.
names = lambda f: [n for n, _, _ in f]
ok(names(V.framings_for(motion((0.5, 0.5), 50), 1920, 1080, 3840, 2160)[0]) == ["full frame"],
   "16:9 fitted: full frame only")
ok(names(V.framings_for(motion((0.5, 0.5), 60), 1920, 1080, 3840, 2160)[0]) == ["full frame", "punch-in"],
   "16:9 centred punch-in: unchanged")
ok("as placed" in names(V.framings_for(motion((0.4, 0.5), 60), 1920, 1080, 3840, 2160)[0]),
   "16:9 off-centre punch-in: as placed is tried")
ok(names(V.framings_for(motion((0.5, 0.5), 100), 1080, 1920, 3840, 2160)[0])[-1] == "as placed, fitted",
   "Scale 100 on a vertical: Scale to Frame Size is tried too")

# --- end to end -------------------------------------------------------------

ffmpeg = H.find_tool("ffmpeg")
ffprobe = H.find_tool("ffprobe")
if not (ffmpeg and ffprobe):
    print(("FAILED " if failed else "ok ") + "%d failed (end to end skipped - no ffmpeg)" % failed)
    sys.exit(1 if failed else 0)

SW, SH, QW, QH = 640, 360, 180, 320            # source 16:9, sequence 9:16
SCALE, POS = QH / SH * 100, (0.2, 0.5)         # fill the height, pushed left
CUT_IN, HANDLE, DUR = 1.4, 0.4, 2.0            # rush 1.4-3.4, exported from 1.0

def run(cmd):
    subprocess.run(cmd, check=True, capture_output=True)

with tempfile.TemporaryDirectory() as tmp:
    rush = os.path.join(tmp, "rush.mov")
    run([ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=%dx%d:rate=25:duration=5" % (SW, SH),
         "-c:v", "mpeg4", "-q:v", "3", rush])
    graded = os.path.join(tmp, "V1-0001_rush.mov")
    run([ffmpeg, "-v", "error", "-y", "-ss", str(CUT_IN - HANDLE), "-i", rush, "-t", str(DUR + 2 * HANDLE),
         "-vf", "hue=h=35:s=1.6,eq=contrast=1.15", "-c:v", "mpeg4", "-q:v", "3", graded])

    # References as Premiere renders them: the rush scaled by Motion and laid
    # into a 180x320 frame at Position.
    k = SCALE / 100
    w, h = round(SW * k), round(SH * k)
    x, y = round(POS[0] * QW - w / 2), round(POS[1] * QH - h / 2)
    def render(pillarbox):
        """`pillarbox` renders the way Premiere 25.6.6 did when asked for a 16:9
        size: the 9:16 frame fitted into it, bars either side."""
        out = []
        for probe in (0.2, 0.8, 1.4):
            name = "ref_%s%d.png" % ("p" if pillarbox else "", round(probe * 1000))
            chain = ("[0:v]scale=%d:%d[s];color=black:s=%dx%d[bg];[bg][s]overlay=x=%d:y=%d:shortest=1"
                     % (w, h, QW, QH, x, y))
            if pillarbox:
                chain += ",scale=-2:180,pad=320:180:(ow-iw)/2:0:white"
            run([ffmpeg, "-v", "error", "-y", "-ss", "%.3f" % (CUT_IN + probe), "-i", rush, "-frames:v", "1",
                 "-filter_complex", chain, os.path.join(tmp, name)])
            out.append({"probe": probe, "file": name})
        return out

    refs = render(False)

    def verify(source_in, reframe, seq=(QW, QH)):
        clip = {"key": "c0", "start": 0, "dur": DUR, "graded": graded, "sourceIn": source_in,
                "room": 2 * HANDLE, "method": "timecode", "reframe": reframe,
                "sourceWidth": SW, "sourceHeight": SH, "refs": refs}
        json.dump({"fps": 25, "sequenceWidth": seq[0], "sequenceHeight": seq[1], "clips": [clip]},
                  open(os.path.join(tmp, "manifest.json"), "w"))
        subprocess.run([sys.executable, os.path.join(ROOT, "helper", "verify_offsets.py"), "--kit", tmp,
                        "--ffmpeg", ffmpeg, "--ffprobe", ffprobe, "--jobs", "1"], capture_output=True, check=True)
        return json.load(open(os.path.join(tmp, "verdicts.json")))["verdicts"][0]

    m = motion(POS, SCALE)
    right = verify(HANDLE, m)
    ok(right["verdict"] == "confirmed", "off-centre 9x16 at the right offset: confirmed (%s %s)"
       % (right["verdict"], right.get("note", "")))
    ok(right.get("framing") == "as placed", "on the as-placed framing (%s, tried %s)"
       % (right.get("framing"), right.get("framingTried")))
    ok(min(p["score"] for p in right["probes"]) > 0.9, "every probe matching strongly (%s)"
       % [p.get("score") for p in right["probes"]])

    wrong = verify(HANDLE + 0.2, m)
    ok(wrong["verdict"] == "disputed", "5 frames out: disputed, not waved through (%s)" % wrong["verdict"])
    ok(wrong.get("measured") is not None and abs(wrong["measured"] - HANDLE) < 0.021,
       "and the picture names the right offset (%s)" % wrong.get("measured"))

    # References as the first live run got them: pillarboxed into 16:9.
    refs = render(True)
    boxed = verify(HANDLE, m)
    ok(boxed["verdict"] == "confirmed" and boxed.get("framing") == "as placed",
       "pillarboxed references: still confirmed as placed (%s %s, %s)"
       % (boxed["verdict"], boxed.get("framing"), [p.get("score") for p in boxed["probes"]]))
    refs = render(False)

    # What the verifier did before it knew where the shot sat.
    blind = verify(HANDLE, None)
    ok(blind["verdict"] != "confirmed", "without the framing it cannot confirm it (%s, best %s)"
       % (blind["verdict"], max([p.get("score", -1) for p in blind["probes"]] or [None])))

print(("FAILED " if failed else "ok ") + "%d failed" % failed)
sys.exit(1 if failed else 0)
