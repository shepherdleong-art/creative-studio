// FILM_DESKTOP_FIXTURE=<isolated fixture.json> node scripts/reassembled-film-delivery.windows.test.ts
// Exercises a real NTFS sharing lock after a completed synthetic desktop export.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { archivePriorFilm, deliveryNames } from '../lib/final-edit/reassembled/delivery.ts';
import { sha256 } from '../lib/film-render/files.ts';
import type { FilmBinding } from '../lib/final-edit/reassembled/types.ts';

if (process.platform !== 'win32') console.log('SKIP Windows sharing-lock acceptance');
else {
  const fixture = JSON.parse(fs.readFileSync(process.env.FILM_DESKTOP_FIXTURE!, 'utf8'));
  assert.ok(fixture.root.includes('reassembled-P1-'));
  assert.ok(!fs.existsSync(path.join(fixture.root, 'storage/run/electron-service.json')), 'stop the fixture desktop first');
  const db = new Database(path.join(fixture.root, 'data/workbench.db'), { readonly: true });
  try {
    const binding = db.prepare('SELECT * FROM final_edit_film_bindings WHERE id=?').get(fixture.bindingId) as FilmBinding;
    assert.ok(binding.deliveryVersion >= 2);
    const previous = deliveryNames(binding.baseName, binding.deliveryVersion - 1);
    const latest = deliveryNames(binding.baseName, binding.deliveryVersion);
    const latestVideo = path.join(binding.deliveryDir, latest.videoFilename);
    const latestHash = sha256(latestVideo);
    const archived = path.join(binding.deliveryDir, '旧版', previous.videoFilename);
    const old = path.join(binding.deliveryDir, previous.videoFilename);
    const archivedHash = sha256(archived);
    assert.ok(!fs.existsSync(old));
    fs.copyFileSync(archived, old, fs.constants.COPYFILE_EXCL);
    const code = '$f = [System.IO.File]::Open($env:FILM_LOCK_FILE, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read); try { [Console]::WriteLine("LOCKED"); [Console]::Out.Flush(); Start-Sleep -Seconds 30 } finally { $f.Dispose() }';
    const child = spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], {
      windowsHide: true, env: { ...process.env, FILM_LOCK_FILE: old }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = once(child, 'close');
    try {
      const ready = await Promise.race([
        once(child.stdout!, 'data').then(([data]) => String(data)),
        closed.then(() => { throw new Error('Lock helper exited before acquiring the file'); }),
      ]);
      assert.match(ready, /LOCKED/);
      assert.match(archivePriorFilm(db, binding, binding.deliveryVersion)!, /新版已交付/);
      assert.equal(sha256(old), archivedHash, 'locked old file must remain intact');
      assert.equal(sha256(latestVideo), latestHash, 'new delivery must remain intact');
    } finally {
      child.kill(); await closed;
    }
    assert.equal(archivePriorFilm(db, binding, binding.deliveryVersion), null);
    assert.ok(!fs.existsSync(old));
    assert.equal(sha256(archived), archivedHash);
    assert.equal(sha256(latestVideo), latestHash);
    console.log('PASS Windows real file sharing lock preserves old/new films; release and archive retry succeed');
  } finally { db.close(); }
}
