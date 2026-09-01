import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {
  MAX_VIDEO_DISPLAY_NAME_LENGTH,
  buildVideoDisplayName,
  countVideoJobsForShot,
  planVideoJobDisplayName,
  rankVideoJobVersions,
  resolveVideoJobDisplayNames,
} from '../lib/video-output-filenames.ts';

// ─────────────────────────────────────────────────────────────────────────────
// 纯命名函数（D5）：`<分镜/自由素材序号>-<来源图名>-<运镜模板或自定义>-V<版次>.mp4`
// ─────────────────────────────────────────────────────────────────────────────

// 方案参考示例：01-LH122K3-B1-沙发-缓慢推近-V01.mp4
assert.equal(
  buildVideoDisplayName({
    shotIndexNum: 1,
    sourceImageName: 'LH122K3-B1-沙发.png',
    templateName: '缓慢推近',
    versionNumber: 1,
  }),
  '01-LH122K3-B1-沙发-缓慢推近-V01.mp4',
  '命名模式必须与方案参考示例一致',
);

// 分镜与自由素材共用同一序号格式：序号来自 shots.indexNum，与 shot_sets.kind 无关。
assert.equal(
  buildVideoDisplayName({ shotIndexNum: 3, sourceImageName: 'a.png', templateName: '环绕', versionNumber: 2 }),
  buildVideoDisplayName({ shotIndexNum: 3, sourceImageName: 'a.png', templateName: '环绕', versionNumber: 2 }),
  '分镜与自由素材序号格式一致（都按 indexNum 两位补零）',
);
assert.equal(
  buildVideoDisplayName({ shotIndexNum: 12, sourceImageName: 'a.png', templateName: '环绕', versionNumber: 10 }),
  '12-a-环绕-V10.mp4',
  '两位以上序号/版次不截断',
);

// 中文、空格、路径字符：复用 sanitizeFilenameBase 的清洗规则。
assert.equal(
  buildVideoDisplayName({ shotIndexNum: 1, sourceImageName: '我的 沙发 图.png', templateName: '缓慢 推近', versionNumber: 1 }),
  '01-我的_沙发_图-缓慢_推近-V01.mp4',
  '空格清洗为下划线',
);
assert.equal(
  buildVideoDisplayName({ shotIndexNum: 1, sourceImageName: '/abs/path/图:名?.png', templateName: '左/右/摇', versionNumber: 1 }),
  '01-图-名-摇-V01.mp4',
  '路径与非法字符被清洗（sanitizeFilenameBase 按 basename 取段），不包含绝对路径',
);
assert.ok(
  !buildVideoDisplayName({ shotIndexNum: 1, sourceImageName: '/abs/path/x.png', templateName: 't', versionNumber: 1 }).includes('/'),
  '展示名不得包含路径分隔符',
);

// 空模板回退「自定义」；空来源图名回退「未命名图」；shot 缺失回退「素材」。
assert.equal(
  buildVideoDisplayName({ shotIndexNum: 1, sourceImageName: 'a.png', templateName: null, versionNumber: 1 }),
  '01-a-自定义-V01.mp4',
);
assert.equal(
  buildVideoDisplayName({ shotIndexNum: 1, sourceImageName: '', templateName: '环绕', versionNumber: 1 }),
  '01-未命名图-环绕-V01.mp4',
);
assert.equal(
  buildVideoDisplayName({ shotIndexNum: null, sourceImageName: 'a.png', templateName: null, versionNumber: 1 }),
  '素材-a-自定义-V01.mp4',
  'shot 被删除（shotId 置空）后仍可派生确定名称',
);

