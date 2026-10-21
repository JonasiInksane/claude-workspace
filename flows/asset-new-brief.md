---
title: "Asset: new brief"
description: "Start an asset: brief, concept views and open questions. Stops before any model is made."
target: agent
project: "game-dev"
agent: "asset-builder"
permissionMode: "acceptEdits"
effort: "medium"
---

Start a new asset from the concept views I uploaded to your image folder (the newest dated folder, unless my notes name other files). My notes for this run say what the asset is: its name, category, class, size and source, or what you should ask me about.

1. Pick the source with me if my notes don't say: procedural (the default; hard-surface and stylized props, modular pieces), meshy (organic or detailed shapes) or library (a CC0 placeholder). Say which you suggest and why.
2. Create it: node tools/asset.mjs new <category>/<Name> --class <class> --height <m> --source <source> (add --width and --depth when known).
3. Copy the views into its concept/ folder as front.png, side.png, back.png and three-quarter.png (whichever exist). Annotated sheets go in as sheet.png; they are not generator inputs.
4. Fill in brief.md: purpose, must keep, may simplify, depth and hidden sides, materials with hex colours.
5. Check the views for the chosen source. For meshy: one subject, plain background, no cast shadows or strong lighting, the same pose and scale in every view, at least 1024 px. For procedural: are the proportions and hidden sides clear enough to build from? Say plainly what is missing.

Done when the asset folder exists with a filled brief and the concept views, and you have listed your open questions. Stop there: no model is generated or cleaned in this run.
