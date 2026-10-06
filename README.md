# The Conformer

A Premiere Pro panel that rebuilds an offline edit against graded footage — the
reverse of what **The Onliner** prepares. MIT licence, see `LICENSE`.

Raw UXP: plain HTML/CSS/JS loaded straight by Premiere. No Node, no bundler, no
`package.json`, same as its sibling panels (The Onliner, The Consolidator).
Anything needing ffmpeg or numpy runs in a small background helper — UXP has
no subprocess capability at all — see "The helper" and "ffmpeg" below.

## What is built

All three modes from the brief, and **picture and sound are chosen
independently** — they come back from different people at different times and
belong in one sequence, so the panel conforms both in a single pass rather than
making an editor conform twice and merge by hand.

## Two axes, one sequence

Picture and sound are separate choices. Either may be **none**, but not both.

| Picture | What comes back | Where it goes |
| --- | --- | --- |
| **One graded file per cut** | DaVinci/Baselight-style per-cut exports | each cut replaced in place |
| **A single graded master** | one file covering the whole programme | a new video track above the offline |
| **Nothing** | — | the picture is left alone |

| Sound | What comes back | Where it goes |
| --- | --- | --- |
| **Mix stems** | full-length stems, flush to the start | one new audio track each, named |
| **Nothing** | — | the sound is left alone |

Any combination works: per-cut grade **plus** stems, a master **plus** stems, or
either on its own. One Check reports both halves with their own counts, one
Conform clones **once** and runs both passes into that sequence.

**Order matters, and it is not cosmetic.** The picture pass leaves empty audio
tracks behind — a per-cut placement aims the graded file's audio at a spare
track and then strips it, and Premiere cannot delete a track. So the sound pass
re-reads the track count **after** the picture pass rather than using the one
from Check time; otherwise the Full Mix lands on top of that leftover. Measured:
an offline with A1 came out as A1 (muted), A2 (the picture pass's leftover) and
the four stems on A3–A6.

Muting targets the **offline's own** audio tracks, counted before either pass
added any — using the post-pass count would silence the stems themselves.

The two whole-file modes do **no matching at all** — the file is supposed to
*be* the sequence. What they do instead is establish the offset, and rank the
evidence for it:

1. **Timecode.** `getZeroPoint()` gives the sequence's start timecode (measured:
   3600s, 01:00:00:00) and the file carries its own. The difference is the
   offset, exactly, assuming nothing about the render.
2. **An exact length match.** Where the file is the sequence to the frame, only
   one offset can be right, so it proves itself.
3. **Nothing.** A longer file with no timecode is placed from its first frame
   and **says so** — because if it was rendered with a head handle, every frame
   of it is out by that handle, and nothing else here can tell.

Neither mode overwrites anything: they land on new tracks, so a conform that
turns out to be one frame out costs a track to delete and nothing else.

**Stems mute the offline's own audio** (optional, on by default). Without it the
stems play on top of the scratch mix rather than instead of it, which sounds
like a bad mix rather than like a mistake — the worst kind of failure to spot.
Each track is named from its filename: Full Mix, Dialogue, VO, Music, SFX,
Ambience, Atmos, laid out in that order.

**Stems are named after what DIFFERS across the set, not by a word list.**
Measured on a real mix delivery:

    Film Title - V3 MIX MINUS MUSIC.wav   ->  "Music"
    Film Title - V3 MUSIC DIPPED.wav      ->  "Music"
    Film Title - V3 MUSIC UNDIPPED.wav    ->  "Music"

Three different stems with one name — and the first of them is the mix with the
music *taken out*, so a mixer pulling the track labelled "Music" would get the
opposite of what they asked for. No vocabulary fixes that, because the word
really is in the name.

What the set itself says is unambiguous: strip the prefix and suffix they all
share and keep the rest — BACKGROUNDS, M+E, MIX MINUS MUSIC, MUSIC DIPPED,
MUSIC UNDIPPED, SFX, SYNC. An affix is only stripped where it lands on a
separator in *every* name, or "MUSIC DIPPED" and "MUSIC UNDIPPED" come out as
"" and "UN". The word list survives for **running order only** — with a guard
so a name that takes something away ("minus", "without") is never sorted in
beside the thing it excludes.

## How a run goes

