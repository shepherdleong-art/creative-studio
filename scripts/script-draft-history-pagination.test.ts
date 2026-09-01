import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listScriptDraftHistoryPage } from '../lib/script-draft-history.ts';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'script-draft-history-pagination-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = tempRoot;

const { closeDb, getDb } = await import('../lib/db.ts');

const db = getDb();
db.prepare(`
  INSERT OR IGNORE INTO providers
    (id, name, baseUrl, apiKeyEnv, apiKey, model, type, enabled)
  VALUES ('pagination-provider', '分页测试供应商', 'http://127.0.0.1:9', '', '', 'test-model', 'openai-compatible', 1)
`).run();
db.prepare(`
  INSERT INTO projects (id, name, providerId, model, prompt)
  VALUES ('pagination-project', '分页测试项目', 'pagination-provider', 'test-model', '')
`).run();

const insertDraft = db.prepare(`
  INSERT INTO script_drafts
    (id, projectId, provider, model, inputSnapshot, outputJson, createdAt)
  VALUES (?, 'pagination-project', 'pagination-provider', 'test-model', '{}', '{}', ?)
`);
// ID 字典序刻意与 createdAt 相反，防止错误实现仅按 id 翻页却碰巧通过。
for (const [id, createdAt] of [
  ['a-newest', '2026-09-01T00:05:00.000Z'],
  ['z-second', '2026-09-01T00:04:00.000Z'],
  ['b-third', '2026-09-01T00:03:00.000Z'],
  ['y-fourth', '2026-09-01T00:02:00.000Z'],
  ['c-oldest', '2026-09-01T00:01:00.000Z'],
] as const) {
  insertDraft.run(id, createdAt);
}

async function listPage(cursor = ''): Promise<{
  ids: string[];
  nextCursor: string | null;
}> {
  const body = listScriptDraftHistoryPage(db, {
    projectId: 'pagination-project',
    cursor,
    limit: 2,
  });
  return {
    ids: body.drafts.map((draft) => draft.id),
    nextCursor: body.nextCursor,
  };
}

try {
  const first = await listPage();
  const second = await listPage(first.nextCursor || '');
  const third = await listPage(second.nextCursor || '');

  assert.deepEqual(first.ids, ['a-newest', 'z-second']);
  assert.deepEqual(second.ids, ['b-third', 'y-fourth']);
  assert.deepEqual(third.ids, ['c-oldest']);
  assert.equal(third.nextCursor, null);
  assert.deepEqual(
    [...first.ids, ...second.ids, ...third.ids],
    ['a-newest', 'z-second', 'b-third', 'y-fourth', 'c-oldest'],
    '按 createdAt DESC, id DESC 跨页时不得重复或遗漏脚本草稿',
  );
} finally {
  closeDb();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log('script-draft-history-pagination.test.ts: ok');
