import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingExcludes: {
    '*': [
      './.cache/**/*',
      './.git/**/*',
      './data/**/*',
      './dist/**/*',
      './docs/**/*',
      './installer/**/*',
      './outputs/**/*',
      './scripts/**/*',
      './storage/**/*',
    ],
  },
  // The DevTools route indicator is an internal Next.js UI and is not localizable.
  // Hide it for this local workbench so users do not see English framework text.
  devIndicators: false,
  // Allow 127.0.0.1 (used by launcher.html) — otherwise Next.js treats it as cross-origin
  // and blocks HMR / dev resources.
  allowedDevOrigins: ['127.0.0.1'],
};

export default nextConfig;
