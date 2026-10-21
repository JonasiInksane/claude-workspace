# Concept-art handoff for 3D production and keeping many 3D assets visually consistent (research notes, 2026-10-21)

Scope: what a concept package for a 3D asset should contain, how to brief a modeler (human, AI agent or image-to-3D service), how small teams keep a style consistent, how reviews work, how to prepare images for AI generation, and the usual 2D-to-3D mistakes. Audience: a solo Unity 6 developer using a Claude Code agent plus maybe an image-to-3D service.

Source quality: most hand-off guidance online is practitioner opinion (Polycount threads) or vendor blogs and FAQs. The strongest primary sources found were Adobe's PBR Guide (material values), Meshy's own docs (AI input rules), Valve's public Dota 2 character art guide (style and readability), and two outsourcing-brief articles (Game Developer, Allcorrect). Several fetches failed (Polycount returned 403, Hitem3D/Hi3D blog 404, Meshy help article 404, Steam texture-guide body didn't load). Where a claim comes only from a search-result excerpt and not a page I fetched, it is marked "(search excerpt)".

## 1. What a production concept sheet for a 3D asset contains, and which parts matter most when the "modeler" is an image-to-3D model or an AI agent

### Takeaway
The core of a 3D handoff is a set of aligned orthographic views (front, side, back; top for vehicles and props) drawn in clean line or flat color, with written callouts for materials and hidden or asymmetric parts, separate files for repeating patterns, and color codes. For an image-to-3D service, the parts that matter most are a clean, evenly lit, near-orthographic front view plus consistent extra views. Callouts, scale and material notes matter more to an AI agent, which reads text, than to the generator, which only sees pixels.

