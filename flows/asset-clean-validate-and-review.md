---
title: "Asset: clean, validate and review"
description: "From an approved raw model to a checked GLB and FBX with a review pack. Also takes numbered revision notes."
target: agent
project: "game-dev"
agent: "asset-builder"
permissionMode: "acceptEdits"
effort: "medium"
---

My notes name the asset (assets/<category>/<Name>), and may add numbered revision notes from an earlier review.

1. node tools/asset.mjs clean <asset>, then node tools/asset.mjs check <asset> --stage final.
2. If a check fails, find the cause in review/check-final.json and review/clean.json. Fix only what is yours to fix (asset.json size or pivot, the brief); a defect in the model itself needs a new generation, so say so. If the same fix fails twice, stop and explain.
3. node tools/asset.mjs review <asset>, then write review/compare.md: for each must-keep item, whether it is visible in review/final_*.png, plus numbered differences from the concept and anything the warnings in check-final.json suggest (texel density, albedo range).
4. Set asset.json status to review and update the brief's log.

Done when check --stage final exits 0, the six final renders and compare.md exist, and you ask me for a verdict: approve, revise (with numbered notes) or reject. You don't approve it yourself.
