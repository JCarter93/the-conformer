"""
The helper must serve EVERY Premiere version's panel, not just one.

Premiere 2025 and 2026 install side by side, each with its own UXP data folder
(PluginsStorage/PPRO/25/... and .../26/...). The helper used to pick the most
recently touched folder once and keep it for life, so the other version's
panel reported "helper not running" while the helper was running. This builds
two version folders in a fake storage root, runs the real helper loop against
it, and checks both get a heartbeat and both get their request answered.

Run: python3 tests/queue_discovery_test.py   (scripts/run-tests.sh runs it too)
"""
import json, os, subprocess, sys, tempfile, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "helper"))
import conform_helper as H  # noqa: E402

failed = 0
def ok(cond, label):
    global failed
    if not cond:
        failed += 1
        print("FAIL  " + label)

with tempfile.TemporaryDirectory() as home:
    store = os.path.join(home, "Library", "Application Support", "Adobe", "UXP", "PluginsStorage")
    data = {}
    for major in ("25", "26"):
        d = os.path.join(store, "PPRO", major, "External", "theconformer", "PluginData")
        os.makedirs(d)
        data[major] = d
    # 26 touched last - the old code would have served 26 alone.
    os.utime(data["25"], (time.time() - 100, time.time() - 100))

    H.uxp_storage_roots = lambda: [store]
    found = H.find_queue_dirs()
    ok(len(found) == 2, "both versions' queues are found, not just the newest (got %d)" % len(found))
    ok(found[0].startswith(data["26"]), "newest first")
    ok(H.find_queue_dir() == found[0], "the single-queue helper still answers with the newest")
    ok(H.find_queue_dirs("/explicit/q") == ["/explicit/q"], "--queue still pins one folder")

    # The real loop, run as a process against the fake home: a probe request in each queue.
    for major, d in data.items():
        q = os.path.join(d, "queue"); os.makedirs(q, exist_ok=True)
        with open(os.path.join(q, "req-t%s.json" % major), "w") as fh:
            json.dump({"id": "t" + major, "kind": "nonsense", "params": {}}, fh)
    env = dict(os.environ, HOME=home)
    proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "helper", "conform_helper.py")],
                            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.time() + 20
        want = [os.path.join(d, "queue", n) for d in data.values() for n in ("status.json",)]
        want += [os.path.join(data[m], "queue", "res-t%s.json" % m) for m in data]
        while time.time() < deadline and not all(os.path.exists(w) for w in want):
            time.sleep(0.25)
    finally:
        proc.terminate(); proc.wait(5)
    for m in data:
        ok(os.path.exists(os.path.join(data[m], "queue", "status.json")), "PPRO %s gets a heartbeat" % m)
        ok(os.path.exists(os.path.join(data[m], "queue", "res-t%s.json" % m)), "PPRO %s's request is answered" % m)

print(("FAILED " if failed else "ok ") + "%d failed" % failed)
sys.exit(1 if failed else 0)
