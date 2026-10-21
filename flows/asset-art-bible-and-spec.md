---
title: "Asset: art bible and spec"
description: "Once per style (a game's look), before its first asset: agree the visual rules and budgets its assets are checked against."
target: agent
project: "game-dev"
agent: "asset-builder"
permissionMode: "plan"
effort: "high"
---

Help me set the art direction for one style, so every asset of that style is checked against the same rules. A style is one game's look (several games may share one); my notes name it, or ask me. node tools/asset.mjs list shows the styles that exist.

Before proposing anything, ask me what you need to know: the camera (first-person, third-person, top-down), the target hardware, PBR or hand-painted, and what the attached images are for. Images labeled "match" are style anchors; images labeled "mood" set the feeling only.

Then propose two things and wait for my OK before writing either:
1. styles/<style>/art-bible.md: a one-line visual identity, palette with hex values, shape and silhouette rules, material rules (albedo range, how rough or shiny), and the golden-asset rule (the style's first approved asset becomes the reference for scale, detail and colour, kept in styles/<style>/golden/).
2. Changes to styles/<style>/spec.json (triangle budgets and texture sizes per class, texel density), with the reason for each number. Keep the current structure; tools/asset.mjs and tools/blender/check.py read it.

If the style doesn't exist yet, create it after my OK with node tools/asset.mjs new-style <style> (it copies styles/default/spec.json and adds an art-bible.md stub and golden/), then edit those files. Leave styles/default alone: it is the template and what the selftest checks against.

Done when both files are written after my approval. If the style already has assets with an export, run node tools/asset.mjs check <asset> --stage final on each and tell me which ones the new numbers fail.
