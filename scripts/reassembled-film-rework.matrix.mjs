// P2_TEMPLATE_IDS=overlay-journal,overlay-minimal,overlay-variety to resume a subset.
// FILM_MATRIX_SYNTHETIC_ROOT points at verified synthetic fixed-render output.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const synthetic = path.resolve(process.env.FILM_MATRIX_SYNTHETIC_ROOT);
const parent = path.resolve('outputs/2026-10-19-p2'); fs.mkdirSync(parent, { recursive: true });
const root = fs.mkdtempSync(path.join(parent, 'domain-matrix-'));
const templates = (process.env.P2_TEMPLATE_IDS || 'overlay-poster,overlay-journal,overlay-minimal,overlay-variety').split(',');
const results = [];
function run(script, env, file) {
  const fd = fs.openSync(file, 'wx');
  let child;
  try { child = spawnSync(process.execPath, [script], { cwd: process.cwd(), env, windowsHide: true, stdio: ['ignore', fd, fd], timeout: 900000 }); }
  finally { fs.closeSync(fd); }
  assert.equal(child.error, undefined, `${file}: ${child.error}`);
  assert.equal(child.status, 0, `See ${file}`);
}
console.log(`P2_MATRIX_ROOT=${root}`);
for (const template of templates) {
  assert.ok(['overlay-poster', 'overlay-journal', 'overlay-minimal', 'overlay-variety'].includes(template));
  const directory = path.join(root, template); fs.mkdirSync(directory);
  const env = { ...process.env, FILM_IMPORT_SPEC: path.join(synthetic, 'variants/01/renders', template + '-first/spec.json'), FILM_INTEGRATION_PARENT: directory, FILM_INTEGRATION_RENDER: '0' };
  console.log(`START ${template}`);
  run('scripts/reassembled-film.integration.test.ts', env, path.join(directory, 'import.log'));
  const fixtures = fs.readdirSync(directory).filter(name => name.startsWith('reassembled-P1-'));
  assert.equal(fixtures.length, 1);
  const fixtureRoot = path.join(directory, fixtures[0]);
  run('scripts/reassembled-film-rework.test.ts', { ...env, FILM_P2_FIXTURE: path.join(fixtureRoot, 'fixture.json'), FILM_P2_RENDER: '1' }, path.join(directory, 'rework.log'));
  const result = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'p2-service-result.json'), 'utf8'));
  assert.equal(result.ok, true); assert.equal(result.rendered, true);
  results.push({ template, fixtureRoot, result });
  fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify({ ok: results.length === templates.length, results }, null, 2));
  console.log(`PASS ${template}`);
}
