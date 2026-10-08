"""
Two cuts from ONE rush: each gets its own candidates, and timecode settles them.

The planner put the same graded-file dicts into every cut that matched a rush
and then wrote each cut's offsets into them, so the last cut solved overwrote
the others - both cuts showed one identical list, right for one cut and wrong
for the other. And where the grade kept source timecode, which export holds
which cut was already decidable without the picture.

This builds real (tiny) media with real timecode - a 12s rush at 01:00:00:00
and two graded exports of different stretches of it - and runs the real
plan_conform.py. Skips if there is no ffmpeg beside the repo or on PATH.

Run: python3 tests/candidates_test.py   (scripts/run-tests.sh runs it too)
"""
import json, os, shutil, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "helper"))
import conform_helper as H  # noqa: E402  (for its ffmpeg search)

ffmpeg = H.find_tool("ffmpeg")
if not ffmpeg:
    print("ok (skipped - no ffmpeg)"); sys.exit(0)

failed = 0
def ok(cond, label):
    global failed
    if not cond:
        failed += 1
        print("FAIL  " + label)

def near(v, want):
    """0.0 is a real answer - never `v or default`, which turned it into a miss."""
    return v is not None and abs(v - want) < 0.021

def make(path, start, dur, tc):
    subprocess.run([ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i",
                    "testsrc2=size=320x180:rate=25:duration=%s" % dur, "-ss", "0",
                    "-c:v", "mpeg4", "-q:v", "5", "-timecode", tc, path], check=True)

with tempfile.TemporaryDirectory() as tmp:
    rush = os.path.join(tmp, "A001C003_RUSH.mov")
    make(rush, 0, 12, "01:00:00:00")
    graded = os.path.join(tmp, "graded", "261008"); os.makedirs(graded)
    # cut A: rush 1.00-3.00, exported with 10 frames of handle -> file covers 0.60-3.40
    make(os.path.join(graded, "V1-0001_A001C003_RUSH.mov"), 0, 2.8, "01:00:00:15")
    # cut B: rush 7.00-9.00, exported with no handles -> file covers 7.00-9.00
    make(os.path.join(graded, "V1-0002_A001C003_RUSH.mov"), 0, 2.0, "01:00:07:00")
    clips = [{"start": 0.0, "in": 1.0, "dur": 2.0, "source": rush, "trackIndex": 0},
             {"start": 2.0, "in": 7.0, "dur": 2.0, "source": rush, "trackIndex": 0}]
    json.dump(clips, open(os.path.join(tmp, "clips.json"), "w"))
    out = os.path.join(tmp, "plan.json")
    r = subprocess.run([sys.executable, os.path.join(ROOT, "helper", "plan_conform.py"), "--graded", os.path.join(tmp, "graded"),
                        "--clips", os.path.join(tmp, "clips.json"), "--out", out, "--fps", "25", "--ffmpeg", ffmpeg],
                       capture_output=True, text=True)
    ok(r.returncode == 0, "planner ran (%s)" % r.stderr[-300:])
    plan = json.load(open(out))
    a, b = plan[0], plan[1]

    # 1. Each cut has its OWN candidate objects and offsets.
    ok(a["candidates"] is not b["candidates"], "candidate lists are not the same object")
    ca = {h["name"]: h for h in a["candidates"]}
    cb = {h["name"]: h for h in b["candidates"]}
    ok(near(ca["V1-0001_A001C003_RUSH.mov"].get("sourceIn"), 0.40),
       "cut A's offset in V1-0001 is 0.40 (got %s)" % ca["V1-0001_A001C003_RUSH.mov"].get("sourceIn"))
    ok(near(cb["V1-0002_A001C003_RUSH.mov"].get("sourceIn"), 0.0),
       "cut B's offset in V1-0002 is 0.00 (got %s)" % cb["V1-0002_A001C003_RUSH.mov"].get("sourceIn"))

    # 2. Timecode excludes the other cut's file rather than inventing an offset in it.
    ok(ca["V1-0002_A001C003_RUSH.mov"].get("excludedByTimecode") is True, "V1-0002 is excluded for cut A")
    ok(ca["V1-0002_A001C003_RUSH.mov"].get("sourceIn") is None, "and carries no offset for cut A")
    ok(cb["V1-0001_A001C003_RUSH.mov"].get("excludedByTimecode") is True, "V1-0001 is excluded for cut B")

    # 3. ...which settles both cuts without the picture.
    ok(a["status"] == "OK" and a.get("resolvedBy") == "timecode", "cut A settled by timecode (%s)" % a["status"])
    ok(os.path.basename(a.get("graded") or "") == "V1-0001_A001C003_RUSH.mov", "cut A -> V1-0001")
    ok(os.path.basename(b.get("graded") or "") == "V1-0002_A001C003_RUSH.mov", "cut B -> V1-0002")
    ok(near(a.get("sourceIn"), 0.40) and near(b.get("sourceIn"), 0.0),
       "with their own offsets (%s, %s)" % (a.get("sourceIn"), b.get("sourceIn")))

    # 4. Without timecode on the exports the picture still decides: nothing excluded, still AMBIGUOUS.
    nt = os.path.join(tmp, "graded_notc", "261008"); os.makedirs(nt)
    for name, src in (("V1-0001_A001C003_RUSH.mov", "V1-0001_A001C003_RUSH.mov"), ("V1-0002_A001C003_RUSH.mov", "V1-0002_A001C003_RUSH.mov")):
        subprocess.run([ffmpeg, "-v", "error", "-y", "-i", os.path.join(graded, src), "-c", "copy",
                        "-write_tmcd", "0", "-map_metadata", "-1", os.path.join(nt, name)], check=True)
    out2 = os.path.join(tmp, "plan2.json")
    subprocess.run([sys.executable, os.path.join(ROOT, "helper", "plan_conform.py"), "--graded", os.path.join(tmp, "graded_notc"),
                    "--clips", os.path.join(tmp, "clips.json"), "--out", out2, "--fps", "25", "--ffmpeg", ffmpeg], capture_output=True)
    p2 = json.load(open(out2))
    ok(p2[0]["status"] == "AMBIGUOUS", "no timecode on the exports: still for the picture (%s)" % p2[0]["status"])
    ok(not any(h.get("excludedByTimecode") for h in p2[0]["candidates"]), "and nothing excluded")

print(("FAILED " if failed else "ok ") + "%d failed" % failed)
sys.exit(1 if failed else 0)
