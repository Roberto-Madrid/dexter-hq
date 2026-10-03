import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Dexter.",
    short_name: "Dexter.",
    description: "Personal headquarters",
    start_url: "/",
    display: "standalone",
    background_color: "#f6f6f4",
    theme_color: "#000000",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
