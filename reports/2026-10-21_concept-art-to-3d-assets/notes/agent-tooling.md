# Agent tooling for 3D asset work: Blender and Unity on Windows (as of 2026-10-21)

Scope: what a Claude Code agent can use to create, clean up, validate and import 3D assets with Blender and Unity on
Windows 11, how to set it up, and how reliable it is. Research notes for the report writer.

Local read-only checks run on 2026-10-21 on the user's machine:
- `winget search --id BlenderFoundation.Blender` returned `BlenderFoundation.Blender` 5.2.2,
  `BlenderFoundation.Blender.LTS.4.5` 4.5.10 and `BlenderFoundation.Blender.LTS.4.2` 4.2.16. Blender is not installed.
- `C:/Program Files/Unity/Hub/Editor` contains only `6000.4.11f1`.
- `claude --version` returned `2.1.306 (Claude Code)`. Nothing was installed and no MCP server was registered.

Third-party vendor write-ups are labeled **(vendor)**. Several of them sell competing Blender MCP products.

---

## 1. Blender automation: headless runs, bpy recipes, export for Unity, install

### Takeaway
Blender 5.2.2 LTS is current (released 2026-09-15). It installs with winget (`BlenderFoundation.Blender`) or as a
portable zip. Headless scripting with `blender.exe --background --factory-startup --python script.py -- args` is
well documented and a good fit for a repeatable import → clean → validate → export pipeline. LLM-written bpy code
often breaks because the API changed in 5.0, so the agent should check operator signatures against the 5.2 API docs
(or a docs-search tool) rather than rely on memory.

