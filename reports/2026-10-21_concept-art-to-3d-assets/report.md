# Concept art to 3D game assets

2026-10-21, Claude Code 2.1.306, Unity 6000.4.11f1

## Summary

- **Where things stand.** Studios still run the same chain: concept, blockout, sculpt, low-poly, UV, bake, texture, LOD/collision, engine. Indie and stylized teams skip the sculpt and the bake. Hosted image-to-3D services (Meshy, Tripo, Rodin, Hunyuan 3D) now turn a clean concept into a textured static prop in minutes, for about €0.60 to €0.80 of credits per try (prices shown 2026-10-21). A June 2026 controlled study and the practitioners agree on the limits: it works for props, blockouts and placeholders, not for hero assets or anything that bends.
- **Recommended approach.** For each asset you write a brief and provide flat-lit concept views. Meshy's API generates the model at the final triangle budget. One project agent (`asset-builder`) then runs headless Blender 5.2 scripts and Unity batchmode scripts that check every result and return a pass or fail exit code. You approve the raw shape and the final in-engine look. MCP servers are optional and come later, mainly for Unity screenshots.
- **Biggest risk.** An asset that "looks done" but never passed a numeric check. AI meshes arrive dense, with fragmented UVs and shadows painted into the colour texture, and agents in long Blender sessions have claimed success they had not reached. The defence is validation scripts with exit codes, one asset per session, and your verdict at two points. The second risk is licensing and Steam's AI disclosure: ship only paid-tier outputs and plan to disclose.
- **This machine** [local]: the GPUs are an Intel UHD and an AMD Radeon 530 (about 2 GB VRAM, no NVIDIA/CUDA), so local image-to-3D models can't run here and all generation is hosted. Unity 6000.4.11f1 and Git LFS 3.5.1 are installed. Blender is not.
- **Next step.** Approve the six decisions in "Decisions for you" at the end. Then run one simple prop through the whole pipeline before making a second asset.

Labels used below: **(vendor claim)** means a company selling the product or a competitor said it. **(search excerpt)** means the researchers saw it only in a search result, without opening the page. **(unverified)** means it was not confirmed in a primary source. **(inference)** means the researchers or this report put it together; it is not a quote. **[local]** means it was checked on this machine on 2026-10-21. **(constructed, not run)** marks commands written from the docs that have not been executed. Prices are as displayed on 2026-10-21 and change often.

## Studios lock scale, silhouette and budget before anyone sculpts

