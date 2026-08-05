import { cpSync, existsSync, mkdirSync } from 'node:fs';
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

// ffmpeg/ffprobe 静态二进制不会被 Next 的文件追踪收录，强制拷入 standalone
for (const pkg of ['ffmpeg-static', 'ffprobe-static']) {
  copyDirectory(join(root, 'node_modules', pkg), join(standaloneDir, 'node_modules', pkg));
}

// Next/NFT may trace the sharp native .node file but omit its adjacent libvips
// DLLs. Copy the installed platform-specific @img packages as one unit. This
// stays cross-platform because npm only installs packages for the build host.
copyDirectory(join(root, 'node_modules', '@img'), join(standaloneDir, 'node_modules', '@img'));

console.log('Standalone static assets synced.');
