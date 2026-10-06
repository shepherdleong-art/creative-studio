import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CORE_DB_MIGRATIONS } from '../lib/db-migrations.ts';
import { importFontFavorites, isFontFamily, listFontFavorites, setFontFavorite } from '../lib/font-favorites.ts';
import { createFontFavoritesStore } from '../components/font-favorites-store.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'font-favorites-'));
const file = path.join(root, 'prefs.db');
let db = new Database(file);
const migration = CORE_DB_MIGRATIONS.find((sql) => sql.includes('CREATE TABLE IF NOT EXISTS font_favorites'))!;
assert.ok(migration, '必须通过追加 core migration 建表');
db.exec(migration);
const secondConnection = new Database(file);
try {
  const request = async (body?: object): Promise<string[]> => {
    const input = body as { action?: string; favorites?: string[]; family?: string; favorite?: boolean } | undefined;
    if (input?.action === 'import') return importFontFavorites(db, input.favorites!);
    if (input?.action === 'set') return setFontFavorite(db, input.family!, input.favorite!);
    return listFontFavorites(db);
  };
  const makeClient = (cache: string[] = []) => createFontFavoritesStore({ request, readCache: () => cache, writeCache: () => {} });
  const taskA = makeClient(['钉钉进步体', 'Arial', 'arial']);
  const taskB = makeClient(); // 独立地址/浏览器缓存，通过同一工作台共享。
  await taskA.refresh();
  await taskB.refresh();
  assert.deepEqual(taskB.getSnapshot().favorites, ['钉钉进步体', 'Arial']);
  assert.deepEqual(listFontFavorites(secondConnection), ['钉钉进步体', 'Arial']);

  await Promise.all([taskA.toggleFavorite('Noto Sans'), taskB.toggleFavorite('宋体')]);
  await taskA.refresh();
  assert.equal(taskA.getSnapshot().favorites.length, 4, '两个窗口同时收藏不同字体不得互相覆盖');
  assert.ok(taskA.getSnapshot().favorites.includes('宋体'));
  await taskA.toggleFavorite('Ａｒｉａｌ');
  await taskB.refresh();
  assert.ok(!taskB.getSnapshot().favorites.includes('Arial'));

  const oldBrowser = makeClient(['Arial', '旧浏览器收藏']);
  await oldBrowser.refresh();
  assert.ok(!oldBrowser.getSnapshot().favorites.includes('Arial'), '已取消的字体不能被旧缓存重新迁入');
  assert.ok(oldBrowser.getSnapshot().favorites.includes('旧浏览器收藏'));

  await Promise.all([taskA.toggleFavorite('快速点击'), taskA.toggleFavorite('快速点击')]);
  assert.ok(!taskA.getSnapshot().favorites.includes('快速点击'), '连续两次点击最终应取消收藏');
  assert.ok(!listFontFavorites(db).includes('快速点击'));

  let fail = false;
  const client = createFontFavoritesStore({
    request: async (body) => { if (fail) throw new Error('offline'); return request(body); },
    readCache: () => [], writeCache: () => {},
  });
  await client.refresh();
  fail = true;
  await client.toggleFavorite('保存失败的字体');
  assert.match(client.getSnapshot().error, /未保存/);
  assert.ok(!client.getSnapshot().favorites.includes('保存失败的字体'), '保存失败应回滚乐观状态');
  fail = false;
  await client.toggleFavorite('保存失败的字体');
  assert.equal(client.getSnapshot().error, '');
  assert.ok(listFontFavorites(db).includes('保存失败的字体'));

  const expected = listFontFavorites(db);
  db.close();
  db = new Database(file);
  db.exec(migration);
  assert.deepEqual(listFontFavorites(db), expected, '重启与重复迁移不丢收藏');
  assert.equal(isFontFamily('正常字体'), true);
  for (const invalid of ['', ' ', 'x'.repeat(201), 'a\u0000b', null, []]) assert.equal(isFontFamily(invalid), false);
} finally {
  secondConnection.close();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log('font favorites tests passed');
