import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // the studio and its phone remote are now the song's Record tab
  redirects() {
    return [
      { source: "/p/:id/studio", destination: "/song/:id?view=record", permanent: false },
      { source: "/p/:id/remote", destination: "/song/:id?view=record&on=mac", permanent: false },
    ];
  },
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
