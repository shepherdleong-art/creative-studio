import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingIncludes: {
    '/**': [
      './node_modules/next/dist/compiled/next-server/*.runtime.prod.js',
      './node_modules/next/dist/compiled/react/**/*',
    ],
  },
  outputFileTracingExcludes: {
    '*': [
      './.cache/**/*',
      './.env',
      './.env.*',
      './.git/**/*',
      './.venv-litellm/**/*',
      './config.yaml',
      './data/**/*',
      './dist/**/*',
      './dist-desktop/**/*',
      './docs/**/*',
      './installer/**/*',
      './litellm-config.yaml',
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
  serverExternalPackages: ['ffmpeg-static', 'ffprobe-static'],
};

export default nextConfig;
