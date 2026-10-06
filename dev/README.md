# dev/ — looking at the panel without restarting Premiere

A UXP panel only reloads its JS and CSS when **Premiere itself restarts**, which
makes iterating on the report layout painfully slow: one wording change, one
restart, one Check.

`report-preview.html` (multi-clip) and `whole-preview.html` (single master and mix
stems) are the real thing, not a mock-up. It is generated with the
**actual** `renderCheck` / `renderVersions` / `renderVerification` / `section` /
`row` functions sliced verbatim out of `js/app.js`, the real `js/plan.js`, the
real `css/style.css`, and a real run's data. Only `require`, `state` and the
click handlers are stubbed.

Regenerate it after changing those renderers — otherwise it is a screenshot of
what the panel used to do, which is worse than having no preview at all.

Serve it (a `file://` page cannot run its scripts):

```bash
python3 -m http.server 8787 --directory .
```

then open <http://localhost:8787/dev/report-preview.html>. There is a
`panel-preview` entry in `.claude/launch.json` at the session root that does the
same thing.

## Never hand-fix the data

The dump scripts build their JSON by calling the real `plan.js`. If a field is
missing, **fix the code, do not add the field to the dump** — a harness you
hand-feed can only tell you the renderer works, never that the data reaches it.
The version picker was invisible in the panel for its whole life while looking
perfect here, because the dump script carried a line setting `versions` that
`applyVerification` was dropping.
