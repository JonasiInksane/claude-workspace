# Professional pipeline: concept art to game-ready 3D assets (props, environment, characters), late 2026

Research notes, 2026-10-21. Target user: solo dev, Windows 11, Unity 6 (6000.4) installed, Blender not installed yet.

Source access caveats for the report writer:
- The Polycount wiki (wiki.polycount.com: "Polygon Count", "Texel density" and related pages) refused connections during this session, and web.archive.org could not be fetched. Nothing in these notes comes from the Polycount wiki.
- GDC Vault talk pages are members-only, so only the session descriptions were available.
- The Blender manual FBX and glTF pages returned only navigation text through the fetch tool, so the Blender export settings below come from secondary guides and are marked as such.
- Several hits were vendor blogs from AI-3D or outsourcing companies (Neural4D, Tripo, Pixune, Sloyd, Innovecs). They are labelled "vendor" wherever they are used.

## 1. What are the stages, and which ones do indie/stylized pipelines skip or merge?

### Takeaway
The standard AAA-style chain is concept/callouts -> blockout -> high-poly/sculpt -> retopo/low-poly -> UV -> bake -> PBR texture -> LODs/collision -> export -> engine setup. Each stage gets more expensive to reverse than the one before, so scale, silhouette and budget get locked at concept and blockout. Indie and stylized pipelines mostly cut the high-poly and bake stages: they model the low-poly directly and texture it with trim sheets, tiling materials, palette/gradient atlases or hand painting. For environment work they also replace one-off assets with grid-snapped modular kits.

