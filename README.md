# Tinkercad 3D Print Pre-Check (`print-check`)

A 100% client-side GitHub Pages web application that lets students check their exported Tinkercad `.stl` models **before** submitting them to be printed. Everything runs inside the student's browser (including Chromebooks) with zero server uploads and zero external runtime dependencies.

## What It Checks

1. **Bed Fit & Auto-Placement**: Automatically drops the model onto the print bed ($Z = 0$) and centers it without changing its rotation, then checks both supported printer build volumes:
   - **Bambu Lab P1S / P1P**: `256 × 256 × 250 mm` (PLA, 0.4 mm nozzle, 0.20 mm layer height)
   - **Flashforge Adventurer 5M**: `220 × 220 × 220 mm` (PLA, 0.4 mm nozzle, 0.20 mm layer height)
2. **Watertight Surface (Mesh Topology)**: Detects open holes, broken non-manifold edges, and inside-out (inverted) shells while filtering out harmless Tinkercad CSG slivers and edge-kissing artifacts.
3. **Floating Parts**: Catches disconnected pieces that would print in mid-air. A piece counts as supported only if its underside rests on the bed or on another part (within 0.15 mm, over some real overlap), or is sunk into one. Touching only sideways does not count. Checked against OrcaSlicer's own "floating regions" warning (supports off): it agrees on every model where separate pieces float. Overhangs inside a single piece are reported separately as needing support.
4. **Wall Thickness & Overhangs**: Raycasts inward from exposed faces to warn about fragile walls (`< 0.8 mm`) and steep overhangs (`> 45°`) that require support material.
5. **In-Browser Layer Slicing & Print Time Limit**: Slices the triangle mesh at every `0.20 mm` layer, detects empty layer gaps, estimates support columns, and calculates print time calibrated against OrcaSlicer's `Bambu Lab P1S` and `Flashforge Adventurer 5M` PLA profiles.
6. **Printer Time Range**: Shows estimates on both supported printers. The teacher chooses the printer. Estimates between 80% and 100% of the class limit require teacher review; above the limit is a failure. This margin is a screening rule, not a guarantee.

Print times are approximate, not slicer results or print guarantees. Settings, supports, startup routines, geometry, and printer behavior can change the actual time. The teacher should confirm the final file and time in their slicer. Mesh cleanup removes duplicate and degenerate triangles; wall and overhang checks sample the surface, so small defects may be missed. Warnings and a passing result do not guarantee a successful print.

When a model is over time, the app evaluates several smaller proportional sizes and may offer one as a starting point. It checks the scaled mesh and estimates its time, but cannot determine whether the size, holes, text, or other details suit the intended use. Students must check those themselves, export the changed model, and run the new file through this tool again.

**Fix it for me.** For a floating part with a measurable gap, or a print that is over the time limit and has a suggested smaller size, the issue card shows a "Fix it for me" button. It lowers the part by the gap plus 0.1 mm, or scales the model down to the suggested size, checks the result again, and offers a fixed STL to download next to the Tinkercad steps. The change is kept only if the new check has fewer failing checks and no new ones; otherwise the original file is checked again and the student is told it could not be fixed automatically. The student's Tinkercad project is not changed. Add `?fix=off` to the link to hide the button.

## Teacher URL Parameters

Configure the page for your class by sharing a link with query parameters (students cannot edit the time limit in the UI):

| Parameter | Default | Example | Description |
|---|---|---|---|
| `max` | `30` | `?max=30` or `?max=45` | Maximum allowed print time in minutes (`1`–`600`). |
| `learn` | optional | `?max=30&learn=required` | Mark applicable learning questions as required and withhold the ready-to-submit message until they are answered correctly. This is a classroom prompt, not enforced access control. |
| `fix` | on | `?fix=off` | Hide the "Fix it for me" button. |

**Example links:**
- Standard 30-minute limit, with estimates for both printers: `https://maravedi.github.io/print-check/?max=30`
- Require applicable learning questions: `https://maravedi.github.io/print-check/?max=30&learn=required`

Learning questions appear alongside applicable findings. Students can request a hint or reveal an explanation. The app compares consecutive successful checks in the current page session, naming both files; students should confirm that they are versions of the same design. It only reports an earlier issue as passing when the new check explicitly passes that category. Results and answers disappear on refresh and are not sent to a server. No question is shown when there is no applicable finding.

## Deploying to GitHub Pages

The site has no build step. `.github/workflows/pages.yml` copies only `index.html`, `styles.css`, `js/`, `fonts/` and `LICENSE` to Pages, so `tests/` and `tools/` are not published.

1. Create the GitHub repository and push this folder to `main`.
2. In the repository, open Settings, then Pages, and set Source to **GitHub Actions**.
3. Each push to `main` redeploys the site. The site is at `https://maravedi.github.io/print-check/`.

Before pushing, review `git status --short` and the staged files. The project ignores student STL/3MF files, local Orca profiles, calibration output and design-tool cache. Do not add student work or derived filenames without permission. A public GitHub Pages site and its query parameters are not an access-control or anti-cheating system.

## Preview locally

Serve this directory over HTTP; opening `index.html` directly does not reliably support modules and workers:

```bash
python3 -m http.server 8000 --bind 127.0.0.1
```

Open `http://127.0.0.1:8000/?max=30`. Stop the server with Ctrl+C. To share on a trusted network, bind to that interface's address instead.

## Running Tests & CLI Locally

Use a current Node.js release with native ES module support (Node 22 or newer recommended). No npm installation is required. The optional student-model test is skipped when those private files are absent; the remaining tests use synthetic models.

```bash
# Run the automated test suite
node --test tests/*.test.mjs

# Audit one or more STL files from the command line
node tools/precheck-cli.mjs --printer p1s path/to/model.stl
```

The CLI checks one selected printer and reports a time estimate only when topology is acceptable. Its verdict covers mesh checks, not the browser's class time limit or two-printer review policy.

The calibration tools are optional developer utilities. `orca_profiles.py` and `orca_calibrate.py` currently expect OrcaSlicer in `/Applications/OrcaSlicer.app` on macOS; generate local profiles first. `fit_estimator.mjs` expects ignored calibration data and local model files. Those inputs are not distributed. Published accuracy should be measured on independent, shareable models as well as the calibration set.

## License

MIT; see [LICENSE](LICENSE).

## Fonts

`fonts/DMSans-latin.woff2` is DM Sans (SIL Open Font License 1.1), self-hosted so the page makes no outside requests. It matches the font used by the class city site.

## Private test models

Tests that use real student models read their file names from `tests/private-fixtures.json` (git-ignored, so names never reach the public repo). Map an alias to a file beside this folder, for example `{"keychain": "Keyboard Keychain.stl", "frog": "...", "duck": "...", "egg": "..."}`. Without that file those two tests are skipped.
