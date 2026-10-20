// Windows P1 actual desktop matrix, local synthetic media only.
// FILM_MATRIX_SYNTHETIC_ROOT: successful film-render-overlay.e2e.test.ts output (all four templates).
// FILM_MATRIX_PORTABLE_ROOT: previously assembled QA portable package; no automatic build/download.
// FILM_MATRIX_ROOT: existing parent for a new isolated evidence directory.
// FILM_MATRIX_WAIT_BASELINE=1: allow the baseline renderer to finish each template while this matrix runs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

assert.equal(process.platform, 'win32', 'This acceptance matrix requires Windows');
for (const key of ['FILM_MATRIX_SYNTHETIC_ROOT', 'FILM_MATRIX_PORTABLE_ROOT', 'FILM_MATRIX_ROOT']) assert.ok(process.env[key], `Set ${key}`);
const synthetic = path.resolve(process.env.FILM_MATRIX_SYNTHETIC_ROOT);
const portable = path.resolve(process.env.FILM_MATRIX_PORTABLE_ROOT);
assert.ok(fs.existsSync(path.join(portable, 'node-runtime/node.exe')));
assert.ok(fs.existsSync(path.join(portable, 'node_modules/electron/dist/electron.exe')));
const templates = ['overlay-poster', 'overlay-journal', 'overlay-minimal', 'overlay-variety'];
const baselineFile = path.join(synthetic, 'results.json');
if (process.env.FILM_MATRIX_WAIT_BASELINE !== '1') {
  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  assert.deepEqual(baseline.map(row => row.template).sort(), [...templates].sort());
}
const root = fs.mkdtempSync(path.join(path.resolve(process.env.FILM_MATRIX_ROOT), 'matrix-'));
console.log(`MATRIX_ROOT=${root}`);
const results = [];
const cleanEnv = { ...process.env };
for (const name of Object.keys(cleanEnv)) if (/^FILM_(DESKTOP_|INTEGRATION_|EXPECT_TEMPLATE)/.test(name)) delete cleanEnv[name];
function run(script, env, logFile) {
  const fd = fs.openSync(logFile, 'wx');
  let child;
  try { child = spawnSync(process.execPath, [script], { cwd: process.cwd(), env, windowsHide: true, stdio: ['ignore', fd, fd], timeout: 20 * 60_000 }); }
  finally { fs.closeSync(fd); }
  assert.equal(child.error, undefined, `${script}: ${child.error?.message}; see ${logFile}`);
  assert.equal(child.status, 0, `${script} failed (${child.status}); see ${logFile}`);
}
for (const mode of ['source', 'portable']) for (const [index, template] of templates.entries()) {
  const deadline = Date.now() + 10 * 60_000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    try { ready = JSON.parse(fs.readFileSync(baselineFile, 'utf8')).some(row => row.template === template); }
    catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (!ready) {
      assert.equal(process.env.FILM_MATRIX_WAIT_BASELINE, '1', `Missing baseline ${template}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  assert.ok(ready, `Baseline timed out: ${template}`);
  const name = `${mode[0]}${'ABCD'[index]}`;
  const directory = path.join(root, name); fs.mkdirSync(directory);
  const spec = path.join(synthetic, 'variants/01/renders', `${template}-first/spec.json`);
  assert.equal(JSON.parse(fs.readFileSync(spec, 'utf8')).template.id, template);
  const env = { ...cleanEnv, FILM_IMPORT_SPEC: spec, FILM_INTEGRATION_PARENT: directory, FILM_EXPECT_TEMPLATE: template };
  console.log(`START ${mode} ${template}`);
  run('scripts/reassembled-film.integration.test.ts', env, path.join(directory, 'integration.log'));
  const fixtureRoots = fs.readdirSync(directory).filter(name => name.startsWith('reassembled-P1-'));
  assert.equal(fixtureRoots.length, 1);
  const fixture = path.join(directory, fixtureRoots[0], 'fixture.json');
  const evidence = path.join(directory, 'desktop');
  run('scripts/reassembled-film.desktop.test.mjs', { ...env, FILM_DESKTOP_FIXTURE: fixture, FILM_DESKTOP_EVIDENCE: evidence,
    ...(mode === 'portable' ? { FILM_DESKTOP_APP_ROOT: portable } : {}) }, path.join(directory, 'desktop.log'));
  const result = JSON.parse(fs.readFileSync(path.join(evidence, 'desktop-result.json'), 'utf8'));
  const cleanup = JSON.parse(fs.readFileSync(path.join(evidence, 'cleanup.json'), 'utf8'));
  assert.equal(result.ok, true); assert.equal(result.template.id, template);
  assert.equal(result.technicalChecks, 12); assert.equal(result.fromVersion, 2); assert.equal(result.toVersion, 3);
  assert.equal(cleanup.exitCode, 0); assert.equal(cleanup.stateCleared, true);
  results.push({ mode, template, evidence, fixture, checks: result.technicalChecks, video: result.video, deliveredVideo: result.deliveredVideo, cleanup });
  fs.writeFileSync(path.join(root, 'matrix-results.json'), JSON.stringify({ ok: results.length === 8, synthetic, portable, results }, null, 2));
  console.log(`PASS ${mode} ${template}: v2 → v3, 12/12 checks, frozen template/audio/subtitles, playback and clean exit`);
}
console.log(`PASS all eight desktop runs; ${path.join(root, 'matrix-results.json')}`);
