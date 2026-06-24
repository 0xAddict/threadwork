---
name: nike
description: >-
  Apply the LOCKED Nike design system / "Nike taste" to any creative — kinetic-typography
  video overlays (Remotion), static graphics, social posts, and ads — by re-applying the
  exact proven design tokens verbatim (Anton heavy condensed UPPERCASE, stark monochrome
  white-on-near-black, exactly ONE Volt #D7FF1E accent, square hard edges, snappy 7f-in/6f-out
  motion, non-overlapping captions) and regenerating fresh on-brand Higgsfield accent imagery
  each run. Use this skill whenever the user says "/nike", "nike style", "nike taste",
  "nike design", "apply the nike tokens", "make it look like nike", "Just Do It style",
  "Nike kinetic typography", or asks for athletic high-contrast condensed-caps creative with a
  single volt-green accent — even if they don't name the brand explicitly. Trigger it before
  designing any overlay, ad, or graphic that should match this house style so the tokens are
  applied exactly, not paraphrased.
---

# Nike Design System (LOCKED tokens)

This skill locks the EXACT Nike design tokens proven in **task #1551** (a YouTube Short
kinetic-typography restyle that passed two independent fail-seeking adversarial reviewers —
Codex CLI + Opus — 17/17 objective checks, zero defects). Re-apply these tokens **verbatim**.
Do not invent variants, do not paraphrase, do not add a second accent color.

The tokens were distilled from scraping `nike.com` + `nike.com/launch` and then implemented and
proven in a real Remotion composition. The canonical implementation is bundled in this skill at
`assets/Main.reference.tsx` (a verbatim copy of the proven
`~/ytshort-harness/overlay/src/Main.tsx`). When in doubt, that file is the source of truth.

---

## The locked tokens (use verbatim)

| Dimension | LOCKED value |
|-----------|--------------|
| **Type family** | **Anton** — single weight 400, reads as a black condensed grotesque (Futura/Trade Gothic Bold Condensed lineage). Self-hosted woff2, embedded via `@font-face` + deterministic `delayRender`/`FontFace.load()` so headless renders never fall back. Bundled at `assets/fonts/Anton-Regular.woff2`. CSS stack: `"'Anton', 'Arial Narrow', system-ui, sans-serif"`. |
| **Type case** | ALL CAPS always (`textTransform: uppercase`). |
| **Type scale** | OVERSIZED. Headline **84px**, lineHeight **0.94**. Kicker label **34px**. Top wordmark 26px. (Type dominates the lower third.) |
| **Type tracking** | Headline `letterSpacing: -1` (tight). Kicker `letterSpacing: 3` (slightly open). |
| **Type lean** | Slight forward skew on entrance (`skewX(-5deg)`) that settles upright — "Just Do It" forward motion. |
| **Color — white** | `#FFFFFF` — pure white type. |
| **Color — ink** | `#0A0A0A` — near-black hard plate behind the headline + kicker text color. |
| **Color — accent** | **Volt `#D7FF1E`** — the ONLY accent. EXACTLY ONE accent color in the entire composition, used SPARINGLY: kicker label background, the rule/underline wipe, the active progress tick, and one small top mark. **Never a second accent.** (The retired v1 cyan `#19E3FF` + orange `#FF7A1A` scheme is permanently removed.) |
| **Layout** | Bottom-anchored, **flush-left / asymmetric**, generous negative space above. Headline sits on a flat hard-edged near-black plate in the lower third. |
| **Edges** | **Square corners only** — `borderRadius: 0` everywhere. NO rounded pills, NO soft cards, NO `backdropFilter` blur badges, NO glows. |
| **Motion IN** | Fast decisive **7-frame** rise + wipe (`Easing.out(Easing.cubic)`), rise from `+54px`, skew settles `-5deg → 0`. |
| **Motion OUT** | Fast **6-frame** wipe-out / drop (`Easing.in(Easing.cubic)`), drops `+40px`. No lingering. |
| **Accent wipe** | Volt rule wipes L→R fast (width `0 → 300` over ~`IN+2` frames), hard edge. |
| **Caption rule** | **Non-overlapping windows.** Each caption window = `[start, min(naturalEnd, nextStart − 6 frames)]`, with a ≥6-frame gap so **no two captions are ever on screen simultaneously.** |

