// 执行清单卡 5 的固定改动：实拍混剪不关联工作台项目。
// 新增任务模块 lib/live-mixcut/projects.ts；把复制来的代码里读 projects 表、项目导出身份的 4 处改成读任务；用量记账不再挂项目。
// 只跑一次；原文对不上就整体停下。用法：node scripts/live-mixcut-port/card5-edits.mjs
import fs from 'node:fs';

const PROJECTS_MODULE = `import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { formatShanghaiTaskDate, sanitizeExportFilenamePart } from '../media-core/export-identity.ts';
import { BatchDomainError } from './errors.ts';
import { createBatchProduction } from './versions.ts';

/**
 * 实拍混剪的"任务"。复制来的代码处处用 projectId，指的就是这里的 id，和工作台的 projects 表无关。
 * 一个任务只有一个批次（batchId）。
 */
export interface LiveMixcutProject {
  id: string;
  name: string;
  productName: string;
  exportDirName: string;
  batchId: string;
  createdAt: string;
  updatedAt: string;
}

const NAME_LIMIT = 80;
const COLUMNS = 'id, name, productName, exportDirName, batchId, createdAt, updatedAt';

function cleanName(value: unknown, label: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > NAME_LIMIT || /[\\u0000-\\u001f\\u007f]/.test(text)) {
    throw new BatchDomainError('invalid_input', \`\${label}必填，最多 \${NAME_LIMIT} 个字\`);
  }
  return text;
}

export function listLiveMixcutProjects(db: Database.Database): LiveMixcutProject[] {
  return db.prepare(\`SELECT \${COLUMNS} FROM live_mixcut_projects WHERE deletedAt IS NULL ORDER BY createdAt DESC, rowid DESC\`)
    .all() as LiveMixcutProject[];
}

export function readLiveMixcutProject(db: Database.Database, projectId: string): LiveMixcutProject {
  const row = db.prepare(\`SELECT \${COLUMNS} FROM live_mixcut_projects WHERE id = ? AND deletedAt IS NULL\`)
    .get(projectId) as LiveMixcutProject | undefined;
  if (!row) throw new BatchDomainError('not_found', '任务不存在');
  return row;
}

/** 导出目录：任务名-创建日期，重名加 -2、-3。创建后不再改，免得已导出的文件找不到。 */
function uniqueExportDirName(db: Database.Database, name: string, createdAt: string): string {
  // 和导出目录守卫的白名单一致：只留字母、数字、中文和 ._-。
  const safe = sanitizeExportFilenamePart(name).replace(/[^A-Za-z0-9._\\-\\u4e00-\\u9fa5]/g, '') || '实拍混剪';
  const base = \`\${safe}-\${formatShanghaiTaskDate(createdAt)}\`;
  const taken = db.prepare('SELECT 1 FROM live_mixcut_projects WHERE exportDirName = ?');
  for (let index = 1; ; index += 1) {
    const candidate = index === 1 ? base : \`\${base}-\${index}\`;
    if (!taken.get(candidate)) return candidate;
  }
}

export function createLiveMixcutProject(db: Database.Database, input: { name: unknown; productName: unknown },
  now = new Date()): LiveMixcutProject {
  const name = cleanName(input.name, '任务名');
  const productName = cleanName(input.productName, '产品名');
  const id = randomUUID();
  const createdAt = now.toISOString();
  db.transaction(() => {
    db.prepare(\`INSERT INTO live_mixcut_projects (id, name, productName, exportDirName, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)\`).run(id, name, productName, uniqueExportDirName(db, name, createdAt), createdAt, createdAt);
    // 剪辑方式固定为实拍公式；批次和任务同名。
    const batchId = createBatchProduction(db, id, name, () => now, { planningMode: 'formula' });
    db.prepare('UPDATE live_mixcut_projects SET batchId = ? WHERE id = ?').run(batchId, id);
  })();
  return readLiveMixcutProject(db, id);
}

export function updateLiveMixcutProject(db: Database.Database, projectId: string,
  input: { name?: unknown; productName?: unknown }, now = new Date()): LiveMixcutProject {
  const current = readLiveMixcutProject(db, projectId);
  const name = input.name === undefined ? current.name : cleanName(input.name, '任务名');
  const productName = input.productName === undefined ? current.productName : cleanName(input.productName, '产品名');
  db.prepare('UPDATE live_mixcut_projects SET name = ?, productName = ?, updatedAt = ? WHERE id = ?')
    .run(name, productName, now.toISOString(), projectId);
  return readLiveMixcutProject(db, projectId);
}

/** 只做软删除：已经导出的文件和制作记录都保留。 */
export function deleteLiveMixcutProject(db: Database.Database, projectId: string, now = new Date()): void {
  readLiveMixcutProject(db, projectId);
  db.prepare('UPDATE live_mixcut_projects SET deletedAt = ?, updatedAt = ? WHERE id = ?')
    .run(now.toISOString(), now.toISOString(), projectId);
}
`;

