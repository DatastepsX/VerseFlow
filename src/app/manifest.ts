import type { MetadataRoute } from "next";

/** added to the Home screen: the app's name, icon and colours */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "VerseFlow",
    short_name: "VerseFlow",
    description: "Write, flow and record your songs — together.",
    start_url: "/",
    display: "standalone",
    background_color: "#111113",
    theme_color: "#6d4aff",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