**Restyle one-liner:** Stark monochrome (white + near-black), ONE volt accent used sparingly,
OVERSIZED Anton all-caps condensed type bottom-anchored on a flat hard-edged black plate, snappy
decisive 7f-in/6f-out entrances/exits, generous negative space, zero rounded soft cards — Nike
"Just Do It" confidence.

---

## Remotion implementation block

This is the proven implementation. The full file lives at `assets/Main.reference.tsx`; copy from
it directly for any new Remotion build. The load-bearing snippets:

### 1. Locked color constants

```tsx
const WHITE = "#FFFFFF";
const INK   = "#0A0A0A"; // near-black plate
const VOLT  = "#D7FF1E"; // single Nike accent — never a second one
const FONT  = "'Anton', 'Arial Narrow', system-ui, sans-serif";
```

### 2. Deterministic Anton font load (delayRender)

So the headless Chromium render embeds the self-hosted woff2 and the first captioned frames are
never rendered in a fallback face:

```tsx
const FontLoader: React.FC = () => {
  const [handle] = React.useState(() => delayRender("load-anton"));
  React.useEffect(() => {
    const url = staticFile("fonts/Anton-Regular.woff2");
    const face = new FontFace("Anton", `url(${url}) format("woff2")`,
      { weight: "400", style: "normal" });
    face.load()
      .then((loaded) => { document.fonts.add(loaded); continueRender(handle); })
      .catch(() => continueRender(handle));
  }, [handle]);
  return (
    <style>{`
      @font-face {
        font-family: 'Anton'; font-style: normal; font-weight: 400; font-display: block;
        src: url(${staticFile("fonts/Anton-Regular.woff2")}) format('woff2');
      }
    `}</style>
  );
};
```

Place `Anton-Regular.woff2` (bundled here at `assets/fonts/`) into the Remotion project's
`public/fonts/`. Render `<FontLoader />` once at the top of the composition.

### 3. Snappy 7f-in / 6f-out motion + Volt rule wipe

```tsx
const IN = 7;            // rise + wipe in
const OUT = 6;           // wipe out
const exitStart = windowFrames - OUT;

const enter = interpolate(frame, [0, IN], [0, 1],
  { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
const exit  = interpolate(frame, [exitStart, windowFrames], [1, 0],
  { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.in(Easing.cubic) });
const vis = Math.min(enter, exit);

const enterY = interpolate(enter, [0, 1], [54, 0]); // rise on entrance
const exitY  = interpolate(exit,  [0, 1], [40, 0]); // drop on exit
const y = enterY + exitY;
const skew = interpolate(enter, [0, 1], [-5, 0], { extrapolateRight: "clamp" }); // forward lean settles

// Volt rule wipes L->R, hard edge
const ruleW = interpolate(frame, [1, IN + 2], [0, 300],
  { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
```

Headline plate: `background: INK; padding: "16px 20px 12px"` (NO borderRadius), span is
`fontFamily: FONT, fontSize: 84, lineHeight: 0.94, letterSpacing: -1, color: WHITE,
textTransform: "uppercase"`. Kicker: `background: VOLT; color: INK; fontSize: 34;
letterSpacing: 3; padding: "10px 16px 6px"` (square). Container is
`alignItems: "flex-start"` (flush-left asymmetric), `bottom: 200`.

### 4. Non-overlapping caption windows (the proven overlap fix)

Guarantees no two lesson captions ever coexist — carves a real gap even when two captions share
the same timestamp:

```tsx
const GAP_FRAMES = 6;
const sorted = [...lessons].sort((a, b) => a.start_sec - b.start_sec);

const windows = sorted.map((l, i) => {
  const start      = Math.round(l.start_sec * fps);
  const naturalEnd = Math.round(l.end_sec * fps);
  const next       = sorted[i + 1];
  const nextStart  = next ? Math.round(next.start_sec * fps) : durationInFrames;
  const hardEnd    = nextStart - GAP_FRAMES;            // gone GAP_FRAMES before next starts
  const displayEnd = Math.min(naturalEnd, hardEnd);
  const windowFrames = Math.max(14, displayEnd - start); // floor so entrance+exit fit
  return { lesson: l, from: start, windowFrames };
});
```

