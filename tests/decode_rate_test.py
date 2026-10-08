"""
The matcher decodes a graded file at ITS OWN rate when that is a whole multiple
of the sequence's (50p exports of a 25p edit). At the sequence rate, a 50p file
lost every other frame, offsets could only be measured in 0.04s steps, and a
cut an odd number of 50p frames in read 0.12 at one probe and 0.16 at the next.

Run: python3 tests/decode_rate_test.py   (scripts/run-tests.sh runs it too)
"""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "helper"))
import verify_offsets as V  # noqa: E402

failed = 0
def eq(got, want, label):
    global failed
    if abs((got or 0) - want) > 1e-9:
        failed += 1
        print("FAIL  %s: want %s, got %s" % (label, want, got))

eq(V.decode_fps(50.0, 25.0), 50.0, "50p graded in a 25p edit decodes at 50")
eq(V.decode_fps(100.0, 25.0), 100.0, "100p in 25p decodes at 100")
eq(V.decode_fps(59.94, 29.97), 59.94, "59.94 in 29.97 decodes at 59.94")
eq(V.decode_fps(25.0, 25.0), 25.0, "same rate stays")
eq(V.decode_fps(24.0, 25.0), 25.0, "24 in a 25 edit keeps the sequence rate the refs were rendered at")
eq(V.decode_fps(30.0, 25.0), 25.0, "30 in 25 is not a multiple - sequence rate")
eq(V.decode_fps(37.5, 25.0), 25.0, "1.5x is not a whole multiple - sequence rate")
eq(V.decode_fps(None, 25.0), 25.0, "unknown rate falls back to the sequence rate")
eq(V.decode_fps(50.0, None), None or 0, "no sequence rate: nothing to compare against")

print(("FAILED " if failed else "ok ") + "%d failed" % failed)
sys.exit(1 if failed else 0)
