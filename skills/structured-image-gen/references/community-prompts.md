# Community Prompt Templates

Reference prompts from the awesome-nanobanana-pro repo (9.3k stars) and other sources.
Full repo cloned at: ~/nb2-workspace/awesome-nanobanana-pro/

## Product Photography (E-commerce)

### Professional Product Shot (Background Removal + Studio)
```
Identify the main product in the uploaded photo (automatically removing any hands holding it or messy background details). Recreate it as a premium e-commerce product shot. Subject Isolation: Cleanly extract the product, completely removing any fingers, hands, or clutter. Background: Place the product on a pure white studio background (RGB 255, 255, 255) with a subtle, natural contact shadow at the base to ground it. Lighting: Use soft, commercial studio lighting to highlight the product's texture and material. Ensure even illumination with no harsh glare. Retouching: Automatically fix any lens distortion, improve sharpness, and color-correct to make the product look brand new and professional.
```

### Virtual Model Try-On
```
Using Image 1 (the garment) and Image 2 (the model), create a hyper-realistic full-body fashion photo where the model is wearing the garment. Crucial Fit Details: The [garment type] must drape naturally on the model's body, conforming to their posture and creating realistic folds and wrinkles. High-Fidelity Preservation: Preserve the original fabric texture, color, and any logos from Image 1 with extreme accuracy. Seamless Integration: Blend the garment into Image 2 by perfectly matching the ambient lighting, color temperature, and shadow direction. Photography Style: Clean e-commerce lookbook, shot on a Canon EOS R5 with a 50mm f/1.8 lens for a natural, professional look.
```

### 3D Chibi Brand Store
```
3D chibi-style miniature concept store of {Brand Name}, creatively designed with an exterior inspired by the brand's most iconic product or packaging (such as a giant {core product}). The store features two floors with large glass windows clearly showcasing the cozy and finely decorated interior: {brand color}-themed decor, warm lighting, and busy staff dressed in outfits matching the brand. Adorable tiny figures stroll or sit along the street, surrounded by benches, street lamps, and potted plants. Rendered in a miniature cityscape style using Cinema 4D, with a blind-box toy aesthetic, rich in details and realism, and bathed in soft lighting. --ar 2:3
```

## Photo Editing

### Smart Outpainting (Expand Image)
```
Zoom out and expand this image to a 16:9 aspect ratio (computer wallpaper size). Context Awareness: Seamlessly extend the scenery on both left and right sides. Match the original lighting, weather, and texture perfectly. Logical Completion: If there are cut-off objects on the borders, complete them naturally based on logical inference. Do not distort the original center image.
```

### Smart Crowd Removal
```
Remove all the tourists/people in the background behind the main subject. Intelligent Fill: Replace them with realistic background elements that logically fit the scene (e.g., extend the cobblestone pavement, empty park benches, or grass textures). Consistency: Ensure no blurry artifacts or 'smudges' remain. The filled area must have the same grain, focus depth, and lighting as the rest of the photo.
```

## Interior Design

### Floor Plan to Design Board
```
Based on the uploaded 2D floor plan, generate a professional interior design presentation board in a single image. Layout: The final image should be a collage with one large main image at the top, and several smaller images below it. Content: 1. Main Image (Top): Wide-angle perspective of main living area. 2-4. Small Images (Bottom): Views of different rooms. Overall Style: Apply a consistent Modern Minimalist style with warm oak wood flooring and off-white walls. Quality: Photorealistic rendering, soft natural lighting.
```

### Room Furnishing Visualization
```
Show me how this room would look with furniture in it
```

## JSON Prompt Templates

### 2000s Mirror Selfie (JSON format)
```json
{
  "subject": {
    "description": "A young woman taking a mirror selfie with very long voluminous dark waves and soft wispy bangs",
    "age": "young adult",
    "expression": "confident and slightly playful",
    "hair": { "color": "dark", "style": "very long, voluminous waves with soft wispy bangs" },
    "clothing": {
      "top": { "type": "fitted cropped t-shirt", "color": "cream white", "details": "features a large cute anime-style cat face graphic" }
    },
    "face": { "preserve_original": true, "makeup": "natural glam makeup with soft pink dewy blush and glossy red pouty lips" }
  },
  "accessories": {
    "earrings": { "type": "gold geometric hoop earrings" },
    "jewelry": { "waistchain": "silver waistchain" },
    "device": { "type": "smartphone", "details": "patterned case" }
  },
  "photography": {
    "camera_style": "early-2000s digital camera aesthetic",
    "lighting": "harsh super-flash with bright blown-out highlights but subject still visible",
    "angle": "mirror selfie",
    "shot_type": "tight selfie composition",
    "texture": "subtle grain, retro highlights, V6 realism, crisp details, soft shadows"
  },
  "background": {
    "setting": "dimly lit bedroom at night",
    "elements": ["messy bed in background", "LED string lights on wall", "posters"],
    "atmosphere": "cluttered but aesthetic",
    "lighting": "dim warm ambient with strong front flash"
  }
}
```

## Reproducible JSON Schema (from alexewerlof gist)

Full schema fields:
- **meta**: aspect_ratio, quality, safety_filter, seed, steps, guidance_scale
- **subject[]**: type, input_image (with usage_type: face_id/pose_copy/clothing_transfer), description, name, age, gender, hair, position, pose, expression, clothing[], accessories[]
- **scene**: location, time, weather, lighting (type + direction), background_elements[]
- **technical**: camera_model, lens, aperture, shutter_speed, iso, film_stock
- **composition**: framing, angle, focus_point
- **text_rendering**: enabled, text_content, placement, font_style, color
- **style_modifiers**: medium, aesthetic, artist_reference[]
- **advanced**: negative_prompt[], magic_prompt_enhancer, hdr_mode

### Quality presets:
ultra_photorealistic, standard, raw, anime_v6, 3d_render_octane, oil_painting, sketch, pixel_art, vector_illustration

### Camera models:
iPhone 15 Pro, Sony A7R IV, Hasselblad X2D, Canon EOS R5, Fujifilm X-T5, Leica M11

### Film stocks:
Kodak Portra 400, Fujifilm Pro 400H, CineStill 800T, Ilford HP5 Plus

## Key Resources

- [Official Prompting Guide](https://blog.google/products/gemini/prompting-tips-nano-banana-pro/)
- [fofr's Guide](https://www.fofr.ai/nano-banana-pro-guide)
- [Full JSON Schema Gist](https://gist.github.com/alexewerlof/1d13401a7647339469141dc2960e66a9)
- [awesome-nanobanana-pro repo](https://github.com/ZeroLu/awesome-nanobanana-pro)