Each window becomes a `<Sequence from={start} durationInFrames={windowFrames}>`. Because the OUT
exit (6f) completes by `displayEnd`, and the next entrance starts at its own `start`, there is
always a clean caption-free run of frames at every transition.

---

## Higgsfield accent imagery — REGENERATE FRESH EACH RUN

Accent images are part of the look but they are **never reused stale**. On every invocation,
**regenerate fresh** Higgsfield accents in the same monochrome + single-Volt language so the
batch is coherent with the current creative. This is a hard rule per the original task author:
generate new ones, do not pull old files.

### Generate-image prompt template (copy-paste, encodes the brand)

```
High-contrast black-and-white athletic motion-graphic accent. Stark monochrome:
pure white and near-black (#0A0A0A) only, maximum contrast. EXACTLY ONE accent color:
Volt green-yellow #D7FF1E, used sparingly as a single sharp pop (a slash / rule / mark) —
never a second color. Hard-edged, square, flat — NO rounded corners, NO soft gradients,
NO blur, NO glow. Bold condensed energy, decisive, kinetic, "Just Do It" confidence,
generous negative space. Subject: <SUBJECT — e.g. running silhouette / explosive sprint
start / abstract speed streaks>. Aspect ratio <9:16 for shorts / 1:1 for posts>.
Editorial sports campaign aesthetic. No text, no logos.
```

Fill `<SUBJECT>` and aspect ratio per creative. Keep "EXACTLY ONE accent = Volt #D7FF1E" and
"hard-edged / no rounded / no blur" verbatim — that's what keeps it on-brand.

### Higgsfield workflow

1. `balance` — confirm credits before spending.
2. `generate_image` — pass the prompt above (fresh, this run) with the right aspect ratio.
3. `job_status` — poll until the job completes.
4. `reveal_generation` / `show_medias` — reveal and inspect the result; reject anything with a
   second accent color, rounded/soft shapes, blur, or a washed-out (non-max-contrast) palette.
5. Download the approved frame and drop it into the composition's `public/` (or the static deck).

(Tools live on the `Higgsfield_MCP` server: `mcp__claude_ai_Higgsfield_MCP__balance`,
`...generate_image`, `...job_status`, `...reveal_generation`, `...show_medias`.)

---

## Usage / workflow

### (a) Video overlays — kinetic typography (Remotion)
1. Copy `assets/Main.reference.tsx` into the Remotion project (`src/Main.tsx`) and
   `assets/fonts/Anton-Regular.woff2` into `public/fonts/`.
2. Feed your captions/lessons (each `{ text, emphasis, start_sec, end_sec }`). The
   non-overlapping window logic is already wired.
3. Regenerate fresh Higgsfield accents (above) for any inserted accent shots.
4. Render. For a shippable deliverable, run it through the **harness-contract** with the
   **`--codex-verify` adversarial gate** (the same gate that proved #1551) so caption-overlap,
   off-brand styling, sync drift, and render artifacts are independently fail-checked before it
   ships.

### (b) Static graphics / ads
Apply the same tokens in your static tool of choice: Anton UPPERCASE oversized headline on a
near-black hard plate, white type, one Volt kicker/rule, flush-left bottom-anchored, square
corners, generous negative space. Pair with a fresh Higgsfield monochrome+Volt accent. No second
color, no rounded cards.

---

## Provenance

Proven in **task #1551** — a v2 Nike-restyle YouTube Short that survived a deliberately
fail-seeking adversarial gate: **Codex CLI + Opus**, both instructed to try HARD to reject it
(caption overlap, off-brand styling vs Nike taste, sync drift, render defects). Both returned
**ADVERSARIAL PASS**, 17/17 objective checks, zero defects. Tokens distilled from scraping
`nike.com` + `nike.com/launch`. Source of truth: `assets/Main.reference.tsx` (verbatim copy of
the proven `~/ytshort-harness/overlay/src/Main.tsx`) and
`~/ytshort-harness/.harness/sprints/sprint-2/nike-taste.md`.
