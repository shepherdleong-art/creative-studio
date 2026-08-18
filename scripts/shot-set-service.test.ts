import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { FREE_SHOT_SET_NAME, MAX_SHOTS_PER_SET } from '../lib/shot-set-domain.ts';
import {
  appendShotToFreeSet,
  createShotSet,
  deleteShotFromFreeSet,
  deleteShotSet,
  getOrCreateFreeShotSet,
} from '../lib/shot-set-service.ts';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);

    CREATE TABLE image_assets (
      id TEXT PRIMARY KEY, projectId TEXT,
      role TEXT NOT NULL DEFAULT 'input', usage TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE shot_sets (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      name TEXT NOT NULL,
      productCode TEXT DEFAULT '',
      category TEXT DEFAULT '',
      sceneReferenceId TEXT,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','generating','reviewing','approved','video_ready')),
      kind TEXT NOT NULL DEFAULT 'storyboard' CHECK(kind IN ('storyboard','free')),
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE shots (
      id TEXT PRIMARY KEY,
      shotSetId TEXT NOT NULL,
      indexNum INTEGER NOT NULL,
      sourceImageId TEXT NOT NULL,
      FOREIGN KEY (shotSetId) REFERENCES shot_sets(id) ON DELETE CASCADE
    );

    CREATE TABLE video_jobs (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      shotSetId TEXT,
      shotId TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      FOREIGN KEY (shotSetId) REFERENCES shot_sets(id) ON DELETE SET NULL,
      FOREIGN KEY (shotId) REFERENCES shots(id) ON DELETE SET NULL
    );

    INSERT INTO projects (id, name) VALUES ('p1', '项目一'), ('p2', '项目二');
  `);
  const insertImage = db.prepare(`INSERT INTO image_assets (id, projectId) VALUES (?, ?)`);
  for (let i = 0; i < 60; i++) insertImage.run(`p1-img-${i}`, 'p1');
  insertImage.run('p2-img-0', 'p2');
  return db;
}

/* ── 建组:普通组 ── */
{
  const db = freshDb();
  const r = createShotSet(db, { projectId: 'p1', name: '  卧室分镜  ', shotImageIds: ['p1-img-0', 'p1-img-1'] });
  assert.ok(r.ok);
  assert.equal(r.name, '卧室分镜', '名称必须 trim');
  assert.equal(r.kind, 'storyboard');
  const row = db.prepare(`SELECT kind, status FROM shot_sets WHERE id = ?`).get(r.id) as { kind: string; status: string };
  assert.deepEqual(row, { kind: 'storyboard', status: 'draft' });
  assert.deepEqual(
    db.prepare(`SELECT indexNum, sourceImageId FROM shots WHERE shotSetId = ? ORDER BY indexNum`).all(r.id),
    [{ indexNum: 1, sourceImageId: 'p1-img-0' }, { indexNum: 2, sourceImageId: 'p1-img-1' }],
    'shots 必须按选择顺序编号',
  );
}

/* ── 建组:普通组不接受空,自由工位接受空 ── */
{
  const db = freshDb();
  assert.equal(createShotSet(db, { projectId: 'p1', name: 'x', shotImageIds: [] }).ok, false);
  const free = createShotSet(db, { projectId: 'p1', name: '', shotImageIds: [], kind: 'free' });
  assert.ok(free.ok, '自由工位可以先建空的');
  assert.equal(free.name, FREE_SHOT_SET_NAME, '不传名字时用固定名');
  const row = db.prepare(`SELECT kind, status FROM shot_sets WHERE id = ?`).get(free.id) as { kind: string; status: string };
  assert.deepEqual(row, { kind: 'free', status: 'approved' });
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM shots WHERE shotSetId = ?`).get(free.id) as { c: number }).c, 0);
}

/* ── 建组:非法 kind → 400,不留残留 ── */
{
  const db = freshDb();
  const r = createShotSet(db, { projectId: 'p1', name: 'x', shotImageIds: ['p1-img-0'], kind: 'bogus' });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.status, 400);
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM shot_sets`).get() as { c: number }).c, 0, '失败时不得留下半个分镜组');
}

/* ── 建组:跨项目图片 → 400 ── */
{
  const db = freshDb();
  const r = createShotSet(db, { projectId: 'p1', name: 'x', shotImageIds: ['p1-img-0', 'p2-img-0'] });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.status, 400);
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM shot_sets`).get() as { c: number }).c, 0);
}

