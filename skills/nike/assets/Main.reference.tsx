import React from "react";
import {
  AbsoluteFill,
  OffthreadVideo,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Easing,
  continueRender,
  delayRender,
} from "remotion";

// ============================================================================
// NIKE-TASTE RESTYLE (sprint-2)
// Tokens (see .harness/sprints/sprint-2/nike-taste.md):
//  - Typography: Anton, heavy condensed UPPERCASE, oversized, tight tracking,
//    self-hosted woff2 @font-face embedded deterministically for headless render.
//  - Color: stark monochrome — pure WHITE type on a hard near-BLACK plate.
//    Exactly ONE accent: VOLT (#D7FF1E), used sparingly (kicker bg + one rule
//    + active progress tick). Old v1 cyan/orange + soft cards REMOVED.
//  - Layout: oversized type, BOTTOM-ANCHORED on a flat hard-edged plate, generous
//    negative space, square corners, no blur cards, no rounded pills.
//  - Motion: fast decisive rise+wipe entrances (~7f) and fast wipe-out exits
//    (~6f). No lingering. "Just Do It" confidence.
//
// OVERLAP FIX: every caption fully exits >= GAP_FRAMES before the next caption's
// entrance begins, guaranteeing a clean caption-free gap at every transition.
// ============================================================================

type Lesson = {
  id: number;
  text: string;
  emphasis: string;
  start_sec: number;
  end_sec: number;
};

const WHITE = "#FFFFFF";
const INK = "#0A0A0A"; // near-black plate
const VOLT = "#D7FF1E"; // single Nike accent

// Inline @font-face so the headless Chromium render embeds the self-hosted
// Anton woff2 deterministically (no network dependency at render time).
const FontLoader: React.FC = () => {
  // delayRender until the font is actually loaded so the first captioned frames
  // are not rendered in a fallback face.
  const [handle] = React.useState(() => delayRender("load-anton"));
  React.useEffect(() => {
    const url = staticFile("fonts/Anton-Regular.woff2");
    const face = new FontFace(
      "Anton",
      `url(${url}) format("woff2")`,
      { weight: "400", style: "normal" }
    );
    face
      .load()
      .then((loaded) => {
        // @ts-ignore - document.fonts is available in the render browser
        document.fonts.add(loaded);
        continueRender(handle);
      })
      .catch(() => continueRender(handle));
  }, [handle]);
  return (
    <style>{`
      @font-face {
        font-family: 'Anton';
        font-style: normal;
        font-weight: 400;
        font-display: block;
        src: url(${staticFile("fonts/Anton-Regular.woff2")}) format('woff2');
      }
    `}</style>
  );
};

const FONT = "'Anton', 'Arial Narrow', system-ui, sans-serif";

