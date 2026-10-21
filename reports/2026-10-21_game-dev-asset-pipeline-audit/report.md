# game-dev asset pipeline: audit

2026-10-21. Scope: the whole path of one asset, from concept upload in the workspace app,
through the five `flows/asset-*.md` flows and the `asset-builder` agent, to the scripts in
`projects/game-dev/tools/`, the user's verdict and git. Read-only review of the code plus the
facts checked on this machine; no agent session was run.

## Summary

- **Where it stands.** The scripted core is solid and proven: `node tools/asset.mjs selftest`
  covers every check rule, the cleanup of a messy model, a procedural build and the recipe guard.
  Everything around it (your verdicts, comparing with the concept, keeping assets consistent)
  still depends on manual steps and the agent's eyes.
- **Biggest risk.** The flows and the agent have never run for real. No asset has gone through
  it yet, so prompt wording and permission prompts in a live session are untested.
- **Biggest gap.** The human gates have no interface. To see renders you open folders; to approve
  you edit `asset.json` by hand; and the deterministic steps (build, clean, check, review) run
  inside agent sessions that cost tokens and time although no judgement is needed.
- **Recommended next step.** A supervised pilot asset (a simple prop, procedural), then an
  "Assets" view in the app with side-by-side review and approve/revise buttons.

## Findings

| # | Area | Finding | Impact | Fix | Size |
|---|---|---|---|---|---|
| 1 | Whole flow | Never run end to end with a real agent session and real concept art. Flow prompts, the agent's handling of its image folder and the permission prompts it hits (copying images with `Copy-Item` is not pre-approved) are unverified | High: first real use may stall or drift | Pilot one prop under supervision; optionally a headless dry run of "Asset: new brief" in a scratch copy, reading `permission_denials` from the JSON result | Small |
| 2 | Human gates | Review renders are only visible by opening `review/`; the app serves images from `inbox/` only (`tools/workspace-app/app.mjs`), so it can't show them. Approving means editing `asset.json` by hand: no command or button sets `approved` | High: the gates the research relies on are the clumsiest step | App "Assets" view for game-dev: each asset's status, concept next to renders, check results, and Approve / Revise (numbered notes) / Reject buttons that write the verdict to `asset.json` and the brief | Medium |
| 3 | Cost and speed | `build`, `clean`, `check` and `review` are deterministic but only reachable through agent flows | Medium: tokens and minutes per asset for steps without judgement | Buttons for those commands in the same Assets view, showing their output; agents only for the brief, the recipe and the comparison | Small, with #2 |
| 4 | Consistency | No shared palette: every procedural recipe defines its own colours. The golden asset is described in the docs but nothing uses it (`golden` appears nowhere in `tools/`). The art bible is written but nothing reads it | Medium: assets drift apart in colour and scale, the research's main consistency lever | `assets/_style/palette.json` that `kit.palette()` can reference by name, with `check` warning about base colours off the palette; `review` renders the golden asset beside the new one when one is set in `spec.json` | Small to medium |
| 5 | Concept intake | Concept images are copied and judged by hand: no check on resolution, background or aspect, and naming relies on the agent | Medium: bad inputs waste generations and rounds | `node tools/asset.mjs concept <asset> <files…>`: copies the uploads with the standard names, reports size, background uniformity (corner pixels) and aspect, and fails under 1024 px | Small |
| 6 | Comparison | Comparing renders with the concept is the agent's eyes only, view by view in separate files | Medium: the step where agents over-claim | `review` writes `compare_<view>.png` (concept left, render right, same height) and an advisory silhouette-overlap score per view when the concept has a plain background | Medium |
| 7 | Provenance | Nothing records where a meshy or library model came from or its licence (only a reminder comment in `tools/asset.mjs`); procedural builds record the recipe hash in `gen/build.json` | Medium: licence and Steam AI disclosure depend on memory | `provenance` in `asset.json` (service and model or URL, licence, plan, date); `check --stage final` fails a meshy or library asset without it | Small |
| 8 | Robustness | Blender runs have no timeout; an EXACT boolean (`kit.cut`) on a heavy mesh can hang and block the agent's session | Low to medium | Timeout on every Blender run (10 minutes), reported as a failure with the log path | Small |
| 9 | Flow friction | Three of the five flows need the asset typed into the run notes each time; nothing lists the assets and their state | Low | `node tools/asset.mjs list` (name, source, status, last check); flow variables in the app later (the prompt research's next step 3) | Small |
| 10 | Git size | Every round's review PNGs and logs-adjacent images would be committed (only `*.log` is ignored), and they are in Git LFS | Low now, grows per asset | Track `final_*.png` and the JSON records; ignore `raw_*.png` (regenerated by `review --stage raw`) | Small |
| 11 | Kit vocabulary | No tube or pipe along points, no arcs, no per-part flat/smooth choice, no array along a line | Low until a real asset needs them | Add per pilot findings, each with a selftest recipe | Medium |
| 12 | Checks not covered | UV overlaps, self-intersecting geometry and painted-in lighting are not checked | Low: generators lay out their own UVs; lighting is judged at G4 | Leave as user judgement for now; revisit after a few meshy assets | — |

## What is fine and should stay

- Scripts with exit codes for every deterministic step, and `selftest` proving the rules with
  broken fixtures.
- The split between sources, with everything from `gen/raw.glb` on shared.
- The recipe guard on `build.py` and the pre-approved command list in `.claude/settings.json`.
- One asset per session, the brief as the state, and only the user approving.

## Suggested order

1. Pilot asset (#1), noting every friction point.
2. Small fixes found by the pilot plus #5, #7, #8, #10 (one sitting).
3. The app's Assets view (#2, #3), with the approval written by the app.
4. Shared palette and golden asset (#4), then side-by-side comparison (#6).
5. Kit additions as real assets need them (#11).
