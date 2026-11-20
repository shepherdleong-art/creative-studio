import fs from 'node:fs';
import path from 'node:path';

/** Tiny frozen resources for orchestration/lifecycle tests; geometry has real-browser tests. */
export function createPackagingLayoutFixture(root: string): string {
  const packaging = path.join(root, 'packaging');
  const write = (file: string, value: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  };
  const chrome = `runtime/chrome-headless-shell/${process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell'}`;
  for (const file of [chrome, 'package-video.mjs', 'auto-layout/runtime.js', 'auto-layout/replay.js',
    'stickers/runtime.js', 'fonts/shared.ttf']) write(path.join(packaging, file), `fixture:${file}`);
  write(path.join(packaging, 'win-hide-spawn.cjs'), '');
  fs.copyFileSync(new URL('../packaging/layout-service.mjs', import.meta.url), path.join(packaging, 'layout-service.mjs'));
  write(path.join(packaging, 'node_modules/hyperframes/package.json'), '{"version":"0.8.134"}');
  write(path.join(packaging, 'stickers/catalog.json'), '{"assets":[]}');
  write(path.join(packaging, 'templates/overlay-poster/index.html'), '<html><head></head><body></body></html>');
  write(path.join(root, 'storage/packaging/fonts/user-point-test.ttf'), 'private user font');
  return packaging;
}
