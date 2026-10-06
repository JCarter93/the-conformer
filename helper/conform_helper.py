#!/usr/bin/env python3
"""
The Conformer's background helper.

WHY THIS EXISTS
    UXP cannot start a subprocess. Not "it is awkward" - there is no API for it
    at all, and the one capability that offers it (Bolt UXP's exec) is a
    compiled native addon this shop has no toolchain for. But the planning and
    verification steps need ffmpeg and numpy.

    So the panel and the tools talk through a folder. The panel writes a
    request file; this helper notices it, runs the real work, and writes a
    response file back; the panel polls for it. From the editor's side there is
    no terminal and no file picker: they press Check, and a few seconds later
    the report appears.

    The queue lives in the PANEL's own data folder, which UXP gives it without
    any permission prompt - that is what makes this work without the editor
    granting access to anything.

WHAT IT RUNS
    plan   -> plan_conform.py, then find_offsets.py IF any cut came back
              RETRIMMED. That chaining is the point: "when does find_offsets
              run" stops being a question anyone has to answer.
    verify -> verify_offsets.py over a kit the panel has already rendered.

RUNNING IT
    scripts/install-helper.sh installs it as a launchd agent on a Mac;
    scripts/install-helper.ps1 as a logon Scheduled Task on Windows. Either
    way it starts at login and stays out of the way. Run it in a terminal
    instead to watch what it does:  python3 helper/conform_helper.py --verbose
"""
import argparse, concurrent.futures as cf, glob, hashlib, json, os, re, shutil, subprocess, sys, threading, time, traceback

HEARTBEAT_SECONDS = 5
POLL_SECONDS = 0.5
VERSION = "1.0.0"

IS_WINDOWS = os.name == "nt"

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, ".."))

# The planning and verification scripts live beside this file.
DEFAULT_SCRIPTS = HERE

# ffmpeg download page, shown by the panel and the installers when no usable
# build is found. ffmpeg is GPLv3, so it is never shipped with the panel.
FFMPEG_DOWNLOAD_URL = "https://ffmpeg.org/download.html"


def find_tool(name, explicit=None):
    """
    Which ffmpeg / ffprobe to run, or None.

    In order: the path given on the command line; a static build in the
    plugin's own bin/ (scripts/fetch-ffmpeg.sh puts one there on a Mac, and a
    Windows user drops one in by hand); whatever is on PATH. None when there
    is nothing - the helper then runs, heartbeats, and refuses the jobs that
    need it with a message that says where to get one, rather than failing on
    every request with "No such file".
    """
    if explicit:
        return explicit if os.path.isfile(explicit) else None
    exe = name + (".exe" if IS_WINDOWS else "")
    local = os.path.join(REPO, "bin", exe)
    if os.path.isfile(local) and os.access(local, os.X_OK):
        return local
    return shutil.which(name)


def tool_report(ffmpeg, ffprobe):
    """What the heartbeat says about the tools, so the panel can show it."""
    return {"ffmpeg": ffmpeg, "ffprobe": ffprobe, "downloadUrl": FFMPEG_DOWNLOAD_URL}


def need_tools(ffmpeg, ffprobe, want_ffprobe=True):
    missing = [n for n, p in (("ffmpeg", ffmpeg), ("ffprobe", ffprobe if want_ffprobe else "x")) if not p]
    if missing:
        raise RuntimeError("%s not found. Put a static build in %s or on PATH (Mac: scripts/fetch-ffmpeg.sh). "
                           "Download: %s" % (" and ".join(missing), os.path.join(REPO, "bin"), FFMPEG_DOWNLOAD_URL))


def uxp_storage_roots():
    """
    Where UXP keeps per-plugin data on this platform - every root worth
    searching, because the two platforms do not agree.

      Mac      ~/Library/Application Support/Adobe/UXP/PluginsStorage
                   (verified: .../PPRO/26/External/theconformer/PluginData)
      Windows  %APPDATA%\\Adobe\\UXP\\PluginsStorage
                   (the registry's sibling - see scripts/install-dev.ps1)
               %APPDATA%\\Adobe\\Premiere Pro\\<ver>\\UXP\\PluginsStorage
                   (what Premiere 26 on Windows was actually seen to use for
                   its built-in panels, keyed by plugin id with no host/version
                   segment)

    Searching both costs nothing and means the helper does not have to be
    told which build of Premiere it is serving.
    """
    if IS_WINDOWS:
        base = os.environ.get("APPDATA") or os.path.expanduser(os.path.join("~", "AppData", "Roaming"))
        return [os.path.join(base, "Adobe", "UXP", "PluginsStorage"),
                os.path.join(base, "Adobe", "Premiere Pro", "*", "UXP", "PluginsStorage")]
    base = os.path.expanduser(os.path.join("~", "Library", "Application Support"))
    return [os.path.join(base, "Adobe", "UXP", "PluginsStorage"),
            os.path.join(base, "Adobe", "Premiere Pro", "*", "UXP", "PluginsStorage")]


