# game-dev asset pipeline: audit, after the pilot

2026-10-21, revision 2. The pilot ran the first real asset (`assets/lunafen/props/CrystalPendant`, a
procedural pendant from the Lunafen sheet) through every flow with the real `asset-builder`
agent, headless, in five runs (about 45 minutes, $7.46). It passes `check --stage final` and
waits for the user's verdict.

## Summary

- **Where it stands.** The flow works end to end. The pilot found eleven friction points; nine
  are fixed and proven by `selftest` (13 cases).
- **Biggest remaining gap.** Still no app interface for the human gates: verdicts and renders
  live in folders and `asset.json` (finding #2 of the first audit).
- **Cost lesson.** Round 2 of the build cost $3.61 because the kit could not flatten a shape;
  round 3 with the new `scale` option and defect locations cost $2.07.
- **Recommended next step.** The app's Assets view (#2, #3), then the shared palette and golden
  asset (#4).

## Status of the first audit's findings

| # | Finding | Status |
|---|---|---|
| 1 | Never run end to end | **Done**: pilot asset through brief, build (3 rounds), finalize |
| 2 | Human gates have no interface | Open |
| 3 | Deterministic steps only through agent sessions | Partly: `finalize` runs build, clean, check and review as one command; app buttons still open |
| 4 | No shared palette or golden asset | Open |
| 5 | Concept intake unchecked | **Done**: `concept` command (crop, enlarge, size, background, measured colours) |
| 6 | Comparison eyes-only | Partly: material view and kept rounds (`review/history/`); no side-by-side image or shape score yet |
| 7 | No provenance | **Done**: `provenance` in `asset.json`, required for meshy and library assets at the final check |
| 8 | No Blender timeout | **Done**: 15 minutes per run |
| 9 | Asset name typed per flow | Partly: `list` command; flow variables in the app still open |
| 10 | Git size | Partly: earlier rounds (`review/history/`) are ignored |
| 11 | Kit vocabulary | Partly: `scale` on every shape; tubes and arcs still open |
| 12 | Unchecked: UV overlap, self-intersection, painted light | Unchanged |

## Found by the pilot

| Finding | Status |
|---|---|
| Project allow list ignored until the folder is trusted (trust is per folder) | Documented in `docs/asset-pipeline.md` and `knowledge/claude-code/permissions-and-settings.md` |
| Flow only looked in dated image folders | Fixed in "Asset: new brief" |
| No way to crop a detail from a sheet or read its colours | `concept` command |
| Colour-only measurements not saved | Saved as `concept/colors-*.json` |
| Chained commands need approval | Agent role: one command per call |
| Brief template assumed separate views | Sheet-based variant added |
| Flattened shapes needed fragile boolean cuts | `scale=(x, y, z)` on every shape |
| `check` gave counts, not locations | Up to five locations per defect, with the part name |
| Review renders can't show metal | `<stage>_material.png` with real materials |
| Each round overwrote the last | Earlier rounds kept in `review/history/` |
| Glowing or see-through materials | Open (kit) |