1. Pick the offline sequence, the video track, and the folder of graded exports.
2. **Check.** The panel reads the track, has the helper match every clip against
   the graded folder, verifies the result against the picture, and lists what it
   will place and what it will refuse, with a reason each.
3. **Conform.** The graded files are imported once each, placed over their cuts,
   and Motion is carried across.

No JSON files, no terminal. The graded folder is the only thing to pick, and it
is remembered between sessions.

Check is a gate, not a preview: the Conform button stays disabled until a Check
has run, and any change to the sequence, the track or the plan disarms it again.
Same principle as Onliner's multicam gate — when a step needs a human, pause
with a named list rather than warning after the damage.

## The placement primitive

There is no API call that places a clip from a given source in-point. The route,
established by trial against Premiere 26.3.2 and written up in the Onliner's
`docs/API-FINDINGS.md` section 20:

```js
clip.createSetInOutPointsAction(inTick, outTick)   // mark the range
editor.createOverwriteItemAction(item, at, vTrack, aTrack)   // the overwrite reads the marks
```

Consequences the code is shaped around:

- **Marks are shared bin state**, so placement is sequential: mark, place,
  re-mark, place. One graded file serving two cuts is the normal case.
- **Marks past the end of the media do not error.** A 6-frame file marked 2–4s
  placed a silent 2-second clip of nothing. `plan.js` refuses that before
  anything is written, using the `gradedDur` the plan carries from ffmpeg —
  `Media.duration` in the UXP API returns an object whose seconds and ticks are
  `undefined`, so it cannot do the check.
- **`audioTrackIndex: -1` does not suppress audio.** It lands on A1, which in a
  conform is where the mix lives. Placements are aimed at a spare audio track
  and the audio is removed immediately. The spare index is worked out **once**
  per run: an index at or beyond the track count creates a new track, so
  recomputing it per clip would add one track per clip.
- **Placement snaps to the sequence's frame grid**, so all arithmetic is in
  ticks against the sequence's own timebase, never in seconds.

## The background helper

UXP has no subprocess API at all, and both the planning and the verification
need ffmpeg (and numpy). So they run in a separate process, and the two talk
through a folder:

```
panel  writes  <plugin data>/queue/req-<id>.json     { id, kind, params }
helper writes  <plugin data>/queue/res-<id>.json     { id, ok, result | error, log }
helper writes  <plugin data>/queue/status.json       a heartbeat, every 5s
```

The queue lives in the **panel's own data folder**, which UXP grants without a
permission prompt — that is what lets this work with no picker and no terminal.
Responses are written to `.part` and renamed, so the panel can never read a
half-written one.

Install it once:

```bash
scripts/install-helper.sh          # install and start (launchd, runs at login)
scripts/install-helper.sh status   # is it running?
scripts/install-helper.sh uninstall
```

The helper needs Python 3 with numpy, and an ffmpeg — see "ffmpeg" below. The
planning and verification scripts it runs (`plan_conform.py`,
`find_offsets.py`, `verify_offsets.py`) live beside it in `helper/`.

### ffmpeg

ffmpeg is **GPLv3**, so it is not shipped with the panel. The helper looks for
`ffmpeg` and `ffprobe` in the plugin's own `bin/` folder first, then on
`PATH`, and says in its heartbeat which it found. Without one the helper still
installs and runs, the panel shows *"Helper running, but it has no ffmpeg"*
with a **Get ffmpeg** link to ffmpeg.org, and every plan or check is refused
with the same message rather than failing obscurely.

On a Mac, `scripts/fetch-ffmpeg.sh` downloads a pinned static build into
`bin/` and verifies its checksum — one build everywhere, which matters because
two builds measured the same file's duration 1.75 frames apart. On Windows,
download a static build and put `ffmpeg.exe` and `ffprobe.exe` in `bin\`.
Restart the helper after adding it. `bin/` is gitignored.

On Windows the same three verbs, as a logon Scheduled Task:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-helper.ps1
powershell -ExecutionPolicy Bypass -File scripts\install-helper.ps1 status
powershell -ExecutionPolicy Bypass -File scripts\install-helper.ps1 uninstall
```

