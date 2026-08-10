import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const standaloneDir = join(root, '.next', 'standalone');

function copyDirectory(source, destination) {
  if (!existsSync(source)) {
    throw new Error(`Missing required build asset directory: ${source}`);
  }
  mkdirSync(destination, { recursive: true });
  cpSync(source, destination, { recursive: true, force: true });
}

if (!existsSync(standaloneDir)) {
  throw new Error(`Missing standalone build directory: ${standaloneDir}`);
}

copyDirectory(join(root, '.next', 'static'), join(standaloneDir, '.next', 'static'));
copyDirectory(join(root, 'public'), join(standaloneDir, 'public'));

// The standalone server is launched through this tiny wrapper so the Electron
// main process can learn the OS-assigned port and launch identity.
// Keep the Next-starting wrapper outside desktop/ so the desktop shell's
// dependency boundary cannot transitively include the business/native graph.
const serverEntrySource = join(root, 'runtime', 'server-entry.js');
if (!existsSync(serverEntrySource)) {
  throw new Error(`Missing required runtime server entry: ${serverEntrySource}`);
}
rmSync(join(standaloneDir, 'runtime'), { recursive: true, force: true });
mkdirSync(join(standaloneDir, 'runtime'), { recursive: true });
copyFileSync(serverEntrySource, join(standaloneDir, 'runtime', 'server-entry.js'));

// ffmpeg/ffprobe 静态二进制不会被 Next 的文件追踪收录，强制拷入 standalone
for (const pkg of ['ffmpeg-static', 'ffprobe-static']) {
  copyDirectory(join(root, 'node_modules', pkg), join(standaloneDir, 'node_modules', pkg));
}

// Next output tracing can conservatively copy the project root when a route has
// dynamic filesystem access. Strip local data, credentials and development
// paths even if a stale standalone directory survived from an earlier build.
const localOnlyRoots = [
  '.cache',
  'desktop',
  'dist-desktop',
  '.git',
  '.venv-litellm',
  'config.yaml',
  'data',
  'dist',
  'docs',
  'installer',
  'litellm-config.yaml',
  'outputs',
  'scripts',
  'storage',
];
for (const relativePath of localOnlyRoots) {
  rmSync(join(standaloneDir, relativePath), { recursive: true, force: true });
}
for (const entry of readdirSync(standaloneDir)) {
  if (entry === '.env' || entry.startsWith('.env.')) {
    rmSync(join(standaloneDir, entry), { recursive: true, force: true });
  }
}

for (const forbidden of [...localOnlyRoots, '.env.local']) {
  if (existsSync(join(standaloneDir, forbidden))) {
    throw new Error(`Standalone output contains forbidden path: ${forbidden}`);
  }
}

console.log('Standalone static assets synced.');
