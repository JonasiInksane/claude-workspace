# AI image-to-3D and text-to-3D generation for game assets (state as of 2026-10-21)

All prices and features below were read on 2026-10-21 unless a different date is given. Vendor pages change often. Third-party and vendor-marketing sources are labelled. Nothing was signed up for and no API was called.

## 1. Which services and open models lead now, and what features do they have?

### Takeaway
The hosted leaders for game assets are **Meshy** (Meshy 7.1 / 6, smart-topology T2.5), **Tripo** (H3.1 / P series), **Rodin / Hyper3D** (Gen-2 / Gen-2.5) and **Tencent Hunyuan 3D** (3.0 hosted). The open-weight leaders are **TRELLIS.2** (Microsoft, MIT, 4B), **Hunyuan3D 2.1** (Tencent community licence) and **SPAR3D / Stable Fast 3D** (Stability). Meshy and Tripo are the most complete for a game pipeline: they combine generation, quad/low-poly retopology, PBR, rigging and animation in one API. Rodin is usually rated best on raw geometry fidelity but has no rigging. Unity 6 now has its own beta 3D Object Generator for static props.

### Cited Findings

**Meshy (hosted)**
- API model versions: `meshy-7.1` (alias `latest`), `meshy-6`, `meshy-6-lite`, plus smart-topology models `meshy-t2` / `meshy-t2.5`. Legacy `meshy-7` is billed as 7.1. `model_type: "lowpoly"` retires on **Oct 30, 2026**. — [Meshy API pricing](https://docs.meshy.ai/api/pricing); [Meshy Image-to-3D API](https://docs.meshy.ai/api/image-to-3d)
- Polycount and topology control: `topology` is `quad` or `triangle` (quad is not allowed with smart-topology). `target_polycount` ranges are 100–300,000 with remesh (default 30,000), 100–15,000 for `meshy-t2` (default 4,000) and 100–30,000 for `meshy-t2.5` (default 15,000). `geometry_resolution` 2k/4k needs meshy-7.1. `pose_mode` accepts a-pose or t-pose. `symmetry_mode` is deprecated and no longer affects output. — [Meshy Image-to-3D API](https://docs.meshy.ai/api/image-to-3d)
- Outputs: `glb`, `fbx`, `obj` (+`mtl`), `usdz` and `stl` by default, with `3mf` on request. Textures are 2k/4k/8k. `base_color` is always returned. `metallic`, `normal` and `roughness` need `enable_pbr: true`. `emission` is omitted for meshy-7.1/latest, meshy-6-lite, meshy-t2 and at 8k. — [Meshy Image-to-3D API](https://docs.meshy.ai/api/image-to-3d)
- Other API features: Multi-Image-to-3D, Retexture, Remesh, UV Unwrap, Convert, Resize, Auto-Rigging, Animation (up to 10 actions per request), Text-to-Motion, and 3D-print tools such as Auto Split. — [Meshy API pricing](https://docs.meshy.ai/api/pricing)
- Meshy's auto-rigging is limited to biped humanoids, according to a competitor's comparison (Tripo, so treat as biased). — [Tripo blog: Meshy alternatives](https://www.tripo3d.ai/blog/meshy-alternative)

**Tripo (hosted, by VAST)**
- Model lines: H series and P series for text-to-model, image-to-model and multiview-to-model, plus image-to-splat. — [Tripo billing docs](https://developers.tripo3d.com/en/docs/billing)
- Add-ons and processing jobs: HD texture, 8K texture, HD geometry, Quad Mesh, Smart Low-poly, Generate Parts, Retopology (v3.0 triangle/quad, v2.0 smart, v1.0 basic), Smart UV, Segmentation, Part Completion, Smart Segmentation (from image or from model), Auto Rig, Animation Retarget, and Format Convert. Format Convert has options for quad face limit, flatten bottom, texture size/format, pivot to center bottom and scale factor. — [Tripo API pricing](https://developers.tripo3d.com/en/pricing)
- Tripo also has an **Image to Multiview** job (10 credits) and **Edit Multiview** (5 per edited image) for making multi-view inputs from one image. — [Tripo API pricing](https://developers.tripo3d.com/en/pricing)
- Reviews describe Tripo as strongest on speed and rigging (including quadrupeds), but that comparison is published by Tripo. — [Tripo blog: Meshy alternatives](https://www.tripo3d.ai/blog/meshy-alternative)
- Tripo's low-poly tool cut one example from about 900K to about 7K faces (vendor-linked promotional article). — [Level Up / gitconnected](https://levelup.gitconnected.com/building-game-ready-3d-assets-fast-the-best-ai-generators-for-production-workflows-in-2026-f1f725ff5df0)

**Rodin / Hyper3D (hosted, by Deemos)**
- Model families: Gen-2.5 (multiple tiers and add-ons), Gen-2 (image- and text-to-3D) and Gen-1/1.5 (Sketch, Regular, Detail and Smooth tiers, with multi-image `concat`/`fuse`). — [Hyper3D docs: Features](https://docs.hyper3d.ai/en/get-started/features)
- Gen-2 output is a quad-dominant mesh at medium density with PBR materials, and quad is the default. Face count in quad mode is about 16× the quality setting (third-party reseller docs). — [Runware: Rodin Gen-2 topology guide](https://runware.ai/docs/models/hyper3d-rodin-gen-2/guides/topology-and-polygon-budget.md)
- Quad face count can be set from 1,000 to 200,000, and raw triangle meshes from 500 to 1,000,000 (third-party reseller). — [EmpirioLabs: Hyper3D Gen2](https://empiriolabs.ai/models/hyper3d-gen2)
- Comparisons consistently rate Rodin top-tier on geometry and photorealism, with 4K PBR options. It has no rigging module and is typically pricier (third-party opinion). — [inker.si comparison](https://inker.si/blog/best-ai-3d-model-generators-2026); [fuser.studio comparison](https://fuser.studio/articles/best-ai-3d-model-generators)

**Tencent Hunyuan 3D (hosted 3.0, plus open weights up to 2.1)**
- Tencent announced the global launch of the Hunyuan 3D engine (3d.hunyuanglobal.com) on **Nov 26, 2025**. It has text-, image- (up to 4 multi-view images) and sketch-to-3D, and "Smart Topology" with triangle or quad faces. It outputs OBJ and GLB, integrates with Unity, Unreal and Blender, and has an enterprise API through Tencent Cloud. — [Tencent press release](https://www.tencent.com/tencent-announces-global-launch-of-hunyuan-3d-engine-to-empower-creators-with-advanced-creation-tools/)
- Hunyuan3D-2.1 (open weights) was released on Jun 13, 2025. It has a PBR texture pipeline (metallic etc.) and supports Windows, macOS and Linux. — [Hunyuan3D-2.1 GitHub](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1)
- Tencent's "Hunyuan3D Studio" paper describes an end-to-end pipeline with part-level generation, polygon generation and semantic UV modules. This is vendor-authored and its claims are unverified. — [arXiv 2509.12815](https://arxiv.org/html/2509.12815v1)
- Open weights for 2.5 or 3.0 are **not confirmed**. A Jan 2026 forum post saw an "Open Weights Available" line for v2.5 on hy-3d.com but found nothing else. — [Reddit snapshot](https://reddit.sentinel-team.org/posts/1qqfpd9/snapshots/2026-01-29T19%3A41%3A44.74037Z)
- Newer Hunyuan "Pro" versions accept up to eight views (third-party comparison). In one third-party glazed-ceramic test, Hunyuan's single-photo output was the cleanest and Tripo's had the most surface speckle. — [inker.si comparison](https://inker.si/blog/best-ai-3d-model-generators-2026)

**TRELLIS.2 (open, Microsoft)**
- 4B parameters. It generates from a single image to a GLB with Base Color, Roughness, Metallic and Opacity (exported OPAQUE by default). Resolution runs from 512³ to 1536³. On an H100 it takes about 3s at 512³, 17s at 1024³ and 60s at 1536³. It also does PBR texturing of an existing shape and includes training code. MIT licence. — [TRELLIS.2 GitHub](https://github.com/microsoft/TRELLIS.2)
- Released around Dec 18, 2025 (secondary news). — [ComfyUI Wiki news](https://comfyui-wiki.com/news/2025-12-18-microsoft-trellis2-3d-generation); paper [arXiv 2512.14692](https://huggingface.co/microsoft/trellis.2-4b)

**SPAR3D / Stable Fast 3D (open, Stability AI)**
- SF3D makes a UV-unwrapped, relatively low-poly textured mesh from one 512×512 image in "under one second". Its textures are delit and it predicts per-object roughness and metallic. — [SF3D model card](https://huggingface.co/stabilityai/stable-fast-3d)
- SPAR3D is based on SF3D. It adds point-cloud conditioning (editable) for a better back side, and its remesh option can be none, triangle or quad. Output is GLB. — [SPAR3D GitHub](https://github.com/Stability-AI/stable-point-aware-3d)

**Others**
- **Hi3D (formerly Hitem3D)** rebranded in 2026. It is noted for high-resolution geometry and multi-view input, and one source says it suits 3D-printing more than game pipelines (third-party). — [inker.si comparison](https://inker.si/blog/best-ai-3d-model-generators-2026)
- **Sloyd** uses parametric generators with sliders rather than a diffusion mesh. Topology is controlled, but creative range is limited. Plus is $15/mo (vendor's own blog). — [Sloyd price comparison](https://sloyd.ai/blog/3d-ai-price-comparison)
- **CSM (Cube)** starts at $20/mo and uses credits (third-party listing). — [CO/AI listing](https://getcoai.com/tool-detail/csm/115133/)
- **Kaedim** pricing is reported in conflicting ranges: $150+/mo from one site and $50–$1,200/mo from Costbench. Both are third-party. — [Costbench Kaedim vs Sloyd](https://www.costbench.com/compare/kaedim-vs-sloyd/)
- **Unity 6 3D Object Generator** entered open beta on **May 21, 2026** for all Unity 6 developers. It makes static mesh prefabs (mesh + materials) for simple single-part props from text with an optional reference image. You can pick "your preferred AI model", but the models are not named. All outputs carry embedded AI-generated metadata for store declarations. It may change or be discontinued. — [Unity blog](https://unity.com/blog/unity-ai-3d-object-generator)
- Unity 6.2 replaced Muse/Sentis with Unity AI. Its Generators use Unity's models plus third-party models from Scenario and Layer, and the user is liable for copyright. — [Digital Production](https://digitalproduction.com/2025/08/22/unity-6-2-welcomes-ai-but-pace-caution-user-liability-on-copyright/)
- Meshy markets an official Unity plugin (vendor page, June 2026). — [Meshy blog](https://www.meshy.ai/cs/blog/ai-3d-models-for-unity-official-meshy-plugin-2026)

### Inferences
- For a solo Unity developer who wants automation, Meshy and Tripo are the two realistic hosted primaries. Both expose quad or low-poly topology, polycount targets, PBR maps, FBX/GLB output and rigging through one REST API. Rodin is the "best geometry" alternative to try for hero-ish static props.
- Unity's built-in generator is a convenient zero-setup option for placeholders. Its unnamed backend models and beta status make it a poor base for a scripted pipeline.
- Luma (Genie) did not show up in any 2026 comparison I found. It no longer looks like a current contender for game assets, but this is not verified.

### Gaps
- I did not verify Rodin's output-format list (GLB/FBX/OBJ/USDZ/STL), HighPack or texture-resolution options from Hyper3D's own docs. The Features page did not list them.
- Tripo's exact output-format list and how H series differs from P series were not verified on a primary page.
- No independent, controlled benchmark covering all the services was found. The comparisons are vendor- or blog-authored.
- Luma Genie, CSM's current status, Kaedim's current product, and other open models (for example ByteDance Seed3D, Step1X-3D, Direct3D-S2) were not researched.

## 2. APIs, pricing, rate limits, MCP servers and local Windows/GPU use

### Takeaway
Meshy, Tripo, Rodin and Tencent all have async REST APIs with API-key auth and credit billing. Failed tasks are not charged on Meshy and Tripo. **Meshy has an official, documented MCP server and a Claude Code skill pack.** Tripo's MCP is alpha, Blender-focused and only listed as "official" by directories. BlenderMCP can drive Hunyuan3D and Rodin from Claude. For local use on Windows with a consumer GPU, SPAR3D/SF3D (~6–10.5 GB) and Hunyuan3D 2.0/2.1 shape (5–10 GB) are feasible. Hunyuan3D 2.1 with texture (~21–29 GB) and TRELLIS.2 (24 GB, Linux-only officially) need a 24 GB-class card or workarounds.

### Cited Findings

**Meshy API**
- Auth is `Authorization: Bearer <key>`. Base URL is `https://api.meshy.ai`. You `POST /openapi/v1/image-to-3d`, then poll `GET .../:id` or stream over SSE (`.../:id/stream`). Statuses are PENDING, IN_PROGRESS, SUCCEEDED, FAILED and CANCELED. Deleting a PENDING task refunds its credits. Input is jpg/png/webp up to 20 MB, as a URL or base64, or `input_task_id` from a Meshy text-to-image task. — [Meshy Image-to-3D API](https://docs.meshy.ai/api/image-to-3d)
- Credits per request for meshy-7.1 and meshy-6: Image-to-3D costs 20 mesh-only, 30 with 2K or 4K textures and 35 with 8K. Multi-Image-to-3D has the same prices. Ultra geometry adds +5. meshy-6-lite and the T2 models cost 5 mesh-only and 15 with 2K textures. Retexture is 10 (15 at 8K), Remesh 5, UV Unwrap 5, Convert 1, Auto-Rigging 5, and Animation 3 per action. Image generation (nano-banana etc.) costs 3–12. — [Meshy API pricing](https://docs.meshy.ai/api/pricing)
- Plans as shown on 2026-10-21 (displayed in EUR to the fetcher):
  - Free: €0, 100 credits per month, no API, CC BY 4.0, 1 concurrent task.
  - Pro: €19, 1,000 credits, API access.
  - Premium: €38, 3,000 credits.
  - Ultra: €95, 8,000 credits.
  - Studio: €67, 5,500 shared credits.
  - Enterprise: custom.
  - Plan credits reset monthly. Purchased credits don't expire. API assets are kept 3 days (14 on Studio).
  — [Meshy pricing](https://www.meshy.ai/pricing). Search snippets show USD Pro $20/mo and Studio $60/mo. Currency and region pricing may differ. — [Meshy pricing (search snippet)](https://meshy.ai/pricing)
- Meshy's FAQ says free users get 200 credits a month, which conflicts with 100 on the pricing page. — [Meshy FAQ](https://docs.meshy.ai/faq)
- API access needs Pro or higher. — [Meshy API page (search snippet)](https://www.meshy.ai/en/api)
- Rate limits: 20 requests/second on all self-serve plans. Queue (PENDING + IN_PROGRESS) limits are Pro 10, Premium 30, Studio 20 and Ultra 100. Enterprise gets 100 rps and 100+ queued. Over the limit returns HTTP 429. — [Meshy rate limits](https://docs.meshy.ai/api/rate-limits)
- **Official MCP server:** npm `@meshy-ai/meshy-mcp-server`, source at github.com/meshy-dev/meshy-mcp-server. It uses the `MESHY_API_KEY` env var. `npx add-mcp @meshy-ai/meshy-mcp-server --env MESHY_API_KEY=...` auto-configures Claude Code and Claude Desktop. Its tools cover text, image and multi-image to 3D, texture, remesh, retexture, rig, animate, convert, resize, UV unwrap, task status/list/cancel/download and balance. MCP calls cost the same credits as REST. Meshy also offers `llms.txt` / `llms-full.txt` and a **`meshy-3d-agent` skill pack** (`npx skills add meshy-dev/meshy-3d-agent`) for Claude Code that calls REST without MCP. — [Meshy AI integration docs](https://docs.meshy.ai/api/ai)

**Tripo API**
- Credits are frozen when a task is created and deducted only on success. Failed or cancelled tasks are not charged. Balance is at `GET /v3/account/balance` and usage at `GET /v3/account/usage`. — [Tripo billing docs](https://developers.tripo3d.com/en/docs/billing)
- Prices per task:
  - Base generation (no texture / standard texture): Text-to-3D 10/20; Image-to-3D and Multiview-to-3D 20/30.
  - Add-ons: HD texture +10, 8K +20, HD geometry +20, Quad +5, Smart Low-poly +10, Generate Parts +20.
  - Processing: Auto Rig 25, Retarget 10 per animation, Retopology 10–40, Smart UV 20, Segmentation 40.
  - 1 credit = ¥0.07 CNY on the page as served.
  — [Tripo API pricing](https://developers.tripo3d.com/en/pricing)
- The v3.1 model page lists Image/Multiview-to-3D at 20/30/40 credits (no texture / standard / detailed). — [Tripo v3.1 model page (search snippet)](https://developers.tripo3d.com/en/models/v3-1)
- Older announcement: $0.01 per credit in units of 100, and 2,000 free credits when an API key is first generated. This predates the current docs and is unverified now. — [Tripo OpenAPI announcement](https://www.tripo3d.ai/blog/announcement-tripo-openapi-platform-payment-system)
- AWS Marketplace overage is $0.01 per credit. — [AWS Marketplace listing](https://aws.amazon.com/marketplace/pp/prodview-hwlbvx7vubh7c)
- Rate limits are per API key and vary by endpoint (exceeding returns 429, code 1007). Default concurrency per category is H series 10, P series 5, image 1, animation 10, model processing 5 and mesh ops 10 (code 2000 with Retry-After). — [Tripo rate limits](https://developers.tripo3d.com/en/docs/rate-limits)
- MCP: `VAST-AI-Research/tripo-mcp` is described by directories as official. It is alpha, runs with `uvx tripo-mcp`, and currently works through the Tripo Blender add-on. Community servers also exist: `tripo-ai-mcp-server` on npm (`TRIPO_API_SECRET`) and `lxy2109/tripo-mcp`. — [Glama: tripo-mcp](https://glama.ai/mcp/servers/VAST-AI-Research/tripo-mcp); [Glama: tripo-ai-mcp-server](https://glama.ai/mcp/servers/pasie15/tripo-ai-mcp-server)

**Rodin / Hyper3D API**
- Bearer API key. Base `https://api.hyper3d.com/api/v2`. Requests are multipart/form-data. The flow is submit, poll Check Status with `jobs.subscription_key`, then Download Results. Each submission reports `consumed` credits. Per-account parallelism cap returns `API_PARALLELISM_LIMIT_REACHED`. — [Hyper3D docs](https://docs.hyper3d.ai/); [Hyper3D Features](https://docs.hyper3d.ai/en/get-started/features)
- Plans: Free $0 (direct credits $1.5 each, 10 private assets); Creator $30/mo (~60 models); Business $120/mo (~416 models, **includes API access**); Enterprise custom. — [Hyper3D pricing](https://hyper3d.ai/pricing?lang=en)
- Reseller pay-as-you-go is $0.80 per Gen-2 generation (EmpirioLabs, third-party). A Gen-2 download can cost about 40 credits (CostBench, third-party). — [EmpirioLabs](https://empiriolabs.ai/models/hyper3d-gen2); [CostBench](https://costbench.com/software/ai-3d-generation/rodin-hyper3d/hidden-costs/)

**Tencent Hunyuan 3D hosted**
- 20 free generations per day on Hunyuan 3D Global. Enterprise API users get 200 free credits through Tencent Cloud. Paid pricing is not stated. — [Tencent press release](https://www.tencent.com/tencent-announces-global-launch-of-hunyuan-3d-engine-to-empower-creators-with-advanced-creation-tools/)
- Hunyuan 3D 3.0 is listed at "28 / generation" on Layer, a paid aggregator (unit unclear). — [Layer listing](https://www.layer.ai/models/tencent-hunyuan3d-3-0)

**BlenderMCP (community)**
- Lets Claude control Blender: objects, materials, scene inspection and running Python. It can generate models through Hunyuan3D (Tencent Cloud API or your own local server) and Hyper3D Rodin (a free trial key with a daily limit, or your own key). It can also pull Sketchfab and Poly Haven assets. Claude Code is configured with `.mcp.json`. — [mcpservers.org: blender-mcp](https://mcpservers.org/es/servers/ahujasid/blender-mcp); [Playbooks: Blender MCP](https://playbooks.com/mcp/ahujasid-blender)

**Local models on Windows with an NVIDIA GPU**
- **TRELLIS.2:** "An NVIDIA GPU with at least 24GB of memory is necessary." Tested only on Linux (A100/H100). It uses flash-attn (xformers as fallback), and the install is large and fragile. — [TRELLIS.2 GitHub](https://github.com/microsoft/TRELLIS.2)
- Community ComfyUI reports on TRELLIS.2 conflict and are weak sources:
  - One guide says minimum 16 GB, ideally 24 GB+, and reports OOM even on a 4090. — [Patreon guide](https://www.patreon.com/posts/146806567)
  - Another claims 8 GB minimum. — [trellis2.app](https://trellis2.app/blog/trellis-2-comfyui)
- **Hunyuan3D 2.1:** about 10 GB for shape, 21 GB for texture and 29 GB for both. Windows is supported. — [Hunyuan3D-2.1 GitHub](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1)
- **Hunyuan3D 2.0:** the mini model needs about 5 GB, standard shape about 6 GB, and shape + texture about 12 GB. — [ComfyUI Wiki: Hunyuan3D](https://comfyui-wiki.com/en/models/hunyuan3d)
- The Hunyuan3D-2GP community fork adds Windows support and low-VRAM profiles (under 6 GB). — [Hunyuan3D-2GP](https://openi.pcl.ac.cn/NewestAI/Hunyuan3D-2GP)
- **SPAR3D:** about 10.5 GB by default, about 7 GB in low-VRAM mode, and about 6 GB for single-image manual inference. Windows is "experimental" (needs VS 2022 + CUDA/PyTorch), and quality is not guaranteed to match Linux. The Hugging Face model is gated. — [SPAR3D GitHub](https://github.com/Stability-AI/stable-point-aware-3d)
- **SF3D:** VRAM is not stated on the model card. — [SF3D model card](https://huggingface.co/stabilityai/stable-fast-3d)

### Inferences
- Rough cost per textured asset, my arithmetic from the figures above, 2026-10-21:
  - Meshy Pro at €19 for 1,000 credits ≈ €0.019/credit, so a 2K/4K-textured image-to-3D (30 credits) is about €0.57. Adding remesh (+5) and rig (+5) brings it to about €0.76.
  - Tripo at ¥0.07/credit (≈ $0.01) with standard texture (30) + quad (+5) is about $0.35. Adding smart low-poly (+10) brings it to about $0.45.
  - Rodin is about $0.80 per generation through a reseller, or needs the $120/mo Business plan for direct API access.
  - These are estimates, not quotes.
- For Claude Code, Meshy is the lowest-friction choice: official MCP, an official agent skill, documented polling and SSE, and every needed post-process (remesh, UV, rig, convert) behind one key.
- A 24 GB card (RTX 3090/4090/5090) is the practical floor for running the best open models (TRELLIS.2, Hunyuan3D 2.1 with texture) locally. On 8–16 GB cards, SPAR3D, Hunyuan3D 2.0 mini/2GP or shape-only Hunyuan3D 2.1 (then texture elsewhere) are the realistic options. Windows support is official only for Hunyuan3D 2.1 and experimental for SPAR3D.

### Gaps
- The user's GPU model and VRAM are unknown, and `context/stack.md` does not list them. That decides whether local generation is viable.
- I did not find Tripo's current USD price per credit or free API credits on a current primary page. The CNY rate and the $0.01 figures come from different pages.
- Rodin's per-generation credit cost by tier, and its API rate limits, are not on the official pages I read.
- Tencent Cloud's international API pricing for Hunyuan 3D was not found.
- I found no verified official Windows install path for TRELLIS.2.

## 3. Licensing, ownership, training data and store policies

### Takeaway
Paid plans on Meshy and Rodin (Creator and up) give private, commercially usable outputs. On Tripo, paid users get full commercial rights, but the free tier's status is contradictory. Meshy Free outputs are CC BY 4.0, so commercial use requires attribution. Among open models, TRELLIS.2 is MIT, SF3D/SPAR3D use the Stability Community License (free under $1M annual revenue), and **Hunyuan3D 2.1's licence does not apply in the EU, UK or South Korea**. Steam requires disclosure of pre-generated AI content that players see, so AI-made 3D assets in a shipped game should be disclosed. Training data (Objaverse/Sketchfab scraping) remains contested.

### Cited Findings
- **Meshy:**
  - Free plan outputs are CC BY 4.0 (commercial use with attribution). All paid plans are "Private & customer-owned". — [Meshy pricing](https://www.meshy.ai/pricing)
  - The FAQ says you own assets created on a premium plan, "provided that you have used materials that do not violate the copyrights of others." — [Meshy FAQ](https://docs.meshy.ai/faq)
  - The help center says free users may sell commercially if they credit Meshy. — [Meshy help: commercial use](https://intercom.help/meshy/en/articles/16102098-can-i-use-meshy-assets-commercially)
- **Tripo:**
  - Tripo's help page says paid users have full commercial rights. For free users it says that under ToS §5.2.1 "Tripo retains all rights to Inputs and Outputs generated by Free Users". — [Tripo help: commercial use](https://www.tripo3d.ai/help/privacy-policy/how-to-use-tripo-models-commercially) (seen via search snippet; the page returned 403 to my fetch)
  - A Tripo blog post instead says free outputs are public under CC BY 4.0. — [Tripo blog](https://www.tripo3d.ai/blog/cheaper-meshy-alternative-private-commercial-use-3d-models)
  - Contradictory, so treat Tripo's free tier as non-commercial.
- **Rodin:** Creator and Business plans allow "Unlimited export and any use". The Free tier's licence is not stated. — [Hyper3D pricing](https://hyper3d.ai/pricing?lang=en)
- **Hunyuan3D 2.1 licence** (Tencent Hunyuan 3D 2.1 Community License):
  - "THIS LICENSE AGREEMENT DOES NOT APPLY IN THE EUROPEAN UNION, UNITED KINGDOM AND SOUTH KOREA". Use outside the Territory is "unlicensed and unauthorized".
  - Tencent claims no rights in outputs.
  - Outputs may not be used to improve other AI models.
  - Above 1M MAU you must request a licence.
  — [Hunyuan3D-2.1 LICENSE](https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1/blob/main/LICENSE)
  - Some sources list Hunyuan3D 2.0 as Apache-2.0 while a Hugging Face notice cites a non-commercial licence. These conflict. — [ComfyUI Wiki](https://comfyui-wiki.com/en/models/hunyuan3d); [HF notice](https://huggingface.co/spaces/LPDoctor/AIGC-3D/blob/main/Notice)
- **TRELLIS.2:** MIT for model and code. nvdiffrast and nvdiffrec have their own licences. — [TRELLIS.2 GitHub](https://github.com/microsoft/TRELLIS.2)
- **SF3D:** Stability AI Community License. It is free for commercial use by individuals or organisations with annual revenue of US$1,000,000 or less, and an Enterprise licence is needed above that. It was trained on Objaverse renders "filtered by license review". — [SF3D model card](https://huggingface.co/stabilityai/stable-fast-3d)
- **Steam:**
  - Valve rewrote its AI disclosure form (reported Jan 16–17, 2026). AI-powered dev tools such as code helpers no longer need disclosure. Developers must still disclose "AI to generate content for the game" (in-game, store page or marketing) and "AI content generated during gameplay". — [Game Developer](https://gamedeveloper.com/business/valve-tweaks-and-clarifies-ai-disclosure-rules-for-steam); [VGC](https://www.videogameschronicle.com/news/valve-has-significantly-rewritten-steams-rules-for-how-developers-much-disclose-ai-use)
  - The two categories are "Pre-Generated" and "Live-Generated". Live-generated content needs guardrail descriptions. Disclosures show on the store page, and developers keep full liability for copyright. — [tbreak](https://tbreak.com/steam-ai-disclosure-policy-update-developers/)
- **Unity AI** marks generated assets with AI metadata "to help you track them for app store declarations". — [Unity blog](https://unity.com/blog/unity-ai-3d-object-generator)
- **Training data:**
  - Objaverse (800K+ models) was sourced from Sketchfab. Sketchfab's CEO said models were scraped before its NoAI tag existed, without artists' knowledge. Critics say attribution was not handled per CC-BY. — [The Decoder](https://the-decoder.com/sketchfab-objaverse-ai-copyright-dispute-enters-third-dimension/); [3DVF](https://3dvf.com/en/ai-this-massive-dataset-of-3d-objects-is-a-game-change-heres-why-it-may-include-some-of-your-3d-assets/)
  - Generators can reproduce protected characters (for example, a Super Mario prompt). — [3DVF on Autodesk generative model](https://3dvf.com/en/autodesk-lauches-a-generative-ai-model-an-overview-of-the-possibilities-and-the-legal-challenges/)

### Inferences
- A solo dev who plans to sell on Steam should use a paid tier (Meshy Pro+, Tripo paid, Rodin Creator+) or an MIT/permissive local model. They should keep the generation records (prompt, input image, task ID, plan at time of generation) and tick Steam's pre-generated content disclosure.
- If the user is based in the EU or UK, the Hunyuan3D open weights are not licensed for them. TRELLIS.2 (MIT) or SPAR3D/SF3D (Community License) are the clean local choices. The hosted Hunyuan service has its own terms, which I did not read.
- Input images must be the user's own concept art, or licensed. Vendor output ownership does not cover rights in the input (Tripo help page, snippet).

### Gaps
- I did not read the full Terms of Service for Meshy, Tripo, Rodin or Hunyuan 3D Global, including indemnity, whether user inputs are used for training, and output exclusivity.
- Steam's exact current form wording was not retrieved from Steamworks, which needs a login. Secondary sources don't mention 3D models specifically.
- I found no court ruling on the copyright status of AI-generated 3D assets.
- Epic, itch.io and console store policies were not researched.

## 4. Inputs that work best

### Takeaway
Use a single, centered, uncropped object on a plain or removed background, with even, shadow-free lighting. Shadows bake into the texture. Multi-view input (front/side/back with consistent scale, orientation and lighting) beats a single image for accuracy. Several services can now make the multi-view set from one concept image (Tripo Image-to-Multiview, Meshy image generation chained by `input_task_id`, Hunyuan up to 4 views).

### Cited Findings
- Meshy recommends a single object, a clean background, good lighting and a centered subject. Cluttered scenes merge into one distorted mesh. The upload area has a Remove Background button. — [Meshy webapp Image-to-3D docs](https://docs.meshy.ai/en/webapp/image-to-3d); [Meshy help](https://intercom.help/meshy/en/articles/9996860-how-to-use-meshy-image-to-3d)
- Meshy's troubleshooting ties dark patches on the model to shadowed areas in the input. It advises evenly lit photos or fixing the lighting in 2D first. Image Enhancement (AI preprocessing) should be off for high-quality inputs. — [Meshy webapp Image-to-3D docs](https://docs.meshy.ai/en/webapp/image-to-3d) (via search summary)
- Multi-view in Meshy takes 2–8 images per its docs (a third-party guide says up to 4). Subject size, orientation and lighting should match across views. — [Meshy webapp Image-to-3D docs](https://docs.meshy.ai/en/webapp/image-to-3d); [Scenario: Meshy essentials](https://help.scenario.com/en/articles/meshy-the-essentials/)
- Parts cropped out of the image stay missing ("cut off the feet... your 3D model won't have feet"). Avoid glass and reflective materials. This is general guidance from a competitor. — [Sloyd](https://www.sloyd.ai/blog/why-some-photos-convert-better-to-3d-than-others)
- Input specs:
  - SF3D expects 512×512 input. — [SF3D model card](https://huggingface.co/stabilityai/stable-fast-3d)
  - Meshy accepts up to 20 MB jpg/png/webp. — [Meshy Image-to-3D API](https://docs.meshy.ai/api/image-to-3d)
- Unity's generator gives "more predictable" results with a clear, isolated subject on a plain or transparent background. — [Unity blog](https://unity.com/blog/unity-ai-3d-object-generator)
- Ways to make multi-view sets:
  - Tripo Image-to-Multiview costs 10 credits, and Edit Multiview 5 per image. — [Tripo API pricing](https://developers.tripo3d.com/en/pricing)
  - Hunyuan 3D image-to-3D accepts up to 4 multi-view images. — [Tencent press release](https://www.tencent.com/tencent-announces-global-launch-of-hunyuan-3d-engine-to-empower-creators-with-advanced-creation-tools/)
  - Hunyuan3D 2.0 added MV and MV-mini models. — [Pixelsham](https://www.pixelsham.com/2025/06/14/tencent-hunyuan3d-2-0-adds-mv-multi-view-and-mv-mini)
- Meshy's `pose_mode` (a-pose/t-pose) is meant for characters that will be rigged. — [Meshy Image-to-3D API](https://docs.meshy.ai/api/image-to-3d)

### Inferences
- A good concept-to-3D input recipe:
  1. Make the concept a single object, fully in frame, three-quarter or front view.
  2. Use flat/neutral lighting with no cast shadows and a transparent or white background.
  3. Use about 1024 px or more.
  4. For characters, use an A- or T-pose.
  5. Then generate consistent side and back views, either with the service's multiview tool or by drawing orthographic turnarounds, and use multi-view mode.
- Stylized or flat-shaded concept art avoids the "baked lighting" problem better than painterly art with strong rim light and shadows.

### Gaps
- I found no controlled study showing how much multi-view improves results over single-image, or what the ideal input resolution is per service.
- Orthographic versus perspective input is not addressed in any source I found.

## 5. Typical defects and the professional cleanup pipeline (and what Blender can do headless)

### Takeaway
Typical raw output is dense, triangulated geometry (hundreds of thousands to millions of triangles), fragmented UVs, lighting baked into albedo, non-manifold or inverted geometry, arbitrary scale and pivot, and geometry clipping or merging. The pro pipeline is: audit → repair (merge by distance, make manifold, recalc normals) → retopo or remesh (auto quad for props, manual for heroes) → re-UV → bake high-to-low (normal, AO, albedo) → delight or repaint → set scale and pivot → LODs → export. Vendors now do part of this server-side (quad remesh, polycount targets, smart UV, low-poly), which cuts but doesn't remove the cleanup. Most steps can be scripted with `blender --background --python`.

### Cited Findings
- Controlled study (Lindenwood University, Begemann & Hutson, June 2026), stylized tavern scene using Meshy 6 + Hunyuan 3D:
  - The AI pipeline took 238 minutes versus 716 for the human-authored scene.
  - The AI scene had about 32.8M triangles (103 objects) versus 293,828 triangles (123 objects).
  - Problems: "dense triangulated geometry, fragmented UV maps, inconsistent prompt adherence, material-editing constraints", clipping during placement, and "loss of texture integrity when attempting decimation". The human pipeline gave better scale control and editability.
  — [Lindenwood Digital Commons](https://digitalcommons.lindenwood.edu/faculty-research-papers/813)
- AI meshes are "notoriously dense (500K+ polygons for a simple object)". — [Level Up / gitconnected](https://levelup.gitconnected.com/building-game-ready-3d-assets-fast-the-best-ai-generators-for-production-workflows-in-2026-f1f725ff5df0)
- Meshy/Tripo output often has non-manifold geometry, inverted normals and 50K+ unorganized triangles. The cleanup sequence offered is:
  1. Import and audit.
  2. Repair (Merge by Distance, 3D Print Toolbox "Make Manifold").
  3. Decimate or Remesh.
  4. Fix normals.
  5. Export.
  This is a vendor blog. — [Neural4D cleanup guide](https://blog.neural4d.com/user-guide/ai-3d-model-blender-cleanup-complete-mesh-fix-guide-2026/)
- Tripo's guide for indie projects: run automated retopology on all assets, do manual cleanup only on hero assets and characters, and rely heavily on normal-map baking (vendor). — [Tripo cleanup guide](https://www.tripo3d.ai/blog/explore/ai-3d-model-generator-mesh-cleanup-as-a-postprocess-model)
- Semi-automation: automate cleanup, decimation, LODs and export, and keep humans on retopo decisions, UV seams and material checks. — [StraySpark](https://strayspark.studio/blog/blender-to-game-engine-pipeline-2026)
- Baked lighting: dark patches come from input shadows (Meshy docs). SF3D produces "delighted textures" specifically for game-engine use. — [Meshy webapp docs](https://docs.meshy.ai/en/webapp/image-to-3d); [SF3D model card](https://huggingface.co/stabilityai/stable-fast-3d)
- Scale and pivot: Tripo's Advanced Convert offers scale factor, pivot to center bottom, flatten bottom and quad face limit (10 credits). — [Tripo API pricing](https://developers.tripo3d.com/en/pricing)
- TRELLIS.2 GLBs export OPAQUE, so transparency must be re-enabled by hand. — [TRELLIS.2 GitHub](https://github.com/microsoft/TRELLIS.2)
- 3DVF: "almost all tools of this kind generate models with very poor topology, often unusable as-is and impossible to animate". — [3DVF](https://3dvf.com/en/autodesk-lauches-a-generative-ai-model-an-overview-of-the-possibilities-and-the-legal-challenges/)
- Server-side fixes available before Blender:
  - Meshy: Remesh (5 credits) with quad/triangle and `target_polycount`, smart-topology T2.5 (≤30K faces), UV Unwrap (5), Convert (1), Resize (1). — [Meshy API pricing](https://docs.meshy.ai/api/pricing); [Meshy Image-to-3D API](https://docs.meshy.ai/api/image-to-3d)
  - Tripo: Retopology v3.0 quad (40), Smart Low-poly (+10), Smart UV (20). — [Tripo API pricing](https://developers.tripo3d.com/en/pricing)
- Blender headless:
  - A decimation job runs as `blender --background --python job.py -- <args>`, adding a DECIMATE modifier per mesh and exporting. — [NVIDIA Omniverse: Blender decimation task](https://docs.omniverse.nvidia.com/farm/latest/guides/custom_decimation_task.html)
  - QuadriFlow is an operator (`bpy.ops.object.quadriflow_remesh`), not a modifier. — [Blender 2.83 API index](https://docs.blender.org/api/2.83/genindex-Q.html)
  - A retopo MCP server notes "bpy.ops can be flaky in background. Modifier is safer". — [retopoflow_blender_mcp source](https://glama.ai/mcp/servers/@ShirshovDIM/retopoflow_blender_mcp/blob/78358fedc1d6d47808d380d331e176370b479c59/src/blender_handlers/remeshing.py)
  - An old Blender bug (T71871, 2.82): looping `quadriflow_remesh` over several selected objects only remeshed the first and last. — [Blender T71871](https://developer.blender.org/T71871)

### Inferences
- Suggested headless Blender pipeline for a solo dev. Each step is either cited above or a standard Blender API feature I did not verify in this session (marked "unverified"):
  1. Import GLB (`bpy.ops.import_scene.gltf`, unverified).
  2. Apply scale and set origin to bottom-center; normalize to real-world meters from a size table.
  3. Merge by distance and recalc normals (bmesh, unverified).
  4. Remesh: QuadriFlow operator, one object at a time with explicit selection to avoid T71871, or a voxel remesh modifier.
  5. Decimate modifier per LOD ratio.
  6. Smart UV Project (`bpy.ops.uv.smart_project`, unverified).
  7. Cycles bake selected-to-active for normal, diffuse and AO from the original high-res AI mesh onto the low (unverified).
  8. Export FBX for Unity.
- Do as much as possible server-side first (Meshy remesh with `topology=quad` and `target_polycount`, or Tripo smart low-poly), then use Blender for scale, pivot, bake, LODs and validation. This cuts manual time the most.
- Delighting has no clean scripted fix. The practical fixes are flat-lit input art, a model that outputs delit or PBR albedo (SF3D, PBR modes), or retexturing with a text prompt (Meshy Retexture, Tripo Texture).
- Unity 6 can also generate LODs. Mesh LOD was mentioned with Unity 6.4 by CG Channel, but this was not verified ([CG Channel tag page](https://www.cgchannel.com/tag/mesh-lod/)).

### Gaps
- I found no authoritative source (Blender manual) in this session confirming headless behaviour of `bpy.ops.uv.smart_project` and `bpy.ops.object.bake`. Both need context and selection set up correctly and should be tested.
- No published, automated de-lighting tool for AI albedo maps was found.
- Thin parts and symmetry: Meshy's `symmetry_mode` is now deprecated. I found no source quantifying thin-part failures per tool.

## 6. Where professionals say AI 3D is good enough today, and where it is not

### Takeaway
The consensus across academic, practitioner and survey sources is that AI 3D is good for ideation, blockouts, placeholders, background or static props and kitbash bases. It is not good enough for hero assets, deforming characters or anything needing clean edge flow, tight budgets or editability, at least without heavy artist work. Developer sentiment toward gen-AI is increasingly negative, especially among artists.

### Cited Findings
- Lindenwood study: gen-AI "contributes most effectively to ideation, rough prop exploration, and early prototyping". "Artists and technical artists remain necessary for optimization, art direction, retopology", UV reconstruction, material refinement and engine validation. — [Lindenwood Digital Commons](https://digitalcommons.lindenwood.edu/faculty-research-papers/813)
- Practitioner view: AI tools "are trained to recreate visual output. They're not built to understand performance budgets, engine limitations, and animation requirements". Useful mainly for concept exploration and blocking out. — [Level Up: 3D artists aren't being replaced](https://levelup.gitconnected.com/3d-artists-arent-being-replaced-by-ai-not-yet-in-real-game-pipelines-cf75a6ee3947)
- Unity positions its own generator for "placeholder" and static single-part props (household items, environment details, decoration). It is not suited to parts that must move independently. — [Unity blog](https://unity.com/blog/unity-ai-3d-object-generator)
- Common production uses include generating concept variations for approval, automating retopology and making base meshes that artists refine (glossary-level source). — [Morphic glossary](https://morphic.com/ar/ai-glossary/Concept-to-Game-Ready)
- "Almost all" such tools produce topology that is "impossible to animate". — [3DVF](https://3dvf.com/en/autodesk-lauches-a-generative-ai-model-an-overview-of-the-possibilities-and-the-legal-challenges/)
- GDC 2026 State of the Industry (2,300+ respondents):
  - 52% say gen-AI is having a negative impact on the industry, up from 30% in 2025. Negative sentiment is highest in visual and technical art (64%). — [GameDev.net](https://www.gamedev.net/news/gdc-trends-report-2026-as-use-of-generative-ai-rises-devs-face-infrastructure-problem-r3601/); [StraySpark recap](https://www.strayspark.studio/blog/gdc-2026-full-recap-indie-developer-takeaways)
  - One recap puts asset generation at about 19% of gen-AI uses, versus 81% for research/brainstorming. This breakdown was not confirmed in the primary report. — [StraySpark recap](https://www.strayspark.studio/blog/gdc-2026-full-recap-indie-developer-takeaways)
- Tripo itself recommends manual cleanup on hero assets and characters, even in its own automated pipeline guide (vendor). — [Tripo cleanup guide](https://www.tripo3d.ai/blog/explore/ai-3d-model-generator-mesh-cleanup-as-a-postprocess-model)

### Inferences
- For a solo Unity dev, the high-return scope is static environment props, set dressing, pickups, blockout and greybox replacements, and kitbash bases, all with automated cleanup. Use AI rigging (Meshy or Tripo) only for background or NPC humanoids, or prototypes.
- Hero characters and anything deforming close to camera should be either hand-retopologized from the AI mesh (AI as a sculpt or base) or modelled conventionally.
- Using AI assets affects the store page (Steam disclosure). Given the negative sentiment in the GDC survey, there is a reputational trade-off to weigh.

### Gaps
- I found no 80 Level or Game Developer artist write-up (2026) describing a named studio's shipping AI-3D pipeline. Searches returned vendor blogs instead.
- I could not get the GDC 2026 primary report figures on asset-generation use directly (behind registration).
- There is no quantitative data on how often AI props pass without manual fixes in production.