It runs under `pythonw.exe` (no console at logon), writes its own log to
`%LOCALAPPDATA%\TheConformer\helper.log` via the helper's `--log` flag, and is
registered at **normal** priority — Task Scheduler's default is below-normal,
the same throttled class as launchd's "Background", which cost 583s against
39s on the Mac. The 72-hour execution limit Task Scheduler applies by default
is switched off, or the helper would silently stop on day four. Run for real
on Windows 11 on 2026-10-06 — see "Windows" under Install.

The panel shows whether the helper is alive, judged by its heartbeat rather than
by the file merely existing — a dead helper would otherwise take a request and
hold it until the panel's timeout expired.

**The panel waits on the heartbeat, not on a stopwatch.** A fixed wall-clock
timeout has to guess how long the longest legitimate job takes, and it guessed
wrong: a four-track verify answered in **904.3s against a 900s limit**, so the
panel abandoned the job 4.3 seconds before the answer landed and told the editor
the helper had not replied. It had. Since the helper publishes what it is
working on every five seconds, there is nothing to guess — the wait only ends
when something is actually wrong, and each case says which:

| What the status file shows | What it means | Message |
| --- | --- | --- |
| alive, `busy` set | working | keep waiting, however long |
| alive, idle, past the pickup window | the job was claimed then dropped — a helper restarted mid-job renames the request `.taken` and never returns to it | "press Check again" |
| heartbeat stale past 90s | the helper died | points at the log |

`waitVerdict()` is pure and tested, so all three can be exercised without a
helper, a filesystem or a fifteen-minute wait.

**A failed check clears the board.** It used to leave the previous check's
report *and* the previous conform's report on screen with a red error beneath
them — three different runs reading as one, with the stale report looking like
the answer to the check that had just failed.

What it runs:

- **plan** → `plan_conform.py`, then `find_offsets.py` **only if** some cut came
  back RETRIMMED. That chaining is the point: when frame matching runs stops
  being something anyone has to know. On a job whose exports preserved source
  timecode it never runs at all.
- **verify** → `verify_offsets.py` over a kit the panel has already rendered.
- **thumbs** → one frame from the middle of each named file, for the version
  picker. Cached by path, so only a graded folder nobody has checked before
  pays for it.

**Run the agent as `Interactive`, never `Background`.** `ProcessType` is not a
hint about tidiness — `Background` puts the helper and every ffmpeg it starts
into Darwin's throttled CPU and I/O class, which is meant for work nobody is
waiting on. An editor *is* waiting on this. Measured on one 11-cut verify, same
machine, same files, same code: **583s throttled, 38.5s not.** That was by far
the largest cost in the whole pipeline, and it was invisible from a shell — a
hand-run of the identical command took 39s, because the shell is not throttled.
**Time the helper path, not your own.**

Measured on the job it was built on: plan 8.6s for 8 clips, verify 17.1s for 4 cuts of
8K ProRes. A full four-track verify of 11 cuts runs in **38.5s**, against 904s
before; of that, concurrency and the single decode took it to 583s and taking
the agent off `Background` did the rest. Verdicts are byte-identical throughout.

**The panel and the helper must agree on the job names.** They are two languages
that never import each other, so a kind the panel sends and the helper has never
heard of fails as `unknown request kind` only once an editor presses the button.
`helper-test.js` greps both files and checks every kind the panel sends is
handled.

**The heartbeat runs on its own thread.** The first version wrote it from the
main loop, between jobs, so a long verify left no heartbeat and the panel
declared the helper dead at exactly the moment it was working hardest — then
refused to send the next request, telling the editor to install something that
was already running.

## Verifying against the picture

Timecode is exact arithmetic, but it trusts that the grade preserved source
timecode. Verification asks the only question that settles it: does the frame
the offline shows at this cut actually appear at that offset in the graded file?
It runs as part of Check, unless switched off.

The reference frames come from **Premiere**, not from the rushes, because ffmpeg
cannot decode ProRes RAW at all — it fails as `Invalid argument` with zero bytes
out, which reads like a broken command rather than an unsupported codec.

What the verdicts do:

| Verdict | What it means | What the panel does |
| --- | --- | --- |
| `confirmed` | two or more probes agree with the plan | places it |
| `corroborated` | one strong probe agrees, the others could not match | places it, says so |
| `static` | locked-off shot — every offset shows the same picture | places it |
| `disputed` | the picture and the plan disagree | **refuses it** |
| `retimed` | the match slides across the cut | **refuses it** |
| `resolved` | an ambiguous cut settled by matching each candidate | places it, on the file the picture chose |
| `inconclusive` | nothing could be proved either way | places it, lists it |