/* ── 建组:20 / 21 边界,以及自由工位不限张数(D18) ── */
{
  const db = freshDb();
  const tooMany = Array.from({ length: MAX_SHOTS_PER_SET + 1 }, (_, i) => `p1-img-${i}`);
  assert.equal(createShotSet(db, { projectId: 'p1', name: 'x', shotImageIds: tooMany }).ok, false);
  const justEnough = Array.from({ length: MAX_SHOTS_PER_SET }, (_, i) => `p1-img-${i}`);
  assert.equal(createShotSet(db, { projectId: 'p1', name: 'x', shotImageIds: justEnough }).ok, true);
  const fifty = Array.from({ length: 50 }, (_, i) => `p1-img-${i}`);
  assert.equal(
    createShotSet(db, { projectId: 'p1', name: 'f', shotImageIds: fifty, kind: 'free' }).ok,
    true,
    '自由工位不受 20 张上限约束',
  );
}

/* ── 自由工位:单例(D15) ── */
{
  const db = freshDb();
  const a = getOrCreateFreeShotSet(db, 'p1');
  assert.ok(a.ok);
  assert.equal(a.created, true, '第一次调用要建');
  const b = getOrCreateFreeShotSet(db, 'p1');
  assert.ok(b.ok);
  assert.equal(b.created, false, '第二次调用不能再建');
  assert.equal(b.id, a.id, '必须返回同一个工位');
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM shot_sets WHERE kind='free'`).get() as { c: number }).c, 1);

  const duplicate = createShotSet(db, {
    projectId: 'p1',
    name: FREE_SHOT_SET_NAME,
    shotImageIds: [],
    kind: 'free',
  });
  assert.equal(duplicate.ok, false, '通用建组服务也不能绕过自由工位单例');
  assert.equal(duplicate.ok === false && duplicate.status, 409);
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM shot_sets WHERE kind='free'`).get() as { c: number }).c, 1);

  const other = getOrCreateFreeShotSet(db, 'p2');
  assert.ok(other.ok);
  assert.notEqual(other.id, a.id, '不同项目各有各的自由工位');

  assert.equal(getOrCreateFreeShotSet(db, 'nope').ok, false, '项目不存在要 404');
}

/* ── 追加图片 ── */
{
  const db = freshDb();
  const free = getOrCreateFreeShotSet(db, 'p1');
  assert.ok(free.ok);

  const first = appendShotToFreeSet(db, free.id, 'p1-img-0');
  assert.ok(first.ok);
  assert.equal(first.indexNum, 1, '空工位追加的第一张是 1');
  const second = appendShotToFreeSet(db, free.id, 'p1-img-1');
  assert.ok(second.ok);
  assert.equal(second.indexNum, 2, 'indexNum 必须递增');

  // 同一张图可以重复追加(用户可能想用同一张图配不同批运镜)
  assert.equal(appendShotToFreeSet(db, free.id, 'p1-img-0').ok, true);

  // 跨项目图片挡住
  const cross = appendShotToFreeSet(db, free.id, 'p2-img-0');
  assert.equal(cross.ok, false);
  assert.equal(cross.ok === false && cross.status, 400);

  // 空 id 挡住
  assert.equal(appendShotToFreeSet(db, free.id, '  ').ok, false);

  // 普通分镜组不能从这里塞
  const sb = createShotSet(db, { projectId: 'p1', name: 'x', shotImageIds: ['p1-img-5'] });
  assert.ok(sb.ok);
  const rejected = appendShotToFreeSet(db, sb.id, 'p1-img-6');
  assert.equal(rejected.ok, false);
  assert.equal(rejected.ok === false && rejected.status, 400);

  // 工位不存在 → 404
  assert.equal(appendShotToFreeSet(db, 'nope', 'p1-img-0').ok, false);
}

