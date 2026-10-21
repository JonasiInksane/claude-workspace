---
title: "Asset: check the raw model"
description: "For meshy and library assets, after saving the download as gen/raw.glb: numbers and renders next to the concept, for the continue-or-regenerate call."
target: agent
project: "game-dev"
agent: "asset-builder"
permissionMode: "acceptEdits"
effort: "medium"
---

My notes name the asset (assets/<category>/<Name>). I have saved the generator's download as gen/raw.glb in it.

Run node tools/asset.mjs check <asset> --stage raw and node tools/asset.mjs review <asset> --stage raw. Then compare the raw renders (review/raw_front.png and the others) with the concept views in concept/, point by point against the brief's must-keep list: what matches, what is missing or wrong, and whether the triangle count and size are reasonable to clean up.

Add a line to the brief's log: the date, the generation try number and your findings.

Done when I have a short verdict request: continue to cleanup, or regenerate (and what to change in the generator input or settings). Don't run clean in this session.