// ---- Nike kinetic headline: oversized white Anton on a hard black plate ----
const KineticHeadline: React.FC<{
  text: string;
  emphasis: string;
  // frames available for this caption's on-screen window (entrance..exit done)
  windowFrames: number;
}> = ({ text, emphasis, windowFrames }) => {
  const frame = useCurrentFrame();

  // Fast decisive entrance: rise + wipe over IN frames.
  const IN = 7;
  const OUT = 6;
  const exitStart = windowFrames - OUT;

  const enter = interpolate(frame, [0, IN], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const exit = interpolate(frame, [exitStart, windowFrames], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.in(Easing.cubic),
  });
  const vis = Math.min(enter, exit);

  // Decisive motion: rise up on entrance, drop on exit. Slight forward lean
  // (skew) on entrance that settles upright — "Just Do It" motion.
  // exit goes 1 -> 0; as it falls, add downward drop (0 -> 40).
  const enterY = interpolate(enter, [0, 1], [54, 0]);
  const exitY = interpolate(exit, [0, 1], [40, 0]);
  const y = enterY + exitY;
  const skew = interpolate(enter, [0, 1], [-5, 0], { extrapolateRight: "clamp" });

  // Volt rule wipes L->R fast under the kicker.
  const ruleW = interpolate(frame, [1, IN + 2], [0, 300], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

  return (
    <div
      style={{
        position: "absolute",
        left: 44,
        right: 44,
        bottom: 200,
        opacity: vis,
        transform: `translateY(${y}px)`,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start", // asymmetric, flush-left — Nike confidence
      }}
    >
      {/* Volt kicker label — flat, square, single accent */}
      <div
        style={{
          background: VOLT,
          color: INK,
          fontFamily: FONT,
          fontWeight: 400,
          fontSize: 34,
          lineHeight: 1,
          letterSpacing: 3,
          padding: "10px 16px 6px",
          textTransform: "uppercase",
          transform: `skewX(${skew}deg)`,
        }}
      >
        {emphasis}
      </div>

      {/* Volt rule wipe */}
      <div style={{ height: 8, width: ruleW, background: VOLT, marginTop: 12 }} />

      {/* Oversized white Anton headline on a hard black plate */}
      <div
        style={{
          marginTop: 14,
          background: INK,
          padding: "16px 20px 12px",
          transform: `skewX(${skew}deg)`,
        }}
      >
        <span
          style={{
            display: "block",
            fontFamily: FONT,
            fontWeight: 400,
            fontSize: 84,
            lineHeight: 0.94,
            letterSpacing: -1,
            color: WHITE,
            textTransform: "uppercase",
          }}
        >
          {text}
        </span>
      </div>
    </div>
  );
};

// ---- Minimal flat segmented progress bar (square, monochrome + volt active) --
const ProgressBar: React.FC<{ lessons: Lesson[] }> = ({ lessons }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const intro = interpolate(frame, [4, 16], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        position: "absolute",
        bottom: 120,
        left: 44,
        right: 44,
        display: "flex",
        gap: 8,
        opacity: intro,
      }}
    >
      {lessons.map((l, i) => {
        const active = t >= l.start_sec && t <= l.end_sec;
        const done = t > l.end_sec;
        return (
          <div
            key={i}
            style={{
              flex: 1,
              height: 6,
              // square, flat — volt only on the active segment
              background: active ? VOLT : done ? WHITE : "#FFFFFF33",
            }}
          />
        );
      })}
    </div>
  );
};

// ---- Top mark: flat uppercase wordmark, no rounded pill / no blur ----
const TopMark: React.FC = () => {
  const frame = useCurrentFrame();
  const intro = interpolate(frame, [4, 16], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const x = interpolate(intro, [0, 1], [-30, 0]);
  return (
    <div
      style={{
        position: "absolute",
        top: 44,
        left: 44,
        opacity: intro,
        transform: `translateX(${x}px)`,
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}
    >
      <div style={{ width: 16, height: 16, background: VOLT }} />
      <span
        style={{
          color: WHITE,
          fontFamily: FONT,
          fontWeight: 400,
          fontSize: 26,
          letterSpacing: 2,
          textTransform: "uppercase",
        }}
      >
        Acceleration Mechanics
      </span>
    </div>
  );
};

export const Main: React.FC<{ lessons: Lesson[] }> = ({ lessons }) => {
  const { fps, durationInFrames } = useVideoConfig();

  // ---- OVERLAP FIX: compute non-overlapping on-screen windows. ----
  // GAP_FRAMES = guaranteed caption-free frames between any caption's full exit
  // and the next caption's entrance start. OUT(6) exit completes by displayEnd,
  // so the gap is clean.
  const GAP_FRAMES = 6;
  const sorted = [...lessons].sort((a, b) => a.start_sec - b.start_sec);

  const windows = sorted.map((l, i) => {
    const start = Math.round(l.start_sec * fps);
    const naturalEnd = Math.round(l.end_sec * fps);
    const next = sorted[i + 1];
    const nextStart = next ? Math.round(next.start_sec * fps) : durationInFrames;
    // Caption must be fully gone GAP_FRAMES before the next caption starts.
    const hardEnd = nextStart - GAP_FRAMES;
    const displayEnd = Math.min(naturalEnd, hardEnd);
    const windowFrames = Math.max(14, displayEnd - start); // floor so entrance+exit fit
    return { lesson: l, from: start, windowFrames };
  });

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <FontLoader />

      {/* Base video bottom layer */}
      <OffthreadVideo src={staticFile("base.mp4")} />

      {/* Stark bottom scrim for high-contrast legibility (flat, monochrome) */}
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(0deg, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.10) 36%, rgba(0,0,0,0) 58%)",
        }}
      />

      <TopMark />
      <ProgressBar lessons={lessons} />

      {/* Per-lesson Nike kinetic typography — non-overlapping windows */}
      {windows.map(({ lesson, from, windowFrames }) => (
        <Sequence key={lesson.id} from={from} durationInFrames={windowFrames}>
          <KineticHeadline
            text={lesson.text}
            emphasis={lesson.emphasis}
            windowFrames={windowFrames}
          />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