/* ── 删单张图(D21) ── */
{
  const db = freshDb();
  const free = getOrCreateFreeShotSet(db, 'p1');
  assert.ok(free.ok);

  // 没有任何任务 → 可删,并回传 sourceImageId 供调用方清理图片
  const clean = appendShotToFreeSet(db, free.id, 'p1-img-0');
  assert.ok(clean.ok);
  const removed = deleteShotFromFreeSet(db, free.id, clean.shotId);
  assert.ok(removed.ok);
  assert.equal(removed.sourceImageId, 'p1-img-0');
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM shots WHERE id = ?`).get(clean.shotId) as { c: number }).c, 0);

  // 只有 failed / canceled → 仍可删
  for (const discardable of ['failed', 'canceled']) {
    const s2 = appendShotToFreeSet(db, free.id, 'p1-img-1');
    assert.ok(s2.ok);
    db.prepare(`INSERT INTO video_jobs (id, projectId, shotSetId, shotId, status) VALUES (?, 'p1', ?, ?, ?)`)
      .run('j-' + discardable, free.id, s2.shotId, discardable);
    assert.equal(
      deleteShotFromFreeSet(db, free.id, s2.shotId).ok, true,
      `只有 ${discardable} 任务时应该还能删,否则配错供应商试一次就永远删不掉`,
    );
  }

  // succeeded 或任何非终态 → 409,且 shot 必须原封不动
  for (const blocking of ['succeeded', 'pending', 'running', 'needs_check', 'paused']) {
    const s3 = appendShotToFreeSet(db, free.id, 'p1-img-2');
    assert.ok(s3.ok);
    db.prepare(`INSERT INTO video_jobs (id, projectId, shotSetId, shotId, status) VALUES (?, 'p1', ?, ?, ?)`)
      .run('jb-' + blocking, free.id, s3.shotId, blocking);
    const r = deleteShotFromFreeSet(db, free.id, s3.shotId);
    assert.equal(r.ok, false, `${blocking} 必须挡住删除`);
    assert.equal(r.ok === false && r.status, 409);
    assert.equal(
      (db.prepare(`SELECT COUNT(*) c FROM shots WHERE id = ?`).get(s3.shotId) as { c: number }).c, 1,
      '409 之后这张图必须还在',
    );
  }

  // 普通分镜组不允许删单张
  const sb = createShotSet(db, { projectId: 'p1', name: 'x', shotImageIds: ['p1-img-9'] });
  assert.ok(sb.ok);
  const sbShot = db.prepare(`SELECT id FROM shots WHERE shotSetId = ?`).get(sb.id) as { id: string };
  const sbReject = deleteShotFromFreeSet(db, sb.id, sbShot.id);
  assert.equal(sbReject.ok, false);
  assert.equal(sbReject.ok === false && sbReject.status, 400);

  // 工位不存在 / shot 不属于这个工位 → 404
  assert.equal(deleteShotFromFreeSet(db, 'nope', sbShot.id).ok, false);
  const foreign = deleteShotFromFreeSet(db, free.id, sbShot.id);
  assert.equal(foreign.ok, false);
  assert.equal(foreign.ok === false && foreign.status, 404);
}

/* ── 删单张图后,indexNum 不重排 ── */
{
  const db = freshDb();
  const free = getOrCreateFreeShotSet(db, 'p1');
  assert.ok(free.ok);
  const a = appendShotToFreeSet(db, free.id, 'p1-img-0');
  const b = appendShotToFreeSet(db, free.id, 'p1-img-1');
  const c = appendShotToFreeSet(db, free.id, 'p1-img-2');
  assert.ok(a.ok && b.ok && c.ok);
  assert.equal(deleteShotFromFreeSet(db, free.id, b.shotId).ok, true);
  assert.deepEqual(
    db.prepare(`SELECT indexNum FROM shots WHERE shotSetId = ? ORDER BY indexNum`).all(free.id),
    [{ indexNum: 1 }, { indexNum: 3 }],
    '中间空号是有意的:重排会让用户眼前的「图 3」突然变成「图 2」',
  );
  // 删完再加,新号必须继续往后走,不能填回空缺
  const d = appendShotToFreeSet(db, free.id, 'p1-img-3');
  assert.ok(d.ok);
  assert.equal(d.indexNum, 4);
}

/* ── 删组:不存在 → 404 ── */
{
  const db = freshDb();
  const r = deleteShotSet(db, 'nope');
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.status, 404);
}

/* ── 删组:全部终态 → 放行 ── */
{
  const db = freshDb();
  const created = createShotSet(db, { projectId: 'p1', name: 'x', shotImageIds: ['p1-img-0'] });
  assert.ok(created.ok);
  const insertJob = db.prepare(`INSERT INTO video_jobs (id, projectId, shotSetId, status) VALUES (?, 'p1', ?, ?)`);
  insertJob.run('j1', created.id, 'succeeded');
  insertJob.run('j2', created.id, 'failed');
  insertJob.run('j3', created.id, 'canceled');
  assert.equal(deleteShotSet(db, created.id).ok, true, '终态任务不应挡住删除');
  assert.equal((db.prepare(`SELECT COUNT(*) c FROM shot_sets`).get() as { c: number }).c, 0);
}

/* ── 删组:任一非终态 → 409,分镜组必须还在 ── */
for (const activeStatus of ['pending', 'running', 'needs_check', 'paused']) {
  const db = freshDb();
  const created = createShotSet(db, { projectId: 'p1', name: 'x', shotImageIds: ['p1-img-0'] });
  assert.ok(created.ok);
  db.prepare(`INSERT INTO video_jobs (id, projectId, shotSetId, status) VALUES ('j1', 'p1', ?, ?)`).run(created.id, activeStatus);
  const r = deleteShotSet(db, created.id);
  assert.equal(r.ok, false, `${activeStatus} 必须挡住删除`);
  assert.equal(r.ok === false && r.status, 409);
  assert.equal(
    (db.prepare(`SELECT COUNT(*) c FROM shot_sets WHERE id = ?`).get(created.id) as { c: number }).c, 1,
    '409 之后分镜组必须原封不动',
  );
}

console.log('shot-set-service.test.ts OK');