**Ambiguity is settled by the picture, not the filename.** Where a shot has two
graded exports, the matcher tries each against the offline's own frame and takes
the clear winner. A candidate is disqualified outright if it is too short to
hold the cut, or if its measured offset would start the cut *before* the file
does — that last one settled a case where two exports scored 0.93 and 0.89, far
too close to call on score alone.

It matters that this uses evidence rather than the name: DaVinci's `V1-`, `V2-`
prefix encodes the **track at grade time**, so once a timeline is rearranged the
prefix points at the wrong export. On the job it was built on the picture chose all four
correctly, and its choices matched the original prefixes — which nothing told it.

**Isolation applies to every cut, including ambiguous ones.** Group the kit by
track using the placements *and* the unresolved list: looking only at placements
sent all four ambiguous cuts through the V1 pass with their own tracks hidden,
and the V4 one rendered black. A blank reference frame reports as "nothing
matched" — indistinguishable from hard footage — so the matcher now detects one
(standard deviation under 1) and names the real cause. The retry for
late-flushing frames also happens inside the isolation window, or a retried
frame is rendered against the whole programme.

**"Set to Frame Size" is detected, reported, and only corrected on evidence.**
A clip with it applied reads Scale 100 in the Motion panel while showing the
whole frame — the fit happens outside Motion, and a fresh placement does not
inherit it. Copy that 100 onto 8K media in an HD sequence and you get a 4×
zoom: measured, the offline and placed frames correlated **-0.007**.

But arithmetic cannot tell that from a *deliberate* 4× punch-in, which also
reads 100. On the job it was built on, two clips of three at Scale 100 were fitted and
the third was a real punch-in — "correcting" it replaced a close-up with the
wide shot. So the panel:

- **flags** every clip reading Scale 100 on media far larger than the frame;
- **corrects** only those where verification matched the picture at full frame,
  scaling by the graded media's own fit (8K in HD → 25), applied to the static
  value and every keyframe alike so an animated push-in keeps its shape;
- **leaves alone** anything the picture says is a punch-in, and says so.

**Probes span the cut, and the matcher decodes a window per probe.** Probes were
once capped near the head to keep decoding cheap, and that is exactly how the
punch-in above was misread: three probes inside the first second of an 8.92s
comp agreed on the wrong framing (full frame 0.97 vs punch-in 0.66), which the
picture reverses from 1.5s onward (0.24 vs 0.91). Decoding `[probe, probe+room]`
rather than `[0, probe+room]` makes a late probe cost no more than an early one.

**Retimed clips never reach the planner.** There is no offset that can be right
for them, but frame matching does not know that and will spend minutes failing —
measured, most of a 140-second run — before reporting "frames likely not in the
graded file", a misleading reason for a speed change. They are filtered out up
front and refused by name.

Inconclusive still places on purpose: failing to prove something is not evidence
against it, and the timecode answer is still exact arithmetic. But those are the
ones to spot-check, so they are listed by name.

Three details that cost a debugging round each:

- **`exportSequenceFrame` returns before the file is on disk.** Checking
  immediately after the call found one of twelve files that all arrived moments
  later, so the first version shipped a kit with a single reference frame in it
  and three clips came back "inconclusive" — which reads like hard-to-match
  footage, not like a bug. The render step now waits for the frames to appear,
  and the panel says so out loud when a kit is short.
- **Two probes can render the identical frame.** Measured: byte-identical PNGs
  at +0.12s and +0.48s of a 15.9s shot, reproducibly, because the head of that
  shot is held. Two identical frames are one vote counted twice, and the whole
  "two probes must agree" rule depends on them being independent — so the
  matcher de-duplicates before counting.

- **Probes never sit on a cut's first frame.** A probe at 0.0 scored 0.15 and
  0.34 on real clips — the head of a cut is often a dissolve, so the frame there
  is a blend of two shots. Probes a few frames later scored 0.93 and 0.96 on the
  same shots.
- **Both framings are tried.** A punch-in means the offline shows a crop of what
  the graded file holds, so a reframed shot will not match its own grade
  uncompensated. But Premiere's Scale cannot tell you which is which: "Scale to
  Frame Size" makes a fitted clip read 100 as well, and cropping one of those to
  the implied 25% turned a 0.93 match into nothing. So the matcher tries full
  frame and the implied punch-in, and keeps whichever matches.
