import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncPackagingAssets } from './sync-packaging-assets.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packaging-assets-'));
const out = path.join(root, 'standalone');
try {
  for (const name of ['package.json', 'package-lock.json', 'package-video.mjs', 'win-hide-spawn.cjs', 'templates/overlay-poster/index.html', 'fonts/a.ttf', 'fonts/user/private.ttf', 'node_modules/hyperframes/bin/hyperframes.mjs', 'runtime/chrome-headless-shell/chrome-headless-shell.exe', 'renders/work/private.json', '.font-scan-cache.json', '.env.local']) {
    const file = path.join(root, 'packaging', name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture');
  }
  fs.mkdirSync(path.join(out, 'packaging/renders'), { recursive: true });
  fs.writeFileSync(path.join(out, 'packaging/renders/old.json'), 'stale');
  syncPackagingAssets(root, out);
  assert.ok(fs.existsSync(path.join(out, 'packaging/templates/overlay-poster/index.html')));
  assert.ok(fs.existsSync(path.join(out, 'packaging/runtime/chrome-headless-shell/chrome-headless-shell.exe')));
  for (const forbidden of ['fonts/user', 'renders', '.font-scan-cache.json', '.env.local']) assert.equal(fs.existsSync(path.join(out, 'packaging', forbidden)), false);
  console.log('Packaging build payload: runtime included, personal fonts/cache/renders/secrets excluded');
} finally {
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(root, { recursive: true, force: true });
}
