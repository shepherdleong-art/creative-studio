import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const standaloneDir = join(root, '.next', 'standalone');

// fs.cpSync 在 Windows 中文/空格长路径下会原生崩溃（0xC0000005，已实测）：
// 用手写递归复制替代（与 packaging/package-video.mjs 的 copyDir 同款）。
function copyDirRecursive(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source)) {
    const from = join(source, entry);
    const to = join(destination, entry);
    if (statSync(from).isDirectory()) copyDirRecursive(from, to);
    else copyFileSync(from, to);
  }
}

function copyDirectory(source, destination) {
  if (!existsSync(source)) {
    throw new Error(`Missing required build asset directory: ${source}`);
  }
  copyDirRecursive(source, destination);
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

// sharp 的原生运行时在 @img/ 下：.node 依赖同目录的 libvips DLL，
// Next 文件追踪只收录 .node 会漏掉 DLL（ERR_DLOPEN_FAILED），整个 @img 目录强制拷入
copyDirectory(join(root, 'node_modules', '@img'), join(standaloneDir, 'node_modules', '@img'));

// Next output tracing can conservatively copy the project root when a route has
// dynamic filesystem access. Strip local data, credentials and development
// paths even if a stale standalone directory survived from an earlier build.
// 禁入清单单一来源为 scripts/packaging/forbidden-paths.json(与 next.config.ts 等共用)
const forbiddenSpec = JSON.parse(readFileSync(join(root, 'scripts', 'packaging', 'forbidden-paths.json'), 'utf8'));
const localOnlyRoots = forbiddenSpec.core;
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
