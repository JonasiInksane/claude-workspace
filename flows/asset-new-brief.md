---
title: "Asset: new brief"
description: "Start an asset: brief, concept views and open questions. Stops before any model is made."
target: agent
project: "game-dev"
agent: "asset-builder"
permissionMode: "acceptEdits"
effort: "medium"
---

Start a new asset from the concept images I uploaded to your image folder (dated subfolders, newest first, or directly in the folder; my notes may name the files). My notes for this run say what the asset is: its style (the game's look it belongs to), name, category, class, size and source, or what you should ask me about.

1. Pick the source with me if my notes don't say: procedural (the default; hard-surface and stylized props, modular pieces), meshy (organic or detailed shapes) or library (a CC0 placeholder). Say which you suggest and why. node tools/asset.mjs list shows the styles; if the style doesn't exist yet, ask me before creating it with node tools/asset.mjs new-style <style>. Read its styles/<style>/art-bible.md and golden/ if they are written.
2. Create it: node tools/asset.mjs new <style>/<category>/<Name> --class <class> --height <m> --source <source> (add --width and --depth when known; the classes come from the style's spec).
3. Bring the images in with node tools/asset.mjs concept <asset> <image> --as <front|side|back|three-quarter|sheet|detail-what> (not a plain copy). Separate views go in under those names. A character or design sheet goes in as sheet; crop each detail you need with --crop x,y,w,h (pixels from the top-left) and --scale to enlarge small ones, then look at the crop and adjust until it frames the detail.
4. Fill in brief.md: purpose, must keep, may simplify, depth and hidden sides, materials. Take the hex colours from concept/*.json, using tight crops (or --colors-only) on each material, not from guesses.
5. Check the views for the chosen source. For meshy: one subject, plain background, no cast shadows or strong lighting, the same pose and scale in every view, at least 1024 px. For procedural: are the proportions and hidden sides clear enough to build from? Say plainly what is missing.

Done when the asset folder exists with a filled brief and the concept views, and you have listed your open questions. Stop there: no model is generated or cleaned in this run.