### Cited Findings
**Overall stage model**
- A 2026 guide frames asset creation as ordered stages and argues that reversing a decision gets steeply more expensive the further down the pipeline it happens. It says a game-ready spec should state the triangle budget, a texel density kept consistent across the set, a PBR texture set with a resolution per map, and the shader/material slot setup. Both guides below are outsourcing-studio content. — [Innovecs Games, "How to Make Game Assets: A Practical Step-by-Step Guide for 2026"](https://www.innovecsgames.com/blog/how-to-make-game-assets/); [Pixune, "Game Art Production Pipeline"](https://pixune.com/blog/game-art-pipeline)
- AI-generated topology and UVs "often require human review" (vendor context, from the same search). — [Innovecs Games](https://www.innovecsgames.com/blog/how-to-make-game-assets/)

**Baking stage (high-poly to low-poly)**
- In Substance 3D bakers, rays start from a "frontal distance" envelope or from a cage mesh. A larger high/low mismatch needs a larger distance, and rays that are too long hit neighbouring geometry. — [Adobe, Substance 3D Painter baking parameters tutorial](https://www.adobe.com/learn/substance-3d-painter/web/substance-3d-painter-baking-parameters); [Substance Automation Toolkit, baker parameters](https://helpx.adobe.com/substance-3d-sat/integrations/substance-maya-toolset/how-to-bake/baker-parameters.html)
- With a custom cage, Painter locks Max Frontal/Rear distance, so ray coverage has to be fixed on the cage itself. When nearby geometry makes the cage self-intersect and produce artifacts, reducing Max Frontal Distance helps. — [Adobe community, baking issues thread](https://community.adobe.com/t5/substance-3d-painter-discussions/help-with-baking-issues/m-p/14216774/highlight/true); [Adobe community, inner cage rays thread](https://community.adobe.com/questions-59/baking-issues-in-substance-painter-suspecting-inner-cage-rays-not-reaching-the-model-629548)
- Dilation ("padding") extends UV-island pixels past their borders by a set number of pixels after the bake, which prevents seams. "Apply Diffusion" fills the empty space with smoothed colours. Anti-aliasing options are None (default) and Subsampling 2x2/4x4/8x8: a 2K bake at 2x2 is computed at 4K. Adobe says raising the ray count is sometimes better than raising subsampling. — [Adobe Substance 3D Bakers, Common Parameters](https://experienceleague.adobe.com/en/docs/substance-3d/bakers/bakers-settings/common-parameters)
- A forum reply (community advice, not official) suggests dilation plus diffusion at about 5–10 px. — [Adobe community thread](https://community.adobe.com/t5/substance-3d-painter-discussions/help-with-baking-issues/m-p/14216774/highlight/true)

**Normal-map convention (texturing to engine hand-off)**
- "Unity uses Y+ normal maps", "sometimes known as OpenGL format". Height maps must be converted to normal maps on import. — [Unity Manual, Normal map](https://docs.unity3d.com/6000.4/Documentation/Manual/StandardShaderMaterialParameterNormalMap.html)
- OpenGL and DirectX normal maps differ only in the direction of the green channel, and nothing in the file records which one it is. Substance Painter is reported to default to DirectX. The convention is set in the New Project dialog, the Bake Textures dialog and the normal map's Color Spaces tab. — [CGAxis](https://cgaxis.com/which-normal-map-should-i-use-opengl-or-directx/); [Versluis, flipping normal maps in Painter](https://www.versluis.com/2022/10/how-to-flip-imported-normal-maps-in-substance-painter/)
- A secondary source claims that Unity auto-flips DirectX maps on import. Search could not confirm this. — [StraySpark blog](https://www.strayspark.studio/blog/directx-vs-opengl-normal-maps-explained)

**Stylized and indie shortcuts**
- **Palette atlas:** a shared texture of colour squares, with each model's UV islands moved onto the colour cells. The point is one material for every model, which avoids draw calls. Tutorials recommend "closest" texture interpolation for crisp cells and collapsing UV islands to a point. — [BlenderNation (jayanam), low-poly Blender](https://www.blendernation.com/2017/10/25/low-poly-blender/); [BlenderNation Bazaar, one-texture atlas tutorial](https://bazaar.blendernation.com/listing/this-blender-scene-uses-only-one-texture-texture-atlas-colour-palette-tutorial/)
- One indie devlog reports that "material changes are one of the more costly operations in rendering", that a single-material scene performs much better than one material per colour, and that its low-poly models rarely need more than about 10 colours. — [Papaya Games devlog, "Blazing-fast rendering with a single material per scene"](https://papaya-games.itch.io/duck-in-town/devlog/73530/blazing-fast-rendering-with-a-single-material-per-scene)
- Palette-atlas tooling exists on both sides of the pipeline: Blender add-ons such as MV Low Poly Painter (builds the atlas and moves face UVs to colour blocks) and Unity tools such as Palette Modifier (recolours Synty-style atlases in engine). — [MV Low Poly Painter docs](https://superhivemarket.com/products/mv-low-poly-painter/docs); [Palette Modifier, Unity Discussions](https://discussions.unity.com/t/released-palette-modifier-change-the-colors-of-low-poly-models-directly-inside-unity/760556)
- **Trim sheets:** design the texture first, then unwrap the geometry onto it. The technique is used to cut draw calls and is common on environment pieces. — [3D Reference, Trim Sheets](https://3dreference.notion.site/Trim-Sheets-e6e86d4155f845e3bb3ed6b04b0c6cab)
- Insomniac's GDC 2015 talk "The Ultimate Trim: Texturing Techniques of Sunset Overdrive" (Morten Olsen) described a specific trim layout and normal-map structure aimed at production speed, memory and performance. It also covered a UV-mapping script and a custom shader for style and variation. — [GDC Vault session 1022323](https://gdcvault.com/play/1022323/The-Ultimate-Trim-Texturing-Techniques) (members-only; description only)
- Community reproductions of the Ultimate Trim technique use two 45-degree bevel strips, one on each adjacent face, to make a 90-degree corner. Without extra strips this limits it to 90-degree transitions. Snapping UVs inward by a pixel removes blend artifacts, and hard edges on the bevels removed seams. — [Polycount comment 2793276](https://polycount.com/discussion/comment/2793276); [Polycount comment 2618735](https://polycount.com/discussion/comment/2618735/)

**Example environment breakdown**
- An environment breakdown (Burial at Sea, BioShock Infinite fan scene, built for Unreal) covers this sequence:
  1. Model the trim sheet in Blender, then bake and texture it in Substance Painter.
  2. Build the modular kit with splines and keep it on the grid.
  3. Check snapping in Blender before moving to the engine.

  — [gamesartist.co.uk, Burial at Sea breakdown (Matt Cane)](https://gamesartist.co.uk/burial-at-sea-environment-breakdown-matt-cane/)

### Inferences
**Hand-off artifact per stage**

Assembled from the findings above plus standard practice. These are not all individually sourced, so treat them as a proposed checklist:

| Stage | Hand-off artifact |
|---|---|
| Concept | Orthographic sheet or turnaround with callouts (materials, scale, functional parts) |
| Blockout | Untextured mesh at real scale, placed in engine next to a player-height reference |
| High-poly | Sculpt or subdivision mesh, decimated for baking |
| Low-poly | Triangulated-safe mesh with smoothing/hard edges set |
| UV | UV0 at the target texel density, plus UV1 lightmap UVs if baked lighting is used |
| Bake | Normal, AO, curvature, thickness, ID maps |
| Texturing | BaseColor + Normal + packed mask per engine (see section 2) |
| LOD/collision | _LOD0.._LODn meshes plus collision primitives |
| Export | FBX or glTF |
| Engine | Material + prefab in Unity |

**Indie/stylized merges**
- Skip high-poly and bake entirely: model the low-poly directly and use weighted normals or chamfers instead of baked normals. Then texture with a palette atlas, tiling materials or a trim sheet. This removes the cage/padding/bake QA gate.
- For an automated or assisted workflow, the cheapest validated path is probably blockout -> low-poly -> UV onto trim or palette atlas -> engine. The full bake pipeline can be kept for hero props only.

**Tools needed per stage (solo dev)**
- Modelling, sculpting, retopo, UV, bake and export: Blender (free; needs installing).
- Texturing: Substance 3D Painter (subscription) or Blender's own painting and baking. Optional bakers include Marmoset Toolbag.
- Engine side: Unity 6 (already installed). Add the glTFast package only if glTF is used.
- This tool list is an inference. Painter licensing and pricing were not checked in this session.

### Gaps
- No primary source (GDC talk transcript or studio doc) was readable that lists a canonical stage list with formal gate names. The stage list is industry convention, supported only indirectly above.
- The Polycount wiki's pipeline pages (Normal map, Texture baking, Edge padding) were unreachable.
- The exact Ultimate Trim layout dimensions are only in the members-only GDC slides.

## 2. Game-ready specs: triangle budgets, texel density, texture sizes and packing, naming, scale, pivots, axes, units (Unity 6 URP/HDRP; FBX vs glTF)

### Takeaway
Hard public numbers are rare. The best primary studio spec found is Valve's Dota 2 Workshop per-slot table, which sets LoD0/LoD1 triangle limits and texture sizes. The other platform numbers are frame-level (Meta Quest draw calls; PC 1–2M triangles per frame). Per-asset character budgets come mostly from vendor blogs and conflict widely.

Texel-density conventions converge on about 5.12 px/cm (512 px/m) for third-person games and 10.24 px/cm (1024 px/m) for first-person games.

Unity facts that matter for the pipeline:
- 1 unit = 1 m.
- Normal maps are Y+ (OpenGL convention).
- URP packs Metallic (R) / Occlusion (G) / Smoothness (A).
- HDRP packs Metallic (R) / AO (G) / Detail mask (B) / Smoothness (A).
- The `_LODn` name suffix auto-creates a LOD Group, with up to 8 levels.
- FBX imports natively. glTF needs the glTFast package.

### Cited Findings
**Triangle budgets: primary studio spec (Valve, Dota 2 Workshop, current site)**

Tusk per-slot limits:

| Slot | LoD0 triangles | LoD1 triangles | Texture size |
|---|---|---|---|
| Head | 3000 | 1200 | 512x512 |
| Neck | 1500 | 600 | 256x256 |
| Shoulders | 3000 | 1200 | 256x512 |
| Arms | 1500 | 600 | 256x256 |
| Back | 2500 | 1000 | 256x256 |
| Weapon | 2500 | 1000 | 256x256 |
| Sigil | 2500 | 1000 | 256x256 |

The LoD1 limit is exactly 40% of LoD0 in every row. — [Dota 2 Workshop requirements, Tusk](https://www.dota2.com/workshop/requirements/tusk)

Other heroes (from search results, pages not opened individually):

| Hero | Slot | LoD0 triangles | LoD1 triangles | Texture size |
|---|---|---|---|---|
| Pudge | Back | 2000 | 800 | 512 |
| Pudge | Arms | 1500 | 600 | 256 |
| Kez | Shoulders | 6000 | 2400 | 512 |
| Ringmaster | Armor | 11000 | 4400 | 512 |
| Undying | Flesh Golem | 10000 | 4000 | 1024 |

Sources: [Pudge](https://dota2.com/workshop/requirements/pudge); [Kez](https://www.dota2.com/workshop/requirements/kez); [Ringmaster](https://www.dota2.com/workshop/requirements/ringmaster?l=english); [Undying](https://www.dota2.com/workshop/requirements/undying)
- Workshop textures are rescaled on import to the slot's resolution, whatever the authored size. — [Polycount comment 2453437](https://polycount.com/discussion/comment/2453437/) (community report)

**Triangle budgets: frame-level platform guidance (Meta)**
- Meta does not give a fixed triangle budget for standalone Quest. It says triangle budgets "fluctuate" like draw-call budgets, and that triangles spanning several GPU tiles cost more. — [Meta, Unity performance](https://developers.meta.com/horizon/documentation/unity/unity-perf/)
- Meta's draw-call ranges for standalone headsets: Quest 3/3S about 200–300 (busy), 400–600 (medium), 700–1,000 (light); Quest 2/Pro about 80–200, 200–300, 400–600. — [Meta, Unreal Android debug](https://developers.meta.com/horizon/documentation/unreal/unreal-debug-android)
- Meta's PC/Rift guideline: about 500–1,000 draw calls and 1–2 million triangles or vertices per frame. This is a PC reference, not Quest. — [Meta, PC performance guidelines](https://developers.meta.com/horizon/documentation/native/pc/dg-performance-guidelines/)

**Triangle budgets: vendor and anecdotal per-asset numbers (low confidence, conflicting)**
- Mobile hero character: 1,500–5,000 triangles (Neural4D, vendor) vs 15K–30K (Tripo, vendor).
- Console/PC hero character: 15K–50K (Neural4D) vs 50K–100K+ (Tripo).
- Neural4D notes that overdraw, not triangle count, is the real mobile killer. — [Neural4D poly-count guide](https://blog.neural4d.com/user-guide/polygon-count-for-3d-game-assets/); [Tripo, poly count for game assets](https://www.tripo3d.ai/blog/poly-count-for-game-assets-how-to-prepare-ai-3d-models)
- An older Polycount thread (2010s, anecdotal) puts a human character at about 15,000–25,000 triangles for the body alone, rising to about 50,000–60,000 with clothing and props. — [Polycount comment 2024310](https://polycount.com/discussion/comment/2024310)

**Texel density**
- Maxon's Cinema 4D 2027 documentation gives example texel densities by camera perspective: first person "e.g. 10.24", third person "e.g. 5.12" (px/cm), with higher density the closer the camera gets. — [Maxon C4D 2027 Help, Texel Density](https://help.maxon.net/c4d/2027/en-us/Content/html/Texel_Density.html)
- A 2026 pipeline blog gives 512 px/m for third-person environments and 1024 px/m for close-up first-person props, adding that these are not industry standards. The search result did not cleanly attribute this to one of the two URLs below. — [Innovecs Games 2026 guide](https://www.innovecsgames.com/blog/how-to-make-game-assets/) / [Unboxfuture, "From 2D Canvas to 3D World" (2026-07)](https://www.unboxfuture.com/2026/07/from-2d-canvas-to-3d-world-complete-5.html)
- A student portfolio (Rookies) used an average of 10.24 px/cm across trim sheets and tiling textures for consistency. — [The Rookies entry](https://www.therookies.co/entries/38924)
- Not every part of an environment needs the same density, but keeping it uniform early is simpler. — [Alex Nevarez, stylized modular tutorial](https://alexnevarez.artstation.com/blog)
- Texel density is commonly expressed as px/m, the texture pixels covering one metre of surface. — [Texelmaster docs](https://superhivemarket.com/products/texelmaster-texel-density-manager/docs)

**Channel packing: Unity URP (Unity 6.0–6.4 manual)**
- One RGBA texture: R = Metallic, G = Occlusion, B = unused, A = Smoothness.
- Turn sRGB (Color Texture) off and assign the texture to both the Metallic and Occlusion slots. Use Shader Graph for other packings. — [Unity Manual, URP channel-packed texture](https://docs.unity3d.com/Manual/urp/shaders-in-universalrp-channel-packed-texture.html)
- URP Lit "Smoothness Source" defaults to Metallic Alpha (alternative: Albedo Alpha), and the texture value is multiplied by the Smoothness slider. The detail mask uses the alpha channel. — [Unity 6.4 Manual, URP Lit shader](https://docs.unity3d.com/6000.4/Documentation/Manual/urp/lit-shader.html)

**Channel packing: Unity HDRP**
- Mask map: R = Metallic, G = Ambient Occlusion, B = Detail mask, A = Smoothness. Import as linear (not sRGB). — [HDRP Mask and detail maps](https://docs.unity3d.com/Packages/hdrp/manual/Mask-Map-and-Detail-Map.html); [Unity Learn, HDRP Material Properties](https://learn.unity.com/tutorial/hdrp-material-properties-2019-3)
- HDRP TerrainLit uses a different order (R = height, G = smoothness, B = metallic per the TerrainLayer reference). — [Unity ScriptReference, TerrainLayer.maskMapTexture](https://docs.unity.cn/es/ScriptReference/TerrainLayer-maskMapTexture.html)

**Channel packing: glTF**
- Metallic is in B and roughness in G of the metallicRoughness texture. Note that it is roughness, not smoothness, so it is inverted relative to Unity. — [Blender manual, glTF 2.0 add-on (3.3)](https://docs.blender.org/manual/en/3.3/addons/import_export/scene_gltf2.html); [ShapeDiver, glTF 2.0 material](https://help.shapediver.com/doc/gltf-2-0-material)

**Normal maps**
- Unity expects Y+ (OpenGL) normal maps. — [Unity Manual](https://docs.unity3d.com/6000.4/Documentation/Manual/StandardShaderMaterialParameterNormalMap.html)

**Texture import (Unity 6)**
- Max Size caps the imported dimension. Higher values use more memory and take longer to compress. The Default tab sets size and format for all platforms, with per-platform overrides. — [Unity Manual, Texture Importer](https://docs.unity3d.com/Manual/class-TextureImporter.html)
- ASTC is "generally recommended" on mobile. ETC2 and DXT5/BC3 need dimensions that are multiples of 4. — [Unity Discussions, "Optimising Unity Texture Import Settings"](https://discussions.unity.com/t/optimising-unity-texture-import-settings/1631377) (forum post)

**Naming**
- Epic's pattern is `[AssetTypePrefix]_[AssetName]_[Descriptor]_[OptionalVariant]`, with prefixes SM_ (static mesh), SK_ (skeletal mesh), M_ (material), MI_ (material instance), T_ (texture) and PHYS_ (physics asset). Texture descriptors (e.g. _D/_N/_ORM) are left to the team. — [Epic, Recommended Asset Naming Conventions](https://dev.epicgames.com/documentation/en-us/unreal-engine/recommended-asset-naming-conventions-in-unreal-engine-projects)
- In Unity, the mesh suffix `_LODX` (e.g. `ExampleMeshName_LOD0`) in an FBX makes Unity create a LOD Group automatically. The maximum is 8 LOD levels, and LOD0 is the most detailed. — [Unity 6.4 Manual, Configure LOD Group](https://docs.unity3d.com/6000.4/Documentation/Manual/lod-group-configure.html)

**Scale, units, axes, pivots: Unity FBX importer (Unity 6.4)**
- Unity physics expects 1 m in game = 1 unit in the file. Scale Factor applies a global scale, and Convert Units converts the file's unit scale.
- Bake Axis Conversion writes the axis conversion into the asset data. When it is off, the root Transform compensates.
- Defaults: Read/Write off, Optimize Mesh = Everything, Weld Vertices on, Index Format = Auto, Normals = Import, Tangents = Calculate Mikktspace.
- Also available: Generate Lightmap UVs, Generate Colliders, Mesh Compression.
- New "Mesh LOD" options: Generate Mesh LODs, Discard Odd Levels, Limit LODs, Maximum Levels. — [Unity 6.4 Manual, FBX Importer Model tab](https://docs.unity3d.com/6000.4/Documentation/Manual/FBXImporter-Model.html)

**Unity Mesh LOD (Unity 6.2+)**
- Mesh LOD generates LODs at import ("Generate mesh LODs", which increases import time) and stores them in the mesh's index buffer. It has a smaller memory footprint than LOD Group but optimizes only geometry: there is no per-LOD material or renderer control. — [Unity 6.2, Generate Mesh LODs](https://docs.unity3d.com/6000.2/Documentation/Manual/lod/mesh-lod-generate-lods.html); [Unity, Mesh LOD introduction](https://docs.unity3d.com/Manual/lod/mesh-lod-introduction.html); [Unity 6.2, LOD Group landing](https://docs.unity3d.com/6000.2/Documentation/Manual/lod/lod-group-landing.html)
- Generating Mesh LODs on models that already contain `_LODx` meshes is "not recommended". — [Unity 6.2, Generate Mesh LODs](https://docs.unity3d.com/6000.2/Documentation/Manual/lod/mesh-lod-generate-lods.html)

**Blender to Unity FBX (secondary sources only; the Blender manual page was unreadable)**
- With default unit settings, Blender FBX exports often arrive in Unity scaled 100x.
- The common recipe:
  - Scene: Metric, Unit Scale 1.0.
  - Exporter: Scale 1.00, Apply Scalings = "FBX Units Scale", Apply Unit ticked.
  - Axes: Forward -Z, Up Y.
  - Unity: optionally tick Bake Axis Conversion.
- Sources disagree on Apply Scalings ("All Local" or "FBX All") and on the "Apply Transform" option, which is experimental and can distort deep child rotations. All agree that up must be Y. — [Katsbits, Unity & Blender FBX scale](https://www.katsbits.com/codex/unity-blender-fbx-scale); [Unity Discussions thread 167005](https://discussions.unity.com/t/imported-models-from-blender-2-77-are-scaled-x100-in-unity-5-3/167005); [Cinevva, Blender-to-Unity export checklist](https://app.cinevva.com/guides/blender-to-unity-export-checklist); [Blender addons issue #70161](https://projects.blender.org/blender/blender-addons/issues/70161)

**Pivot / anchor**
- For characters, Unity says to put the feet on the local origin. — [Unity 6.4 Manual, Preparing humanoid assets](https://docs.unity3d.com/6000.4/Documentation/Manual/UsingHumanoidChars.html)

**FBX vs glTF in Unity 6**
- FBX is imported natively. glTF/GLB needs the Unity glTFast package (com.unity.cloud.gltfast), a ScriptedImporter.
- glTFast extension support is listed per extension: KHR_materials_clearcoat and KHR_texture_basisu are supported; KHR_materials_specular, volume and sheen are listed as planned.
- glTFast imports up to 8 UV sets, but its shaders use only 2.
- Keep .bin and image files next to the .gltf with their relative paths unchanged. — [glTFast 6.5 features](https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.5/manual/features.html); [glTFast 6.0 features](https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.0/manual/features.html); [glTFast editor import](https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.2/manual/ImportEditor.html)
- Claims that glTF "loads materials much more correctly" than FBX come from secondary or vendor blogs and conflict with each other. — [Neural4D Unity 6 import guide](https://blog.neural4d.com/user-guide/how-to-import-3d-models-into-unity-6-fbx-glb-ai-workflow/); [binna Notion comparison](https://binna.notion.site/Comparing-Material-Application-glTF-vs-FBX-in-Unity-1bd6d763bcdf80ab827fd6f8b098f212)

**LOD ratios**
- Unity Learn suggests cutting triangles by 50% between LOD levels. — [Unity Learn, Level of Detail](https://learn.unity.com/tutorial/level-of-detail-3653)
- Simplygon: art guidelines often specify LOD1 = 50% and LOD2 = 25%, but flat ratios fail per asset. It recommends screen-size or max-deviation targets instead (target_max_deviation = scene_bounding_sphere_diameter / target_on_screen_size). — [Simplygon, "What is the right reduction target for LOD creation?"](https://simplygon.com/posts/b83478b7-a2a1-46a9-a0e1-cba3da7da307); [Simplygon, LOD transitions](https://simplygon.com/posts/51aba9d5-bafd-459d-94b8-718273fdf092)
- A Blender LOD add-on's "Balanced" preset uses 100/50/25/12.5% for LOD0–LOD3. — [Lod Builder docs](https://superhivemarket.com/products/lod-builder--blender-addon-for-game-asset-lod-generation/docs)
- Valve's Dota 2 LoD1 limit is 40% of LoD0. — [Dota 2 Tusk](https://www.dota2.com/workshop/requirements/tusk)

**Collision (Unity)**
- Convex Mesh Colliders are limited to 255 triangles (older Unity manuals). A Unity 6 forum thread quotes a warning that a convex mesh couldn't be built within the 256-polygon limit, after which a partial hull is used. — [Unity 2018.4 Manual, Mesh Collider](https://docs.unity3d.com/es/2018.4/Manual/class-MeshCollider.html); [Unity Discussions, Unity 6 collider limitation](https://discussions.unity.com/t/can-we-have-new-system-that-gets-rid-of-this-physics-collider-limitation-in-unity-6/950590)
- Mesh colliders cost more than primitives, so use them "sparingly". Non-convex mesh colliders are only allowed on GameObjects without a Rigidbody. — [Unity 2018.4 Manual, Mesh Collider](https://docs.unity3d.com/es/2018.4/Manual/class-MeshCollider.html)

### Inferences
**Suggested default spec for the user's Unity 6 URP project (to validate)**
- Units: 1 unit = 1 m. Up axis: Y.
- Pivot: base-centre for props and environment, feet at origin for characters, grid corner for modular pieces.
- Texel density: 512 px/m (third-person) or 1024 px/m (first-person).
- Textures: BaseColor (sRGB), Normal (Y+/OpenGL), and a linear mask with R = Metallic, G = AO, A = Smoothness. Glossiness = 1 − roughness, so Substance's export preset must target Unity URP/HDRP rather than glTF ORM.
- LODs: `_LOD0..2` at about 100/50/25%, or Unity Mesh LOD for simple props.
- Collision: primitives first, convex hulls under 255 triangles.
- Format: FBX unless a glTF-first toolchain is chosen.

**Validation notes**
- The Dota numbers are a stylized top-down MOBA at small screen size. They are useful as a floor for small attachments, not as general budgets.
- An automated validator can check the following:
  - triangle count against the class budget
  - texel density per UV shell
  - power-of-two texture dimensions
  - sRGB flag per map type
  - `_LODn` naming and LOD triangle ratios
  - collider triangle count ≤255
  - bounds against the expected real-world size (Unity units = m)

### Gaps
- No authoritative, current (2025–2026) AAA per-asset triangle budgets were found for PC/console. The Polycount wiki "Polygon Count" page, which lists per-game numbers, was unreachable.
- I could not confirm Unity 6's default Max Size (believed 2048) or the default compression formats for normal maps (BC5 vs BC7).
- I could not confirm from a fetched source that glTF occlusion is read from the R channel. That is my understanding of the Khronos spec, but it is unverified in this session.
- No first-party Unity "art asset best practice" page exists at the 6.4 URL (404).
- The current Unity 6 Mesh Collider manual wording on the 255 limit was not fetched.
- No primary source for texture resolution per asset class (e.g. 2K hero prop, 1K small prop, 4K character), apart from Dota.

## 3. What do studios check at each review gate?

### Takeaway
Public gate checklists are scarce. What exists covers the following:
- Silhouette and value read at gameplay distance and in context (Valve's Dota 2 guide).
- Scale against a 1 m reference or player and the correct origin (Unity).
- Deformation pose tests for characters.
- Bake artifacts, cage/ray distance, seams and padding.
- Normal-map convention.
- Texel-density consistency across sets and trims.
- Engine budgets: triangles, LODs, draw calls/materials, collider complexity.

### Cited Findings
**Silhouette, value and detail (Valve, Dota 2 Character Art Guide, 2012, 18 pages)**
- A hero's silhouette must be identifiable at first glance.
- Value (lightness/darkness regardless of colour) matters more than colour. If the feet are as intense as the head, the character is hard to break apart at a glance.
- Small detail patches read in profile but get lost in normal gameplay. Use simple "areas of rest" to balance complex areas.
- Evaluate assets in context. — [Steam Support, Dota 2 character art guide](https://help.steampowered.com/faqs/view/0688-7692-4D5A-1935); [CG Channel coverage, 2012](https://www.cgchannel.com/2012/06/valve-releases-useful-character-design-guide)

**Scale and origin**
- Compare the imported model against a 1-unit (1 m) cube, and place the feet on the local origin. — [Unity 6.4 Manual, Preparing humanoid assets](https://docs.unity3d.com/6000.4/Documentation/Manual/UsingHumanoidChars.html)
- Unity physics assumes 1 unit = 1 m. — [Unity 6.4 FBX Importer](https://docs.unity3d.com/6000.4/Documentation/Manual/FBXImporter-Model.html)

**Topology and deformation (characters)**
- A pose test is the only reliable check: bend elbows and knees to 90° and twist the forearms. Place poles on flat, low-deformation areas.
- The inner elbow and the back of the knee are compression zones and need denser loops. — [Sloyd, manual retopology guide](https://www.sloyd.ai/blog/manual-retopology-for-sculpted-models-step-by-step-guide) (vendor); [Tripo, joint loop placement](https://www.tripo3d.ai/blog/explore/smart-mesh-joint-loops-placement-for-elbows-and-knees) (vendor); [Novedge, anatomy-driven retopology](https://novedge.com/blogs/design-news/zbrush-tip-anatomy-driven-retopology-for-predictable-deformation)
- Unity: cap holes, weld vertices, remove hidden faces, and convert NURBS/subdivision surfaces to polygons. Test skinning with animation and keep 4 influences per vertex by default. — [Unity 6.4 Manual, humanoid](https://docs.unity3d.com/6000.4/Documentation/Manual/UsingHumanoidChars.html)

**Bake and seams**
- Artifacts come from ray distance or cage collisions. Dilation/padding prevents seams. — [Adobe, Common Parameters](https://experienceleague.adobe.com/en/docs/substance-3d/bakers/bakers-settings/common-parameters); [Adobe community](https://community.adobe.com/t5/substance-3d-painter-discussions/help-with-baking-issues/m-p/14216774/highlight/true)
- Trim seams come from UV placement or padding, from normal strips not at 45°, and from vertex normals. Keeping each UV border within a single normal direction matters more than padding. — [Polycount comment 2793276](https://polycount.com/discussion/comment/2793276)

**Normal-map convention**
- A Y-flip mismatch is invisible in the file, so it must be checked explicitly. — [CGAxis](https://cgaxis.com/which-normal-map-should-i-use-opengl-or-directx/)

**Texel density across trims**
- A critique point: when every trim on a sheet is the same size, density was not considered. The same trim is often needed at several sizes to keep density consistent. — [Polycount comment 2618544](https://polycount.com/discussion/comment/2618544)

**LOD quality**
- Check each LOD at different camera distances. Too little reduction hurts performance. — [Unity Learn, LOD](https://learn.unity.com/tutorial/level-of-detail-3653)
- Flat ratios can break specific parts, as in Simplygon's minecart example. — [Simplygon](https://simplygon.com/posts/b83478b7-a2a1-46a9-a0e1-cba3da7da307)

**Draw calls and materials**
- Merge small meshes and use instancing, because per-object draw calls are CPU-bound. — [Meta, WebXR perf workflow](https://developers.meta.com/horizon/documentation/web/webxr-perf-workflow/)

### Inferences
Proposed gate list for an assisted workflow (synthesised, not from one source):

| Gate | Check |
|---|---|
| G1 Concept | Callouts complete; scale reference present; silhouette read as a black fill at gameplay distance; value grouping |
| G2 Blockout | In engine next to the player capsule; correct real-world bounds; pivot and grid snap; gameplay clearance |
| G3 High-poly | Forms read at gameplay distance; no detail below texel resolution |
| G4 Low-poly | Triangle budget; silhouette matches high-poly; smoothing groups or hard edges at UV splits; characters: pose test |
| G5 UV | Texel density within tolerance; no stretching (checker map); padding sized for the lowest mip; lightmap UV non-overlapping if needed |
| G6 Bake | No skewing, ray misses or cage bleed; tangent-space match (MikkTSpace; Unity calculates MikkTSpace by default) |
| G7 Texture | Material values consistent with the shared library; correct sRGB/linear flags; correct packing; Y+ normals |
| G8 LOD/collision | Ratios; pop test; collider complexity |
| G9 Engine | Lit in the target scene and lighting; prefab, naming, import settings |

### Gaps
- No public AAA studio QA checklist document was found. Studio art bibles and checklists are typically internal.
- The Polycount wiki pages on edge padding and baking artifacts were unreachable.
- No authoritative numeric guidance on padding pixels per texture size was found beyond a 5–10 px community suggestion.

## 4. How are style consistency and reuse achieved across many assets?

### Takeaway
Studios combine an art bible (visual identity, palette, value and silhouette rules, asset standards) with reusable material systems: a shared material library, trim sheets, tiling textures, palette/texture atlases, and a fixed texel density. Environments are built from grid-snapped modular kits. Bethesda's Skyrim kits are the best-documented public example, and Insomniac's "Ultimate Trim" is the canonical trim-sheet talk.

### Cited Findings
**Modular kits (Bethesda)**
- GDC 2013 (Joel Burgess & Nathan Purkeypile, Skyrim): kits are systems "typically snapped to a grid" and "more than the sum of their parts". Skyrim used 2 kit artists, 8 level designers and 7 kits to produce 400+ unique cells over 30 months. The listed con is high complexity: kit work needs a rare mix of art and technical skills. — [Slideshare, GDC 2013 kit building](https://www.slideshare.net/slideshow/gdc2013-kit-buildingfinal/17728576)
- A follow-up GDC 2016 talk, "Fallout 4's Modular Level Design", covered the art-kit techniques. — [GDC Vault 1022930](https://gdcvault.com/play/1022930/contactUs); [Game Developer preview](https://www.gamedeveloper.com/design/come-to-gdc-and-learn-how-bethesda-built-the-world-of-i-fallout-4-i-)

**Trim sheets**
- Insomniac's Ultimate Trim (GDC 2015): a trim layout plus normal structure plus a UV script plus a variation shader, aimed at production speed, memory and performance. — [GDC Vault](https://gdcvault.com/play/1022323/The-Ultimate-Trim-Texturing-Techniques)
- Same trim at multiple sizes for consistent density. Bevels baked into the texture make pieces less modular and harder to offset for variation, while modelled bevels cost triangles. — [Polycount comment 2618544](https://polycount.com/discussion/comment/2618544); [Polycount comment 2618507](https://polycount.com/discussion/comment/2618507)

**Palette atlases**
- One shared material and texture across models cuts draw calls. Recolour by moving UVs. — [Papaya Games devlog](https://papaya-games.itch.io/duck-in-town/devlog/73530/blazing-fast-rendering-with-a-single-material-per-scene); [BlenderNation](https://www.blendernation.com/2017/10/25/low-poly-blender/)
- Ready-made gradient atlases are sold, for example 74 vertical gradients in a 1024x2304 atlas. — [Texture Gradient Palette (itch.io)](https://tenebra23.itch.io/texture-gradient-palette)

**Kit content (commercial example)**
- A modular kit with triplanar-projected tertiary texture, a shared trim material with multiple wood/metal textures, and a fabric atlas with pattern variants. — [80 Level, modular desert kit by Pavel Oliva](https://80.lv/articles/a-new-modular-desert-kit-by-pavel-oliva)

**Art bible and palette**
- Valve's guide prescribes silhouette, value patterning and a coherent colour palette as the basis for consistency across many contributors (Workshop artists). — [CG Channel](https://www.cgchannel.com/2012/06/valve-releases-useful-character-design-guide)
- A palette-first workflow: start from a colour palette, then categorise materials by the colour theme. — [Adobe Substance 3D Magazine, diorama with community assets](https://www.adobe.com/products/substance3d/magazine/creating-a-diorama-scene-with-free-community-made-assets)
- An art-bible template (Claude Code skill in a community repo; low authority, but structurally useful) lists: Visual Identity Statement (one rule plus 2–3 principles), Color Palette, Lighting & Atmosphere, Environment & Level Art, Asset Standards, Style Prohibitions. — [tessl registry, art-bible skill (Donchitos/Claude-Code-Game-Studios)](https://tessl.io/registry/skills/github/Donchitos/Claude-Code-Game-Studios/art-bible)

**Texel density as a consistency tool**
- 10.24 px/cm used consistently across trims and tiling textures. — [The Rookies](https://www.therookies.co/entries/38924)

### Inferences
- For an automated or assisted pipeline, the art bible should be machine-readable. It should hold:
  - a palette (hex values plus value ranges)
  - a material library (named PBR materials with albedo/roughness ranges)
  - the texel density target
  - the grid unit for modular pieces (often a power-of-two metre fraction; not sourced here)
  - triangle budgets per class
  - naming rules

  Each asset can then be validated against it.
- For a solo dev in Unity URP, one shared trim sheet plus a few tiling materials plus a palette atlas for small props is the highest-leverage reuse setup. It also cuts materials and draw calls.

### Gaps
- The full Dota 2 guide text and any GDC talk content on art bibles (e.g. Riot, Blizzard style guides) were not fetched.
- No public numeric grid standards for modular kits were found. Bethesda's exact grid size was not in the retrieved text.
- No current (2025–2026) GDC talk on trim sheets or modular kits was found. The canonical talks are from 2013–2016.

## 5. Characters vs props: what changes, and what can a solo dev realistically do?

### Takeaway
Characters add deformation-driven topology (loops at joints and face), a skeleton (Unity Humanoid needs at least 15 bones and a T-pose), skinning (4 influences per vertex by default), blend shapes for faces, and animation retargeting. These steps are where most of the time goes: studio anecdotes put characters at 1–3 months vs hours for props. A solo dev can realistically auto-rig humanoids (Mixamo, AccuRIG, Rigify, Auto-Rig Pro), use Unity's Humanoid retargeting, and limit facial work to a few blend shapes or none.

### Cited Findings
**Unity humanoid requirements (Unity 6.4 Manual)**
- Model in a T-pose, with at least 15 bones in a natural hierarchy (hips, spine, chest, neck, head, limbs).
- Use consistent L/R and body-part bone naming for Avatar matching.
- Use well-formed topology so the mesh does not distort.
- Cap holes, weld vertices and remove hidden faces.
- Skin automatically first, then refine with animation tests.
- 4 influences per vertex is the default maximum (raise the Skin Weights setting or bake deformers for more).
- Export as FBX (skeleton, normals, textures, animation) and re-import it to verify.

— [Unity 6.4 Manual, Preparing humanoid assets](https://docs.unity3d.com/6000.4/Documentation/Manual/UsingHumanoidChars.html)

**FBX import options relevant to characters**
- Import BlendShapes, Blend Shape Normals (Import/Calculate/None), Legacy Blend Shape Normals. — [Unity 6.4 FBX Importer](https://docs.unity3d.com/6000.4/Documentation/Manual/FBXImporter-Model.html)

**Topology (community and vendor sources)**
- Circular loops around joints, with support loops at elbows and knees. Spread shoulder deformation across several loops that follow the deltoid. Concentric loops around the eyes and mouth, with nasolabial loops flowing into the jaw, support blinking and lip sync. Game pipelines remove unnecessary loops but keep even quads at joints. — [Sloyd](https://www.sloyd.ai/blog/manual-retopology-for-sculpted-models-step-by-step-guide); [Tripo, anatomical topology](https://www.tripo3d.ai/blog/explore/smart-mesh-topology-for-anatomical-shapes-simplified); [Novedge](https://novedge.com/blogs/design-news/zbrush-tip-anatomy-driven-retopology-for-predictable-deformation)

**Rigging options for a solo dev**

| Tool | Cost / platform | Notes |
|---|---|---|
| Mixamo | Free, web | Fast humanoid auto-rig; little control, no non-humanoids |
| AccuRIG (Reallusion) | Free, Windows app | Exports FBX/USD; a free add-on converts its armature to a Rigify control rig |
| Rigify | Free, Blender add-on | Place the metarig by hand; Blender computes weights; the deform hierarchy needs fixing for game export |
| Auto-Rig Pro | Paid, Blender add-on | About $50 per a competing vendor's page (unverified); face rig; exports to Unity/Unreal/Godot |

Sources: [itechguides, AccuRIG](https://www.itechguides.com/products/accurig/); [GameFromScratch, AccuRIG](https://gamefromscratch.com/accurig-auto-rigging-tool-from-reallusion/); [Reallusion forum, AccuRIG 2 vs Mixamo](https://discussions.reallusion.com/t/accurig-2-vs-mixamo-smarter-auto-rigging-for-3d-animators/14668); [Cinevva, Auto-Rig Pro alternatives](https://app.cinevva.com/guides/auto-rig-pro-alternatives); [BlenderArtists, ARP vs Rigify](https://blenderartists.org/t/how-do-auto-rig-pro-and-rigify-compare/1232022)

**Customisation within an existing skeleton**
- Valve's Workshop constrains custom character items to its default skeleton, joint positions and animations (e.g. Undying's Flesh Golem). — [Dota 2 Workshop, Undying](https://www.dota2.com/workshop/requirements/undying)

**Budgets**
- Character triangle budgets conflict widely (see section 2): vendor ranges of 1.5K–100K+ depending on platform, and an old Polycount thread at 15–25K for the body or 50–60K with gear.

### Inferences
**What changes vs props**
- Characters add the stages rig -> skin -> pose and animation test -> blend shapes -> Humanoid Avatar config.
- Retopo for characters is driven by deformation, not just silhouette.
- Characters usually need several texture sets (body, head, gear), and LODs must keep the skeleton.

**Realistic solo path**
- Use stylized proportions with simple hands.
- Model in a T-pose and auto-rig (Mixamo or AccuRIG for speed; Rigify or Auto-Rig Pro for control).
- Use Unity Humanoid with Mixamo-retargeted animations.
- Faces: no facial rig, or a handful of blend shapes (blink, a few visemes).

### Gaps
- No primary studio source on character LOD skeleton practice (bone LODs) or facial rig standards (e.g. ARKit 52 blend shapes) was fetched in this session.
- Auto-Rig Pro pricing and current Mixamo availability or terms were not verified.
- Topology sources are mostly vendor blogs. The Polycount wiki topology pages were unreachable.

## 6. Time and effort per asset class for a skilled artist

### Takeaway
Only anecdotal and vendor numbers exist:
- Simple props: a few hours to one day (4–8 h).
- Mid props and environment pieces: 1–3 days.
- Weapons: about 2 weeks.
- Vehicles: 2–4 weeks.
- Characters: 1–3 months (realistic, full pipeline). Stylized characters are quoted at 3–7 days by a vendor.

Context (hero vs background, LOD requirements, style) changes these numbers more than raw complexity does.

### Cited Findings
- Studio estimates posted by a user in a Polycount thread: barrels 4–8 h; water wells and boulders 8–16 h; assault rifle about 2 weeks; vehicles 2–4 weeks; characters 1–3 months. Commenters noted large context dependence, such as a racing-game car with interior and LODs. The thread was surfaced by search, but opening the comment page returned HTTP 403, so the exact wording and post date are unverified. — [Polycount thread (comment 1003743 and neighbours)](https://polycount.com/discussion/comment/1003743)
- In the same thread, an experienced modeller estimated a detailed prop at a few hours of high-poly, plus 1–2 h for low-poly, unwrap and bake, plus a few hours of texturing. That is about 6–10 h in a fairly simple style. — [Polycount comment 1003223](https://polycount.com/discussion/comment/1003223) (via search, unverified mapping to the exact comment)
- Pixune (an outsourcing vendor, so it has a commercial interest) gives these tiers: simple props, crates and rocks take "a few hours"; mid-level assets 1–3 days; hero or cinematic assets days to weeks; stylized characters 3–7 days. — [Pixune, "How Long Does It Take to Create a 3D Model?"](https://pixune.com/blog/how-long-does-it-take-to-create-a-3d-model/)
- Kit-based throughput at scale: Skyrim's 2 kit artists plus 8 level designers produced 400+ cells in 30 months using 7 kits. — [Slideshare, GDC 2013](https://www.slideshare.net/slideshow/gdc2013-kit-buildingfinal/17728576)

### Inferences
- For a solo dev who is still learning Blender, expect several times these figures at first. Palette-atlas or trim-sheet props without a high-poly bake can plausibly come in under the "simple prop" tier. That is an inference; no time study was found.
- When asking for or estimating a quote, the scope should state which stages are included: high-poly, low-poly, UV, bake, texture, LODs, collision, rig.

### Gaps
- No systematic or recent (2024–2026) time study was found. All figures are anecdotes or vendor marketing.
- No source quantified how much AI-assisted generation (image-to-3D) or auto-retopo cuts these times. That likely belongs to an adjacent research track.
