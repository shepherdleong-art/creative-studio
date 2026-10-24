import type Database from 'better-sqlite3';
import {
  STORE_CODES,
  formatShanghaiIdentityDate,
  normalizeIdentityText,
} from '../project-production-identity.ts';
import { BatchDomainError } from './errors.ts';

/**
 * 实拍混剪任务名：日期 + 店铺 + 型号 + 实拍混剪 + 剪辑师。
 * 包装代号不进任务名：它在第二步「声音和包装」随机或指定，第四步导出时由实际渲染结果带进文件名。
 */
export const LIVE_MIXCUT_PRODUCTION_TYPE = '实拍混剪';

export interface LiveMixcutNamingFields {
  storeCode: string;
  productCode: string;
  editorName: string;
}

const MAX_PART_LENGTH = 40;
const WINDOWS_FORBIDDEN_CHARS = /[\/\\:*?"<>|\u0000-\u001f\u007f]/;

function requiredPart(value: unknown, label: string): string {
  const text = normalizeIdentityText(typeof value === 'string' ? value : '');
  if (!text) throw new BatchDomainError('invalid_input', `${label}必填`);
  if (text === '.' || text === '..' || WINDOWS_FORBIDDEN_CHARS.test(text)) {
    throw new BatchDomainError('invalid_input', `${label}包含非法字符`);
  }
  if (text.length > MAX_PART_LENGTH) throw new BatchDomainError('invalid_input', `${label}最多 ${MAX_PART_LENGTH} 个字`);
  return text;
}

/** 服务端解析新建任务的生产身份；与前端预览使用同一套字段与文案。 */
export function parseLiveMixcutNamingInput(body: Record<string, unknown>): LiveMixcutNamingFields {
  const storeCode = normalizeIdentityText(typeof body.storeCode === 'string' ? body.storeCode : '');
  if (!STORE_CODES.includes(storeCode as (typeof STORE_CODES)[number])) {
    throw new BatchDomainError('invalid_input', `店铺仅支持 ${STORE_CODES.join('、')}`);
  }
  return {
    storeCode,
    productCode: requiredPart(body.productCode, '型号'),
    editorName: requiredPart(body.editorName, '剪辑师'),
  };
}

/** 唯一构造公式：`{YYYYMMDD}-{店铺}-{型号}-实拍混剪-{剪辑师}`。 */
export function buildLiveMixcutTaskName(identity: LiveMixcutNamingFields, namingDate: string): string {
  if (!/^\d{8}$/.test(namingDate)) throw new BatchDomainError('invalid_input', '任务日期格式无效');
  const part = (value: string) => normalizeIdentityText(value);
  return `${namingDate}-${part(identity.storeCode)}-${part(identity.productCode)}-${LIVE_MIXCUT_PRODUCTION_TYPE}-${part(identity.editorName)}`;
}

/** 同日同身份重名时追加 `-02`、`-03`，与工作台项目命名保持一致。 */
export function resolveUniqueLiveMixcutTaskName(db: Database.Database, baseName: string): string {
  let candidate = baseName;
  for (let sequence = 2; ; sequence += 1) {
    const occupied = db.prepare('SELECT 1 FROM live_mixcut_projects WHERE name = ?').get(candidate);
    if (!occupied) return candidate;
    candidate = `${baseName}-${String(sequence).padStart(2, '0')}`;
  }
}

/** 页面预览用的今日日期，按上海时区计算。 */
export function liveMixcutToday(): string {
  return formatShanghaiIdentityDate(new Date());
}
