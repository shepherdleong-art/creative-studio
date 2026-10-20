// CONTENT_TEMPLATE_IDS controls subsets; classic needs FILM_CONTENT_CLASSIC_SPEC.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const synthetic = path.resolve(process.env.FILM_MATRIX_SYNTHETIC_ROOT);
const parent = path.resolve('outputs/2026-10-19-complete'); fs.mkdirSync(parent, { recursive: true });
const root = fs.mkdtempSync(path.join(parent, 'content-matrix-'));
const templates = (process.env.CONTENT_TEMPLATE_IDS || 'classic,overlay-poster,overlay-journal,overlay-minimal,overlay-variety').split(',');
const results = [];
function run(script, env, file) {
  const fd = fs.openSync(file, 'wx'); let child;
  try { child = spawnSync(process.execPath, [script], { cwd: process.cwd(), env, windowsHide: true, stdio: ['ignore', fd, fd], timeout: 900000 }); }
  finally { fs.closeSync(fd); }
  assert.equal(child.error, undefined, `${file}: ${child.error}`); assert.equal(child.status, 0, `See ${file}`);
}
console.log(`CONTENT_MATRIX_ROOT=${root}`);
for (const template of templates) {
  assert.ok(['classic', 'overlay-poster', 'overlay-journal', 'overlay-minimal', 'overlay-variety'].includes(template));
  const directory = path.join(root, template); fs.mkdirSync(directory);
  const spec = template === 'classic' ? process.env.FILM_CONTENT_CLASSIC_SPEC : path.join(synthetic, 'variants/01/renders', template + '-first/spec.json');
  assert.ok(spec && fs.existsSync(spec));
  const env = { ...process.env, FILM_IMPORT_SPEC: spec, FILM_INTEGRATION_PARENT: directory, FILM_INTEGRATION_RENDER: '0' };
  console.log(`START ${template}`); run('scripts/reassembled-film.integration.test.ts', env, path.join(directory, 'import.log'));
  const fixtures = fs.readdirSync(directory).filter(name => name.startsWith('reassembled-P1-')); assert.equal(fixtures.length, 1);
  const fixtureRoot = path.join(directory, fixtures[0]);
  run('scripts/reassembled-film-content.integration.test.ts', { ...env, FILM_CONTENT_FIXTURE: path.join(fixtureRoot, 'fixture.json'), FILM_CONTENT_RENDER: '1' }, path.join(directory, 'content.log'));
  const result = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'content-service-result.json'), 'utf8')); assert.equal(result.ok, true);
  results.push({ template, fixtureRoot, result }); fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify({ ok: results.length === templates.length, results }, null, 2));
  console.log(`PASS ${template}`);
}
