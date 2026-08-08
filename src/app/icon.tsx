import { ImageResponse } from "next/og";

// Cherry brand mark — white rounded square + cherries emoji. White
// background so the (mostly red) emoji actually reads at 32x32 — a
// red-on-red version was tried first and was nearly invisible.
// Matches the "Cherry" product name in src/app/layout.tsx metadata.
// Next.js renders this at build time and auto-injects
// <link rel="icon"> into <head>.
//
// This route takes precedence over src/app/favicon.ico, which is the
// Next.js default and can stay on disk harmlessly (or be removed).

export const runtime = "edge";
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#ffffff",
          borderRadius: 6,
          fontSize: 22,
        }}
      >
        🍒
      </div>
    ),
    { ...size },
  );
}