- **It runs the clips concurrently**, and both framings come off a **single
  decode** — ffmpeg splits the stream and stacks the two results into one tall
  frame, because they always asked about the same window of the same file.
  Together those took a four-track, 11-clip job from 904s to 583s; see the
  helper section for the launchd throttle that accounted for the rest, down to
  38.5s. Every verdict is byte-identical across all of it.

## Scale, and when it is corrected

A fresh placement does not inherit "Set to Frame Size", and Premiere's Scale is
a percentage of the *source's own pixels*. So the offline's Scale number can
mean something different on the graded media, and copying it across changes the
shot.

`placedScaleFor` works out what the placed clip needs, and **applies it only
where the arithmetic is certain**:

| Case | Corrected? |
| --- | --- |
| graded export a different size from the source | **yes** — pure arithmetic, no ambiguity |
| Scale 100 on media far larger than the frame | **no** — flagged; only the picture can tell |
| …the same, with verification confirming full frame | **yes** |
| …the same, with verification confirming a punch-in | no — left at the offline's Scale |
| anything else (a real punch-in at Scale 27) | no — carried across unchanged |

The second row is the trap: **"Set to Frame Size" and a deliberate 4× punch-in
both read Scale 100.** Measured here, one clip of three at 100 was a genuine
punch-in, and "correcting" it replaced a close-up with the wide shot. So that
one case waits for the picture.

**A resolved cut needs dimensions too.** The matcher's verdict names the
*file* that won, not how big it is, and the resolved branch was reading a
`chosenWidth` that has never existed — so `placedScaleFor` returned null and
the fit silently did not happen. Separately, `sourceWidth` was recorded inside
`solve()`, which only runs for an entry that already has a chosen file, so
every AMBIGUOUS cut had none. Measured: a conform where all eight graded clips
were fitted to 25 except the two resolved ones, which sat at 100 on 8K media.
The source's size is now recorded for every entry, and the candidates' sizes
travel with the unresolved cut so the verdict can be matched back to them.

**Fitting is not part of "Carry Motion across".** A fresh placement gets Scale
100, and Scale is a percentage of the *source's* pixels — so 8K media in an HD
sequence sits at 100 showing the centre sixteenth. Turning Motion off is a
request to drop the *edit's* reframing, not a request for a crop nobody chose.
Measured on a real run with Motion unchecked: every graded clip landed at Scale
100, including ones whose offline was 25. The fit now applies either way; only
the editor's own punch-ins and pushes ride on the checkbox, and the run report
says how many clips were fitted.

**The verdict has to reach the correction.** `buildRun` decides the Scale
before a single frame has been compared, so the ambiguous row is left flagged —
and `applyVerification` recomputed it only for ambiguous cuts, never for
confirmed ones. A clip that matched at full frame was therefore still placed at
the offline's Scale 100. Verification ran, produced the right answer, and
changed nothing. The placement now carries the media dimensions so the Scale can
be worked out again once the framing is known.

The first row is a trap in the other direction, and cost a clip: an **HD comp at
Scale 100** — filling the frame exactly, nothing fitted about it — came back
from the grade as an **8K export**, where Scale 100 shows a sixteenth of the
picture. Gating that behind "is it fitted?" meant it was neither corrected nor
flagged, because it never looked fitted. It needs no picture: the sizes differ,
so the number has to change.

## Choosing between versions

Where one shot was exported more than once, the panel lists the candidates and
lets the editor pick, with a thumbnail from the middle of each file.

Two cases, one control:

- **AMBIGUOUS** — two exports of the same source in the same round, because the
  shot is used twice. The plan places neither.
- **SUPERSEDED** — the same shot in two dated folders. The plan takes the newest,
  which is a sound default and an invisible one.

`plan_conform.py` solves **every** candidate, not just the one it picked, so a
different choice carries its own `sourceIn`, duration and pixel size and applies
instantly — no re-plan, no helper, no waiting.

**Most of these settle without decoding a frame.** A file shorter than the cut
cannot be it, and on the job it was built on that alone disqualified a rival in three of
the four ambiguous cuts. The panel says so against each candidate, which is what
makes the picker usable with verification switched off — otherwise those cuts
have no way to be settled at all.

