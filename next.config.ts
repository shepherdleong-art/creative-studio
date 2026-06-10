import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The DevTools route indicator is an internal Next.js UI and is not localizable.
  // Hide it for this local workbench so users do not see English framework text.
  devIndicators: false,
};

export default nextConfig;
