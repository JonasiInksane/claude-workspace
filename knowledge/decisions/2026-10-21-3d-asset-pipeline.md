---
title: "3D asset pipeline: scripted Blender checks, Meshy by hand first"
tags: [decision, gamedev, 3d, blender, meshy, assets, agents]
updated: 2026-10-21
claude_code_version: 2.1.306
---

# 3D asset pipeline: scripted Blender checks, Meshy by hand first

**TL;DR:** `projects/game-dev` is a tools project (no game). Its first tool turns concept art into
checked 3D models: Meshy generates (web app for now), headless Blender 5.2 scripts clean, check
and render, one `asset-builder` agent runs them, and the user approves at fixed gates.

## Context

- The user wants agents for game development, starting with clean 3D asset building from
  concept art; no specific game and no engine yet.
- Research: [Concept art to 3D game assets](../../reports/2026-10-21_concept-art-to-3d-assets/report.md).
  Image-to-3D is good enough for props, not for hero or deforming assets; agents are reliable
  as operators of scripts with exit codes, unreliable at judging looks or modelling detail.
- This PC: Intel UHD + Radeon 530 (about 2 GB VRAM, no CUDA), so local generation models can't
  run; Unity 6000.4.11f1 and Git LFS are installed.

## Options

| Topic | Options considered |
|---|---|
| Generation | Meshy (API, official MCP, paid output owned by the user), Tripo, Rodin (API only on a $120/month plan), local models (not possible on this GPU), Unity's generator (placeholders) |
| Cleanup and checks | Headless Blender scripts with exit codes; an agent driving Blender through MCP; manual work |
| Engine | Unity 6 (installed), Godot, none yet |
| MCP servers | None; community Blender MCP (four CVEs in 2026, unauthenticated socket); Blender Lab official; Unity MCP |

## Decision

- **Project:** `projects/game-dev`, from the game template, as a toolbox; no engine for now
  (the user's choice). Exports are GLB and FBX so any engine can take them later.
- **Blender 5.2.2 LTS** via winget, pinned (`winget pin add --id BlenderFoundation.Blender`).
  The scripts refuse other versions, so an update can't silently change their behaviour.
- **Scripts, not MCP:** `node tools/asset.mjs new | clean | check | review | selftest`.
  `check --stage final` fails (exit 1) on hard rules; looks only warn. `selftest` proves every
  rule with deliberately broken models.
- **Three sources per asset**, a field in `asset.json`: `procedural` (default; the agent writes
  a `build.py` recipe with `tools/blender/kit.py`, for hard-surface and stylized props),
  `meshy` (for organic or detailed shapes) and `library` (CC0 placeholders). Everything from
  `gen/raw.glb` on is shared. Recipes may only call the kit, `math` and basic Python; `build`
  refuses the rest before running, so `build` could be pre-approved like the other commands.
  A test barrel built this way: 1,056 triangles, exact size, every check passing, flat colours.
- **Meshy:** the user tests the free web app first; Meshy Pro and an API script only if the
  quality holds up. Paid-plan output is the user's; free output is CC BY 4.0.
- **One agent** (`asset-builder`, opus, medium effort) plus five flows in `flows/asset-*.md`;
  a separate reviewer agent only after the first approved asset.
- **Styles, not one global spec** (added the same day, after the pilot): the project serves many
  games, so each game's art direction is a style in `styles/<style>/` (`spec.json`,
  `art-bible.md`, `golden/`) and assets live in `assets/<style>/<category>/<Name>/`. Every
  `asset.json` names its style and the checks use that style's spec. `styles/default/` is the
  template for `node tools/asset.mjs new-style` and the selftest's spec. First style: `lunafen`.

## Consequences

- Each asset needs a written brief and clean concept views; the user gives verdicts at the
  brief, the raw model and the final review.
- No LODs or colliders in the pipeline: Unity (Mesh LOD) and Godot make them at import.
- Shipping AI-generated meshes on Steam means disclosing AI content; the brief's log and
  `review/clean.json` record what was generated and how.
- The API key, once there, lives only in the user's Windows environment (`MESHY_API_KEY`).