### Cited Findings
- Turnarounds are front, side and back views, usually on one sheet, kept aligned and in one consistent rendering style, with key dimensions added (third-party guide, search excerpt) — [Portfoliobox Magazine](https://www.portfoliobox.com/magazine/preparing-concept-art-and-character-designs-for-digital)
- Material callouts should be specific: name the type of metal, not just "metal", and give color swatches with Hex or RGB codes (third-party guide, search excerpt; I could not confirm which of these two pages said it) — [Portfoliobox Magazine](https://www.portfoliobox.com/magazine/preparing-concept-art-and-character-designs-for-digital); [Hitem3D blog (vendor, 404 when fetched)](https://www.hitem3d.ai/blog/en-Concept-Art-for-3D-How-to-Create-Reference-Art-That-Translates-to-3D-Models)
- A public hand-off spec from a large modding project (Beyond Skyrim) requires that asymmetric designs also show the other side in the turnaround, recommends drawing clothing over the standard body template so the 3D artist can build armor more easily, and asks for repeating patterns as separate high-resolution files (usually black on transparent) so modelers can use them as alphas (search excerpt) — [Beyond Skyrim wiki, Arcane University: 2D definitions](https://wiki.beyondskyrim.org/wiki/Arcane_University:2D_definitions)
- Practitioners on Polycount say that painting indicative detail instead of clearly drawn line work makes modelers' lives difficult (practitioner opinion, search excerpt; thread returned 403) — [Polycount thread](https://polycount.com/discussion/comment/1570746)
- Other modelers prefer suggestive concepts that leave room for interpretation, and say they don't always model over an ortho, so exact proportions matter less to them (practitioner opinion, search excerpt) — [Polycount thread](https://polycount.com/discussion/comment/1570497)
- A brief example in Game Developer describes the expected design-sheet deliverable as front, back and side views plus close-ups of the face and key accessories — [Game Developer, "Crafting the Perfect Game Art Brief" (Hannah George, 2023-11-03)](https://www.gamedeveloper.com/design/crafting-the-perfect-game-art-brief)
- Meshy (vendor) says image-to-3D input should be "near-orthographic projection or telephoto lens" to avoid perspective distortion, with one clear subject on a simple background, and multi-view input of 2 to 8 images, recommending "Front + Side + Back + 3/4 view" — [Meshy docs, Image to 3D](https://docs.meshy.ai/en/webapp/image-to-3d)
- Tripo's multi-view mode (vendor feature, described in third-party docs) takes up to four views. Front is required, plus at least one of left, right or back — [Scenario docs, Tripo](https://docs.scenario.com/docs/3d-model-generation-tripo-ai); [ComfyUI docs, Tripo P1](https://docs.comfy.org/tutorials/partner-nodes/tripo/tripo-p1)
- Meshy's rigging pipeline defaults to a character height of 1.7 m (vendor API parameter via fal.ai) — [fal.ai Meshy V7 Image to 3D](https://fal.ai/models/meshy/v7/image-to-3d/llms.txt)

### Inferences
- Priority order for an **image-to-3D service** (inferred from the vendor input rules in Q5): (1) one clean front view, orthographic or telephoto-like, on a plain background with flat even lighting; (2) side, back and 3/4 views in the same pose and lighting; (3) high resolution. The service cannot read callouts, scale bars or swatches, so leave them off the generator input images and keep them on a separate annotated sheet.
- Priority order for an **AI agent** (Claude Code) that briefs the generator, cleans up meshes or writes materials: (1) written must-keep features and may-simplify features; (2) scale (height next to a 1.7 m human, or real dimensions); (3) a material list with colors and PBR targets; (4) notes on asymmetry and hidden sides; (5) the views themselves. The agent reads text reliably, so callouts belong in a Markdown or JSON file next to the images, not only painted onto them.
- Silhouette sheets and exploded views: I found no source covering them for 3D hand-off (see Gaps). By general practice they help for mechanical props (to show how parts join) and for checking readability. For an image-to-3D workflow they are review aids, not generator inputs.
- Suggested folder per asset (inference): `concept/front.png`, `side.png`, `back.png`, `three-quarter.png` (generator inputs, clean); `concept/sheet-annotated.png` (callouts, scale figure, swatches); `brief.md` (the ticket, see Q2); `patterns/*.png` (alphas on transparent background).

### Gaps
- I found no studio's official concept-to-3D hand-off spec beyond the Beyond Skyrim modding wiki. GDC talks on this were not located.
- Silhouette sheets and exploded views for mechanical parts: no source found in this pass.
- The vehicle-specific advice (front, side and top views, optional rear and perspective, close-ups of tires and grilles) appeared in a search summary without a clear source. It is omitted as uncited.

## 2. How to brief a modeler: the asset brief or art ticket

### Takeaway
Published outsourcing-brief guides agree on these sections: context (game, audience, camera and mechanics), style with annotated and negative references, deliverables, technical specs (formats, engine and version, platform limits), approval stages and feedback timing, and evaluation criteria. None of the public articles gives a ready-made acceptance checklist or numeric poly and texture budgets. Those have to come from the project's own art bible.

### Cited Findings
- Game Developer brief sections: background and audience (including "game mechanics, controls, and camera positioning", which matter most to riggers and animators); art style with an annotated mood board, fidelity targets, a do's and don'ts list, and a realism scale ("1 being cartoony and 10 being realistic"); annotated reference screenshots and exact picked colors; "show what you don't want"; goals with objectives; a deliverable list; technical specs (file types, in-game limits, platform optimization, software, engine version); deadlines and budget with contingency; delivery method and usage rights. The article gives no numeric poly budget, number of feedback rounds or acceptance criteria — [Game Developer (Hannah George, 2023-11-03)](https://www.gamedeveloper.com/design/crafting-the-perfect-game-art-brief)
- Allcorrect's brief template (outsourcing vendor, 2022-12-22) adds: "Stages that require client approval", "Number of options needed at the sketch stage", "Number of views needed at each stage of the pipeline", "Response time for client feedback", "Current assets in the game that resemble the required assets", "Evaluation criteria", and technical requirements (size, file extension, submission format) — [Allcorrect Games, Brief for Developing Game Art](https://allcorrectgames.com/insights/brief-for-developing-game-art/)
- A gamedev.net article frames a brief as scope, style, deadlines and deliverables, and pairs each goal with a measurable objective (search excerpt) — [GameDev.net, What to include in the perfect art brief](https://gamedev.net/blogs/entry/2276042-what-to-include-in-the-perfect-art-brief/)
- Outsourcing-vendor articles (search excerpts; which article said what is not verified) recommend agreeing on poly budgets, texel density, naming conventions and engine version up front; attaching two or three references per category, each with a note on how close the result should be (for example "close match"); and running one small test asset through the whole pipeline to check feedback handling and that files drop cleanly into the build — [Lemon Sky Studios, game art outsourcing](https://www.lemonskystudios.com/insights/game-art-outsourcing); [Thundercloud Studio, 2D outsourcing workflow](https://thundercloud-studio.com/article/2d-game-art-outsourcing-workflow/)
- Practitioners advise showing the final concept to the animator for a technical check before it goes to the modeler, because flowing cloth and tentacles are hard to animate and cost performance (practitioner opinion, search excerpt) — [Polycount thread](https://polycount.com/discussion/comment/2609415)

### Inferences
Suggested **asset ticket template** for the agent, combining the sources above. Fields marked (src) come from the cited briefs. The rest are my additions for a solo Unity and AI pipeline.

```
# Asset: <id> <name>                      status: brief | blockout | review | approved
Purpose / gameplay role (src): what it does, how often it's seen, interactive?
Camera (src): view (first/third/top-down), typical distance in m, closest distance
Scale: real height/size in m (or "next to 1.7 m human"); pivot location; forward axis
Style refs (src): 2–3 refs, each with closeness note (close match / mood only)
Negative refs (src): what it must NOT look like
Existing in-game assets it must sit next to (src)
Must-keep features: silhouette elements, key shapes, colors, readable details
May-simplify features: what can be merged, baked to normal map, or dropped
Materials: list of material slots with base color (hex), metal/non-metal, roughness target
Budgets: tris (LOD0), texture size, texel density (px/m), number of materials
Rig/anim needs: static / rigged humanoid (A- or T-pose) / custom rig; moving parts
Deliverables (src): files, formats (FBX/GLB), naming, LODs, collider, prefab
Approval stages (src): e.g. blockout → textured → in-engine; views required per stage (src)
Acceptance criteria (src: "evaluation criteria"): see review checklist (Q4)
```

- An AI agent, unlike a human outsourcer, needs every closeness and must-keep decision written down. "Show what you don't want" (Game Developer) maps directly to a negative-prompt or "avoid" list in the generator prompt.
- The test-asset advice fits a solo dev too: run one representative asset end to end (concept → generator → cleanup → Unity prefab → in-game screenshot) before batch-producing, and lock the settings that worked into the ticket template.

### Gaps
- I found no public studio outsourcing brief with real numeric budgets (tri counts, texture sizes) for a shipped game. Valve's Dota 2 workshop has per-hero "Budgets for models and textures" pages, but I did not fetch one ([Dota 2 workshop requirements index](https://www.dota2.com/workshop/requirements/character_art_guide)).
- None of the sources defines formal acceptance criteria for 3D assets. The checklist in Q4 is my inference.

## 3. Art bibles and style guides for 3D: palettes, shape language, proportions, material and PBR value ranges, texel density, stylized edges; how they are enforced

### Takeaway
A useful 3D style guide fixes a small number of measurable rules: palette and value structure, silhouette readability at the gameplay camera, a detail gradient, PBR albedo and metal ranges (if the game is PBR), and one project-wide texel density. Small teams enforce it with one lead-approved "golden" asset that everyone matches, plus stage-by-stage reviews against the guide. A written guide alone is not enough.

### Cited Findings
**Readability, value and detail (Valve's public Dota 2 character guide, 2012, 18 pages)**
- Each hero should be identifiable at a glance from above, and the silhouette should show orientation. The guide stresses value (lightness and darkness regardless of hue) and a coherent palette (summarized from coverage and search excerpts; full PDF not fetched) — [CG Channel, "Valve releases useful character design guide" (2012-06-20)](https://www.cgchannel.com/2012/06/valve-releases-useful-character-design-guide)
- Patches of small detail look good in the profile view but become hard to read during normal play. If the colors at a hero's feet are as intense as those at the head, the figure is harder to parse, so detail and intensity should fall off toward the feet (search excerpt of Valve's guide) — [CG Channel](https://www.cgchannel.com/2012/06/valve-releases-useful-character-design-guide); [Parka Blogs, Dota 2 Character Design Guide PDF](https://parkablogs.com/content/valves-dota-2-character-design-guide-pdf-download)
- Valve's Dota 2 color-texture guide says in-game lighting is subtle, so artists paint or bake light into the color texture. Most Dota characters use large, crisp graphic patterns for legibility, and adjusting saturation and the value gradient are the final steps (search excerpt; the page body did not load when fetched) — [Steam Support, Dota 2 Workshop – Color Texture Light Baking](https://support.steampowered.com/kb/8700-SJKN-4322/dota-2-character-texture-guide)

**PBR value ranges (primary: Adobe's PBR Guide)**
- Dielectric base color: "For dark values, you should not go under 30-50 sRGB" (30 is the tolerant limit, 50 the strict one), and no higher than 240 sRGB — [Adobe, The PBR Guide Part 2](https://www.adobe.com/learn/substance-3d-designer/web/the-pbr-guide-part-2)
- Raw metal reflectance is 70–100% reflective, which is 180–255 sRGB in base color. Raw metal in the metallic map should be 235–255 sRGB, and if metallic values fall below 235, base-color reflectance should be lowered — [Adobe, The PBR Guide Part 2](https://www.adobe.com/learn/substance-3d-designer/web/the-pbr-guide-part-2)
- Dielectric F0 is 4% (0.04 linear) in metal/roughness, hard-coded in the shader. Common dielectrics are 0.02–0.05 linear (about 40–75 sRGB in specular/gloss); use 0.04 when no IOR is known — [Adobe, The PBR Guide Part 2](https://www.adobe.com/learn/substance-3d-designer/web/the-pbr-guide-part-2)
- Base color must contain no lighting information such as AO (micro-occlusion is the only exception, and it must stay within the brightness range). AO goes in its own channel, and it affects only diffuse — [Adobe, The PBR Guide Part 2](https://www.adobe.com/learn/substance-3d-designer/web/the-pbr-guide-part-2)
- Adobe's guide gives no numeric roughness ranges ("Be creative and tell a visual story about the surface") — [Adobe, The PBR Guide Part 2](https://www.adobe.com/learn/substance-3d-designer/web/the-pbr-guide-part-2)
- The metal range agrees with Cocos engine docs (metals 180–255 sRGB) — [Cocos Creator 3.7 PBR docs](https://docs.cocos.com/creator/3.7/manual/en/shader/effect-builtin-pbr.html). A Polycount practitioner notes the 30/50–240 cutoffs apply per channel, not to the average (practitioner opinion, search excerpt) — [Polycount](https://polycount.com/discussion/comment/2636450)
- Unity publishes "material charts" with reference values for metallic and specular workflows in its Standard shader manual. I did not retrieve the numbers, and these pages are for the Built-in pipeline's Standard shader — [Unity Manual, Material charts](https://docs.unity3d.com/Manual/StandardShaderMaterialCharts.html)

**Texel density**
- Maxon's Cinema 4D docs give 10.24 px/cm (about 1024 px/m) for first-person, 5.12 px/cm (about 512 px/m) for third-person, and 2.56 px/cm or lower for top-down. A closer camera needs higher density, an object with a very different density from its surroundings stands out, and density that is too low looks "spongy" up close — [Maxon C4D 2026 help, Texel Density](https://help.maxon.net/c4d/2026/en-us/Content/html/Texel_Density.html)
- A Polycount practitioner calls 512 px/m "pretty standard" for third-person console games and puts first-person nearer 1024 px/m (practitioner opinion) — [Polycount](https://polycount.com/discussion/comment/2707057). A third-party guide gives about 512–1024 px/m for third-person, 1024–2048 for first-person, and 256–512 for mobile and VR (third-party, unverified) — [StraySpark](https://www.strayspark.studio/blog/texture-resolution-guide-games-512-1k-2k-4k)
- Studios usually set a texel density guideline early in production (third-party blog) — [RebusFarm](https://rebusfarm.net/blog/texel-density-basics-every-artist-should-know)

**Enforcement on small teams**
- On Polycount, an experienced member says a style guide alone isn't enough: talk through the intent behind the visuals with the artists. Once the lead approves one asset, it becomes the target every artist aims for. Each asset is reviewed at major stages (high poly, low poly, UVs, texturing) against the style sheet (practitioner opinion, search excerpts) — [Polycount thread](https://polycount.com/discussion/comment/1692265); [Polycount thread](https://polycount.com/discussion/comment/1694145)
- An OpenGameArt thread suggests writing down the defining criteria, such as a fixed palette and base sizes, and points to the LPC project's public style guide as an example (community) — [OpenGameArt LPC, Maintaining a Consistent Art Style](https://lpc.opengameart.org/node/100360)
- Sloyd (AI 3D vendor) recommends one saved reference image as the style anchor for generated props, characters and environments, with separate saved styles for each asset category (vendor guidance) — [Sloyd blog, How to create 3D assets with AI in a consistent style](https://www.sloyd.ai/en/blog/how-to-style-consistent)

### Inferences
- **Conflict to resolve early:** Valve's stylized guidance paints light into the color texture, while Adobe's PBR guidance forbids any lighting in base color. The art bible has to choose one: PBR (lit by Unity) or hand-painted/unlit-style (lighting in the albedo). Mixing them is a common cause of inconsistent assets. Image-to-3D outputs from lit concept images tend to land in the hand-painted camp by accident (see Q5 and Q6).
- Suggested measurable rules for an agent-checkable style guide (my selection of the cited values): albedo per channel 30–240 sRGB for non-metals (50 if strict); metals 180–255 sRGB; metallic map either 0 or 235–255; no AO or shadows in albedo (if PBR); one project texel density (for example 512 px/m third-person, 1024 px/m first-person, 256 px/m top-down), checked per asset; a palette file (hex values) plus a value-structure rule (focal area brightest or most saturated, detail falling off away from it); a silhouette-at-gameplay-distance test.
- Keep one golden asset per category (character, prop, environment piece) in the agent's reference folder, with in-engine screenshots at gameplay distance. New assets are compared to it side by side (Polycount's "approved piece as target", Sloyd's "style anchor").
- Line and edge treatment for stylized 3D (outline shaders, bevel width, chamfer rules) and proportion rules (head counts, exaggeration ratios) belong in the guide, but I found no sources for them in this pass.

### Gaps
- No public art bible from a shipped 3D game with shape-language and proportion rules was retrieved. GDC Vault talks (for example on Overwatch or Sea of Thieves style) were not found or fetched.
- No source on stylized edge or outline treatment, or on roughness range tables. Adobe explicitly gives none.
- I did not verify Unity 6 URP Lit-specific guidance (for example whether Unity publishes albedo ranges for URP or HDRP in Unity 6). The material-charts page found is for the Built-in Standard shader.
- 80.lv interviews did not come up in searches.

## 4. Review practice: paintovers, side-by-side with the concept, turntables, in-engine checks at gameplay distance; feedback formats that work

### Takeaway
The sources available are thin. The few practitioner sources support reviewing at fixed stages against the style sheet and approved target asset, giving feedback as marks over clean screenshots that the artist supplies, and paintovers on either a plain render or an in-engine screenshot. Valve's readability rules make the in-game camera view the deciding check, because detail that reads in profile view can vanish in play.

### Cited Findings
- Feedback is much faster as marks on clean screenshots from the 3D artist than with direct access to the model, and the artist, not the reviewer, should capture those images (practitioner opinion, search excerpt) — [Polycount thread](https://polycount.com/discussion/comment/2808807/)
- A commenter in the same discussion ruled out third-party model-review web services because client models on outside servers break NDAs (practitioner opinion) — [Polycount thread](https://polycount.com/discussion/comment/2808783)
- Paintovers are used to decide textures and colors. Practitioners discuss whether to paint over a plain render from the modeling package or over an in-engine screenshot (practitioner opinion, search excerpt) — [Polycount thread](https://polycount.com/discussion/comment/1433955)
- Stage-gate reviews: check each asset after high poly, low poly, UVs and texturing against the style sheet (practitioner opinion) — [Polycount thread](https://polycount.com/discussion/comment/1692265)
- When notes are vague, modelers ask for examples or sketches, break feedback into concrete steps (for example "adjust proportions", "refine textures"), and weigh technical feasibility for rigging and animation (vendor FAQ, generic) — [Hitem3D FAQ](https://www.hitem3d.ai/ai-faq/how-do-3d-modelers-incorporate-feedback-from-directors-or-project-leads)
- Small, busy detail reads in the profile view but becomes hard to read in normal play, which argues for judging at the gameplay camera — [CG Channel on Valve's guide](https://www.cgchannel.com/2012/06/valve-releases-useful-character-design-guide)
- Allcorrect's brief asks for "Number of views needed at each stage of the pipeline" and "Evaluation criteria", so the review views are agreed in the brief (vendor) — [Allcorrect Games](https://allcorrectgames.com/insights/brief-for-developing-game-art/)

### Inferences
Suggested **review checklist** the agent can run and attach screenshots to (my synthesis, not from one source):
1. Side-by-side: render at the same angle and focal length as each concept view (front, side, back, 3/4) next to the concept image. Note deviations on must-keep features.
2. Turntable: 8 fixed angles (every 45°) or a short GIF, neutral lighting, plain background.
3. In-engine: the Unity prefab in a test scene with the game's real lighting and post-processing, captured at the gameplay camera's typical and closest distance, next to the golden asset.
4. Silhouette: a flat black render at gameplay distance. Is it still identifiable, and does it show orientation (Valve)?
5. Technical: tri count vs budget, texture size, measured texel density vs target, albedo range check (30–240 non-metal), scale (height in m), pivot, axis, naming.
6. Feedback format: numbered marks drawn on the screenshot (paintover), each with one concrete action ("widen the shoulder pads 15%", "remove the shadow baked under the brim"), plus a verdict (approve / revise / reject).

- For an agent loop, the "artist supplies the clean screenshots" rule means the agent should produce the review images itself (Unity editor screenshots or a turntable script) and present them. The user then marks them up or replies with numbered notes.

### Gaps
- No GDC talk or studio document on art review cadence or feedback formats was found. In-engine turntable review practice was not directly sourced.
- No source compared feedback formats (paintover vs written vs video) for effectiveness.

## 5. Preparing images for AI image-to-3D generation: background, neutral pose, lighting, extra views, resolution

### Takeaway
Vendor guidance agrees: one subject, plain or removed background, soft even lighting with no harsh shadows, near-orthographic framing, and a reasonably high-resolution image (Meshy's floor is 512×512). Add consistent multi-view images (front required; side, back and 3/4 recommended) in the same pose and lighting. For humanoid characters, Meshy can re-pose to A- or T-pose itself, so a dynamic concept can still be used. Extra views can be generated from one image with an image-editing model, but those views are guesses.

### Cited Findings
- Meshy (vendor docs): formats JPG and PNG; "resolution ≥ 512×512"; a clear single subject on a simple background; remove busy backgrounds (built-in AI background removal). A cluttered multi-object scene can make the AI merge objects into one distorted mesh — [Meshy docs, Image to 3D](https://docs.meshy.ai/en/webapp/image-to-3d)
- Meshy: use evenly lit images, because shadows or dark areas can cause black patches on the surface. Use near-orthographic or telephoto framing to avoid severe perspective distortion — [Meshy docs](https://docs.meshy.ai/en/webapp/image-to-3d)
- Meshy multi-view: 2–8 images, recommended "Front + Side + Back + 3/4 view", all of the same object under similar lighting — [Meshy docs](https://docs.meshy.ai/en/webapp/image-to-3d)
- Meshy pose: Custom Pose offers 6 presets or manual joint adjustment, and the output takes the set pose rather than the image's pose. Set T-pose or A-pose for Animate auto-rigging. Humanoids only; other subjects keep the pose shown in the image — [Meshy docs](https://docs.meshy.ai/en/webapp/image-to-3d). Via the API the pose value is "a-pose", "t-pose" or empty, and auto-rigging works best on humanoids with clearly defined limbs — [fal.ai Meshy V7](https://fal.ai/models/meshy/v7/image-to-3d/llms.txt); [Scenario docs, Meshy](https://docs.scenario.com/docs/3d-model-generation-meshy)
- Meshy model names as of this check: Meshy 7 is the image-to-3D model (Ultra Mode on Meshy 7 only). Smart Topology (Meshy T2 by default) outputs a target of 100–15,000 polygons (vendor; names change often) — [Meshy docs](https://docs.meshy.ai/en/webapp/image-to-3d)
- **Conflict on resolution and formats:** Meshy's own docs say ≥512×512 and JPG/PNG. A third-party guide says short side ≥1024 px (≥2048 px with Refine), PNG/JPG/WebP and 20 MB max. Treat 1024+ as the safer target, unverified (search excerpt) — [Hakky Handbook, Meshy guide](https://book.st-hakky.com/en/data-science/meshy-image-to-3d-model-guide)
- Meshy's help center recommends a clear, front-facing image with a plain background (search excerpt; article 404 when fetched) — [Meshy help center](https://intercom.help/meshy/en/articles/9996860-how-to-use-meshy-image-to-3d)
- Tripo (via third-party docs): multi-view is supported on Tripo v3.1 and Tripo P1. Front view required plus at least one of left, right or back. Use consistent lighting, a clean background, and the same pose in every view. TRELLIS 2 takes a single image only — [ComfyUI docs, Tripo P1](https://docs.comfy.org/tutorials/partner-nodes/tripo/tripo-p1); [Scenario docs, Tripo](https://docs.scenario.com/docs/3d-model-generation-tripo-ai)
- Generating extra views: a Scenario case study generated left, back and right views of a hero character with an image-editing model, then fed all four into Tripo 3.1 Multi View. It notes that from a single image "the front is grounded in the reference while the sides and back are inferred" (vendor) — [Scenario blog, Tripo image-to-3D 2026](https://www.scenario.com/blog/tripo-image-to-3d-model-ai-2026)
- A tester found Tripo works best on clean, clear shapes, and that intricate textures can confuse the modeling (third-party, search excerpt) — [Midlibrary, Tripo AI](https://midlibrary.io/midguide/tripo-ai-midjourney-to-3d)

### Inferences
**Image-prep checklist for the agent** (synthesized from the vendor rules above):
- One subject, centered, whole object in frame with a small margin; background removed (transparent PNG) or flat neutral gray or white.
- Flat, even, frontal lighting. No cast shadows, rim light, strong specular highlights or dark occluded areas (Meshy: they turn into black patches). If the concept is a moody painting, make a flat-lit version first.
- Near-orthographic: no wide-angle foreshortening. Front view at eye level with the object's center.
- Humanoids: neutral A-pose (or T-pose), arms clear of the body, legs slightly apart, no props crossing the body, symmetric unless asymmetry is intended. Meshy can re-pose humanoids, but a clean neutral input avoids merged limbs (inference). Non-humanoids keep their pose, so pose the object as it should exist in the game (Meshy).
- Multi-view set: front (required) + side + back + 3/4, same pose, scale, lighting and color in every image. If views are AI-generated from one image, the agent should check them against the must-keep list before submitting, because they are inferred.
- Resolution: at least 1024 px on the short side (Meshy's floor is 512). PNG.
- Simplify noisy surface texture in the input if geometry matters more than surface detail (Tripo tester). Supply the texture or pattern separately.
- Record the generator, model version, settings and seed in the asset folder. Vendor model names change fast (Meshy 7 / T2, Tripo v3.1 / P1 as of this check).

**Prompt template skeleton** for an agent driving a text- or image-conditioned generator (inference):
`<asset name>, <category>, <style anchor phrase from art bible>, <primary shapes / must-keep features>, <materials with colors>, neutral A-pose (if humanoid), front view, orthographic, even flat studio lighting, no shadows, plain white background, centered, full object visible` + avoid list: `<negative refs>, perspective distortion, cast shadows, background objects, cropped parts, text, extra limbs`.

### Gaps
- I did not check input guidelines from Hyper3D Rodin, Tencent Hunyuan3D, Microsoft TRELLIS, Unity's own AI generators, or Stability's 3D models. Only Meshy (primary docs) and Tripo (third-party docs) were covered.
- No vendor states an exact best lighting setup or background color. "Even light" and "plain background" are as specific as they get.
- I found no vendor guidance on whether stylized (non-PBR, painted-light) concepts produce baked lighting in the generated textures. The inference in Q6 is unverified.

## 6. Common mistakes going from 2D concept to 3D, and how they are resolved

### Takeaway
The recurring problems are views that disagree with each other, painted indicative detail instead of readable form, designs that only work from one angle (optical illusions), animation-hostile features, perspective distortion, and lighting or shadow painted into the image. Practitioners fix them by asking for clean, consistent orthos or drawing their own extra views, blocking out big forms first, getting a technical check from the animator before modeling, and, for AI input, re-rendering the concept flat-lit and near-orthographic.

### Cited Findings
- Some concept art "looks totally fine but if you study it closely and try to recreate it 1:1 it's just not going to happen". 2D optical illusions can't be built as painted (practitioner opinion, search excerpt) — [Polycount thread](https://polycount.com/discussion/comment/1571115); [Polycount thread](https://polycount.com/discussion/comment/1570800)
- Irregularities between front, side and rear views force the modeler to guess (practitioner opinion, search excerpt) — [Polycount thread](https://polycount.com/discussion/comment/1571115)
- Workarounds: draw your own angles or perspective from the concept, and draw over it to work out the major shapes and forms before modeling (practitioner opinion, search excerpt) — [Polycount thread](https://polycount.com/discussion/comment/2609247/); [Polycount thread](https://polycount.com/discussion/comment/2609003)
- Flowing cloth and tentacles on secondary characters are hard to animate and cost performance. Show the final concept to the animator for a technical check (practitioner opinion, search excerpt) — [Polycount thread](https://polycount.com/discussion/comment/2609415)
- Indicative painted detail instead of clear line work makes modelers' lives difficult (practitioner opinion, search excerpt) — [Polycount thread](https://polycount.com/discussion/comment/1570746)
- Missing views of asymmetric sides are handled by requiring the other side to be drawn in the turnaround (modding-project spec, search excerpt) — [Beyond Skyrim wiki](https://wiki.beyondskyrim.org/wiki/Arcane_University:2D_definitions)
- For AI generators, perspective distortion and shadows or dark areas cause distorted geometry and black patches on the texture (vendor) — [Meshy docs](https://docs.meshy.ai/en/webapp/image-to-3d)
- For PBR, lighting in base color is wrong by definition: no AO or lighting in albedo — [Adobe, The PBR Guide Part 2](https://www.adobe.com/learn/substance-3d-designer/web/the-pbr-guide-part-2)

### Inferences
- **Painted-in lighting** is the main trap for an image-to-3D workflow. The generator projects image colors onto the texture, so painted highlights and shadows become part of the albedo (inferred from Meshy's black-patch warning and Adobe's no-lighting rule). Fix: ask for a flat-lit "material pass" of the concept (local colors only) as the generator input, and keep the lit painting as a mood reference. Then check the albedo range (30–240) on the output.
- **Ambiguous depth** (how far does a feature stick out, is it concave or convex) is resolved by a side view or a callout ("protrudes ~5 cm", "recessed") in `brief.md`, since a front view alone can't show it. The agent should flag any must-keep feature whose depth isn't shown in any view and ask instead of guessing.
- **Impossible geometry** (parts that intersect, joints that can't rotate) is caught by a blockout review before detailing: a quick gray-box model or the first AI generation, reviewed as a turntable against the concept.
- **Inconsistent AI-generated views:** if extra views come from an image model, they can disagree with the front (Scenario: sides and back are inferred). Treat them like an inconsistent turnaround. The front view and the written must-keep list win.

### Gaps
- No professional, consolidated source (GDC talk, book chapter or studio doc) listing concept-to-3D pitfalls was found. The findings are practitioner forum opinion read through search excerpts, because Polycount pages returned 403.
- How strongly each image-to-3D service bakes input lighting into textures, and whether any offer "de-lighting", was not checked.