def find_queue_dir(explicit=None):
    """
    Where the panel's data folder is.

    UXP hands the panel a data folder it can always write to, and puts it under
    PluginsStorage keyed by host and plugin id. The exact path carries a
    version segment that changes with Premiere, so this globs rather than
    hard-coding it - and takes the most recently touched match, which is the
    one the running Premiere is using.
    """
    if explicit:
        return explicit
    patterns = []
    for root in uxp_storage_roots():
        patterns += [
            os.path.join(root, "*", "*", "External", "theconformer", "PluginData"),
            os.path.join(root, "*", "*", "*", "theconformer", "PluginData"),
            os.path.join(root, "External", "theconformer", "PluginData"),
            os.path.join(root, "**", "theconformer", "**", "PluginData"),
        ]
    hits = []
    for p in patterns:
        hits.extend(glob.glob(p, recursive=True))
    if not hits:
        return None
    hits.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    return os.path.join(hits[0], "queue")


class Heartbeat(object):
    """
    Writes status.json on its OWN thread.

    This has to be a thread, and that was learned the hard way: the first
    version wrote the heartbeat from the main loop, between requests. A verify
    over 8K ProRes takes tens of seconds - minutes when Premiere is competing
    for the same disk - and for all that time no heartbeat was written, so the
    panel decided the helper had died at exactly the moment it was working
    hardest. It then refused to send the next request, telling the editor to
    install a helper that was already running.

    It also reports WHAT it is doing, so the panel can say "busy with verify"
    rather than leaving an editor watching a spinner.
    """

    def __init__(self, queue_getter, scripts, tools=None):
        self.queue_getter = queue_getter
        self.scripts = scripts
        self.tools = tools or {}
        self.lock = threading.Lock()
        self.busy = None
        self.since = None
        self.stop = threading.Event()

    def start_job(self, kind):
        with self.lock:
            self.busy = kind
            self.since = time.time()

    def end_job(self):
        with self.lock:
            self.busy = None
            self.since = None

    def write(self):
        queue = self.queue_getter()
        if not queue or not os.path.isdir(queue):
            return
        with self.lock:
            busy, since = self.busy, self.since
        payload = {"pid": os.getpid(), "version": VERSION, "lastSeen": time.time(),
                   "scripts": self.scripts, "tools": self.tools, "busy": busy,
                   "busySeconds": round(time.time() - since, 1) if since else None}
        try:
            tmp = os.path.join(queue, "status.json.part")
            with open(tmp, "w") as fh:
                json.dump(payload, fh)
            os.replace(tmp, os.path.join(queue, "status.json"))
        except OSError:
            pass

    def loop(self):
        while not self.stop.wait(HEARTBEAT_SECONDS):
            self.write()


def run(cmd, log):
    log.append("$ " + " ".join(cmd))
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.stdout:
        log.extend(r.stdout.rstrip().splitlines()[-40:])
    if r.returncode != 0:
        log.extend((r.stderr or "").rstrip().splitlines()[-20:])
        raise RuntimeError("%s failed (exit %d)" % (os.path.basename(cmd[1] if len(cmd) > 1 else cmd[0]), r.returncode))
    return r