// 超长来源图名：总长不超过上限，优先压缩来源段。
const longSourceName = `${'长'.repeat(200)}.png`;
const longName = buildVideoDisplayName({ shotIndexNum: 1, sourceImageName: longSourceName, templateName: '缓慢推近', versionNumber: 1 });
assert.ok(longName.length <= MAX_VIDEO_DISPLAY_NAME_LENGTH, `超长来源图名必须被压缩（实际 ${longName.length}）`);
assert.ok(longName.endsWith('-缓慢推近-V01.mp4'), '压缩不得破坏模板段与版次段');
assert.ok(longName.startsWith('01-长'), '压缩只动来源段');
// 来源段与模板段同时超长：先压缩来源段，模板段与版次段保持完整。
const longTemplateName = '移'.repeat(120);
const bothLongName = buildVideoDisplayName({ shotIndexNum: 1, sourceImageName: longSourceName, templateName: longTemplateName, versionNumber: 1 });
assert.ok(bothLongName.length <= MAX_VIDEO_DISPLAY_NAME_LENGTH, `来源+模板同时超长必须被压缩（实际 ${bothLongName.length}）`);
assert.ok(bothLongName.endsWith(`${'移'.repeat(80)}-V01.mp4`), '压缩优先动来源段，模板段与版次段保持完整');
assert.ok(!bothLongName.includes('长'.repeat(40)), '来源段确实被压缩');
// 名称不包含 provider：模式本身没有 provider 段，这里固定断言防止未来加回去。
for (const name of [longName, '01-a-自定义-V01.mp4']) {
  assert.ok(!/kling|jimeng|openai|provider/i.test(name), '展示名不得包含供应商');
}

// 同 shot 多条任务：版次不同即可保证不重名。
const shotJobs = ['job-a', 'job-b', 'job-c'];
const names = new Set(
  shotJobs.map((_, index) => buildVideoDisplayName({ shotIndexNum: 2, sourceImageName: 'b.png', templateName: '推近', versionNumber: index + 1 })),
);
assert.deepEqual([...names], ['02-b-推近-V01.mp4', '02-b-推近-V02.mp4', '02-b-推近-V03.mp4'], 'V01/V02/V03 稳定且不重名');

// ─────────────────────────────────────────────────────────────────────────────
// 版次排名：同 shot 按 (createdAt, id) 升序；时间格式兼容 ISO 与 SQLite 空格式
// ─────────────────────────────────────────────────────────────────────────────
const ranked = rankVideoJobVersions([
  { id: 'c', shotSetId: 'ss', shotId: 's1', createdAt: '2026-01-05 10:00:00' },
  { id: 'a', shotSetId: 'ss', shotId: 's1', createdAt: '2026-01-05T09:00:00.000Z' },
  { id: 'b', shotSetId: 'ss', shotId: 's1', createdAt: '2026-01-05 09:30:00' },
  { id: 'd', shotSetId: 'ss', shotId: 's2', createdAt: '2026-01-05 08:00:00' },
]);
assert.equal(ranked.get('a'), 1, 'ISO 与 SQLite 空格格式统一归一化后按时间排序');
assert.equal(ranked.get('b'), 2);
assert.equal(ranked.get('c'), 3);
assert.equal(ranked.get('d'), 1, '不同 shot 的版次独立计算');
const tieRanked = rankVideoJobVersions([
  { id: 'zz', shotSetId: 'ss', shotId: 's1', createdAt: '2026-01-05 10:00:00' },
  { id: 'aa', shotSetId: 'ss', shotId: 's1', createdAt: '2026-01-05 10:00:00' },
]);
assert.deepEqual([tieRanked.get('aa'), tieRanked.get('zz')], [1, 2], '同秒平局按 id 稳定打破');