### Cited Findings
**Version and install**
- Current download: Blender 5.2.2 LTS, released 2026-09-15, with "2 years of LTS updates". Windows options are an x64
  installer (.msi, 348 MB), a portable .zip (386 MB), the Microsoft Store, and ARM64 .msi/.zip builds. The installer is
  listed as compatible with Windows 11, 10 and 8.1. — [blender.org/download](https://www.blender.org/download/)
- Blender 5.2 LTS was first released 2026-07-14 and is supported until July 2028. Highlights: experimental Geometry Nodes
  physics, a Mesh Bevel node, remote asset libraries, built-in LoopTools functions, a Cycles texture cache, and EEVEE
  Screen Space Raytracing changes. — [Blender 5.2 LTS release page](https://www.blender.org/releases/5-2/);
  [Phoronix](https://phoronix.com/news/Blender-5.2-Released)
- winget IDs (checked locally): `BlenderFoundation.Blender` (5.2.2), `BlenderFoundation.Blender.LTS.4.5` (4.5.10),
  `BlenderFoundation.Blender.LTS.4.2` (4.2.16). — local `winget search` on 2026-10-21

**Command line (Blender 5.2 LTS manual)**
- `-b/--background` runs without the UI, and audio is off by default. `-P/--python <file>` runs a script.
  `--python-expr` runs an expression. `--python-exit-code <0-255>` sets the exit code used when a script raises an
  exception (0 disables this). `--factory-startup` skips the user's `startup.blend`. `--` ends option parsing, and the
  rest is passed to Python's `sys.argv`. `-o/--render-output` sets the output path (`#` becomes the frame number).
  `-f/--render-frame` renders a frame. `-E/--engine` sets the engine (`-E help` lists engines). `--addons` enables a
  comma-separated list of add-ons. — [Blender manual: Command Line Arguments](https://docs.blender.org/manual/en/latest/advanced/command_line/arguments.html)
- **Arguments are executed in order.** Setting `--render-output` before the .blend is loaded, or after
  `--render-frame`, has no effect. — [same page](https://docs.blender.org/manual/en/latest/advanced/command_line/arguments.html)
- Windows: `-con/--start-console` is Windows-only. `TEMP` controls the temp folder. — [same page](https://docs.blender.org/manual/en/latest/advanced/command_line/arguments.html)
- Windows shortcuts start `blender-launcher.exe`, which hides the console window and forwards arguments to
  `blender.exe`. Running `blender.exe` directly keeps console behaviour "for users who use Blender for batch
  processing". This comes from the 2022 commit and is not re-verified for 5.2. — [bf-blender-cvs, Nov 2022](https://lists.blender.org/pipermail/bf-blender-cvs/2022-November/180990.html)

**Python API breaking changes in 5.0 (likely to trip LLM-written scripts)**
- EEVEE engine ID changed from `BLENDER_EEVEE_NEXT` to `BLENDER_EEVEE`. `scene.node_tree` (compositor) was removed in
  favour of `scene.compositing_node_group`. BGL was removed. `bpy.props` properties no longer support dict-style access
  (for example, `scene['cycles']`). The legacy Action API (`action.fcurves`) was removed. UV selection moved to shared
  BMesh attributes, and `MeshUVLoopLayer.vertex_selection` was removed. The boolean "FAST" solver was renamed "FLOAT".
  `ImageFormatSettings` needs `media_type` set before `file_format`. — [Blender 5.0 Python API release notes](https://developer.blender.org/docs/release_notes/5.0/python_api/)
- One vendor article says models trained on older Blender code often call APIs that changed or were removed in 5.x, so
  API grounding matters. — [StraySpark (vendor), 2026-09-25](https://www.strayspark.studio/blog/official-blender-mcp-server-comparison-2026)

**Operator signatures verified against the 5.2 API docs**
- `bpy.ops.uv.smart_project(*, angle_limit=1.15192, margin_method='SCALED', rotate_method='AXIS_ALIGNED_Y', island_margin=0.0, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)`.
  `angle_limit` is in **radians** (range 0 to 1.5708, default ≈ 66°). — [bpy.ops.uv (5.2)](https://docs.blender.org/api/current/bpy.ops.uv.html)
- `bpy.ops.uv.unwrap(*, method='CONFORMAL', fill_holes=False, correct_aspect=True, ..., margin=0.001, no_flip=False, iterations=10, ...)`, where method is `ANGLE_BASED`, `CONFORMAL` or `MINIMUM_STRETCH`.
  `bpy.ops.uv.pack_islands(*, ..., rotate=True, rotate_method='ANY', scale=True, merge_overlap=False, margin_method='SCALED', margin=0.001, ..., shape_method='CONCAVE')`.
  `bpy.ops.uv.lightmap_pack(*, PREF_CONTEXT='SEL_FACES', PREF_PACK_IN_ONE=True, PREF_NEW_UVLAYER=False, PREF_BOX_DIV=12, PREF_MARGIN_DIV=0.1)`.
  `bpy.ops.uv.select_overlap(*, extend=False)` selects overlapping UV faces. — [bpy.ops.uv (5.2)](https://docs.blender.org/api/current/bpy.ops.uv.html)
- `bpy.ops.object.transform_apply(*, location=True, rotation=True, scale=True, properties=True, corrective_flip_normals=True, isolate_users=False)`;
  `bpy.ops.object.origin_set(*, type='GEOMETRY_ORIGIN', center='MEDIAN')`; `bpy.ops.object.voxel_remesh()` (no
  arguments: it uses the mesh's remesh settings); `bpy.ops.object.quadriflow_remesh(*, ..., mode='FACES', target_ratio=1.0, target_edge_length=0.1, target_faces=4000, ...)`;
  `bpy.ops.object.shade_smooth(*, keep_sharp_edges=True)`. — [bpy.ops.object (5.2)](https://docs.blender.org/api/current/bpy.ops.object.html)
- FBX export defaults in 5.2: `global_scale=1.0`, `apply_unit_scale=True`, `apply_scale_options='FBX_SCALE_NONE'`
  (other values: `FBX_SCALE_UNITS`, `FBX_SCALE_CUSTOM`, `FBX_SCALE_ALL`), `use_space_transform=True`,
  `bake_space_transform=False`, `use_mesh_modifiers=True`, `mesh_smooth_type='OFF'`, `use_tspace=False`,
  `add_leaf_bones=True`, `axis_forward='-Z'`, `axis_up='Y'`, `path_mode='AUTO'`, `embed_textures=False`,
  `use_triangles=False`. — [bpy.ops.export_scene (5.2)](https://docs.blender.org/api/current/bpy.ops.export_scene.html)
- glTF export defaults in 5.2: `export_yup=True` (+Y up), `export_apply=False` (True applies modifiers but drops shape
  keys), `use_selection=False`, `export_image_format='AUTO'`, `export_materials='EXPORT'`,
  `export_draco_mesh_compression_enable=False`, `export_texcoords=True`, `export_normals=True`, `export_tangents=False`,
  `export_extras=False`. There is no LOD option. — [bpy.ops.export_scene (5.2)](https://docs.blender.org/api/current/bpy.ops.export_scene.html)

**Blender → Unity FBX settings (community guidance; official Blender page leaves "Apply Scalings" as TODO)**
- Recommended: Metric scene units with Unit Scale 1.0. In the exporter, Scale 1.0, Apply Scalings = "FBX Units Scale",
  Apply Unit on. In Unity, Scale Factor 1 with Convert Units on, and tick **Bake Axis Conversion** so the root's −90° X
  rotation goes away. — [Katsbits](https://www.katsbits.com/codex/unity-blender-fbx-scale);
  [Cinevva checklist](https://app.cinevva.com/guides/blender-to-unity-export-checklist)
- Apply transforms before export. The exporter's "Apply Transform" option is experimental and reported to mangle the
  rotation of nested children. Some users still saw 100× scale, so check after import. — [Unity forum thread](https://discussions.unity.com/t/imported-models-from-blender-2-77-are-scaled-x100-in-unity-5-3/167005)
- Unity's `ModelImporter` exposes `globalScale`, `useFileScale`, `useFileUnits` and `bakeAxisConversion`, so these can
  be enforced in an AssetPostprocessor instead of by hand. — [ModelImporter (6000.4)](https://docs.unity3d.com/6000.4/Documentation/ScriptReference/ModelImporter.html)

### Inferences
- The headless pipeline shape is well supported by the docs (untested here):
  `"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" --background --factory-startup --python-exit-code 1 --python tools\asset_clean.py -- --in raw.glb --out clean.fbx --tris 5000`.
  Use `blender.exe`, not `blender-launcher.exe`, so stdout and the exit code reach the agent. The install path is the
  usual MSI default and has not been verified on this machine.
- The portable zip suits an agent that should not touch system state: unzip into a tools folder and pin the version
  in the script, so API drift is controlled.
- A minimal recipe chain using the signatures above (untested):
  import (`bpy.ops.import_scene.gltf` / `bpy.ops.import_scene.fbx` / `bpy.ops.wm.obj_import`; the importers were
  not fetched in this session, so check them) → join and clean (merge by distance, recalculate normals) → Decimate
  modifier (ratio from the triangle budget) or voxel remesh → `uv.smart_project(angle_limit=math.radians(66), island_margin=0.02)`
  → `uv.pack_islands` → `object.transform_apply(location=False, rotation=True, scale=True)` →
  `object.origin_set(type='ORIGIN_GEOMETRY')` (or a pivot at the bottom center set by moving the 3D cursor) → LOD copies
  with a Decimate ratio per level, named `Name_LOD0..n` → `export_scene.fbx(apply_scale_options='FBX_SCALE_UNITS', axis_forward='-Z', axis_up='Y', use_mesh_modifiers=True, mesh_smooth_type='FACE', use_tspace=True, add_leaf_bones=False)`
  or `export_scene.gltf(export_format='GLB', export_yup=True, export_apply=True)`. The `mesh_smooth_type`,
  `use_tspace` and `add_leaf_bones` overrides are common practice for game export, not documented recommendations.
- Baking (normal or AO from high to low poly) goes through `bpy.ops.object.bake`. From prior knowledge, not verified
  in this session: baking needs the Cycles engine and an image texture node selected in the target material. Cycles
  can run on CPU headless, which makes baking the most robust headless step.

### Gaps
- `bpy.ops.object.bake` and the import operators (`import_scene.gltf`, `import_scene.fbx`, `wm.obj_import`) were not
  fetched. Their 5.2 signatures are unverified here.
- Whether `blender-launcher.exe` still behaves the same way in 5.2 was not re-verified (the source is 2022).
- The official Blender manual page for FBX export "Apply Scalings" is a TODO placeholder, so the Unity settings rest on
  community guides.

---

## 2. Blender MCP servers: official Blender Lab server and the community ahujasid/blender-mcp

### Takeaway
There are two serious free options. The **official Blender Lab MCP server** (GPL, Blender 5.1+, v1.0.3, 26 to 27 tools)
is the server behind Anthropic's Blender connector. It focuses on scene analysis, code execution, screenshots and
docs search, and has headless `_for_cli` tools. The **community "MCP for Blender"** (ahujasid, MIT, Blender 3.0+,
package `mcp-for-blender`) adds asset search and import (Poly Haven, Sketchfab, Poly Pizza) and AI 3D generation
(Hyper3D Rodin, Hunyuan3D, Tripo, Meshy). Both run arbitrary Python with the user's rights. The community server has
had CVEs and its socket has no authentication.

### Cited Findings
**Official Blender Lab MCP server**
- A lightweight MCP server from Blender Lab: a Blender add-on (v1.0.3) plus a separate MCP server installed as an
  `.mcpb` bundle or from source. It requires Blender 5.1 or newer. Example uses: finding polygon-heavy objects that are
  small on screen, renaming data-blocks, querying which objects use a material, documenting Geometry Nodes setups.
  — [blender.org/lab/mcp-server](https://www.blender.org/lab/mcp-server/)
- Security, quoted from Blender: the server "will execute LLM generated code in Blender without any guards in place".
  Blender recommends a VM or a system without sensitive data. — [blender.org/lab/mcp-server](https://www.blender.org/lab/mcp-server/)
- The code is on Blender's Gitea at `projects.blender.org/lab/blender_mcp`. WebFetch got HTTP 403 there, so the README
  could not be read directly. — [blender.org/lab/mcp-server](https://www.blender.org/lab/mcp-server/)
- Tools (from secondary sources): `execute_blender_code`, `execute_blender_code_for_cli` (runs in a background
  Blender process), five `get_blendfile_summary_*` tools with `_for_cli` variants that open a .blend without a GUI,
  object summaries, three screenshot tools, a thumbnail render, `search_api_docs`, `search_manual_docs`, and `jump_to_*`
  UI tools. 26 tools in total. — [Voyager (vendor), 2026-09-17](https://voyager.so/blog/blender-mcp)
- Versions: v1.0.0 on 2026-04-27, v1.0.2 on 2026-09-08, v1.0.3 on 2026-09-11. 26 tools. Blender's Francesco Siddi
  reportedly said "no generative AI functionality is currently available or planned to be integrated in Blender."
  — [StraySpark (vendor)](https://www.strayspark.studio/blog/official-blender-mcp-server-comparison-2026).
  Tool count conflicts: 27 per [Glama listing](https://glama.ai/mcp/servers/A-to-PC/blender-lab-mcp-client).
- Claude Code setup (long path): clone the repo, `pip install -e mcp` in a venv, then
  `claude mcp add blender -- <venv>\...\blender-mcp`. Add `--scope project` to write `.mcp.json`. Check with
  `claude mcp list` or `/mcp` (it should show 26 tools). Short path: add the Blender connector in Claude Desktop, then
  `claude mcp add-from-claude-desktop`, which the article says works on macOS and WSL only. A `blender-1.0.3.mcpb`
  bundle shipped on 2026-09-11. — [Voyager (vendor)](https://voyager.so/blog/blender-mcp)
- Anthropic released a Blender connector on 2026-04-28 as one of nine creative-tool connectors. The coverage says it
  uses Blender's Python API to analyse and debug scenes and batch-apply changes, and that other MCP clients can use it.
  Anthropic became a Blender Development Fund Corporate Patron. — [Digital Production](https://digitalproduction.com/2026/04/30/anthropic-funds-blender-ships-claude-connector/);
  [Unite.AI](https://www.unite.ai/anthropic-wires-claude-into-photoshop-blender-and-ableton/)
- Version conflict: Claude's own tutorial reportedly says Blender 4.2+, while Blender's page and the add-on manifest say
  5.1+. — [Voyager (vendor)](https://voyager.so/blog/blender-mcp)

**Community MCP for Blender (ahujasid/blender-mcp, renamed; PyPI `mcp-for-blender`)**
- Architecture: a Blender add-on runs a socket server (default `localhost:9876`), and an MCP server bridges the client
  to it. Tools: `execute_blender_code`; `look` (viewport, camera, multiple auto-framed angles, animation strip, several
  shading modes, and showing renders or image files "so the AI can check its own work"); `get_scene_info`;
  `generate_3d` (Tripo, Hunyuan3D, Hyper3D Rodin, Meshy); `search_assets`/`import_asset` (Poly Haven, Sketchfab, Poly
  Pizza); `get_addon_status`; telemetry tools. — [GitHub README](https://github.com/ahujasid/blender-mcp)
- Requirements: Blender 3.0+, Python 3.10+, and `uv` (use the official installer, not pip). Install with
  `uvx mcp-for-blender setup`, which configures clients and installs the add-on, or `uvx mcp-for-blender install-addon`.
  Then in Blender enable "Interface: MCP for Blender", press N, and click "Start MCP Server". — [README](https://github.com/ahujasid/blender-mcp)
- Claude Code: `claude mcp add blender uvx mcp-for-blender`. Run only one client instance against the add-on at a time.
  — [README](https://github.com/ahujasid/blender-mcp)
- Windows notes: install uv with winget and open a new terminal (you may need to add it to PATH). GUI clients can fail
  with `spawn uvx ENOENT`; fix it with the full uvx path or `cmd /c`. Fully quit the client from the system tray after
  config changes. Use `--python 3.11` and `UV_PYTHON_PREFERENCE=only-managed` if conda or pyenv interferes.
  — [README](https://github.com/ahujasid/blender-mcp)
- Security: `execute_blender_code` runs arbitrary Python. The socket has no authentication or encryption, so keep it on
  localhost. An opt-in `BLENDER_MCP_SAFE_MODE=1` blocks file access, subprocesses and network. Minimal anonymous
  telemetry is on by default; `DISABLE_TELEMETRY=true` turns it off. — [README](https://github.com/ahujasid/blender-mcp)
- Known limits: complex requests may time out, so split them. Poly Haven downloads run on Blender's main thread and can
  freeze the UI (request 1k or 2k). Poly Pizza can fail behind Cloudflare from VPN or cloud IPs. — [README](https://github.com/ahujasid/blender-mcp)
- CVEs in 2026: CVE-2026-10688 (code injection via `execute_blender_code`, rolling release with no fixed version
  listed), CVE-2026-10661 (unvalidated `input_image_url`), CVE-2026-10662 (SSRF via `zip_file_url`), and
  CVE-2026-66004 (path traversal in `download_polyhaven_asset`, from Vulert, not NVD). — [NVD CVE-2026-10688](https://nvd.nist.gov/vuln/detail/CVE-2026-10688);
  [NVD CVE-2026-10661](https://nvd.nist.gov/vuln/detail/CVE-2026-10661); [SentinelOne CVE-2026-10662](https://www.sentinelone.com/vulnerability-database/cve-2026-10662/);
  [Vulert CVE-2026-66004](https://vulert.com/vuln-db/CVE-2026-66004). The commit-to-fix mapping was not verified.
- Tool count conflicts: 36 tools per [StraySpark (vendor)](https://www.strayspark.studio/blog/official-blender-mcp-server-comparison-2026),
  while the current README lists a smaller set of consolidated tools. It was renamed on 2026-09-16, and the old
  `blender-mcp` PyPI name still works (same source). Premium generation plans cost $10 or $20 a month (same source).
- Paid alternatives exist: Blender MCP Pro (120+ tools) and StraySpark's server (556 tools, 22 on by default, code
  execution denied by default, path jails, audit log). The article's author sells the second one. — [StraySpark (vendor)](https://www.strayspark.studio/blog/official-blender-mcp-server-comparison-2026)

**Claude Code mechanics relevant to these servers**
- `claude mcp add [--scope local|project|user] [--env K=V] <name> -- <command> [args]`. The `--` keeps server flags
  away from Claude's parser. Project scope writes `.mcp.json`, and interactive sessions ask for approval before using
  project servers. — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- `MCP_TIMEOUT` sets the startup timeout. `MCP_TOOL_TIMEOUT` sets the tool timeout, and a per-server `"timeout"`
  (ms) in `.mcp.json` overrides it. The idle timeout defaults to 30 minutes for stdio and 5 minutes for HTTP.
  `MAX_MCP_OUTPUT_TOKENS` defaults to 25,000. — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- When an MCP tool returns a PNG, JPEG, GIF or WebP, Claude sees it inline (possibly downscaled), and Claude Code saves
  the original bytes under `~/.claude/projects/.../tool-results` (v2.1.283+). — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- Subagents can get MCP servers through `mcpServers` frontmatter, either inline definitions (connected only while the
  subagent runs, keeping tool descriptions out of the main context) or references to configured servers. Tool access
  can be narrowed with `tools: mcp__blender__*` or `disallowedTools`. Background subagents keep all MCP tools.
  — [Claude Code subagents docs](https://code.claude.com/docs/en/sub-agents)

### Inferences
- For an asset-cleanup subagent, the official server's `_for_cli` tools and `search_api_docs` fit best: headless .blend
  inspection plus grounding against the 5.x API. The community server is the choice when asset import or AI generation
  (Poly Haven, Hunyuan3D, Rodin) is wanted. Both can coexist under different names, but each needs its own add-on.
- Many cleanup steps don't need MCP at all. A plain `blender.exe --background --python` run from Bash is more
  reproducible, can't hang a live UI, and returns an exit code. MCP pays off mainly for live inspection and `look`
  screenshots while iterating.
- For safety on a dev machine: keep MCP servers project-scoped, not user-scoped. Enable `BLENDER_MCP_SAFE_MODE=1` for
  the community server. Work on copies of .blend files. Stop the add-on server when idle.

### Gaps
- The official server's full tool list and exact Windows install steps could not be read: projects.blender.org
  returned 403, and the list comes from secondary sources.
- The Claude Code MCP docs page does have a Windows `cmd /c` note for `npx`/`uvx`, but it was not in the fetched
  sections. The `cmd /c` advice above comes from the ahujasid README (for Cursor).
- No first-party information was found on whether the Claude Desktop Blender connector can be imported into Claude Code
  on native Windows.

---

## 3. Unity automation: MCP servers, batchmode, AssetPostprocessor, LODs, procedural meshes, ProBuilder, glTF

### Takeaway
Unity 6000.4 supports deterministic automation without MCP: `Unity.exe -batchmode -projectPath ... -executeMethod Ns.Class.Method -logFile - -quit`,
plus an `AssetPostprocessor` that enforces import settings (scale, axis, materials, colliders, LODs). For live editor
control there are three MCP options:
- **CoplayDev "MCP for Unity"**: MIT, free, Unity 2021.3 to 6.x, about 50 tools including screenshots. It is the most
  used option and the one a Windows Claude Code user settled on.
- **Unity's official MCP**, in `com.unity.ai.assistant`: needs Unity 6+ and, by most readings, a paid Unity AI
  subscription on Personal. It has a Windows relay (`relay_win.exe`) that was reported to leave orphan processes.
- **IvanMurzak "AI Game Developer"**: Apache-2.0, 70+ tools, runtime support.

### Cited Findings
**Batchmode / command line (Unity 6.4 manual)**
- `-batchmode` runs with no dialogs. `-nographics` skips GPU initialization (no GI baking, no log unless `-logFile`
  is set). `-quit` exits after the commands run. `-executeMethod <Class.Method>` runs a static method once the project
  opens; the script must be in an Editor folder, and arguments are read with `System.Environment.GetCommandLineArgs`.
  `-logFile -` writes to stdout (on Windows this "isn't the console by default"). `-importPackage` imports a
  `.unitypackage` without a dialog. — [Unity 6.4 Command-line arguments](https://docs.unity3d.com/6000.4/Documentation/Manual/EditorCommandLineArguments.html)
- Exit codes: a script exception in batch mode exits with code 1. An `-executeMethod` can throw, or call
  `EditorApplication.Exit(nonZero)`. A project that is already open in an Editor can't also be opened in batch mode.
  Windows path pattern: `"C:\Program Files\Unity\Hub\Editor\<Version>\Editor\Unity.exe"`. — [same page](https://docs.unity3d.com/6000.4/Documentation/Manual/EditorCommandLineArguments.html)

**Import pipeline control**
- AssetPostprocessor callbacks for models: `OnPreprocessModel` (override ModelImporter settings),
  `OnPostprocessMeshHierarchy`, `OnAssignMaterialModel`, `OnPostprocessMaterial`,
  `OnPostprocessGameObjectWithUserProperties`, `OnPostprocessModel` (last, on the root). For textures:
  `OnPreprocessTexture` and `OnPostprocessTexture`. `OnPostprocessAllAssets` runs once per import batch. Unity advises
  incrementing `GetVersion` when the postprocessor's output changes. `assetImporter` can be a different importer type
  (for example SpeedTree), so check the type before casting. — [AssetPostprocessor (6000.4)](https://docs.unity3d.com/6000.4/Documentation/ScriptReference/AssetPostprocessor.html)
- `ModelImporter` properties include `globalScale`, `useFileScale`, `useFileUnits`, `bakeAxisConversion`,
  `materialImportMode`, `materialLocation`, `addCollider`, `generateSecondaryUV`, `meshCompression`, `isReadable`,
  `importNormals`/`importTangents`, `generateMeshLods`, `maximumMeshLod`, `meshLodGenerationFlags`, `keepQuads`,
  `weldVertices`, `indexFormat`, `importAnimation`, `importCameras`/`importLights` and `animationType`.
  — [ModelImporter (6000.4)](https://docs.unity3d.com/6000.4/Documentation/ScriptReference/ModelImporter.html)
- LODs from Blender: name meshes `Name_LOD0`, `_LOD1`, and so on, and Unity creates an LOD Group on import (at most 8
  levels, LOD0 most detailed). — [Unity 6.0 Importing LOD meshes](https://docs.unity3d.com/6/Documentation/Manual/importing-lod-meshes.html)
- Unity 6.2+ **Mesh LOD**: enable "Generate mesh LODs" in the model importer and Unity generates LODs during import
  (longer imports). It skips meshes that don't meet the generator's conditions. Combining it with existing `_LODx` meshes
  is "not recommended". — [Unity 6.2 Generate mesh LODs](https://docs.unity3d.com/6000.2/Documentation/Manual/lod/mesh-lod-generate-lods.html)
- A vendor blog says Mesh LOD packs all levels into one mesh's index buffer, ignores skin weights and blend shapes, and
  needs the GPU Resident Drawer for cross-fade. Unverified. — [StraySpark (vendor)](https://www.strayspark.studio/blog/tripo-to-unity-6-game-ready-lods-smoothness-normals)
- glTF/GLB needs the `com.unity.cloud.gltfast` package, which imports .glb/.gltf in Assets as native prefabs and
  supports URP, HDRP and Built-in. .gltf companion .bin and image files must keep their relative paths. If another
  importer claims .glb, set it to alternative or define `GLTFAST_FORCE_DEFAULT_IMPORTER_OFF`. — [glTFast Editor Import](https://docs.unity3d.com/Packages/com.unity.cloud.gltfast@6.2/manual/ImportEditor.html)
- ProBuilder: package registry lists 6.0.9 (and 6.0.6) for Unity 6000.0, with a C# scripting API.
  `ShapeGenerator.CreateShape(ShapeType, PivotLocation)` returns a `ProBuilderMesh` in 5.x docs; the 6.0 signature
  was not confirmed. — [packages.unity.com](https://packages.unity.com/com.unity.probuilder);
  [ProBuilder 6.0 manual](https://docs.unity3d.com/Packages/com.unity.probuilder@6.0/manual/index.html);
  [ShapeGenerator (5.0)](https://docs.unity3d.com/ja/Packages/com.unity.probuilder@5.0/api/UnityEngine.ProBuilder.ShapeGenerator.html)

**CoplayDev "MCP for Unity"**
- Free, MIT, not affiliated with Unity, maintained with sponsorship from Aura. Supports Unity 2021.3 LTS to 6.x and
  needs Python 3.10+ with `uv`. Install via Package Manager "Add from git URL"
  `https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity#main` (or pin a tag, or `openupm add com.coplaydev.unity-mcp`),
  then Window → MCP for Unity → Configure All Detected Clients. — [GitHub](https://github.com/CoplayDev/unity-mcp)
- Latest release: v10.3.0 dated 2026-10-04 on the GitHub page. — [GitHub](https://github.com/CoplayDev/unity-mcp).
  The raw README still shows v10.0.0 (2026-06-30) — [raw README](https://raw.githubusercontent.com/CoplayDev/unity-mcp/main/README.md).
  Tool count is "about 50" (GitHub page and docs) versus "48" (raw README).
- Docs: 50 tools in 10 groups and 25 resources. Optional groups: animation, vfx, ui, testing, probuilder. HTTP `/mcp`
  endpoint or stdio. The Python server talks to the Unity plugin over WebSocket. Multi-editor routing. Custom C# tools
  via an attribute. No telemetry by default. — [CoplayDev docs site](https://coplaydev.github.io/unity-mcp/)
- Screenshots: older docs put a `screenshot` action on `manage_scene` (save a PNG to Assets or return an inline image,
  named camera, six-angle "surround" batch, temporary camera). Newer docs move it to `manage_camera`, with
  `capture_source="scene_view"` for the editor Scene view. — [tools reference (Glama mirror)](https://glama.ai/mcp/servers/@CoplayDev/unity-mcp/blob/08b8eacab13da57ed13859167fa6033c6441f58d/unity-mcp-skill/references/tools-reference.md);
  [orchestrator skill summary](https://skills.cat/skills/coplaydev/unity-mcp/unity-mcp-orchestrator)
- A Windows Claude Code user moved from the official package to CoplayDev. CoplayDev's HTTP server runs inside the
  Editor on `localhost:8080`, so it stops when the Editor closes. — [kludgelog, note.com, 2026-06-01](https://note.com/kludgelog/n/nbd48152e59ab?hl=en)
- Setup problems: Claude Code auto-detection may not work and can fail silently, so check the config file. Use absolute
  paths. The HTTP bridge can drop when the Editor is in the background or loses focus. — [CoplayDev wiki: Common Setup Problems](https://github.com/CoplayDev/unity-mcp/wiki/3.-Common-Setup-Problems)
  (seen via search snippet only)

**Unity official MCP (com.unity.ai.assistant)**
- Needs Unity 6 (6000.0)+ and the package. Edit > Project Settings > AI > Unity MCP Server shows "Unity Bridge:
  Running". The relay installs to `%USERPROFILE%\.unity\relay\relay_win.exe`. Client config is
  `{"command": "<abs path>/relay_win.exe", "args": ["--mcp"]}`, optionally with `--project-path` or `--instance-id`.
  Use absolute paths because `~` may not expand. The first connection must be approved in Unity under Pending
  Connections. Example tools: `Unity_ManageScene`, `Unity_ManageGameObject`, `Unity_ReadConsole`.
  — [Unity AI Assistant 2.7: Get started with Unity MCP](https://docs.unity3d.com/Packages/com.unity.ai.assistant@2.7/manual/integration/unity-mcp-get-started.html)
- Unity's blog describes this as part of an AI open beta. — [Unity blog](https://unity.com/blog/unity-ai-mcp-how-to-get-started)
- Pricing conflict: Unity's AI FAQ reportedly says the MCP Server requires a Unity AI subscription on Personal (14-day
  trial with 1,000 credits, then $10 a month), while some pricing tables list MCP access as included. Pro includes it
  with 3 concurrent MCP connections. Users pushed back on the forum. — [unity.com/features/ai](https://unity.com/features/ai);
  [Unity Discussions: "Call to make Unity MCP usage free"](https://discussions.unity.com/t/call-to-make-unity-mcp-usage-free/1724543).
  Read from search excerpts and not confirmed on the live pricing page.
- Windows failure report: `relay_win.exe` sometimes outlived the Editor, kept locks under `Library/`, and caused
  re-imports and stalls until it was killed in Task Manager. — [kludgelog, 2026-06-01](https://note.com/kludgelog/n/nbd48152e59ab?hl=en)

**IvanMurzak "AI Game Developer" (Unity-MCP)**
- Apache-2.0, 70+ tools: assets, prefabs, materials, scenes, screenshots, C# scripts with Roslyn compile and run,
  reflection method calls, play mode, console, tests, and profiler. Optional ProBuilder, Terrain and other extensions.
  Runtime (in-game) support. Install with `npm install -g unity-mcp-cli` or OpenUPM `com.ivanmurzak.unity.mcp`.
  Project paths must not contain spaces. Auth defaults to none. `script-execute` and `reflection-method-call` run
  arbitrary C#. — [GitHub](https://github.com/IvanMurzak/Unity-MCP)

### Inferences
- Recommended split for an asset subagent: (a) committed Editor scripts (`Assets/Editor/AssetImportRules.cs` as an
  AssetPostprocessor, `Assets/Editor/AssetValidation.cs` with static `-executeMethod` entry points) give deterministic
  imports and checks that run in batchmode from Bash; (b) an optional MCP server (CoplayDev) for live scene placement,
  screenshots and console reading while the user has the Editor open.
- Batchmode and an open Editor exclude each other for the same project. The procedure has to choose: batchmode when
  the Editor is closed, MCP when it is open. A batchmode run on a clone or worktree of the project is a workaround,
  but costs a full import.
- In `OnPreprocessModel`, an AssetPostprocessor scoped to a folder such as `Assets/Art/Props/` could set
  `bakeAxisConversion = true`, `useFileScale = true`, `globalScale = 1`, `materialImportMode`, `addCollider` (or add
  simpler colliders in `OnPostprocessModel`), `generateSecondaryUV` for static lightmapped props, and either rely on
  `_LODn` naming or `generateMeshLods`. Bump `GetVersion()` when the rules change.
- Procedural meshes and prefabs from Editor scripts: create a `Mesh`, save it with `AssetDatabase.CreateAsset`, build
  the GameObject, and save with `PrefabUtility.SaveAsPrefabAsset`. These are standard Unity APIs, not fetched in this
  session.
- Keep tool names stable: one user named the `.mcp.json` key `unityMCP` so tool names stayed `mcp__UnityMCP__*` across
  server switches, avoiding rewrites of 11 skills and agents. Limit Unity MCP calls to one per turn to avoid clogging
  the UnitySynchronization queue. — [kludgelog](https://note.com/kludgelog/n/nbd48152e59ab?hl=en)

### Gaps
- The exact `claude mcp add` command for CoplayDev on Windows (HTTP URL and port versus stdio with `uvx`) is not in
  the fetched pages. The project's "Configure All Detected Clients" writes it; check the result.
- No official Unity Personal pricing for MCP was confirmed on the live pricing page.
- ProBuilder 6.x API signatures and a Unity 6.4-specific glTFast version were not confirmed.

---

## 4. Visual verification: letting the agent see its result and compare with the concept art

### Takeaway
The agent can see images in two ways. MCP screenshot tools (Blender `look`, Blender Lab screenshot tools, CoplayDev
`manage_camera`/`manage_scene` screenshot) return images inline. Scripted renders can write PNGs, which Claude Code
reads as images. Claude Code shows MCP image results inline and also saves the full-resolution file. Visual
comparison with concept art is the agent's own judgment; no tool for automated "matches the concept" scoring was found.
Headless Blender rendering is reliable with Cycles (CPU or GPU). EEVEE and Workbench in `--background` need an OpenGL
context, which a Windows desktop session with a GPU normally provides, but sources are old.

### Cited Findings
- Community Blender MCP `look`: viewport, camera, multiple auto-framed angles, animation strip, several shading modes,
  and it can show renders and image files "so the AI can check its own work". — [ahujasid README](https://github.com/ahujasid/blender-mcp)
- Official Blender Lab server: three screenshot tools and a thumbnail render. — [Voyager (vendor)](https://voyager.so/blog/blender-mcp);
  [StraySpark (vendor)](https://www.strayspark.studio/blog/official-blender-mcp-server-comparison-2026) ("screenshots, viewport renders")
- Headless Blender render: `blender.exe -b file.blend -E <engine> -o //out/shot_# -f 1`, with arguments in that order
  (load, set output, render). — [Blender CLI manual](https://docs.blender.org/manual/en/latest/advanced/command_line/arguments.html)
- EEVEE always needs OpenGL, even with `-b`. Cycles GPU (CUDA) does not. A .blend with a second scene set to EEVEE
  broke a `-E CYCLES` job, because `-E` only changes the current scene. These are 2019-2020 sources. — [Blender devtalk](https://devtalk.blender.org/t/blender-2-8-unable-to-open-a-display-by-the-rendering-on-the-background-cycles/8607)
- A tracker issue about running EEVEE and other OpenGL engines with `-b` when a graphical desktop is available is
  marked resolved. — [projects.blender.org #54633](https://projects.blender.org/blender/blender/issues/54633)
- Unity: CoplayDev screenshot action with named camera, downscale cap, six-angle surround batch, PNG saved to Assets or
  returned inline, and `capture_source="scene_view"` in newer versions. — [tools reference](https://glama.ai/mcp/servers/@CoplayDev/unity-mcp/blob/08b8eacab13da57ed13859167fa6033c6441f58d/unity-mcp-skill/references/tools-reference.md);
  [orchestrator skill](https://skills.cat/skills/coplaydev/unity-mcp/unity-mcp-orchestrator)
- Unity API: `ScreenCapture.CaptureScreenshotIntoRenderTexture` captures the game view into a RenderTexture. Unity
  recommends calling it from a coroutine after `WaitForEndOfFrame` and reading back with `AsyncGPUReadback`.
  — [ScreenCapture.CaptureScreenshotIntoRenderTexture](https://docs.unity3d.com/ScriptReference/ScreenCapture.CaptureScreenshotIntoRenderTexture.html)
- `-nographics` skips GPU initialization. — [Unity CLI manual](https://docs.unity3d.com/6000.4/Documentation/Manual/EditorCommandLineArguments.html)
- Claude Code: MCP image results (PNG, JPEG, GIF, WebP) appear inline, possibly downscaled, and the original is saved to
  the session's `tool-results` folder (v2.1.283+). — [Claude Code MCP docs](https://code.claude.com/docs/en/mcp)
- A Unity user reported that captured camera images can differ from what a human sees in Play mode, and that judging
  lighting or "nighttime atmosphere" against an existing scene stays hard. — search excerpt of [CGVista / gamedevllm guides](https://cgvista.com/unity-claude-mcp/)
  (not opened; treat as anecdotal)
- Blender returns "FINISHED" when an operator runs, not when the result is correct, and screenshots won't reveal
  non-manifold geometry or empty exports. — [StraySpark (vendor)](https://www.strayspark.studio/blog/official-blender-mcp-server-comparison-2026)

### Inferences
- A repeatable "turntable sheet" check: a Blender script places a camera at fixed angles (front, side, back, 3/4, top),
  uses a neutral HDRI or three-point lights, and renders each with Cycles (low samples plus denoise) or Workbench to
  `out/<asset>_<angle>.png`. The agent then reads the PNGs next to the concept art and writes a short difference list
  (silhouette, proportions, colour blocks, missing parts). Fixed angles let the agent compare before and after.
- For Unity, an `-executeMethod` that renders a dedicated camera to a RenderTexture and writes a PNG works in
  batchmode **without** `-nographics` on a GPU machine. This is inferred and untested. With the Editor open, use the
  MCP screenshot tool instead.
- Screenshots should complement numeric validation (section 5), never replace it.

### Gaps
- No current (5.x) source confirms that EEVEE and Workbench render headless on Windows. Test it once on the user's machine.
- No tool or source was found for automated image similarity between a render and concept art (for example CLIP or
  silhouette IoU) in an LLM-agent workflow.
- Unity batchmode screenshot capture is not documented in the sources found.

---

## 5. Validation scripts: triangle count, non-manifold, normals, UVs, scale, textures, naming

### Takeaway
All required checks can be written with documented Blender 5.2 APIs (bmesh edge and vertex flags, `uv.select_overlap`,
object dimensions) and Unity APIs (ModelImporter settings, mesh and texture properties). They should run as scripts
that print JSON and exit non-zero on failure, so the agent gets a pass or fail it can't misread.

### Cited Findings
- bmesh flags (5.2): `BMEdge.is_manifold` ("True when this edge is manifold"), `is_boundary`, `is_contiguous` ("manifold,
  between two faces with the same winding", which catches flipped neighbours), `is_convex`, `is_wire` (no faces);
  `BMVert.is_manifold`, `is_boundary`; `BMFace.calc_area()`, `BMFace.normal`. — [bmesh.types (5.2)](https://docs.blender.org/api/current/bmesh.types.html)
- `bpy.ops.uv.select_overlap(extend=False)` selects overlapping UV faces. — [bpy.ops.uv (5.2)](https://docs.blender.org/api/current/bpy.ops.uv.html)
- 3D Print Toolbox "Solid" check: non-manifold edges (an edge must touch exactly two faces) and "Bad Contiguous" edges
  (a neighbour with the opposite normal direction). "Make Manifold" tries to fix normals, holes and empty geometry.
  — [Blender manual 4.1: 3D Print Toolbox](https://docs.blender.org/manual/ru/4.1/addons/mesh/3d_print_toolbox.html).
  Known false positive: an extra vertex on an edge was flagged as non-manifold. — [blender-addons #105193](https://projects.blender.org/blender/blender-addons/issues/105193)
- `bpy.ops.object.transform_apply(... corrective_flip_normals=True ...)` exists in 5.2, which matters when applying a
  negative scale. — [bpy.ops.object (5.2)](https://docs.blender.org/api/current/bpy.ops.object.html)
- In Blender's own MCP example, the analysis missed a Solidify modifier that doubled the polygon count. Count triangles
  on the **evaluated** mesh, after modifiers. — [Voyager (vendor), citing Blender's page](https://voyager.so/blog/blender-mcp)
- Unity side: `ModelImporter` exposes the import settings (scale, axis, colliders, LOD generation, mesh compression,
  readability) that a validation method can assert. — [ModelImporter (6000.4)](https://docs.unity3d.com/6000.4/Documentation/ScriptReference/ModelImporter.html).
  LOD Group has at most 8 levels and is created from `_LODn` naming. — [Importing LOD meshes](https://docs.unity3d.com/6/Documentation/Manual/importing-lod-meshes.html)

### Inferences
- Blender validation script (`validate_mesh.py`, run with `--background --python-exit-code 1`) should, per mesh
  object, report:
  - Triangle count of the evaluated mesh (`obj.evaluated_get(depsgraph).to_mesh()` with `loop_triangles`) against a
    budget per LOD.
  - Counts of non-manifold edges (`not e.is_manifold`), boundary edges (holes), wire edges, loose vertices, and
    non-contiguous edges (inconsistent normals).
  - Zero-area faces (`f.calc_area() < eps`).
  - Unapplied transforms (`obj.scale != (1,1,1)` or a non-zero rotation) and negative scale.
  - Dimensions in metres against an expected range (for example a crate is 0.5 to 1.5 m).
  - Origin position (for example the bottom center for props).
  - UVs: has a UV map, all coordinates within 0..1 (unless UDIM is intended), and overlap count via `uv.select_overlap`
    in edit mode (this needs an edit-mode context in background; untested).
  - Images: power-of-two sizes and a maximum resolution (`img.size`).
  - Names against a pattern (for example `^[A-Z][A-Za-z0-9]+(_LOD[0-7])?$`) and material count.
  Output a JSON report and exit with code 1 on any hard failure.
- Outward-normal heuristic for closed meshes: signed volume (the sum of the triangles' scalar triple products) should
  be positive. A negative value suggests the whole mesh is flipped. `is_contiguous` only catches local inconsistency.
  This is a standard geometric technique, not found in the sources above.
- Unity validation (`AssetValidation.Run` via `-executeMethod`) should check, per imported model:
  - The importer settings match the rules.
  - `MeshFilter.sharedMesh.triangles.Length / 3` within budget per LOD.
  - Renderer bounds size in metres within the expected range.
  - The LODGroup exists and levels are ordered.
  - Texture importer max size and compression.
  - Missing materials or shaders (pink).
  Write JSON to a file and exit through `EditorApplication.Exit(code)`.

### Gaps
- No ready-made, maintained "game asset validator" for Blender 5.x or Unity 6 was found in this research. The Print3D
  Toolbox (now an extension) targets 3D printing, not game-asset rules.
- `uv.select_overlap` and similar edit-mode operators in `--background` need a context setup that was not verified.

---

## 6. What has worked or failed for people using Claude or other LLM agents with Blender and Unity

### Takeaway
The evidence is anecdotal: blogs, a few structured experiments, no benchmarks. It agrees on these points:
- What works: simple hard-surface scenes, layout, batch scripts, scene analysis and debugging.
- What fails: organic or character modelling, clean topology, aesthetic judgment, and long sessions, which run into
  context and token limits.
- In Unity, simple systems work on the first try, while complex ones are "data-correct but unplayable".
- Setup and tooling fragility (orphan processes, silent config failures, API drift) causes as much trouble as model
  quality.

### Cited Findings
- MindStudio (2026-05-06, opinion piece with no stated test method): primitives, transforms, lighting and camera are
  "recognizably" close but imprecise. Organic forms, characters and foliage are very difficult. Claude doesn't reason
  about edge loops or subdivision-ready topology. Principled BSDF materials are fine, complex node setups are hard.
  Python errors need several rounds, and Geometry Nodes break across versions. It recommends prototyping, hard-surface
  and architectural work, and batch scripts, and not production assets. — [MindStudio](https://www.mindstudio.ai/blog/claude-blender-mcp-real-world-performance)
- A "donut test" reported that Claude claimed the work was done and stalled as context filled. It recommends saving the
  .blend at milestones, and reports heavy token use (60% of a session on the $200 Max plan). — [MindStudio donut test](https://www.mindstudio.ai/blog/claude-blender-mcp-60-percent-tokens-donut-test-results)
  (seen via search excerpt only)
- One review judged output worse than a Blender beginner's after a few hours of practice. — search excerpt, source
  among [harknessai.nz](https://www.harknessai.nz/articles/generate-3d-models-claude-blender) and MindStudio; not
  opened, weak evidence.
- The community server's own troubleshooting says Claude "is sometimes erratic with its behaviour" (Poly Haven), and
  complex requests time out. — [Voyager quoting the README](https://voyager.so/blog/blender-mcp); [ahujasid README](https://github.com/ahujasid/blender-mcp)
- Blender: results "will depend on the model used". Blender's own analysis demo missed a Solidify modifier that doubled
  polygons. — [Voyager (vendor)](https://voyager.so/blog/blender-mcp)
- Unity, structured experiment (Classmethod, 2026-03-13; Claude Code with Opus 4.6, Unity 6000.3.10f1, official
  `com.unity.ai.assistant` 2.1.0-pre.1, Windows):
  - A bullet-hell shooter and a platformer worked on the first output.
  - A metroidvania dungeon was unplayable at first: exits were unreachable with the starting jump and there were
    ability dead ends.
  - Claude tested by teleporting the player through MCP rather than playing with real input.
  - The conclusion: playability ("experience correctness" versus "data correctness") is still a human job.
  - When it had MCP tools (Play mode, console, screenshots, object state), Claude ran 7 tests and fixed 5 issues itself.
  — [DevelopersIO / Classmethod](https://dev.classmethod.jp/en/articles/unity-mcp-claude-code-2d-game-verification/)
- Unity, Windows Claude Code user (2026-06-01): the official relay left orphan processes that locked `Library/`. They
  switched to CoplayDev. Consecutive MCP calls clog the UnitySynchronization queue, so they limit it to one call per
  turn. Switching servers forced rewrites of tool names in 11 skills and agents. — [kludgelog](https://note.com/kludgelog/n/nbd48152e59ab?hl=en)
- Unity setup: Claude Code auto-config can fail silently. The HTTP bridge drops when the Editor loses focus. One guide
  recommends Unity 6.0.66f2+ for the AI Assistant package because of a signature-validation bug in 6.0.60f1.
  — [CoplayDev wiki](https://github.com/CoplayDev/unity-mcp/wiki/3.-Common-Setup-Problems);
  [gamedevllm guide](https://gamedevllm.com/en/unity-mcp-claude-codex-gemini-cursorcomplete-guide-en/) (search excerpts)
- Security incidents: four 2026 CVEs against the community Blender MCP (see section 2). — [NVD](https://nvd.nist.gov/vuln/detail/CVE-2026-10688)

### Inferences
- For concept-art-to-asset work, the agent is most reliable as the **pipeline operator**: it imports a mesh (from an
  AI image-to-3D service, an asset library, or a human-made blockout), cleans it, decimates, unwraps, sets the pivot,
  makes LODs, exports, validates and imports into Unity. It is least reliable as the **modeller** of anything organic or
  detailed. Generation via Hunyuan3D, Rodin or Tripo through the community MCP moves modelling to a dedicated model.
  Output quality there is outside this note's scope.
- The procedure should be split into small scripted steps, each with a saved .blend checkpoint and a numeric
  validation gate, to address context exhaustion, false "done" claims, and FINISHED-but-wrong operators.
- Pin the Blender version (5.2 LTS) and give the agent the official server's `search_api_docs` or the 5.0 breaking
  changes list, to cut API-drift errors.

### Gaps
- No benchmark or controlled study of LLM agents on game-asset cleanup (as opposed to generation or scene layout) was
  found.
- No first-hand reports were found that combine Claude Code with Blender **and** Unity in one asset pipeline on Windows.
- Several anecdotal sources (MindStudio donut test, harknessai, CGVista, gamedevllm) were seen only as search excerpts.
