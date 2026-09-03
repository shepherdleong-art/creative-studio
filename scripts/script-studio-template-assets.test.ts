import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';

// dataRoot() 在进程启动时解析一次，且 ESM import 会被提升到最前。
// 必须先设置环境变量，再用动态 import 加载业务模块。
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'script-studio-template-assets-'));
process.env.CREATIVE_STUDIO_DATA_ROOT = testRoot;
const { ensureScriptStudioSchemaReady } = await import('../lib/script-studio/schema.ts');
const { importTemplateCatalog } = await import('../lib/script-studio/catalog-service.ts');
const { getCatalogRevisionView } = await import('../lib/script-studio/catalogs.ts');

// 1×1 透明 PNG（白背景）
const PNG_1PX_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function buildTemplateBufferWithImage(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const visualHooks = wb.addWorksheet('开头钩子画面（待优化）');
  visualHooks.addRow(['核心玩法', '裂变玩法', '画面公式', '示例画面', '参考案例', 'AI实现路径', '适合品类', '搭配钩子', '参考口令', null]);
  visualHooks.addRow(['0→1 生成', '快递箱爆炸开场', '[A]→[B]', '', 'AI小特效', '可灵首尾帧', '全品类', '利益式', '试试看', '即梦OK']);
  const imageId = wb.addImage({ buffer: Buffer.from(PNG_1PX_BASE64, 'base64') as unknown as Parameters<typeof wb.addImage>[0]['buffer'], extension: 'png' });
  visualHooks.addImage(imageId, { tl: { col: 3, row: 1 }, ext: { width: 40, height: 40 } });
  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function createBaseDatabase(): Database.Database {
  const db = new Database(path.join(testRoot, 'workbench.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt TEXT NOT NULL DEFAULT (datetime('now')), productCode TEXT DEFAULT '', exportDirName TEXT NOT NULL DEFAULT '');
    CREATE TABLE shot_sets (id TEXT PRIMARY KEY, projectId TEXT NOT NULL, name TEXT NOT NULL, createdAt TEXT NOT NULL, FOREIGN KEY(projectId) REFERENCES projects(id) ON DELETE CASCADE);
  `);
  return db;
}

const db = createBaseDatabase();
const readiness = await ensureScriptStudioSchemaReady({ db, backupRoot: path.join(testRoot, 'backups') });
assert.ok(readiness.state === 'current' || readiness.state === 'ready', `schema 未就绪: ${JSON.stringify(readiness)}`);

try {
  const buffer = await buildTemplateBufferWithImage();
  const outcome = await importTemplateCatalog(db, buffer, '脚本内容框架.xlsx');

  // 1. 修订创建成功，且作为当前版本
  assert.equal(outcome.created, true);
  const view = getCatalogRevisionView(db, outcome.revisionId);
  assert.ok(view);
  assert.equal(view.current, true);

  // 2. 资产行落库，相对路径指向 storage 受管副本
  const assetRows = db.prepare(`SELECT * FROM script_studio_template_assets WHERE revisionId = ?`).all(outcome.revisionId) as Array<{ relativePath: string; contentSha256: string; visualHookId: string }>;
  assert.equal(assetRows.length, 1, '嵌入图片必须提取为资产行');
  const storageRoot = path.resolve(path.join(testRoot, 'storage'));
  const storedPath = path.join(storageRoot, ...assetRows[0]!.relativePath.split('/'));
  assert.ok(storedPath.startsWith(storageRoot + path.sep), '资产路径必须落在 storage 受管目录内');

  // 3. 磁盘副本存在且内容与源图一致
  assert.ok(fs.existsSync(storedPath), '受管副本文件必须落盘');
  const storedBuffer = fs.readFileSync(storedPath);
  const sourceImage = Buffer.from(PNG_1PX_BASE64, 'base64');
  assert.deepEqual(storedBuffer, sourceImage, '副本内容必须与嵌入图片一致');
  assert.equal(assetRows[0]!.contentSha256, crypto.createHash('sha256').update(sourceImage).digest('hex'), '指纹必须与副本内容一致');

  // 4. 修订视图可关联参考图
  const vh = view.visualHookTemplates[0];
  assert.ok(vh);
  assert.equal(vh.assetIds.length, 1, '画面钩子视图必须带参考图 id');

  // 5. 原工作簿缓冲释放/源文件不再需要：副本与 DB 引用自洽（不依赖原 Excel 继续存在）
  buffer.fill(0);
  assert.equal(fs.existsSync(storedPath), true, '源缓冲丢弃后副本仍可用');
  const reread = fs.readFileSync(storedPath);
  assert.deepEqual(reread, sourceImage, '副本内容不随源缓冲变化');
} finally {
  db.close();
  fs.rmSync(testRoot, { recursive: true, force: true });
}

console.log('script-studio-template-assets tests passed');