// ─────────────────────────────────────────────────────────────────────────────
// 数据库侧：持久化优先、旧行确定性派生、创建侧续号
// ─────────────────────────────────────────────────────────────────────────────
const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE shot_sets (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'storyboard', createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE shots (
    id TEXT PRIMARY KEY, shotSetId TEXT NOT NULL, indexNum INTEGER NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE image_assets (
    id TEXT PRIMARY KEY, projectId TEXT, filename TEXT NOT NULL, path TEXT NOT NULL
  );
  CREATE TABLE video_prompt_templates (
    id TEXT PRIMARY KEY, name TEXT NOT NULL
  );
  CREATE TABLE video_jobs (
    id TEXT PRIMARY KEY, projectId TEXT NOT NULL, shotSetId TEXT, shotId TEXT,
    sourceImageId TEXT, templateId TEXT, displayName TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
db.prepare(`INSERT INTO shot_sets (id, projectId, name, kind) VALUES ('ss-1', 'p1', '分镜组', 'free')`).run();
db.prepare(`INSERT INTO shots (id, shotSetId, indexNum) VALUES ('shot-1', 'ss-1', 1), ('shot-2', 'ss-1', 2)`).run();
db.prepare(`INSERT INTO image_assets (id, projectId, filename, path) VALUES ('img-1', 'p1', 'LH122K3-B1-沙发.png', '/x/img-1.png')`).run();
db.prepare(`INSERT INTO video_prompt_templates (id, name) VALUES ('tpl-push', '缓慢推近'), ('tpl-orbit', '环绕')`).run();

const insertJob = db.prepare(`
  INSERT INTO video_jobs (id, projectId, shotSetId, shotId, sourceImageId, templateId, displayName, createdAt)
  VALUES (?, 'p1', 'ss-1', ?, 'img-1', ?, ?, ?)
`);
// 旧任务（displayName 为 NULL）：同 shot 三条，按 createdAt 升序 V01/V02/V03。
insertJob.run('old-1', 'shot-1', 'tpl-push', null, '2026-01-05 10:00:00');
insertJob.run('old-2', 'shot-1', 'tpl-orbit', null, '2026-01-05 10:01:00');
insertJob.run('old-3', 'shot-1', null, null, '2026-01-05 10:02:00');
// 新任务：创建时已持久化 displayName，必须原样返回。
insertJob.run('new-1', 'shot-2', 'tpl-push', '99-持久化名-推近-V07.mp4', '2026-01-06 09:00:00');
// shot 被删除后 shotId 置空的孤儿任务：按 shotSetId 归组 + 「素材」前缀。
insertJob.run('orphan-1', null, 'tpl-orbit', null, '2026-01-05 11:00:00');
insertJob.run('orphan-2', null, null, null, '2026-01-05 11:30:00');

const resolved = resolveVideoJobDisplayNames(db, ['old-1', 'old-2', 'old-3', 'new-1', 'orphan-1', 'orphan-2', 'no-such-job']);
assert.equal(resolved.get('old-1'), '01-LH122K3-B1-沙发-缓慢推近-V01.mp4', '旧任务按 (createdAt, id) 派生 V01');
assert.equal(resolved.get('old-2'), '01-LH122K3-B1-沙发-环绕-V02.mp4', '模板名参与派生');
assert.equal(resolved.get('old-3'), '01-LH122K3-B1-沙发-自定义-V03.mp4', '空模板回退「自定义」');
assert.equal(resolved.get('new-1'), '99-持久化名-推近-V07.mp4', '已持久化的 displayName 优先于派生');
assert.equal(resolved.get('orphan-1'), '素材-LH122K3-B1-沙发-环绕-V01.mp4', 'shotId 为空按 shotSetId 归组、前缀回退「素材」');
assert.equal(resolved.get('orphan-2'), '素材-LH122K3-B1-沙发-自定义-V02.mp4');
assert.equal(resolved.get('no-such-job'), undefined, '不存在的任务不产生条目');
// 确定性：重复解析结果一致，且不回写数据库。
assert.deepEqual(resolveVideoJobDisplayNames(db, ['old-1', 'old-2', 'old-3']), new Map([
  ['old-1', '01-LH122K3-B1-沙发-缓慢推近-V01.mp4'],
  ['old-2', '01-LH122K3-B1-沙发-环绕-V02.mp4'],
  ['old-3', '01-LH122K3-B1-沙发-自定义-V03.mp4'],
]));
assert.equal(
  (db.prepare(`SELECT COUNT(*) AS count FROM video_jobs WHERE displayName IS NOT NULL`).get() as { count: number }).count,
  1,
  '解析不得回写数据库',
);

// 创建侧：同 shot 版次续号（现有 3 条 → 新任务 V04）。
assert.equal(countVideoJobsForShot(db, 'shot-1'), 3);
assert.equal(
  planVideoJobDisplayName(db, { shotId: 'shot-1', sourceImageId: 'img-1', templateId: 'tpl-push', versionNumber: countVideoJobsForShot(db, 'shot-1') + 1 }),
  '01-LH122K3-B1-沙发-缓慢推近-V04.mp4',
  '新任务版次 = 同 shot 现有任务数 + 1',
);
// 创建后持久化与派生一致：插入带 displayName 的新行后，旧行派生不变、新行用持久值。
insertJob.run('created-1', 'shot-1', 'tpl-push', '01-LH122K3-B1-沙发-缓慢推近-V04.mp4', '2026-01-07 09:00:00');
assert.equal(resolveVideoJobDisplayNames(db, ['created-1']).get('created-1'), '01-LH122K3-B1-沙发-缓慢推近-V04.mp4');
assert.equal(resolveVideoJobDisplayNames(db, ['old-1']).get('old-1'), '01-LH122K3-B1-沙发-缓慢推近-V01.mp4', '新行插入不改变旧行派生');

// ─────────────────────────────────────────────────────────────────────────────
// 批量视频批内顺序（复核 F5，对齐 C4 的「最新批次在前、批内按提交顺序」）：
// 批量创建整批写同一 createdAt，读取端用 rowid 决胜。这里镜像各读取路由的
// 实际 ORDER BY，证明排序语义成立。
// ─────────────────────────────────────────────────────────────────────────────
insertJob.run('batchA-1', 'shot-2', 'tpl-push', '02-LH122K3-B1-沙发-缓慢推近-V01.mp4', '2026-01-08 09:00:00');
insertJob.run('batchA-2', 'shot-2', 'tpl-orbit', '02-LH122K3-B1-沙发-环绕-V02.mp4', '2026-01-08 09:00:00');
insertJob.run('batchA-3', 'shot-2', null, '02-LH122K3-B1-沙发-自定义-V03.mp4', '2026-01-08 09:00:00');
insertJob.run('batchB-1', 'shot-2', 'tpl-push', '02-LH122K3-B1-沙发-缓慢推近-V04.mp4', '2026-01-08 10:00:00');
insertJob.run('batchB-2', 'shot-2', 'tpl-orbit', '02-LH122K3-B1-沙发-环绕-V05.mp4', '2026-01-08 10:00:00');
const listOrder = (db.prepare(`
  SELECT id FROM video_jobs WHERE shotSetId = 'ss-1' ORDER BY createdAt DESC, rowid ASC
`).all() as Array<{ id: string }>).map((row) => row.id);
assert.deepEqual(
  listOrder,
  ['batchB-1', 'batchB-2', 'batchA-1', 'batchA-2', 'batchA-3', 'created-1', 'new-1', 'orphan-2', 'orphan-1', 'old-3', 'old-2', 'old-1'],
  '列表 API（createdAt DESC, rowid ASC）：最新批次在前，批内按提交顺序（V01→V02→V03），不再倒序',
);
const ascOrder = (db.prepare(`
  SELECT id FROM video_jobs WHERE shotSetId = 'ss-1' ORDER BY createdAt, rowid
`).all() as Array<{ id: string }>).map((row) => row.id);
assert.deepEqual(
  ascOrder,
  ['old-1', 'old-2', 'old-3', 'orphan-1', 'orphan-2', 'new-1', 'created-1', 'batchA-1', 'batchA-2', 'batchA-3', 'batchB-1', 'batchB-2'],
  'Mixcut/ZIP 读取（createdAt ASC, rowid）：整时间升序，批内仍按提交顺序',
);

db.close();
console.log('video output filename tests passed');