def do_plan(params, work, scripts, ffmpeg, ffprobe, log):
    """
    Plan the conform, and resolve the re-trimmed cuts if there are any.

    The panel sends the clips it read off the timeline, so there is no
    clips.json for anyone to build by hand.
    """
    clips = params.get("clips") or []
    if not clips:
        raise ValueError("no clips were sent")
    graded_dir = params.get("gradedDir")
    if not graded_dir or not os.path.isdir(graded_dir):
        raise ValueError("the graded folder does not exist: %s" % graded_dir)

    clips_path = os.path.join(work, "clips.json")
    plan_path = os.path.join(work, "plan.json")
    resolved_path = os.path.join(work, "plan_resolved.json")
    with open(clips_path, "w") as fh:
        json.dump(clips, fh, indent=1)

    cmd = [sys.executable, os.path.join(scripts, "plan_conform.py"),
           "--graded", graded_dir, "--clips", clips_path, "--out", plan_path,
           "--fps", str(params.get("fps") or 25.0), "--ffmpeg", ffmpeg]
    if params.get("handleFrames") is not None:
        cmd += ["--handle-frames", str(params["handleFrames"])]
    if params.get("align") and params["align"] != "auto":
        cmd += ["--align", str(params["align"])]
    run(cmd, log)

    with open(plan_path) as fh:
        plan = json.load(fh)

    # find_offsets.py runs ONLY when something needs it - a cut that moved
    # after grading, where no arithmetic can place it. On a job whose exports
    # preserved source timecode, that is nothing at all, and it never runs.
    retrimmed = [e for e in plan if e.get("status") == "RETRIMMED"]
    used_offsets = False
    if retrimmed:
        log.append("%d cut(s) re-trimmed since the grade - frame matching them" % len(retrimmed))
        try:
            run([sys.executable, os.path.join(scripts, "find_offsets.py"),
                 "--plan", plan_path, "--out", resolved_path,
                 "--ffmpeg", ffmpeg, "--fps", str(params.get("fps") or 25.0)], log)
            with open(resolved_path) as fh:
                plan = json.load(fh)
            used_offsets = True
        except Exception as e:
            # A failed frame match is not a failed plan: those cuts stay
            # RETRIMMED and the panel refuses them by name, which is the
            # correct outcome anyway.
            log.append("frame matching did not complete: %s" % e)

    counts = {}
    for e in plan:
        counts[e.get("status", "?")] = counts.get(e.get("status", "?"), 0) + 1
    return {"entries": plan, "counts": counts, "frameMatched": used_offsets,
            "planPath": resolved_path if used_offsets else plan_path}


_PLANNER = {}


