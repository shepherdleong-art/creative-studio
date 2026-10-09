import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
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
  compiler: {
    async runAfterProductionCompile({ projectDir, distDir }) {
      // Next 16 Turbopack does not apply route tracing excludes to instrumentation.
      // Filter before standalone copying: post-build cleanup is too late when a
      // traced local asset has disappeared. Keep the shared forbidden list authoritative.
      const tracePath = join(distDir, 'server', 'instrumentation.js.nft.json');
      if (!existsSync(tracePath)) return;
      const trace = JSON.parse(readFileSync(tracePath, 'utf8')) as { version: number; files: string[] };
      const entries = [...forbiddenPaths.core, ...forbiddenPaths.consumers.nextStandaloneExcludes.extra];
      const forbiddenPatterns = entries.map((entry) => {
        const pattern = entry.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*');
        return new RegExp(`^${pattern}${forbiddenPaths.fileEntries.includes(entry) ? '$' : '(?:/|$)'}`);
      });
      trace.files = trace.files.filter((file) => {
        const projectPath = relative(projectDir, resolve(dirname(tracePath), file)).replace(/\\/g, '/');
        return !forbiddenPatterns.some((pattern) => pattern.test(projectPath));
      });
      writeFileSync(tracePath, JSON.stringify(trace));
    },
  },
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
