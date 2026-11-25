import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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

function nextFilesystemRoot() {
  const project = process.cwd();
  if (process.env.NODE_ENV !== 'development' || process.env.CREATIVE_STUDIO_SERVER_RELEASE_ID !== 'local-preview') return project;
  // A nested worktree can share its parent checkout's node_modules through a junction.
  const dependencyOwner = dirname(realpathSync(join(project, 'node_modules')));
  const fromOwner = relative(dependencyOwner, realpathSync(project));
  return isAbsolute(fromOwner) || fromOwner.split(sep)[0] === '..' ? project : dependencyOwner;
}

const filesystemRoot = nextFilesystemRoot();
const nextConfig: NextConfig = {
  output: 'standalone',
  // A staged build has its own lockfile; never infer a parent workspace root.
  turbopack: { root: filesystemRoot },
  outputFileTracingRoot: filesystemRoot,
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
  serverExternalPackages: ['ffmpeg-static', 'ffprobe-static', '@ffprobe-installer/ffprobe'],
};

export default nextConfig;
