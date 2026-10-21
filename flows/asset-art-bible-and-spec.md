---
title: "Asset: art bible and spec"
description: "Once, before the first asset: agree the visual rules and budgets every asset is checked against."
target: agent
project: "game-dev"
agent: "asset-builder"
permissionMode: "plan"
effort: "high"
---

Help me set the art direction for the assets this pipeline will make, so every later asset is checked against the same rules.

Before proposing anything, ask me what you need to know: the camera (first-person, third-person, top-down), the target hardware, PBR or hand-painted, and what the attached images are for. Images labeled "match" are style anchors; images labeled "mood" set the feeling only.

Then propose two things and wait for my OK before writing either:
1. assets/_style/art-bible.md: a one-line visual identity, palette with hex values, shape and silhouette rules, material rules (albedo range, how rough or shiny), and the golden-asset rule (the first approved asset becomes the reference for scale, detail and colour).
2. Changes to assets/_style/spec.json (triangle budgets and texture sizes per class, texel density), with the reason for each number. Keep the current structure; tools/asset.mjs and tools/blender/check.py read it.

Done when both files are written after my approval and `node tools/asset.mjs selftest` still passes.