const plans = [
  ['lib/live-mixcut/formula/narration.ts', [
    ["if (!db.prepare('SELECT 1 FROM projects WHERE id=?').get(projectId)) throw new BatchDomainError('not_found', '配音所属项目不存在');",
      "if (!db.prepare('SELECT 1 FROM live_mixcut_projects WHERE id=? AND deletedAt IS NULL').get(projectId)) throw new BatchDomainError('not_found', '配音所属任务不存在');"],
    ["usageContext: { projectId, refType: 'formula-narration',", "usageContext: { projectId: null, refType: 'live-mixcut-narration',"],
  ]],
  ['lib/live-mixcut/formula/replacements.ts', [
    ['{ projectId, refType: `formula_${purpose}`, refId: request.id }', '{ refType: `live_mixcut_${purpose}`, refId: request.id }'],
  ]],
  ['lib/media-core/adapters/text-json.ts', [
    ['usage: { projectId: string; refType: string; refId: string }', 'usage: { projectId?: string; refType: string; refId: string }'],
  ]],
  ['lib/live-mixcut/formula/output-presentation.ts', [
    ["import { buildPackagingVars, loadProjectPackagingData, parsePackagingConfig } from '../../media-core/packaging-vars.ts';",
      "import { buildPackagingVars, parsePackagingConfig } from '../../media-core/packaging-vars.ts';"],
    [`/** Older/minimal project schemas may not have optional product copy. Never read it again during execution. */
export function captureFormulaPresentationProject(db: Database.Database, projectId: string) {
  const columns = db.prepare("SELECT name FROM pragma_table_info('projects') WHERE name IN ('productName','sellingPointsJson')").all();
  return columns.length === 2 ? loadProjectPackagingData(db, projectId) : {};
}`, `/** 实拍混剪不关联项目：包装标题用任务里填的产品名，暂时没有卖点库。生成时读一次，之后不再读。 */
export function captureFormulaPresentationProject(db: Database.Database, projectId: string): { productName?: string; sellingPoints?: string[] } {
  const row = db.prepare('SELECT productName FROM live_mixcut_projects WHERE id = ?').get(projectId) as { productName: string } | undefined;
  return row?.productName.trim() ? { productName: row.productName.trim() } : {};
}`],
  ]],
  ['lib/live-mixcut/batch-workspace.ts', [
    ["import { resolveProjectExportDirName } from '../project-export-dir.ts';\nimport { getCurrentExportDirName } from '../project-export-identity.ts';\n",
      "import { readLiveMixcutProject } from './projects.ts';\n"],
    ['getCurrentExportDirName(db, projectId) ?? resolveProjectExportDirName(db, projectId)', 'readLiveMixcutProject(db, projectId).exportDirName', 'all'],
  ]],
  ['app/api/live-mixcut/assets/import/route.ts', [
    ["if (!getDb().prepare('SELECT 1 FROM projects WHERE id=?').get(projectId)) throw new BatchDomainError('not_found', '项目不存在');",
      "if (!getDb().prepare('SELECT 1 FROM live_mixcut_projects WHERE id=? AND deletedAt IS NULL').get(projectId)) throw new BatchDomainError('not_found', '任务不存在');"],
    ['const project = db.prepare(`SELECT id FROM projects WHERE id = ?`).get(projectId);',
      'const project = db.prepare(`SELECT id FROM live_mixcut_projects WHERE id = ? AND deletedAt IS NULL`).get(projectId);'],
  ]],
  ['app/api/live-mixcut/batches/[id]/exports/reveal/route.ts', [
    ["import { resolveProjectExportDirName } from '@/lib/project-export-dir';\nimport { getCurrentExportDirName } from '@/lib/project-export-identity';\nimport { assertNoStorageSymlink } from '@/lib/final-edit/storage-path';",
      "import { assertNoStorageSymlink } from '@/lib/media-core/storage-path';\nimport { readLiveMixcutProject } from '@/lib/live-mixcut/projects';"],
    ['const exportDirName = getCurrentExportDirName(getDb(), projectId) ?? resolveProjectExportDirName(getDb(), projectId);',
      'const exportDirName = readLiveMixcutProject(getDb(), projectId).exportDirName;'],
  ]],
  ['lib/live-mixcut/phase-e.ts', [
    [`import { resolveProjectExportDirName } from '../project-export-dir.ts';
import {
  createExportIdentity,
  getOrCreateCurrentExportIdentity,
  hasExportIdentity,
  type ExportIdentityView,
} from '../project-export-identity.ts';
import { readProductionIdentityFields, deriveProjectNamingDate } from '../project-production-identity.ts';
`, ''],
    ["import { formatShanghaiTaskDate, formulaExportSuffix } from '../media-core/export-identity.ts';",
      "import { formatShanghaiTaskDate, formulaExportSuffix, sanitizeExportFilenamePart } from '../media-core/export-identity.ts';\nimport { readLiveMixcutProject } from './projects.ts';"],
    ['import { readFrozenBatchExportIdentity, startBatchProduction } from', 'import { startBatchProduction } from'],
    { from: '  const project = db.prepare(`SELECT productCode, createdAt, storeCode, productSubmodel, productionType, editorName, namingDate FROM projects WHERE id = ?`)',
      to: '    exportDirName = frozenIdentity ? frozenIdentity.exportDirName : resolveProjectExportDirName(db, projectId);\n  }\n',
      replacement: `  // 实拍混剪不关联项目：导出目录和文件名都取任务上保存的值（见 ./projects.ts）。
  const task = readLiveMixcutProject(db, projectId);
  const taskDate = formatShanghaiTaskDate(task.createdAt) || undefined;
  const exportDirName = task.exportDirName;
  const taskBaseName = sanitizeExportFilenamePart(task.productName) || '实拍混剪';
` },
    ["        productCode: frozenBatchIdentity?.productCode || project.productCode || '',\n        taskDate: frozenBatchIdentity?.taskDate || taskDate || options.now?.() || new Date(),",
      "        productCode: '',\n        taskDate: taskDate || options.now?.() || new Date(),"],
    ['        ...(frozenIdentity ? { baseName: frozenIdentity.baseName } : {}),\n        ...(frozenBatchIdentity?.baseName && !frozenIdentity ? { baseName: frozenBatchIdentity.baseName } : {}),',
      '        baseName: taskBaseName,'],
  ]],
];