**Do not choose by the filename.** DaVinci's `V1-`, `V2-` prefix encodes the
track the clip sat on *at grade time*; rearrange the timeline afterwards, as
happened here, and the prefix points at the wrong export.

Thumbnails come from the helper's `thumbs` job — one frame from the middle of
each candidate, rendered concurrently and cached by path. Cold, eight 8K ProRes
candidates take about 4s; the second check takes 0.01s. The report renders first and
the pictures fill in when they arrive, so this is never in front of the check.

**The dropdown shows what is in use, and the rows are in timecode order.**
A row that said "the picture chose it" above a control reading "Undecided"
invites exactly one response: correcting the control. On a real run that
swapped two cuts which were already right, while the two that needed swapping
sat further down a list ordered by *track* rather than by time.

**The picker has to survive verification.** `applyVerification` returns a
fresh run object, and leaving `versions` off it made the picker vanish the
moment verification ran — which is every real run, because verification is on
by default. Built, unit-tested against hand-made data that carried the field,
and unreachable in the panel. `plan-test.js` now asserts that every field the
run carried in comes out again, with anything deliberately dropped listed by
name and reason.

Where the picture settled an ambiguous cut, the row says **"the picture chose
it"** rather than "nothing chosen yet" — something did choose, and the editor
is overriding a decision rather than making a first one.

**A swap only invalidates the cut that was swapped.** Rebuilding after a
version change used to drop the verdicts entirely, so changing one cut silently
re-admitted a *different* cut that verification had refused — measured on a real
run, swapping the cut at 0:07.32 brought a retimed one at 0:11.52 back from
"will not be placed" to "will be placed", with only a status line to say the
check was stale. The verdicts for every untouched cut are now kept, and the
status names how many cuts still need re-checking.

**A candidate with no derivable offset needs a re-check, not just a pick.**
Choosing a file answers *which*; it does not answer *where in it*. Where the
plan could not work the offset out, the cut waits on verification with its
candidate list narrowed to the one chosen — so press Check again after picking.

## Motion

A fresh placement carries no effects, which is exactly what strips the offline's
temp grade. Motion is the exception: scale and position are the *edit* —
punch-ins and reframes — and the colourist graded the full frame. So Motion is
read off the offline clip before it is overwritten and written back onto the
graded one.

**Keyframes are rebased.** They live in the clip's source time, and the graded
file's in-point is not the offline's:

```
newTicks = oldTicks - offlineSourceIn + gradedSourceIn
```

Copied verbatim they land at the wrong moment or outside the clip, where
Premiere clamps to the nearest keyframe and the parameter reads flat while still
reporting the right keyframe count. Nothing errors, so `tests/locked-access-test.js`
asserts the rebase is still there.

## Reading the check report

The report is grouped, and ordered by what the editor has to **do**: choose a
version, read the refusals, glance at the warnings, then confirm what will be
placed. Each group is a titled block with a count, and within a row the
timecode, the clip and the reason are three separate things rather than one long
sentence — the reason is the part anyone acts on, and it used to be the dimmest
text on the panel.

`--muted` was `#8d8d8d` on `#262626`, about 4.5:1, and the notes used it at
10px. It is now `#aeaeae` at 11px, and a clip name or a reason never uses the
faint colour at all.

`dev/report-preview.html` renders the report in a browser from a real run's
data, using the actual render functions and stylesheet, so layout and contrast
can be worked on **without a Premiere restart** — see `dev/README.md`.

## Layout

```
index.html              the panel
js/app.js               UI, state, and the run loop
js/plan.js              every decision made BEFORE Premiere is touched (pure, tested)
js/ppro.js              the only module that talks to premierepro
js/helper.js            the panel's side of the helper protocol
js/prefs.js             settings that persist between runs
helper/conform_helper.py  the background helper - ffmpeg and numpy live here
helper/plan_conform.py    match each cut to its graded file (timecode, then handles)
helper/find_offsets.py    frame-match a re-trimmed cut inside its graded file
helper/verify_offsets.py  check the plan against the picture before placing
scripts/fetch-ffmpeg.sh   pinned static ffmpeg into bin/ (Mac); bin/ is gitignored
scripts/install-helper.sh installs it as a launchd agent (Mac)
scripts/install-helper.ps1 installs it as a logon Scheduled Task (Windows)
tests/                  run with scripts/run-tests.sh (jsc - there is no Node here)
tests/portability-test.js  static guard: no Mac path in panel code or the helper
```

