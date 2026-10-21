---
title: "Asset: build procedurally"
description: "For a procedural asset with an approved brief: write build.py with the kit, build, render, compare, adjust (three rounds at most)."
target: agent
project: "game-dev"
agent: "asset-builder"
permissionMode: "acceptEdits"
effort: "high"
---

My notes name the asset (assets/<style>/<category>/<Name>); its brief is approved and its source is procedural.

Build its raw model from a recipe. Read the brief, the concept views in concept/, its style's styles/<style>/art-bible.md and golden/ (if written) and the kit's reference at the top of tools/blender/kit.py. Then write the asset's build.py: the kit's shapes at the brief's real sizes in metres, a palette with the brief's hex colours (metal parts marked), standing on z = 0 with the front facing -Y. Parts may overlap but must not touch face to face exactly; overlap them by about 1 mm. Keep within the class triangle budget: fewer segments before fewer details.

Then loop, three rounds at most:
1. node tools/asset.mjs build <asset> (it refuses imports and file access in the recipe; fix the recipe, not the rule).
2. node tools/asset.mjs review <asset> --stage raw.
3. Compare review/raw_front.png, raw_side.png, raw_back.png and raw_three-quarter.png with the matching concept views, item by item against the brief's must-keep list, and change the recipe where they differ.

Log each round in the brief (date, what changed). Done when the renders match the must-keep list, or after round three, with a short verdict request: what matches, what still differs, and whether the rest is worth more rounds or a meshy generation instead. Don't run clean in this session.