const results = plans.map(([file, pairs]) => {
  let text = fs.readFileSync(file, 'utf8');
  for (const pair of pairs) {
    if (!Array.isArray(pair)) {
      // 整段替换：从 from 所在行开始，到 to 结束（含）。
      const start = text.indexOf(pair.from);
      const end = start < 0 ? -1 : text.indexOf(pair.to, start);
      if (start < 0 || end < 0 || text.indexOf(pair.from, start + 1) >= 0) throw new Error(`${file}：整段替换的起止位置找不到或不唯一`);
      text = text.slice(0, start) + pair.replacement + text.slice(end + pair.to.length);
      continue;
    }
    const [from, to, mode] = pair;
    const count = text.split(from).length - 1;
    if (mode === 'all' ? count < 1 : count !== 1) throw new Error(`${file}：要替换的原文出现 ${count} 次：${from.slice(0, 80)}`);
    text = text.split(from).join(to);
  }
  return [file, text];
});
if (fs.existsSync('lib/live-mixcut/projects.ts')) throw new Error('lib/live-mixcut/projects.ts 已存在，停止');
fs.writeFileSync('lib/live-mixcut/projects.ts', PROJECTS_MODULE, 'utf8');
console.log('写入 lib/live-mixcut/projects.ts');
for (const [file, text] of results) {
  fs.writeFileSync(file, text, 'utf8');
  console.log(`写入 ${file}`);
}
const leftover = ['lib/live-mixcut/phase-e.ts'].filter(file => /\bproject\.|frozenIdentity|frozenBatchIdentity/.test(fs.readFileSync(file, 'utf8')));
if (leftover.length) console.log(`\n注意：${leftover.join('、')} 里还有项目导出身份的引用，按执行清单卡 5 的说明处理后再继续。`);
