import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fixtureProject, repo, treeHash } from './film-render-test-fixture.ts';
import { gateOpening, OPENING_EFFECTS } from '../lib/film-render/gate.ts';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'film-gate-')));
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3.12');
const cases = [
  ...OPENING_EFFECTS.map(effect => ({ name: effect, edit: (t: Record<string, unknown>, r: Record<string, unknown>) => { t.openingEffectId = r.effectId = effect; }, ok: true })),
  { name: 'missing approval', edit: (_t: Record<string, unknown>, r: Record<string, unknown>) => { r.status = 'downloaded'; }, ok: false },
  { name: 'missing review', edit: (_t: Record<string, unknown>, r: Record<string, unknown>) => { r.variant = '02'; }, ok: false },
  { name: 'generic pan', edit: (t: Record<string, unknown>) => { t.openingEffectId = 'pan-left'; }, ok: false },
  { name: 'different effect', edit: (_t: Record<string, unknown>, r: Record<string, unknown>) => { r.effectId = 'magic-growth'; }, ok: false },
  { name: 'different shot', edit: (_t: Record<string, unknown>, r: Record<string, unknown>) => { r.shot = 'S02'; }, ok: false },
  { name: 'different source path', edit: (_t: Record<string, unknown>, r: Record<string, unknown>) => { r.sourceFile = './opening.mp4'; }, ok: false },
  { name: 'replaced file', edit: () => { fs.writeFileSync(path.join(root, 'variants/01/opening.mp4'), 'changed'); }, ok: false },
  { name: 'legacy no hash', edit: (_t: Record<string, unknown>, r: Record<string, unknown>) => { delete r.sha256; }, ok: true },
];
try {
  for (const test of cases) {
    const t = fixtureProject(root);
    const reviewFile = path.join(root, 'review/opening-effects.json');
    const r = JSON.parse(fs.readFileSync(reviewFile, 'utf8')).variants[0];
    test.edit(t, r);
    fs.writeFileSync(path.join(root, 'variants/01/timeline.json'), JSON.stringify(t));
    fs.writeFileSync(reviewFile, JSON.stringify({ variants: [r] }));
    const before = treeHash(root);
    let actual;
    try { actual = { ok: true, result: gateOpening(root, '01') }; }
    catch { actual = { ok: false }; }
    const oracle = spawnSync(python, ['-c', `import json,sys
sys.path.insert(0, sys.argv[1])
from contract import validate
try:
 r=validate(sys.argv[2], '01'); r.pop('timeline'); print(json.dumps(dict(ok=True,result=r)))
except Exception:
 print(json.dumps(dict(ok=False)))`, path.join(repo, 'scripts/reassembled-film'), root], { encoding: 'utf8', windowsHide: true });
    assert.equal(oracle.status, 0, oracle.stderr);
    assert.deepEqual(actual, JSON.parse(oracle.stdout), test.name);
    assert.equal(actual.ok, test.ok, test.name);
    assert.equal(treeHash(root), before, 'gate must not alter project or review');
  }
  console.log(`film-render gate: ${cases.length} cases match Python contract, read-only hashes unchanged`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