def planner(scripts):
    """
    plan_conform.py loaded as a module, for its ffmpeg parsers.

    Duration, dimensions, frame rate and especially START TIMECODE are already
    parsed there, drop-frame handled properly rather than by dividing frames by
    fps. Re-implementing any of that here would give the single-master and stem
    modes a second, subtly different answer to the same question.
    """
    if "mod" not in _PLANNER:
        import importlib.util
        path = os.path.join(scripts, "plan_conform.py")
        spec = importlib.util.spec_from_file_location("plan_conform", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _PLANNER["mod"] = mod
    return _PLANNER["mod"]


def do_probe(params, scripts, ffmpeg, log):
    """
    What a whole file IS: how long, where it starts, and what is in it.

    The single-master and stem modes do no matching at all - the file is
    supposed to BE the sequence - so this is the entire evidence base for both.
    Start timecode is the part that matters: it is the only thing that can tell
    a master rendered with head handles from one rendered flush, and getting
    that wrong offsets every frame of the programme by the same amount.

    `hasVideo` / `hasAudio` are returned so the panel can refuse a stem that is
    a picture file, or a master with no picture, by name rather than by letting
    the placement do something strange.
    """
    paths = params.get("paths") or []
    if not paths:
        raise ValueError("no files were sent")
    pc = planner(scripts)
    fallback_fps = float(params.get("fps") or 25.0)

    def one(path):
        if not os.path.exists(path):
            return path, {"error": "this file is not where the panel says it is"}
        stderr = pc.probe(ffmpeg, path)
        fps = pc.parse_fps(stderr, fallback_fps)
        width, height = pc.parse_dims(stderr)
        tc = pc.parse_start_tc(stderr, fps)
        info = {
            "duration": pc.parse_duration(stderr),
            "fps": fps,
            "width": width,
            "height": height,
            "hasVideo": bool(re.search(r"Stream #\d+:\d+.*: Video:", stderr)),
            "hasAudio": bool(re.search(r"Stream #\d+:\d+.*: Audio:", stderr)),
        }
        if tc:
            info["startTC"] = tc.get("seconds")
            info["startTCText"] = tc.get("raw")
            info["dropFrame"] = tc.get("dropFrame")
            if tc.get("unreliable"):
                info["timecodeNote"] = tc["unreliable"]
        audio = re.search(r"Audio:.*?, (\d+) Hz, ([^,]+)", stderr)
        if audio:
            info["sampleRate"] = int(audio.group(1))
            info["channelLayout"] = audio.group(2).strip()
        if not info["duration"]:
            info["error"] = "ffmpeg could not read a duration from this file"
        return path, info

    out = {}
    with cf.ThreadPoolExecutor(max_workers=min(6, max(1, len(paths)))) as pool:
        for path, info in pool.map(one, paths):
            out[path] = info
            if info.get("error"):
                log.append("%s: %s" % (os.path.basename(path), info["error"]))
    return {"files": out}


def do_thumbs(params, queue, ffmpeg, ffprobe, log):
    """
    A single frame out of the middle of each file, for the panel to show.

    Where one shot was exported twice, the choice between the two is instant
    from the picture and impossible from the name - on the reference job one
    was a two-car head-on and the other a fist bump, while their filenames
    differed by one character. DaVinci's V1-/V2- prefix is no help either: it
    records the TRACK at grade time, so a timeline rearranged since points it
    at the wrong export.

    Kept separate from verification deliberately, so the panel can offer the
    choice on any check - including one run with verification switched off,
    which is otherwise the case where an ambiguous cut cannot be settled at
    all.

    Rendered CONCURRENTLY, and cached by path: eight 8K ProRes candidates take
    about 4s cold and 0.01s once they have been seen, so only a graded folder
    nobody has checked before pays anything.

    Those same eight took 70s before this ran the files in parallel AND before
    the launchd agent came off ProcessType Background - see install-helper.sh,
    because throttling was most of it.

    The panel renders its report first and fills the pictures in when they
    arrive, so none of this is ever in front of the check.
    """
    paths = params.get("paths") or []
    if not paths:
        raise ValueError("no files were sent")
    folder = os.path.join(queue, "thumbs")
    os.makedirs(folder, exist_ok=True)
    def one(path):
        if not os.path.exists(path):
            return None, None
        name = "th_%s.jpg" % hashlib.sha1(path.encode("utf8")).hexdigest()[:16]
        dest = os.path.join(folder, name)
        if os.path.exists(dest) and os.path.getsize(dest) > 0:
            return path, name                  # already rendered for an earlier check
        at = 0.0
        probed = subprocess.run([ffprobe, "-v", "error", "-show_entries", "format=duration",
                                 "-of", "default=nw=1:nk=1", path],
                                capture_output=True, text=True)
        try:
            at = max(0.0, float(probed.stdout.strip().splitlines()[0]) / 2.0)
        except Exception:
            pass
        # Written to a temp name and renamed, like every other response here:
        # the panel may look while ffmpeg is still writing. The suffix goes
        # BEFORE the extension - ffmpeg picks its output format from the
        # extension, and a file ending .jpg.part is a format it has never
        # heard of, which fails before a frame is read.
        part = os.path.join(folder, "part_" + name)
        r = subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-ss", str(at),
                            "-i", path, "-frames:v", "1", "-vf", "scale=320:-2",
                            "-q:v", "5", "-y", part], capture_output=True)
        if r.returncode == 0 and os.path.exists(part) and os.path.getsize(part) > 0:
            os.replace(part, dest)
            return path, name
        else:
            # Say WHY. The first version of this logged only the filename, and
            # a plain "no thumbnail" hid a broken command behind what looked
            # like an awkward file.
            why = (r.stderr or b"").decode("utf8", "replace").strip().splitlines()
            log.append("no thumbnail for %s%s" % (os.path.basename(path),
                                                  (": " + why[-1]) if why else ""))
            if os.path.exists(part):
                os.remove(part)
        return None, None

    out = {}
    with cf.ThreadPoolExecutor(max_workers=min(6, max(1, len(paths)))) as pool:
        for path, name in pool.map(one, paths):
            if path:
                out[path] = name
    return {"folder": folder, "thumbs": out}


def do_verify(params, scripts, ffmpeg, ffprobe, log):
    kit = params.get("kitDir")
    if not kit or not os.path.isdir(kit):
        raise ValueError("the kit folder does not exist: %s" % kit)
    out = os.path.join(kit, "verdicts.json")
    run([sys.executable, os.path.join(scripts, "verify_offsets.py"),
         "--kit", kit, "--out", out, "--ffmpeg", ffmpeg, "--ffprobe", ffprobe], log)
    with open(out) as fh:
        return json.load(fh)


