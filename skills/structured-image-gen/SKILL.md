---
name: structured-image-gen
description: Edit and generate images using structured JSON prompts with Nano Banana 2 (Gemini image model). Use this skill whenever the user wants to edit AI images, change colors/materials/objects in photos, swap logos or text, adjust lighting or camera perspective, generate product images, or work with Nano Banana / NB2 / Gemini image generation. Also trigger when the user mentions JSON prompts for images, reference folders for image editing, or wants fine-grained control over image modifications without the AI ruining the rest of the image.
---

# Structured Image Generation (Nano Banana 2 / Gemini)

## Purpose

Generate and edit images via **Nano Banana 2** (NB2), the Gemini image model,
using **structured JSON prompts** instead of fragile free-form text. The JSON
schema lets you isolate exactly what changes — color, material, lighting,
camera, text — while pinning everything else, so iterative edits do not
"AI-blur" the rest of the image.

This skill orchestrates the `mcp__nano-banana-mcp__*` tool family. The model
behind it is excellent at following structured prompts; the value of this
skill is the JSON schema and the workflow around it, not raw prompt magic.

## When to fire

Trigger on any of these signals — even without an explicit "use this skill":

- Edit, modify, retouch, fix, or change an existing image
- Generate a product shot, lookbook image, model try-on, hero render
- Change colors, materials, fabric, textures in a photo
- Swap a logo, replace text, change a sign, alter signage
- Adjust lighting, time of day, weather, camera angle, lens, depth of field
- Remove crowds/tourists, remove background, isolate a subject
- Expand / outpaint / extend a canvas, change aspect ratio
- Anything mentioning "Nano Banana", "NB2", "nanobanana", "Gemini image",
  "Imagen", "JSON prompt", "structured prompt", or "reference folder"
- User wants fine-grained control without re-rolling the whole composition

## Tools to use

All under the `mcp__nano-banana-mcp__*` namespace:

| Tool | Purpose |
|---|---|
| `get_configuration_status` | Check whether a Gemini token is configured. Call first. |
| `configure_gemini_token` | Set the Gemini API token if missing. |
| `generate_image` | Create a new image from scratch (with a JSON prompt). |
| `edit_image` | Edit an existing image given a reference + JSON modifications. |
| `continue_editing` | Iterate on the last image — refine without re-uploading. |
| `get_last_image_info` | Inspect metadata for the most recently produced image. |

## Workflow

1. **Check config.** Call `get_configuration_status`. If no token, ask the
   user for one and call `configure_gemini_token`. Never assume it's set.
2. **Pick the entry point.**
   - Generate from scratch → `generate_image` with a full JSON prompt.
   - Edit an existing image → `edit_image` with the reference image(s) and a
     JSON prompt describing **only the modifications** (and what to preserve).
3. **Iterate.** Use `continue_editing` to refine the last result — change one
   field at a time (e.g. only lighting, only material). This is the
   anti-blur move: small JSON deltas keep everything else stable.
4. **Inspect.** Use `get_last_image_info` to retrieve metadata, paths, or
   seeds if you need to reproduce or branch.
5. **Branch on seed if reproducibility matters.** Pin `meta.seed` in the JSON
   so re-runs are deterministic.

## JSON prompt structure

NB2 reads a structured object. The full reproducible schema (from the
alexewerlof gist, see reference doc) is organized into these top-level keys:

- **`meta`** — `aspect_ratio`, `quality`, `safety_filter`, `seed`, `steps`,
  `guidance_scale`. Pin `seed` for reproducibility.
- **`subject[]`** — array of subjects. Each has `type`, optional
  `input_image` with `usage_type` (`face_id` | `pose_copy` | `clothing_transfer`),
  `description`, `name`, `age`, `gender`, `hair`, `position`, `pose`,
  `expression`, `clothing[]`, `accessories[]`. Set `face.preserve_original: true`
  to lock identity across edits.
- **`scene`** — `location`, `time`, `weather`, `lighting` (type + direction),
  `background_elements[]`.
- **`technical`** — `camera_model`, `lens`, `aperture`, `shutter_speed`,
  `iso`, `film_stock`. Real camera/film names (Hasselblad X2D, Kodak Portra
  400, CineStill 800T) move the aesthetic noticeably.
- **`composition`** — `framing`, `angle`, `focus_point`.
- **`text_rendering`** — `enabled`, `text_content`, `placement`, `font_style`,
  `color`. Use this for logo swaps, signage, packaging copy.
- **`style_modifiers`** — `medium`, `aesthetic`, `artist_reference[]`.
- **`advanced`** — `negative_prompt[]`, `magic_prompt_enhancer`, `hdr_mode`.

**Quality presets:** `ultra_photorealistic`, `standard`, `raw`, `anime_v6`,
`3d_render_octane`, `oil_painting`, `sketch`, `pixel_art`, `vector_illustration`.

### Minimal generate example

```json
{
  "meta": { "aspect_ratio": "16:9", "quality": "ultra_photorealistic", "seed": 4242 },
  "subject": [{ "type": "product", "description": "matte black ceramic coffee mug" }],
  "scene": { "lighting": { "type": "soft studio key + rim", "direction": "45deg camera-left" }, "background_elements": ["seamless white sweep"] },
  "technical": { "camera_model": "Hasselblad X2D", "lens": "80mm f/2.8" },
  "composition": { "framing": "3/4 product hero", "angle": "slightly above eye-level" }
}
```

### Minimal edit example (preserve everything else)

```json
{
  "meta": { "seed": 4242 },
  "modifications": {
    "subject[0].clothing[0].color": "burgundy",
    "scene.lighting.type": "golden hour window light"
  },
  "preserve": ["face", "pose", "background", "composition"]
}
```

The `preserve` array is the antidote to the "AI ruins the rest of the image"
problem — name the fields you want frozen and NB2 will leave them alone.

## Full prompt library

See `references/community-prompts.md` for vetted, copy-paste-ready templates
from the awesome-nanobanana-pro repo and community gists, including:

- Professional product shot (background removal + studio)
- Virtual model try-on (garment + model composite)
- 3D chibi brand store
- Smart outpainting / canvas expansion
- Smart crowd removal
- Floor plan → interior design board
- Full 2000s mirror selfie JSON example
- The complete alexewerlof reproducible JSON schema
- Camera bodies, lenses, and film stocks that pull their weight

Read the reference file when the user's task matches one of those patterns —
do not paraphrase or duplicate it here.

## Tips that punch above their weight

- **One change per iteration.** Edit a single JSON field, then
  `continue_editing`. Compounding changes are where drift creeps in.
- **Name real gear.** "Shot on Hasselblad X2D, 80mm, Kodak Portra 400" is
  worth several paragraphs of vibes.
- **Use `preserve_original: true` on faces** the moment identity matters.
- **Pin the seed** before you start branching, so you can always return to a
  known-good base.
- **For text/logos**, use `text_rendering` rather than describing the text in
  prose — NB2 honors the structured field far more reliably.

## Resources

- `references/community-prompts.md` — community prompt library (read-only)
- Official prompting guide: https://blog.google/products/gemini/prompting-tips-nano-banana-pro/
- fofr's guide: https://www.fofr.ai/nano-banana-pro-guide
- Full JSON schema gist: https://gist.github.com/alexewerlof/1d13401a7647339469141dc2960e66a9
- awesome-nanobanana-pro: https://github.com/ZeroLu/awesome-nanobanana-pro