The professional chain for a game asset runs from concept with callouts, through blockout, high-poly sculpt, low-poly retopology, UVs, baking, PBR texturing, LODs and collision, to export and engine setup. Each decision costs more to reverse the further down the chain it is changed, so **scale, silhouette and the triangle budget are fixed at concept and blockout** ([Innovecs Games](https://www.innovecsgames.com/blog/how-to-make-game-assets/); [Pixune](https://pixune.com/blog/game-art-pipeline), both outsourcing studios). A game-ready spec names a triangle budget, a texel density held constant across the set, a texture set with a resolution per map, and the material-slot setup ([Innovecs Games](https://www.innovecsgames.com/blog/how-to-make-game-assets/)).

Indie and stylized pipelines mostly remove two stages. They model the low-poly directly and texture it with shared systems instead of baking:

- **Palette atlases.** One texture of colour cells shared by many models, so they all use one material. One devlog found a single-material scene far faster than one material per colour, and its models rarely needed more than about 10 colours ([Papaya Games devlog](https://papaya-games.itch.io/duck-in-town/devlog/73530/blazing-fast-rendering-with-a-single-material-per-scene)).
- **Trim sheets.** Design the texture first, then unwrap the geometry onto it. Insomniac's "Ultimate Trim" talk from GDC 2015 is the standard reference ([GDC Vault](https://gdcvault.com/play/1022323/The-Ultimate-Trim-Texturing-Techniques), description only).
- **Grid-snapped modular kits.** On Skyrim, **2 kit artists, 8 level designers and 7 kits produced 400+ cells in 30 months** ([GDC 2013 slides](https://www.slideshare.net/slideshow/gdc2013-kit-buildingfinal/17728576)).

**What a 3D concept package contains.** The package that feeds this chain is a set of aligned orthographic views: front, side and back, plus top for props and vehicles. They are drawn in clean line or flat colour, with:

- written material callouts,
- the other side of anything asymmetric,
- repeating patterns as separate high-resolution files ([Beyond Skyrim wiki](https://wiki.beyondskyrim.org/wiki/Arcane_University:2D_definitions), search excerpt).

Published briefs add camera and mechanics, annotated and negative references ("show what you don't want"), deliverables, technical limits, approval stages and evaluation criteria ([Game Developer](https://www.gamedeveloper.com/design/crafting-the-perfect-game-art-brief); [Allcorrect Games](https://allcorrectgames.com/insights/brief-for-developing-game-art/), vendor). None of them publishes numeric budgets or acceptance criteria; those come from each project's own art bible. One difference matters here: an image-to-3D service sees only pixels, while an agent reads text reliably. So scale bars, swatches and callouts belong in a text brief next to clean generator images, not painted onto them (inference).

**How style stays consistent.** Small teams rely on a few measurable rules plus one lead-approved "golden" asset that every new asset is matched against. A written guide alone is not enough ([Polycount](https://polycount.com/discussion/comment/1692265), practitioner opinion, search excerpt). Valve's public Dota 2 guide makes silhouette and value the first test: identifiable at a glance, detail and intensity falling off away from the focal area, and judged in context at gameplay distance ([CG Channel](https://www.cgchannel.com/2012/06/valve-releases-useful-character-design-guide)).

For PBR, Adobe gives hard limits ([Adobe PBR Guide](https://www.adobe.com/learn/substance-3d-designer/web/the-pbr-guide-part-2)):

| Value | Limit |
|---|---|
| Non-metal base colour | **30 to 240 sRGB** (50 as the strict lower bound) |
| Raw metal base colour | **180 to 255 sRGB** |
| Lighting or AO in base colour | none |

That last rule conflicts with Valve's stylized practice of painting light into the colour texture ([Steam Support](https://support.steampowered.com/kb/8700-SJKN-4322/dota-2-character-texture-guide), search excerpt). The art bible has to pick one. Generators fed moody, lit paintings end up in the painted camp by accident (inference).

**Reviews and time.** Reviews happen at fixed stages against the style sheet. Feedback works best as numbered marks on clean screenshots that the artist supplies ([Polycount](https://polycount.com/discussion/comment/2808807/), practitioner opinion, search excerpt). For scale, studio estimates posted on Polycount put a skilled artist at ([Polycount](https://polycount.com/discussion/comment/1003743), exact wording unverified):

| Asset | Time |
|---|---|
| Barrel | 4 to 8 hours |
| Well or boulder | 8 to 16 hours |
| Rifle | about 2 weeks |
| Vehicle | 2 to 4 weeks |
| Realistic character | 1 to 3 months |

Characters cost more because they add deformation topology, a skeleton, skinning and animation tests. Unity's Humanoid setup expects a T-pose, at least 15 bones and, by default, 4 bone influences per vertex ([Unity Manual](https://docs.unity3d.com/6000.4/Documentation/Manual/UsingHumanoidChars.html)).

| Stage | Studio (AAA) | Indie / stylized | This setup (AI-assisted) |
|---|---|---|---|
| Concept | Ortho sheet with callouts | Same, fewer views | Flat-lit front/side/back/three-quarter PNGs plus `brief.md` |
| Blockout | Grey box in engine at real scale | Often merged with low-poly | First AI generation serves as the blockout (gate G2) |
| High-poly | Sculpt or subdivision | Skipped | The AI mesh is effectively the "high" |
| Low-poly / retopo | Manual | Model low directly | Server-side `target_polycount` or smart topology; manual only for heroes |
| UV | At target texel density | Onto trim or palette atlas | Keep the generator's UVs; re-UV only when re-baking |
| Bake | Normal, AO, curvature | Skipped (bevels, weighted normals) | Hero props only (Cycles bake) |
| Texture | PBR in Substance | Trim, atlas, hand paint | Generator PBR maps, repacked for URP |
| LOD / collision | `_LODn` meshes, primitives | Same | Unity Mesh LOD or `_LODn`; primitives first |
| Engine | Material + prefab | Same | AssetPostprocessor rules plus a batchmode validator |

## Unity's importer is the real spec sheet

The engine's import rules are the one spec that is not a matter of opinion:

- **Units.** Unity's physics treats 1 unit as 1 metre ([Unity FBX Importer](https://docs.unity3d.com/6000.4/Documentation/Manual/FBXImporter-Model.html)).
- **Normal maps.** Unity expects Y+ ("OpenGL") normal maps, and nothing in the file says which convention a map uses, so a flipped green channel has to be checked by eye ([Unity Manual](https://docs.unity3d.com/6000.4/Documentation/Manual/StandardShaderMaterialParameterNormalMap.html); [CGAxis](https://cgaxis.com/which-normal-map-should-i-use-opengl-or-directx/)).
- **URP mask texture.** URP Lit reads one linear mask: **R = Metallic, G = Occlusion, B unused, A = Smoothness**, with sRGB off and the same texture in both the Metallic and Occlusion slots ([Unity URP channel packing](https://docs.unity3d.com/Manual/urp/shaders-in-universalrp-channel-packed-texture.html)).
- **Roughness vs smoothness.** glTF stores roughness in G and metallic in B ([Blender glTF manual](https://docs.blender.org/manual/en/3.3/addons/import_export/scene_gltf2.html)). So AI texture sets in glTF style need converting to smoothness (1 minus roughness) and repacking before URP can use them.
- **LODs.** Mesh names ending in `_LOD0`, `_LOD1` and so on make Unity build a LOD Group on import, up to 8 levels ([Unity LOD Group](https://docs.unity3d.com/6000.4/Documentation/Manual/lod-group-configure.html)). Since 6.2, **Mesh LOD** can instead generate LODs at import inside one mesh. It saves memory but only changes geometry, and Unity advises against combining it with `_LODn` meshes ([Unity Mesh LOD](https://docs.unity3d.com/6000.2/Documentation/Manual/lod/mesh-lod-generate-lods.html)).
- **Colliders.** Convex mesh colliders are capped at 255 triangles, and mesh colliders should be used sparingly ([Unity Mesh Collider](https://docs.unity3d.com/es/2018.4/Manual/class-MeshCollider.html); [Unity Discussions](https://discussions.unity.com/t/can-we-have-new-system-that-gets-rid-of-this-physics-collider-limitation-in-unity-6/950590)).
- **Formats.** FBX imports natively. glTF needs the glTFast package ([glTFast](https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.5/manual/features.html)).

**Scale bugs start in Blender.** With default settings, FBX files from Blender often arrive in Unity 100 times too large. The community fix is consistent across guides ([Katsbits](https://www.katsbits.com/codex/unity-blender-fbx-scale); [Cinevva](https://app.cinevva.com/guides/blender-to-unity-export-checklist); [Unity Discussions](https://discussions.unity.com/t/imported-models-from-blender-2-77-are-scaled-x100-in-unity-5-3/167005)):

1. Metric scene at Unit Scale 1.0.
2. Exporter Apply Scalings set to "FBX Units Scale".
3. Forward −Z, up Y.
4. Apply transforms before export.
5. Tick Bake Axis Conversion in Unity.

Blender's own manual still leaves Apply Scalings as a TODO. Blender 5.2's FBX exporter defaults to `apply_scale_options='FBX_SCALE_NONE'`, `mesh_smooth_type='OFF'` and `add_leaf_bones=True`, so a game export script has to override all three ([bpy.ops.export_scene 5.2](https://docs.blender.org/api/current/bpy.ops.export_scene.html)).

**Budgets.** Public per-asset numbers are rare. The best studio spec found is Valve's Dota 2 Workshop: Tusk's head slot allows **3,000 triangles at LoD0 and 1,200 at LoD1 with a 512² texture**, and LoD1 is exactly 40% of LoD0 in every row ([Dota 2 Workshop: Tusk](https://www.dota2.com/workshop/requirements/tusk)). Large items reach 10,000 to 11,000 triangles ([Undying](https://www.dota2.com/workshop/requirements/undying); [Ringmaster](https://www.dota2.com/workshop/requirements/ringmaster?l=english)). Vendor ranges for characters disagree by a factor of ten ([Neural4D](https://blog.neural4d.com/user-guide/polygon-count-for-3d-game-assets/); [Tripo](https://www.tripo3d.ai/blog/poly-count-for-game-assets-how-to-prepare-ai-3d-models), both vendor claims).

**Texel density** converges on **512 px/m for third-person and 1,024 px/m for first-person**, and 256 px/m or less for top-down. An object whose density differs from its surroundings stands out ([Maxon C4D Help](https://help.maxon.net/c4d/2026/en-us/Content/html/Texel_Density.html)). Unity Learn suggests halving triangles at each LOD step. Simplygon warns that flat ratios fail on some assets ([Unity Learn](https://learn.unity.com/tutorial/level-of-detail-3653); [Simplygon](https://simplygon.com/posts/b83478b7-a2a1-46a9-a0e1-cba3da7da307)). These numbers feed the default spec in setup section 5.

## Image-to-3D is ready for static props, not for heroes or anything that bends

| Service (Oct 2026) | Best at | Game-pipeline controls | API access and price (shown 2026-10-21) | Rights in outputs |
|---|---|---|---|---|
| [Meshy](https://docs.meshy.ai/api/image-to-3d) 7.1 / 6, smart-topology T2 / T2.5 | Most complete single API; official MCP server and Claude Code skill pack ([Meshy AI docs](https://docs.meshy.ai/api/ai)) | Quad or triangle; `target_polycount` 100 to 300,000; smart topology up to 15,000 (T2) or 30,000 (T2.5) faces; PBR maps; remesh; UV unwrap; biped auto-rig; animation; GLB/FBX/OBJ/USDZ | API needs Pro: €19/mo for 1,000 credits (USD $20 in a search snippet). Textured image-to-3D costs 30 credits. Pro allows 10 queued tasks. API files are kept 3 days ([pricing](https://www.meshy.ai/pricing); [API pricing](https://docs.meshy.ai/api/pricing); [rate limits](https://docs.meshy.ai/api/rate-limits)) | Paid: "Private & customer-owned". Free: CC BY 4.0, no API |
| [Tripo](https://developers.tripo3d.com/en/pricing) H/P series, v3.1 | Speed; rigging including quadrupeds (Tripo's own claim) | Quad, smart low-poly, smart UV, parts, retopology, pivot-to-bottom and scale on convert, multiview from one image | ¥0.07 per credit as served (about $0.01). Textured image-to-3D 30 credits, quad +5 | Paid: full commercial rights. Free: contradictory, so treat as non-commercial |
| [Rodin / Hyper3D](https://hyper3d.ai/pricing?lang=en) Gen-2 / 2.5 | Geometry fidelity (third-party comparisons, [inker.si](https://inker.si/blog/best-ai-3d-model-generators-2026)) | Quad-dominant PBR mesh, 1,000 to 200,000 quad faces (reseller docs); no rigging | API only on Business at $120/mo; Creator $30/mo; resellers about $0.80 per generation | Creator and up: "any use" |
| [Hunyuan 3D 3.0](https://www.tencent.com/tencent-announces-global-launch-of-hunyuan-3d-engine-to-empower-creators-with-advanced-creation-tools/) (hosted) | Up to 4 input views | Smart topology (triangle or quad), OBJ/GLB | 20 free generations a day; API through Tencent Cloud (price not found) | Hosted terms not read |
| [Unity 3D Object Generator](https://unity.com/blog/unity-ai-3d-object-generator) (beta since 2026-05-21) | Zero setup inside Unity | Static, single-part props only; the AI models behind it are not named; AI metadata is embedded in outputs | Unity AI terms not verified | User carries copyright liability ([Digital Production](https://digitalproduction.com/2025/08/22/unity-6-2-welcomes-ai-but-pace-caution-user-liability-on-copyright/)) |
| Open weights: [TRELLIS.2](https://github.com/microsoft/TRELLIS.2), [Hunyuan3D 2.1](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1), [SPAR3D](https://github.com/Stability-AI/stable-point-aware-3d) | Free, run locally | GLB with PBR | Need an NVIDIA GPU with 6 to 24+ GB: **not possible on this machine** [local] | MIT (TRELLIS.2); Hunyuan3D 2.1 licence excludes the EU, UK and South Korea |

**The best quality evidence** is a controlled study from Lindenwood University (June 2026) that built the same stylized tavern scene twice, once with an AI pipeline (Meshy 6 plus Hunyuan 3D) and once by hand ([Lindenwood Digital Commons](https://digitalcommons.lindenwood.edu/faculty-research-papers/813)):

| | AI pipeline | Human-authored |
|---|---|---|
| Time | **238 minutes** | **716 minutes** |
| Triangles | **about 32.8 million** (103 objects) | **293,828** (123 objects) |

The AI scene was more than 100 times heavier. Its problems were "dense triangulated geometry, fragmented UV maps, inconsistent prompt adherence", clipping during placement, and "loss of texture integrity when attempting decimation". The authors conclude that AI helps most with ideation, rough props and prototyping, and that artists are still needed for optimisation, retopology, UVs and engine validation.

Others agree:

- Unity limits its own generator to placeholders and static single-part props ([Unity blog](https://unity.com/blog/unity-ai-3d-object-generator)).
- 3DVF says almost all such tools produce topology "impossible to animate" ([3DVF](https://3dvf.com/en/autodesk-lauches-a-generative-ai-model-an-overview-of-the-possibilities-and-the-legal-challenges/)).
- Tripo's own pipeline guide still keeps manual cleanup for heroes and characters ([Tripo](https://www.tripo3d.ai/blog/explore/ai-3d-model-generator-mesh-cleanup-as-a-postprocess-model), vendor claim).

**Practical consequence: reduce triangles before the texture is made, not after.** Meshy takes `target_polycount` and smart-topology models, and Tripo offers quad and smart low-poly options ([Meshy API](https://docs.meshy.ai/api/image-to-3d); [Tripo pricing](https://developers.tripo3d.com/en/pricing)). That way the budget is met on the service side and the texture is generated for the final mesh. Blender is left with scale, pivot, packing, LODs and checks, and a full high-to-low bake is kept for hero props only (inference).

**Inputs decide most of the result.** Meshy asks for ([Meshy docs](https://docs.meshy.ai/en/webapp/image-to-3d)):

- one centred subject on a plain background,
- even lighting, because shadows become black patches on the texture,
- near-orthographic or telephoto framing,
- for multi-view, 2 to 8 images in the same pose and light, ideally front, side, back and three-quarter.

Parts cropped out of the image stay missing ([Sloyd](https://www.sloyd.ai/blog/why-some-photos-convert-better-to-3d-than-others), competitor guidance). Meshy can re-pose humanoids to an A- or T-pose for auto-rigging, which covers bipeds only ([Tripo blog](https://www.tripo3d.ai/blog/meshy-alternative), competitor claim). Extra views made by an image model from one drawing are guesses: "the front is grounded in the reference while the sides and back are inferred" ([Scenario](https://www.scenario.com/blog/tripo-image-to-3d-model-ai-2026), vendor). So the best input for this pipeline is a flat-lit "material pass" of the concept (local colours, no shading), with the moody painting kept as a reference only (inference).

**Ownership depends on the tier:**

- **Meshy.** Free outputs are CC BY 4.0. Paid outputs are customer-owned ([Meshy pricing](https://www.meshy.ai/pricing)), on the condition that the inputs don't infringe anyone's copyright ([Meshy FAQ](https://docs.meshy.ai/faq)).
- **Tripo.** The free tier is contradictory. Its help page says Tripo "retains all rights" to free users' outputs, while a Tripo blog says CC BY 4.0 ([Tripo help](https://www.tripo3d.ai/help/privacy-policy/how-to-use-tripo-models-commercially), search excerpt; [Tripo blog](https://www.tripo3d.ai/blog/cheaper-meshy-alternative-private-commercial-use-3d-models)).
- **Hunyuan3D 2.1 open weights.** The licence "does not apply in the European Union, United Kingdom and South Korea" ([LICENSE](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1/blob/main/LICENSE)).

**Steam and reputation.** Steam rewrote its AI disclosure form in January 2026. AI development tools such as code helpers no longer need disclosing, but AI-generated content in the game or on the store page still does ([Game Developer](https://gamedeveloper.com/business/valve-tweaks-and-clarifies-ai-disclosure-rules-for-steam); [VGC](https://www.videogameschronicle.com/news/valve-has-significantly-rewritten-steams-rules-for-how-developers-much-disclose-ai-use)). The exact Steamworks wording sits behind a login and was not retrieved. The training data is disputed: Objaverse's 800,000+ models came from Sketchfab, scraped before Sketchfab had a NoAI tag ([The Decoder](https://the-decoder.com/sketchfab-objaverse-ai-copyright-dispute-enters-third-dimension/)). Developer sentiment is turning too. **52% of GDC 2026 survey respondents say gen-AI harms the industry, up from 30%, and 64% in visual and technical art** ([GameDev.net](https://www.gamedev.net/news/gdc-trends-report-2026-as-use-of-generative-ai-rises-devs-face-infrastructure-problem-r3601/)).

## Claude works best as the pipeline operator: scripts are the gates, MCP is the eyes

The field reports are anecdotal: blogs, vendor write-ups and two structured tests, with no benchmark. They point the same way. Claude handles layout, hard-surface primitives, batch scripts and scene analysis, and struggles with organic modelling, clean topology and aesthetic judgment ([MindStudio](https://www.mindstudio.ai/blog/claude-blender-mcp-real-world-performance), opinion piece). In one Blender "donut test", Claude claimed the work was finished and then stalled as its context filled ([MindStudio](https://www.mindstudio.ai/blog/claude-blender-mcp-60-percent-tokens-donut-test-results), search excerpt).

In a structured Unity test on Windows, simple games worked first time, while a metroidvania came out "data-correct" but unplayable. With MCP tools for play mode, the console and screenshots, Claude ran 7 tests and fixed 5 issues on its own ([Classmethod](https://dev.classmethod.jp/en/articles/unity-mcp-claude-code-2d-game-verification/)). That suggests the role. The agent is the **pipeline operator**: it imports, cleans, measures, packs, exports, validates, imports into Unity and takes screenshots. Meshy, or a person, does the modelling (inference).

**Blender.** Blender 5.2 LTS is current: 5.2.2 shipped 2026-09-15, and the line is supported until July 2028 ([blender.org](https://www.blender.org/download/); [5.2 release](https://www.blender.org/releases/5-2/)). It runs scripts headless. `blender.exe --background --factory-startup --python-exit-code 1 --python script.py -- args` runs a script without the UI and turns any Python exception into a non-zero exit code. Arguments are processed in order, so `--python-exit-code` has to come before `--python` ([Blender CLI manual](https://docs.blender.org/manual/en/latest/advanced/command_line/arguments.html)).

The main danger is API drift. Blender 5.0 removed or renamed things that models were trained on: `BLENDER_EEVEE_NEXT`, the compositor's `scene.node_tree`, BGL and the legacy `action.fcurves` ([Blender 5.0 Python API notes](https://developer.blender.org/docs/release_notes/5.0/python_api/)). The agent should check operator signatures against the 5.2 API docs, not its memory. Two more traps from the field:

- Operators report FINISHED when they run, not when the result is right.
- Blender's own MCP demo missed a Solidify modifier that doubled the polygon count, so triangles must be counted on the evaluated mesh, after modifiers ([StraySpark](https://www.strayspark.studio/blog/official-blender-mcp-server-comparison-2026), vendor; [Voyager](https://voyager.so/blog/blender-mcp), vendor).

**Unity.** Unity 6000.4 runs scripts headless too. `-batchmode -projectPath … -executeMethod Ns.Class.Method -quit` runs a static Editor method. A thrown exception exits with code 1, and `EditorApplication.Exit(n)` sets the code. A project that is open in the Editor can't also be opened in batchmode ([Unity CLI](https://docs.unity3d.com/6000.4/Documentation/Manual/EditorCommandLineArguments.html)). An `AssetPostprocessor` applies import rules on every import: `OnPreprocessModel` covers scale, axis, colliders and LODs, and `OnPreprocessTexture` covers sRGB and size. Increment `GetVersion` whenever the rules change ([AssetPostprocessor](https://docs.unity3d.com/6000.4/Documentation/ScriptReference/AssetPostprocessor.html); [ModelImporter](https://docs.unity3d.com/6000.4/Documentation/ScriptReference/ModelImporter.html)).

**MCP servers** are the live connection, used mainly for inspection and screenshots:

| Server | Licence / cost | Useful for | Risks |
|---|---|---|---|
| [Blender Lab official](https://www.blender.org/lab/mcp-server/) (v1.0.3, Blender 5.1+) | GPL, free; it is the server behind Anthropic's Blender connector ([Digital Production](https://digitalproduction.com/2026/04/30/anthropic-funds-blender-ships-claude-connector/)) | Scene summaries, `_for_cli` headless .blend inspection, screenshots, API docs search | Blender says it "will execute LLM generated code in Blender without any guards" and recommends a VM. Windows install steps could not be read (403) |
| [MCP for Blender](https://github.com/ahujasid/blender-mcp) (community) | MIT, free | `look` screenshots; Poly Haven, Sketchfab and Poly Pizza import; `generate_3d` through Rodin, Hunyuan, Tripo or Meshy | Four 2026 CVEs, e.g. [CVE-2026-10688](https://nvd.nist.gov/vuln/detail/CVE-2026-10688). The socket has no authentication. Telemetry is on by default. Safe mode is opt-in |
| [CoplayDev MCP for Unity](https://github.com/CoplayDev/unity-mcp) (v10.3.0, 2026-10-04) | MIT, free | About 50 tools, screenshots including a six-angle surround, console | Stops when the Editor closes. The bridge drops when the Editor loses focus, and auto-config can fail silently ([wiki](https://github.com/CoplayDev/unity-mcp/wiki/3.-Common-Setup-Problems), search excerpt) |
| [Unity official](https://docs.unity3d.com/Packages/com.unity.ai.assistant@2.7/manual/integration/unity-mcp-get-started.html) (AI Assistant) | Needs a Unity AI subscription on Personal per search excerpts ($10/mo after a trial) ([unity.com/features/ai](https://unity.com/features/ai)) | Scene, GameObject and console tools | `relay_win.exe` outlived the Editor and locked `Library/` in one Windows report ([kludgelog](https://note.com/kludgelog/n/nbd48152e59ab?hl=en)) |
| [IvanMurzak AI Game Developer](https://github.com/IvanMurzak/Unity-MCP) | Apache-2.0 | 70+ tools including running C# | No authentication by default; runs arbitrary C# |
| [Meshy MCP](https://docs.meshy.ai/api/ai) (official) | Free; calls cost the same credits as REST | Generate, remesh, rig, check balance | Every call spends credits; the API key is passed as an environment variable |

**How Claude Code handles MCP.** When an MCP tool returns a PNG, JPEG or WebP image, Claude Code shows it inline and saves the original file (v2.1.283+). Tool output is capped at 25,000 tokens by default. Claude Code asks for approval before using servers from a project's `.mcp.json` ([Claude Code MCP docs](https://code.claude.com/docs/en/mcp)).

One Windows user found that back-to-back Unity MCP calls clogged the Editor's synchronisation queue, and limited themselves to **one Unity MCP call per turn**. They also named the server key `unityMCP` so tool names stayed the same across a server switch, which had otherwise forced rewrites of 11 skills and agents ([kludgelog](https://note.com/kludgelog/n/nbd48152e59ab?hl=en)).

**Visual checks.** No tool scores "matches the concept" automatically. The best available check is the agent comparing fixed-angle renders with the concept views by eye. Screenshots don't reveal non-manifold geometry or an empty export, so they add to the numeric checks and never replace them ([StraySpark](https://www.strayspark.studio/blog/official-blender-mcp-server-comparison-2026), vendor). Cycles renders reliably headless on the CPU. EEVEE and Workbench need an OpenGL context, which a Windows desktop session normally provides, but those sources date from 2019 to 2020. Test it once on this machine ([Blender devtalk](https://devtalk.blender.org/t/blender-2-8-unable-to-open-a-display-by-the-rendering-on-the-background-cycles/8607)).

## Conclusion

AI generation has moved the bottleneck. Making the mesh now takes minutes. The hours go into deciding exactly what the asset must be and proving that it is right. For a solo developer, that makes the brief, the machine-readable spec and the validation scripts the real production assets. They let an agent work unattended between your two approvals, and they survive a change of generator. That matters: Meshy's `model_type: "lowpoly"` retires on 30 October 2026 ([Meshy API](https://docs.meshy.ai/api/image-to-3d)), and model names change every few months. Consistency also comes more cheaply from shared rules than from per-asset polish: one style anchor for inputs, one texel density, one albedo range, one review scene, and one golden asset per category.

AI does not make hero characters or deforming assets cheaper. It moves their cost from modelling into retopology and rigging, so the player character and anything close to the camera should stay on a conventional path, or use AI only as a base mesh. Using AI art is now visible to players through Steam's disclosure and judged by other developers, so it is a product decision as much as a pipeline one.

## Recommended setup for this workspace

Everything below is a proposal (inference) built from the findings above. `<game>` is the new Unity project under `projects/`, and `BarrelOak` is an example asset. Nothing has been installed or created yet.

### 1. The pipeline

| # | Stage | Who / what | Tool and command | Output file | Check / gate |
|---|---|---|---|---|---|
| 0 | Style lock (once) | You decide; asset-builder drafts | Flow F1 "Art bible and spec" | `docs/art/art-bible.md`, `art-source/_style/spec.json` | You approve. The first approved asset becomes the golden asset |
| 1 | Concept views | You | Draw or pick views and upload them in the workspace app (they land in `inbox/attachments/<game>/asset-builder/YYYY-MM-DD/`) | Front, side, back and three-quarter PNGs, plus an annotated sheet | Flat-lit, one subject, at least 1024 px on the short side, same pose and scale in every view |
| 2 | Brief | asset-builder drafts, you approve | Flow F2 "New asset brief": copies the images into `concept/` | `art-source/props/BarrelOak/brief.md` (status `brief`) | **G1 (you):** must-keep list, real size, budget class and depth questions all answered |
| 3 | Generate | Meshy API through a project script; the agent runs it after you approve the credits | `node tools\meshy\generate.mjs --asset art-source\props\BarrelOak --confirm-credits 35` | `gen/raw.glb`, raw texture PNGs, `gen/record.json` | The script refuses images under 1024 px or a missing `--confirm-credits`, and exits 1 on FAILED. At most 3 tries per asset |
| 4 | Raw look | Blender script plus the agent | `turntable.py` on `gen\raw.glb`, at the concept angles | `review/raw_front.png`, `raw_side.png`, … | **G2 (you):** shape and proportions against the concept. Regenerate or continue |
| 5 | Clean and prep | Blender script | `asset_clean.py`: import, apply transforms, scale to the brief's size, base-centre pivot, merge by distance, recalculate normals, LOD copies if the class needs them, roughness→smoothness and mask packing, FBX export | `blend/BarrelOak.blend` (plus a checkpoint per step), `export/SM_BarrelOak.fbx`, `export/T_BarrelOak_*.png` | Exit 0 |
| 6 | Validate mesh | Blender script | `validate_mesh.py` | `review/validate.json` | **G3a:** exit 0. Checks: triangles on the evaluated mesh within budget; zero non-manifold or inconsistent-normal edges; size in metres in range; pivot; UVs present and within 0..1; power-of-two textures; albedo within range; names match the pattern |
| 7 | Compare | Blender turntable plus the agent's eyes | `turntable.py` on the export, plus a black-fill silhouette render | `review/clean_*.png`, `review/silhouette.png`, `review/compare.md` | Numbered differences against the must-keep list. The agent can't approve its own work |
| 8 | Unity import | Unity AssetPostprocessor plus a prefab Editor script | Copy `export/` into `Assets/Art/Props/BarrelOak/`. With the Editor open it imports by itself; with the Editor closed, use batchmode | FBX, textures, `M_BarrelOak.mat`, `PF_BarrelOak.prefab` | Import rules are applied automatically. Nothing reaches `Assets/` before G3a passes |
| 9 | Validate in Unity | Unity Editor script in batchmode (Editor closed) | `ArtPipeline.AssetValidation.Run` (command below) | `review/validate-unity.json`, `Logs/art-validate.log` | **G3b:** exit 0. Checks: importer settings, bounds in metres, LOD order, texture sRGB flags and maximum sizes, no missing shaders |
| 10 | In-engine look | You, or an Editor menu "Art > Capture review shots" (Unity MCP in phase 2) | `ArtReview` scene with the game's lighting, the golden asset, a 1.7 m reference capsule and the gameplay camera | `review/unity_typical.png`, `review/unity_closest.png` | **G4 (you):** approve, revise or reject, with numbered notes. Optionally run art-reviewer first |
| 11 | Record | asset-builder. Commits happen only when you ask | Update `brief.md` status and log, plus the agent's memory | `brief.md` status `approved`, `gen/record.json` | `git lfs ls-files` lists the binaries |

```powershell
# (constructed, not run) The Blender path is unverified until install: Get-ChildItem "C:\Program Files\Blender Foundation"
$blender = "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe"
$unity   = "C:\Program Files\Unity\Hub\Editor\6000.4.11f1\Editor\Unity.exe"
$asset   = "art-source\props\BarrelOak"

# Blender step: exit code 1 on any Python error or failed check
& $blender --background --factory-startup --python-exit-code 1 --python tools\blender\validate_mesh.py -- --asset $asset
if ($LASTEXITCODE -ne 0) { Write-Output "validate_mesh failed, see $asset\review\validate.json" }

# Unity step (close the Editor first). Start-Process -Wait so PowerShell waits for Unity and gets its exit code.
$p = Start-Process -FilePath $unity -ArgumentList "-batchmode -nographics -projectPath $PWD -executeMethod ArtPipeline.AssetValidation.Run -logFile $PWD\Logs\art-validate.log -quit" -Wait -PassThru
$p.ExitCode
```

### 2. Agent design

**Create one builder agent now, and add a light reviewer after the first asset passes.**

**asset-builder role (body text):**

> You turn one approved asset brief and its concept views into a validated Unity prefab. You are the pipeline operator, not the modeller: Meshy makes the mesh, and your scripts measure, fix and package it. Work on one asset per session. Move it one stage at a time, and save a checkpoint after each step. Stop at the two points where the user must look: the raw shape (G2) and the in-engine look (G4). Numbers decide the technical pass or fail, and the user decides whether it looks right. Never call an asset done because it looks right to you.

Frontmatter (the tools, effort and model lines are added by hand):

```yaml
---
name: asset-builder
description: Turns an approved asset brief and concept views into a validated Unity prefab (Meshy generation, headless Blender cleanup and checks, Unity import and validation). One asset per session.
memory: project
model: opus
effort: medium
tools: Read, Grep, Glob, Edit, Write, Bash, PowerShell, WebFetch
---
```

| | asset-builder | art-reviewer (later) |
|---|---|---|
| **Role** | Runs stages 2 to 11 for one asset per session | A second opinion at G4 in a fresh session. It sees only the outputs, not the builder's reasoning |
| **Tools** | Read, Grep, Glob, Edit, Write, Bash, PowerShell, WebFetch (only for Blender, Unity and Meshy docs). No MCP at first. In phase 2 add the Unity MCP tools under the server key `unityMCP` | Read, Grep, Glob, PowerShell (only to re-run the two pre-approved validators) |
| **Model / effort** | opus / medium. Raise to high in flows that write or fix scripts | opus / high (short sessions, visual judgment) |
| **permissionMode** | Leave unset, so it asks. Generation spends money and Blender scripts run arbitrary Python. Pre-approve only the exact validate, turntable and clean commands in `.claude/settings.json`, as both Bash and PowerShell rules. Never pre-approve `generate.mjs` | Leave unset |
| **Owns** | `art-source/**`, `Assets/Art/**`, `Assets/Editor/ArtPipeline/**`, `Assets/Scenes/ArtReview.unity` (changed only through its Editor scripts), `tools/blender/**`, `tools/meshy/**`, `docs/art/**` | Nothing. It writes no files; its verdict goes in chat |
| **Leaves alone** | Gameplay code, other scenes and prefabs, `ProjectSettings/`, `Packages/manifest.json` (asks first), `Library/`, `Temp/`, every `.meta` file (Unity writes these), `.env`, `git commit` and `git push` (only when you ask) | Everything |
| **Done means** | `validate_mesh.py` and `AssetValidation.Run` both exit 0 on the final files. The review pack is in `review/`: concept vs render for every view, silhouette, Unity shots. `gen/record.json` is complete: service, model, parameters, task ID, credits, date, plan, input files. `brief.md` log updated and status set to `review`. You have been asked for a verdict. It never sets `approved` itself | A verdict of pass, revise or fail, with numbered, concrete notes (for example "remove the shadow baked under the lid"). "Unknown" is allowed. A missing or stale JSON means "revise". Your verdict wins |
| **Memory rules** | After each asset, save: the Meshy parameters that worked for each category, recurring defects and their fixes, and your feedback patterns. Keep it short. Never store keys or prices as facts | Defects it caught that the builder missed, and your verdicts where you disagreed with it |
| **Images** | Its own folder `inbox/attachments/<game>/asset-builder/YYYY-MM-DD/` for concept views. `_shared/` holds golden-asset screenshots and style anchors. It copies concept views into `art-source/.../concept/` so they are versioned | `inbox/attachments/<game>/art-reviewer/...` plus `_shared/` |
| **Context rules** | Read `brief.md` first, because it holds the state. Scripts print a summary of at most 20 lines and write full logs to files; read the JSON, not the Unity log. At most one Unity MCP call per turn. If the same fix fails twice, stop and explain | Load only the files listed in the flow |

**Why add a reviewer, and why later.** Agents have claimed success they had not reached. A fresh context that grades only the outputs is cheap insurance: one agent file and one flow. The earlier report's advice to grade what the agent produced applies here ([Prompt and pipeline best practices](../2026-10-21_prompt-pipeline-practices/report.md)). Create it after the first asset passes end to end, so its checklist reflects real defects. It never replaces your G4 verdict.

### 3. Asset brief template

Saved as `art-source/<category>/<Asset>/brief.md`. The fields come from the published briefs (Game Developer, Allcorrect) plus what an AI pipeline needs.

```markdown
# Asset brief: <AssetName>
id: <category>-<NNN>    status: brief | generating | cleanup | review | approved | rejected
created: YYYY-MM-DD    updated: YYYY-MM-DD

## Purpose
- Gameplay role: <what it does; interactive or decoration; how often the player sees it>
- Class (from spec.json): prop-small | prop-medium | prop-large | env-modular | char-background
- Camera: <first-person | third-person | top-down>; typical distance <m>; closest distance <m>

## Scale and orientation
- Real size (m): height <h>, width <w>, depth <d>   (or: "next to the 1.7 m reference human")
- Pivot: base-centre | feet | grid corner
- Forward: the side shown in front.png faces Unity +Z (checked in the ArtReview scene)
- Grid snap (modular only): <m>

## Views (generator inputs: clean, flat-lit, no text)
| File | View | Drawn or AI-made | Notes |
|---|---|---|---|
| concept/front.png | front, eye level | drawn | required |
| concept/side.png | side | | |
| concept/back.png | back | | |
| concept/three-quarter.png | 3/4 | | |
Not sent to the generator: concept/sheet-annotated.png (callouts, swatches), concept/mood.png (lit painting)

## Must keep
1. <silhouette element or shape that defines the asset>
2. <colour block or readable detail>

## May simplify
- <what can be merged, flattened into the texture, or dropped>

## Depth and hidden sides
- <feature>: protrudes about <cm> | recessed about <cm>
- Back side: as drawn | mirror of front | plain
- Asymmetry: <none | describe>

## Style
- Style anchor: <golden asset or image>, closeness: close match | mood only
- Avoid (negative refs): <what it must not look like>
- Must sit next to: <existing assets>
- Lighting in base colour: none (PBR, per art bible)

## Materials
| Slot | Base colour (hex) | Metal? | Smoothness target | Notes |
|---|---|---|---|---|
| <wood> | #<hex> | no | 0.3 | |

## Budgets (from spec.json unless overridden here)
- LOD0 triangles: <n>    LODs: none | Unity Mesh LOD | _LOD0.._LOD2 at 100/50/25 %
- Texture size: <512 | 1024 | 2048>    Texel density: <512> px/m
- Materials: 1    Collider: none | box | capsule | convex hull <=255 tris (<Asset>_COL)

## Rig and animation
- static | humanoid (A-pose input, auto-rig, background use only) | moving parts: <list>

## Generator settings (filled in by asset-builder)
- Service and model: Meshy <model id>    Mode: image | multi-image
- Parameters: <topology, target_polycount, enable_pbr, texture resolution>
- Texture prompt: <text>    Avoid: <text>
- Credits approved: <n>    Max tries: 3

## Deliverables
- Assets/Art/<Category>/<AssetName>/: SM_<AssetName>.fbx, T_<AssetName>_BaseColor/_Normal/_Mask.png, M_<AssetName>.mat, PF_<AssetName>.prefab

## Acceptance
- [ ] validate_mesh.py exit 0            - [ ] AssetValidation.Run exit 0
- [ ] every must-keep feature visible in the side-by-side renders
- [ ] silhouette readable at gameplay distance (black-fill render)
- [ ] no shadows baked into base colour; non-metal albedo 30-240 sRGB
- [ ] sits with the golden asset in the ArtReview scene
- User verdict: approve | revise | reject (date, numbered notes)

## Log
- YYYY-MM-DD try 1: task <id>, <credits> credits, result <...>
```

### 4. Starter flows

Write each flow prompt with one goal, the expected output files, the gate, and a cap on rounds. The earlier report covers how ([Prompt and pipeline best practices](../2026-10-21_prompt-pipeline-practices/report.md)).

| Flow | Target | Mode / effort | What the prompt asks for | Images to attach |
|---|---|---|---|---|
| **F1 Art bible and spec** | asset-builder | plan / high | Ask me the open questions (camera, platform, PBR or painted). Then propose `docs/art/art-bible.md` (a one-line visual identity, palette hex values, value and silhouette rules, the golden-asset rule) and `art-source/_style/spec.json` (budgets per class, texel density, texture sizes, naming pattern, albedo ranges). Write nothing until I approve | Image 1 "style anchor: match this". Images 2 to 5 "mood only". Optional Image 6 "not like this" |
| **F2 New asset brief** | asset-builder | acceptEdits / medium | Create `art-source/<category>/<Asset>/`. Fill `brief.md` from the template. Copy the images to `concept/` under fixed names. Run the input checklist: size, plain background, cast shadows, perspective, whether the views agree. List questions about depth, hidden sides and scale. Stop before any generation | Image 1 front (required), Image 2 side, Image 3 back, Image 4 three-quarter, Image 5 annotated sheet with the caption "not a generator input" |
| **F3 Generate raw model** | asset-builder | manual / medium | Read the brief. State the model, parameters and credit cost, and wait for my OK. Run `generate.mjs` once. Render the raw turntable at the concept angles and show it side by side with the concept. Log the try in the brief. Stop for my G2 verdict | None (it reads the asset folder). Optional Image 1: golden asset at gameplay distance |
| **F4 Clean, validate, import** | asset-builder | acceptEdits / medium | Starting from the approved raw model: clean, validate, render turntable and silhouette, then copy into `Assets/Art` only after validation passes. Ask me to close the Editor, then run the Unity validation. Build the review pack. Fix failures only inside your own folders, and stop if the same fix fails twice. End with the G4 checklist. Also handles "apply these numbered notes" for revisions | None. Optional Image 1: an in-engine screenshot with my notes drawn on it |
| **F5 Review asset** | art-reviewer | manual / high | Compare concept, clean renders, in-engine shots and the golden asset. Check both validation JSON files and the must-keep list. Return pass, revise or fail with numbered notes; "unknown" is allowed. Edit nothing | Image 1 concept front, Image 2 clean render front, Image 3 in-engine at gameplay distance, Image 4 golden asset at the same distance |

### 5. Folder layout, naming and the Unity URP default spec

```text
projects/<game>/
├─ Assets/
│  ├─ Art/
│  │  ├─ Props/BarrelOak/        SM_BarrelOak.fbx, T_BarrelOak_BaseColor.png, T_BarrelOak_Normal.png,
│  │  │                          T_BarrelOak_Mask.png, M_BarrelOak.mat, PF_BarrelOak.prefab
│  │  ├─ Environment/<Kit>/      modular pieces, trim-sheet materials
│  │  ├─ Characters/<Name>/      SK_<Name>.fbx and its textures
│  │  └─ Shared/                 palette atlas, trim sheets, shared M_ materials, golden assets
│  ├─ Editor/ArtPipeline/        AssetImportRules.cs, AssetValidation.cs, PrefabBuilder.cs, ReviewCapture.cs
│  └─ Scenes/ArtReview.unity     game lighting, 1 m cube, 1.7 m capsule, gameplay camera
├─ art-source/                   outside Assets/, so Unity never imports it
│  ├─ _style/                    spec.json, palette.png, golden/ (approved in-engine screenshots)
│  └─ props/BarrelOak/
│     ├─ brief.md
│     ├─ concept/                front.png, side.png, back.png, three-quarter.png, sheet-annotated.png, mood.png
│     ├─ gen/                    raw.glb, raw textures, record.json   (_rejected/ is gitignored)
│     ├─ blend/                  BarrelOak.blend and step checkpoints
│     ├─ export/                 validated FBX + textures, copied into Assets/Art (gitignored)
│     └─ review/                 raw_*.png, clean_*.png, silhouette.png, unity_*.png, validate*.json, compare.md
├─ tools/
│  ├─ blender/                   asset_clean.py, validate_mesh.py, turntable.py (each fails unless bpy.app.version is 5.2.x)
│  └─ meshy/generate.mjs         Node, no dependencies, key read from $env:MESHY_API_KEY
└─ docs/art/art-bible.md
```

**Naming** follows Epic's `Prefix_AssetName_Descriptor_Variant` pattern ([Epic](https://dev.epicgames.com/documentation/en-us/unreal-engine/recommended-asset-naming-conventions-in-unreal-engine-projects)). Unity reads the `_LODn` suffix ([Unity](https://docs.unity3d.com/6000.4/Documentation/Manual/lod-group-configure.html)). `PF_` and `_COL` are this project's own conventions.

| Thing | Pattern | Example |
|---|---|---|
| Asset and folder | PascalCase, with an optional `_NN` variant suffix | `BarrelOak`, `BarrelOak_02` |
| Static / skinned mesh file | `SM_<Asset>.fbx` / `SK_<Name>.fbx` | `SM_BarrelOak.fbx` |
| Mesh objects inside the FBX | `<Asset>_LOD0..2`, collider `<Asset>_COL` | `BarrelOak_LOD1`, `BarrelOak_COL` |
| Material / textures | `M_<Asset>`; `T_<Asset>_BaseColor`, `_Normal`, `_Mask` | `T_BarrelOak_Mask.png` |
| Prefab | `PF_<Asset>` | `PF_BarrelOak.prefab` |
| Validator pattern for mesh objects | `^[A-Z][A-Za-z0-9]+(_[0-9]{2})?(_LOD[0-7]\|_COL)?$` | |

| Spec item | Default | Source / label |
|---|---|---|
| Units, axes | 1 unit = 1 m, Y up. Blender scene Metric at Unit Scale 1.0 | [Unity FBX Importer](https://docs.unity3d.com/6000.4/Documentation/Manual/FBXImporter-Model.html) |
| Blender FBX export | `apply_scale_options='FBX_SCALE_UNITS'`, `axis_forward='-Z'`, `axis_up='Y'`, `use_mesh_modifiers=True`, `mesh_smooth_type='FACE'`, `use_tspace=True`, `add_leaf_bones=False`; transforms applied first | [bpy 5.2](https://docs.blender.org/api/current/bpy.ops.export_scene.html); [Katsbits](https://www.katsbits.com/codex/unity-blender-fbx-scale) (community; the overrides are common practice) |
| Unity model import (set by AssetPostprocessor) | Scale Factor 1, Convert Units on, Bake Axis Conversion on, Read/Write off, Generate Colliders off, Generate Lightmap UVs only for static lightmapped props | [ModelImporter](https://docs.unity3d.com/6000.4/Documentation/ScriptReference/ModelImporter.html) |
| Pivot | Base centre for props, feet at the origin for characters, grid corner for modular pieces | [Unity humanoid](https://docs.unity3d.com/6000.4/Documentation/Manual/UsingHumanoidChars.html); inference |
| Texel density | 512 px/m (third-person) by default; 1,024 first-person; 256 top-down; tolerance ±25% (inference) | [Maxon](https://help.maxon.net/c4d/2026/en-us/Content/html/Texel_Density.html) |
| Texture size | Small prop 512, medium 1024, large 2048, all powers of two. At 512 px/m a 1 m barrel (about 3 m² of surface) fits in 1024² with padding. Props larger than about 3 m need tiling textures or trim sheets instead of one unique texture | Inference (only Dota publishes per-slot sizes) |
| Maps | BaseColor sRGB. Normal imported as a Normal map, Y+ (check the first asset by eye). Mask linear (sRGB off): R metallic, G AO, B 0, A smoothness = 1 − roughness, assigned to both the Metallic and Occlusion slots; Smoothness Source = Metallic Alpha | [URP packing](https://docs.unity3d.com/Manual/urp/shaders-in-universalrp-channel-packed-texture.html); [URP Lit](https://docs.unity3d.com/6000.4/Documentation/Manual/urp/lit-shader.html) |
| Albedo ranges | Non-metal 30 to 240 sRGB per channel; metal 180 to 255; metallic map either 0 or 235 to 255 | [Adobe PBR Guide](https://www.adobe.com/learn/substance-3d-designer/web/the-pbr-guide-part-2) |
| LOD0 triangles (starting points, to tune on your target hardware) | Small prop 1,000; medium 4,000; large 12,000; modular piece 2,000; background humanoid 15,000. Hero character: not AI-only | Inference, anchored on Meshy's T2 default of 4,000 and T2.5 default of 15,000 and Dota items at 1,500 to 11,000 |
| LODs | Static props: Unity Mesh LOD. Anything needing control per level (characters): `_LOD0..2` at 100/50/25%. Never both on one model | [Unity Mesh LOD](https://docs.unity3d.com/6000.2/Documentation/Manual/lod/mesh-lod-generate-lods.html); [Unity Learn](https://learn.unity.com/tutorial/level-of-detail-3653) |
| Colliders | Primitives first (box, capsule, sphere). A convex `_COL` mesh of at most 255 triangles. Non-convex mesh colliders only on static objects without a Rigidbody | [Unity Mesh Collider](https://docs.unity3d.com/es/2018.4/Manual/class-MeshCollider.html) |
| Materials | 1 per asset. Small props and modular pieces share atlases or trims where possible | [Papaya Games](https://papaya-games.itch.io/duck-in-town/devlog/73530/blazing-fast-rendering-with-a-single-material-per-scene) |
| Format | FBX into Unity. GLB only as the raw generator output | [glTFast](https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.5/manual/features.html) |

A starting `art-source/_style/spec.json`. The numbers are inference; F1 proposes the real ones:

```json
{
  "units": "m", "upAxis": "Y",
  "texelDensityPxPerM": 512, "texelTolerance": 0.25,
  "classes": {
    "prop-small":      { "trisLod0": 1000,  "texture": 512,  "lods": "none",    "collider": "box" },
    "prop-medium":     { "trisLod0": 4000,  "texture": 1024, "lods": "meshLod", "collider": "box" },
    "prop-large":      { "trisLod0": 12000, "texture": 2048, "lods": "lod3",    "collider": "convex255" },
    "env-modular":     { "trisLod0": 2000,  "texture": "trim", "lods": "meshLod", "collider": "box", "gridM": 1.0 },
    "char-background": { "trisLod0": 15000, "texture": 2048, "lods": "lod3",    "collider": "capsule" }
  },
  "albedoSrgb": { "nonMetalMin": 30, "nonMetalMax": 240, "metalMin": 180 },
  "naming": "^[A-Z][A-Za-z0-9]+(_[0-9]{2})?(_LOD[0-7]|_COL)?$"
}
```

### 6. Decisions for you

| Decision | Options | Recommendation |
|---|---|---|
| **Install Blender** | 5.2.2 LTS (current, supported until July 2028, needed by the official Blender MCP, which requires 5.1+), 4.5 LTS, or the portable zip | **5.2.2 through winget, pinned**: `winget install --id BlenderFoundation.Blender --version 5.2.2 --exact`, then `winget pin add --id BlenderFoundation.Blender` (pin unverified on this machine). The scripts also refuse to run unless the version is 5.2.x, which controls API drift. Installing is about 348 MB |
| **Generation service** | Meshy Pro at €19/mo for 1,000 credits with the API (2026-10-21; about 28 textured tries, so roughly 14 finished assets at 2 tries each, inference). Tripo (about $0.35 to $0.45 per textured try, inference). Rodin (API only at $120/mo). Hunyuan 3D Global (20 free a day; terms not read). Unity's generator (beta, placeholders) | **Test 2 or 3 concepts on Meshy Free in the web app first.** Free outputs are CC BY 4.0, which is fine for throwaway tests (100 credits per the pricing page, 200 per the FAQ). Buy Pro only if the shape quality holds up. Ship only Pro outputs. **Key handling:** add `MESHY_API_KEY` yourself under Windows "Edit environment variables for your account", not on a PowerShell command line (which keeps a history file, general Windows practice). It never goes in `.mcp.json`, `.env.example`, the brief or a flow. Don't use Meshy's `npx add-mcp … --env MESHY_API_KEY=…` installer unless the resulting config file stays untracked |
| **MCP servers** | None; CoplayDev MCP for Unity; Unity's official MCP; Blender Lab official; community MCP for Blender; Meshy MCP | **None at the start**: scripts with exit codes cover the pipeline and keep context free. **Phase 2:** CoplayDev MCP for Unity (MIT, free) for in-engine screenshots, under the server key `unityMCP`, pinned to a release tag, one call per turn. It needs `uv`, which is another install to approve. **Skip** the community Blender MCP (four CVEs, unauthenticated socket) and Unity's official MCP (subscription on Personal, orphaned-relay report). If you later want live Blender inspection, use the Blender Lab server, project-scoped, on copies of your .blend files: Blender itself warns it runs generated code without guards |
| **Steam AI disclosure** | Disclose, or keep shipped art AI-free | **Plan to disclose "pre-generated" AI content** if any AI mesh or texture ships. Keep `record.json` for every asset as evidence. Using Claude Code for scripts counts as a development tool under the January 2026 rules (secondary sources). Weigh the reputational cost: 52% of GDC 2026 respondents are negative about gen-AI. One option is to use AI for props and set dressing only |
| **Camera and platform** | First-person, third-person or top-down; PC or mobile | **Tell me before F1.** The default spec assumes third-person on PC at 512 px/m. Your 2 GB GPU is a development machine, not a target: test budgets on your target hardware |
| **Style direction** | PBR, lit by Unity; or hand-painted with light in the albedo | **PBR.** Meshy returns PBR maps, the albedo-range check only works for PBR, and flat-lit concept inputs avoid baked shadows. Hand-painted needs different checks and lit inputs |

### 7. Setup order

Steps 1 to 10 cost nothing and are easy to undo. Money and new servers come last.

1. **Record your answers** to the six decisions. The coordinator writes them to `knowledge/decisions/2026-10-21-3d-asset-pipeline.md` (Context, Options, Decision, Consequences).
2. **Create the workspace project** from the game template: `node tools/new-project.mjs <game> --type game`. This comes first because the tool refuses a folder that is not empty (checked in `tools/new-project.mjs`).
3. **Create the Unity project.**
   - In Unity Hub: New project, editor 6000.4.11f1, "Universal 3D" template, created in a temporary folder (for example `C:\dev\unity-tmp\<game>`).
   - Close Unity. Move `Assets`, `Packages` and `ProjectSettings` into `projects/<game>/`.
   - In Unity Hub: Add, then "Add project from disk". This order has not been tested.
4. **Set up git for Unity.**
   - Add a `.gitignore` with `Library/`, `Temp/`, `Obj/`, `Logs/`, `UserSettings/` (from the template README), plus `art-source/**/export/`, `art-source/**/gen/_rejected/`, `.claude/settings.local.json` and `CLAUDE.local.md`.
   - Turn on the LFS lines in `.gitattributes` for png, jpg, psd, tga, exr, hdr, fbx, glb and blend. Run `git lfs install`.
   - Commit `.gitattributes` before the first asset. Commit only after you say so. Commit every `.meta` file.
5. **Fill in the project's `CLAUDE.md`:**
   - Engine: Unity 6000.4.11f1, URP, C#. Add the Unity path and the verified test command.
   - Add an "Art pipeline" section that points to `docs/art/` and `art-source/_style/spec.json`.
   - Change "Do not touch: binary files in `assets/`" so asset-builder may write in `art-source/` and `Assets/Art/`.
6. **Install Blender 5.2.2** with winget and pin it (decision 1). Find the real path with `Get-ChildItem "C:\Program Files\Blender Foundation" -Recurse -Filter blender.exe`, and check it with `& $blender --version`.
7. **Write and test `tools/blender/validate_mesh.py` first, with no credits spent.** It should pass a Blender cube scaled to 1 m, and fail with exit 1 on a deliberately broken mesh (a deleted face, a flipped normal, unapplied scale).
8. **Write and test `turntable.py`.** Try Workbench headless once; if it fails, fall back to Cycles on the CPU at low samples, 512 px. Then write `asset_clean.py` and test it on a free GLB, for example a cube exported from Blender itself.
9. **Write the Unity Editor scripts** in `Assets/Editor/ArtPipeline/`:
   - `AssetImportRules.cs`: limited to `Assets/Art/`, with `GetVersion` set.
   - `AssetValidation.cs`: writes JSON and calls `EditorApplication.Exit`. Keep the rule checks as pure functions covered by EditMode tests.
   - `PrefabBuilder.cs` and `ReviewCapture.cs` (a menu item).
   - The `ArtReview` scene.

   Run the validation once in batchmode with the Editor closed and confirm both exit codes, 0 and 1.
10. **Add permission rules** to the project's `.claude/settings.json` for the exact, verified Blender and Unity commands, each as a Bash and a PowerShell rule (see the template README). Leave `generate.mjs` unapproved, so every generation asks.
11. **Create the agent:** `node tools/new-agent.mjs <game> asset-builder --role "pipeline operator for concept-to-prefab 3D assets"`. Then add the tools, model, effort and body from section 2, in the app or by hand.
12. **Meshy.**
    - Run the Free web-app test (decision 2). If the quality holds up, buy Pro and add `MESHY_API_KEY` to your user environment yourself, then restart the workspace app.
    - The coordinator writes `tools/meshy/generate.mjs`. It uses Node's built-in `fetch`, so no packages are needed (Node 20.15.1 through nvm-windows, per `context/stack.md`; `fetch` is built in from Node 18). It works from Meshy's current docs and does six things: checks PNG size, prints the credit cost, requires `--confirm-credits`, polls, downloads straight away (files expire after 3 days), and writes `record.json`. It must not use `model_type: "lowpoly"`, which retires 2026-10-30.
    - Test it with one cheap untextured generation (5 credits on `meshy-6-lite` or T2).
13. **Save flows F1 to F4** in the app. Run F1, then run one simple medium prop through F2 to F4. Make it the golden asset, and save the lessons with `/capture-lesson`.
14. **Create `art-reviewer`** and flow F5 once the first asset has passed G4.
15. **Phase 2, optional:** CoplayDev MCP for Unity for in-engine screenshots. It needs `uv` and a Package Manager git URL pinned to a tag, and both need your approval. After install, check the config that "Configure All Detected Clients" writes, then add `mcp__unityMCP__*` to asset-builder's tools.
