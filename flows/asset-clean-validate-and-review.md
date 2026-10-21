---
title: "Asset: clean, validate and review"
description: "From an approved raw model to a checked GLB and FBX with a review pack. Also takes numbered revision notes."
target: agent
project: "game-dev"
agent: "asset-builder"
permissionMode: "acceptEdits"
effort: "medium"
---

My notes name the asset (assets/<style>/<category>/<Name>), and may add numbered revision notes from an earlier review.

1. Apply any revision notes that are yours to apply (a procedural asset's build.py, asset.json, the brief). A meshy or library asset needs its provenance in asset.json (where it came from and its licence) before it can pass.
2. node tools/asset.mjs finalize <asset>: it rebuilds a procedural asset, then cleans, runs check --stage final and renders the review, stopping at the first failure.
3. If it stops, find the cause in review/check-final.json (its "where" entries say where a defect is) and review/clean.json. Fix only what is yours to fix (the recipe, asset.json size or pivot, the brief); a defect in a generated model needs a new generation, so say so. If the same fix fails twice, stop and explain.
4. Write review/compare.md: for each must-keep item, whether it is visible in review/final_*.png (final_material.png shows real materials, such as how metal shines), plus numbered differences from the concept and anything the warnings in check-final.json suggest (texel density, albedo range). Earlier rounds' renders are in review/history/ if you need to compare.
5. Set asset.json status to review and update the brief's log.

Done when finalize ends with "finalize done", compare.md exists, and you ask me for a verdict: approve, revise (with numbered notes) or reject. You don't approve it yourself.