def handle(path, queue, scripts, ffmpeg, ffprobe, verbose, beat=None):
    try:
        with open(path) as fh:
            request = json.load(fh)
    except Exception as e:
        os.rename(path, path + ".unreadable")
        return
    rid = request.get("id") or os.path.basename(path)
    kind = request.get("kind")
    log = []
    started = time.time()
    # Claimed before the work starts, so a helper restarted mid-job does not
    # run the same request twice.
    taken = path + ".taken"
    try:
        os.rename(path, taken)
    except OSError:
        return

    work = os.path.join(queue, "work", str(rid))
    os.makedirs(work, exist_ok=True)
    response = {"id": rid, "kind": kind, "ok": False}
    if beat:
        beat.start_job(kind)
    try:
        if kind == "plan":
            need_tools(ffmpeg, ffprobe)
            response["result"] = do_plan(request.get("params") or {}, work, scripts, ffmpeg, ffprobe, log)
        elif kind == "verify":
            need_tools(ffmpeg, ffprobe)
            response["result"] = do_verify(request.get("params") or {}, scripts, ffmpeg, ffprobe, log)
        elif kind == "probe":
            need_tools(ffmpeg, ffprobe, want_ffprobe=False)
            response["result"] = do_probe(request.get("params") or {}, scripts, ffmpeg, log)
        elif kind == "thumbs":
            need_tools(ffmpeg, ffprobe)
            response["result"] = do_thumbs(request.get("params") or {}, queue, ffmpeg, ffprobe, log)
        elif kind == "ping":
            response["result"] = {"version": VERSION, "scripts": scripts, "tools": tool_report(ffmpeg, ffprobe)}
        else:
            raise ValueError("unknown request kind: %s" % kind)
        response["ok"] = True
    except Exception as e:
        response["error"] = str(e)
        log.extend(traceback.format_exc().splitlines()[-6:])
    finally:
        if beat:
            beat.end_job()
    response["log"] = log
    response["seconds"] = round(time.time() - started, 2)

    # Written beside, then renamed: the panel polls for this file, and a
    # half-written one would parse as a broken response rather than as "not
    # ready yet".
    out = os.path.join(queue, "res-%s.json" % rid)
    with open(out + ".part", "w") as fh:
        json.dump(response, fh, indent=1)
    os.replace(out + ".part", out)
    if verbose:
        print("[%s] %s -> %s (%.1fs)" % (time.strftime("%H:%M:%S"), kind,
                                         "ok" if response["ok"] else response.get("error"),
                                         response["seconds"]), flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--queue", default=None, help="queue folder (default: the panel's own data folder)")
    ap.add_argument("--scripts", default=DEFAULT_SCRIPTS)
    ap.add_argument("--ffmpeg", default=None, help="path to ffmpeg (default: bin/ffmpeg beside this repo, then PATH)")
    ap.add_argument("--ffprobe", default=None, help="path to ffprobe (same search)")
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--once", action="store_true", help="handle whatever is queued, then exit")
    ap.add_argument("--log", default=None,
                    help="append stdout/stderr to this file (the Windows installer runs the helper "
                         "under pythonw, which has no console to write to)")
    a = ap.parse_args()

    if a.log:
        os.makedirs(os.path.dirname(os.path.abspath(a.log)), exist_ok=True)
        # Line-buffered, so a crash still leaves its last lines in the file.
        sys.stdout = sys.stderr = open(a.log, "a", buffering=1)

    a.ffmpeg = find_tool("ffmpeg", a.ffmpeg)
    a.ffprobe = find_tool("ffprobe", a.ffprobe)
    if a.verbose:
        print("ffmpeg:  %s" % (a.ffmpeg or "NOT FOUND - " + FFMPEG_DOWNLOAD_URL), flush=True)
        print("ffprobe: %s" % (a.ffprobe or "NOT FOUND - " + FFMPEG_DOWNLOAD_URL), flush=True)

    state = {"queue": None}

    def current_queue():
        return state["queue"]

    beat = Heartbeat(current_queue, a.scripts, tool_report(a.ffmpeg, a.ffprobe))
    thread = threading.Thread(target=beat.loop, daemon=True)
    thread.start()

    while True:
        # The queue folder may not exist until the panel has run once, so it is
        # looked up on every pass rather than at startup - otherwise installing
        # the helper before opening the panel would need a restart.
        queue = state["queue"]
        if queue is None or not os.path.isdir(queue):
            queue = find_queue_dir(a.queue)
            if queue:
                os.makedirs(queue, exist_ok=True)
                state["queue"] = queue
                beat.write()
                if a.verbose:
                    print("watching %s" % queue, flush=True)

        if queue:
            for req in sorted(glob.glob(os.path.join(queue, "req-*.json"))):
                handle(req, queue, a.scripts, a.ffmpeg, a.ffprobe, a.verbose, beat)

        if a.once:
            return
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
