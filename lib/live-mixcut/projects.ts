import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { sanitizeExportFilenamePart } from '../media-core/export-identity.ts';
import { formatShanghaiIdentityDate } from '../project-production-identity.ts';
import { BatchDomainError } from './errors.ts';
import {
  buildLiveMixcutTaskName,
  parseLiveMixcutNamingInput,
  resolveUniqueLiveMixcutTaskName,
} from './naming.ts';
import { createBatchProduction } from './versions.ts';

/**
 * 实拍混剪的"任务"。复制来的代码处处用 projectId，指的就是这里的 id，和工作台的 projects 表无关。
 * 一个任务可以有多个批次；batchId 仅记录首批，供界面默认选中，不再影响导出目录。
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
  if (!text || text.length > NAME_LIMIT || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new BatchDomainError('invalid_input', `${label}必填，最多 ${NAME_LIMIT} 个字`);
  }
  return text;
}

export function listLiveMixcutProjects(db: Database.Database): LiveMixcutProject[] {
  return db.prepare(`SELECT ${COLUMNS} FROM live_mixcut_projects WHERE deletedAt IS NULL ORDER BY createdAt DESC, rowid DESC`)
    .all() as LiveMixcutProject[];
}

export function readLiveMixcutProject(db: Database.Database, projectId: string): LiveMixcutProject {
  const row = db.prepare(`SELECT ${COLUMNS} FROM live_mixcut_projects WHERE id = ? AND deletedAt IS NULL`)
    .get(projectId) as LiveMixcutProject | undefined;
  if (!row) throw new BatchDomainError('not_found', '任务不存在');
  return row;
}

/** 导出目录：直接用自动生成的任务名，重名加 -2、-3。创建后不再改，免得已导出的文件找不到。 */
function uniqueExportDirName(db: Database.Database, name: string): string {
  // 和导出目录守卫的白名单一致：只留字母、数字、中文和 ._-。
  const safe = sanitizeExportFilenamePart(name).replace(/[^A-Za-z0-9._\-\u4e00-\u9fa5]/g, '') || '实拍混剪';
  const taken = db.prepare('SELECT 1 FROM live_mixcut_projects WHERE exportDirName = ?');
  for (let index = 1; ; index += 1) {
    const candidate = index === 1 ? safe : `${safe}-${index}`;
    if (!taken.get(candidate)) return candidate;
  }
}

export function createLiveMixcutProject(db: Database.Database, input: {
  storeCode: unknown; productCode: unknown; editorName: unknown;
}, now = new Date()): LiveMixcutProject {
  const naming = parseLiveMixcutNamingInput(input);
  // 实拍混剪不单独填写产品名：包装标题使用型号，和生产身份保持一致。
  const productName = naming.productCode;
  const id = randomUUID();
  const createdAt = now.toISOString();
  db.transaction(() => {
    const name = resolveUniqueLiveMixcutTaskName(db, buildLiveMixcutTaskName(naming, formatShanghaiIdentityDate(now)));
    db.prepare(`INSERT INTO live_mixcut_projects (id, name, productName, exportDirName, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id, name, productName, uniqueExportDirName(db, name), createdAt, createdAt);
    // 首批与任务同名；后续可在任务内复制或新建其他批次。
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
