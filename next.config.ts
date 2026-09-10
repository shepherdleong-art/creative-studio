import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NextConfig } from "next";

interface ForbiddenPathsSpec {
  version: number;
  fileEntries: string[];
  core: string[];
  consumers: {
    nextStandaloneExcludes: { extra: string[] };
  };
}

const forbiddenPaths = JSON.parse(
  readFileSync(join(process.cwd(), 'scripts', 'packaging', 'forbidden-paths.json'), 'utf8'),
) as ForbiddenPathsSpec;

const renderForbiddenPath = (entry: string) =>
  forbiddenPaths.fileEntries.includes(entry) ? `./${entry}` : `./${entry}/**/*`;

const nextStandaloneExcludes = [
  ...forbiddenPaths.core.map(renderForbiddenPath),
  ...forbiddenPaths.consumers.nextStandaloneExcludes.extra.map(renderForbiddenPath),
];

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingIncludes: {
    '/**': [
      './node_modules/next/dist/compiled/next-server/*.runtime.prod.js',
      './node_modules/next/dist/compiled/react/**/*',
    ],
  },
  outputFileTracingExcludes: {
    '*': nextStandaloneExcludes,
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
