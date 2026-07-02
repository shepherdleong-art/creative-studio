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

console.log('Standalone static assets synced.');