## Install

```bash
scripts/install-dev.sh
```

Symlinks the working copy into the UXP plugins folder **and registers it** —
Premiere does not scan that folder, it reads
`~/Library/Application Support/Adobe/UXP/PluginsInfo/v1/premierepro.json`, and an
unregistered plugin is ignored silently.

On Windows:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-dev.ps1
```

Same two steps against `%APPDATA%\Adobe\UXP\Plugins\External` and
`%APPDATA%\Adobe\UXP\PluginsInfo\v1\premierepro.json`, using a directory
junction (no admin, no Developer Mode). `scripts\uninstall-dev.ps1` removes it.

### Windows

The panel JS never names a platform path: it works from folder entries the
editor picked and never calls `getEntryWithUrl`. Two things did need doing for
Windows. `normalisePath` (in `js/plan.js` and, identically, `js/ppro.js`) now
turns backslashes round and upper-cases the drive letter, so a graded file
compares equal to itself whichever way Premiere spells it; a UNC path keeps
its double lead. And the helper derives its roots from the platform —
`%APPDATA%\Adobe\UXP\PluginsStorage` for the queue, the Consolidator's
`bin/` beside this repo then `PATH` for ffmpeg — instead of spelling out a Mac
path. `tests/portability-test.js` holds both to that.

**Verified on a Windows machine (Premiere 26.5.2, Windows 11 ARM64, Parallels,
2026-10-06):** the panel loads and reads the project, `install-helper.ps1`
registered the Scheduled Task, and the helper found the queue the panel
created and was heartbeating within seconds. Premiere there reports
`project.path` as `\\?\C:\...`; `normalisePath` strips that prefix. Not
exercised: an actual conform (no graded footage on the VM).

Then restart Premiere. **Closing and reopening the panel does not reload its
code** — only restarting Premiere does, so batch changes rather than testing one
at a time.

## Tests

```bash
scripts/run-tests.sh
```

Around 285 assertions, all pure logic under `jsc` — there is no Node on this
machine, and the UXP runtime cannot be driven from outside.

`plan-test.js` covers the placement decisions; `locked-access-test.js` is a
static guard over `js/ppro.js` for the rules no unit test can reach — every
`create*Action` must be created inside `lockedAccess`, every value it is built
from too, every pipeline function must re-resolve its sequence by GUID, the
Motion rebase must survive, and the audio removal must never ripple.
`exports-test.js` catches the class of bug where a function is written, used by
`app.js` and never exported — which fails only at the moment of placing, after
the run has already duplicated a sequence and imported files.

`real-run-test.js` runs the whole pipeline against a **real captured job**
(`tests/fixtures/real-run.json`: the plan, the clips and the verdicts from an
actual conform) and checks the output is COMPLETE rather than checking
particular values — every placement that can be scaled has a scale, every one
is frame-aligned, every refusal names a clip and a reason.

That is deliberately not a field-name checklist. Five bugs here have had one
shape — a value computed correctly and never delivered — and every one passed
its unit tests, because a hand-built fixture supplies the very field that is
missing in real life. A checklist only catches names someone thought to list;
a completeness check catches whichever field goes missing next, because the
placement it feeds comes out incomplete. Proven by reintroducing the real bug:
the test fails and names the two affected cuts.

**Do not hand-edit the fixture to make a test pass.** Re-capture it.

The Python side is checked against saved output rather than by unit tests: a
refactor of `verify_offsets.py` or `plan_conform.py` is proved by re-running it
over a kit and a plan from a real job and diffing the result field by field.
Both current versions reproduce the live run exactly.

## Note on handles

The skill's key signal is that fixed-handle exports give
`gradedDur - cutDur == 2 × handle`, and the cut then places exactly. That holds
where the grade was exported with fixed handles. It did not hold on the job this was built on: the exports carry 22, 7, 0, 2 and 10 frames on different
clips. `plan_conform.py` now also recognises the zero-difference case — where
the graded file *is* the cut, to the frame, there is exactly one offset that can
be right and it needs no frame search. Everything else needs `find_offsets.py`.
