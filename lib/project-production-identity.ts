import type Database from 'better-sqlite3';
import { ProjectInfoValidationError } from './project-info.ts';

/**
 * 生产身份/导出身份领域错误。独立于 final-edit 的 FinalEditError，
 * 使本模块可被 `batch-production/` 安全导入（批量侧红线：不得依赖 final-edit）。
 */
export class ProjectIdentityError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'ProjectIdentityError';
    this.code = code;
    this.status = status;
  }
}

/**
 * 项目生产身份（详见 `docs/superpowers/plans/2026-09-03-项目生产身份与脚本知识模板-执行方案.md` §2.1-§2.3）。
 *
 * 新项目的生产身份由「店铺、型号、子型号、生产类型、剪辑师」五个字段 + 服务端冻结的
 * 项目日期组成。项目名称与正式导出基础名都由唯一构造公式
 * `{YYYYMMDD}-{店铺}-{型号}[-{子型号}]-{生产类型}-{剪辑师}` 生成，前端不再手填项目名。
 *
 * 红线：
 * - 型号是不可推断的原子值：`PC672-A` 整体就是型号，绝不允许按连字符/尾字母拆分。
 * - 任何读取端都不得反向解析项目名或文件名来恢复字段，SQLite 字段才是权威来源。
 * - 本模块是前后端可复用的纯函数族（不读 `process.env`），服务端与客户端必须产出完全相同的名称。
 */

export const STORE_CODES = ['B店', 'D店', 'K店', '京东'] as const;
export type StoreCode = (typeof STORE_CODES)[number];

export const PRODUCTION_TYPES = ['新品种草', 'AI种草'] as const;
export type ProductionType = (typeof PRODUCTION_TYPES)[number];

/** 历史下单表口径归一：只用于理解和旧数据手动补全，不参与运行时校验。 */
export const STORE_CODE_LEGACY_MAP: Readonly<Record<string, string>> = {
  '天猫-B店': 'B店',
  '天猫-D店': 'D店',
  '天猫-K店': 'K店',
  '天猫-k店': 'K店',
  'K店': 'K店',
  '天猫-婴童': 'K店',
  '京东-自营': '京东',
  '京东-POP': '京东',
  '京东-自营+POP': '京东',
};

/** 生产身份领域字段名，用于增量更新时只接受这些键。 */
export const PRODUCTION_IDENTITY_KEYS = [
  'storeCode',
  'productCode',
  'productSubmodel',
  'productionType',
  'editorName',
] as const;

/**
 * PATCH 请求中显式确认「启用新的导出名称」的字段名。
 * 前端弹窗与项目路由共用同一常量，避免两侧字段名漂移导致确认永远失败。
 */
export const ENABLE_NEW_EXPORT_IDENTITY_KEY = 'enableNewExportIdentity';

export interface ProductionIdentityFields {
  /** 店铺：仅允许 B店、D店、K店、京东 */
  storeCode: string;
  /** 型号：必填自由文本，整个输入值就是型号（原子值，不拆分）。 */
  productCode: string;
  /** 子型号：选填自由文本；为空时整段省略，不产生连续连字符。 */
  productSubmodel: string;
  /** 生产类型：仅允许 新品种草、AI种草 */
  productionType: string;
  /** 剪辑师：必填自由文本。 */
  editorName: string;
}

export interface ProjectProductionIdentity extends ProductionIdentityFields {
  /** 项目日期 `YYYYMMDD`，按 `Asia/Shanghai` 计算并永久冻结。 */
  namingDate: string;
}

const WINDOWS_FORBIDDEN_CHARS = /[\/\\:*?"<>|]/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * 身份字段归一：NFKC + 首尾空白 + 连续空白折叠为单个空格。
 * 中文、英文字母、数字、内部连字符与合法内部空格全部保留。
 */
export function normalizeIdentityText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ');
}

/** 必填自由文本校验：清洗后为空、`.`/`..`、路径分隔符、Windows 禁用字符、控制字符一律拒绝。 */
function validateRequiredText(value: string, label: string): string {
  const normalized = normalizeIdentityText(value);
  if (!normalized) throw new ProjectInfoValidationError(`${label}不能为空`);
  return validateIdentityText(normalized, label);
}

/** 选填自由文本校验：非空时才校验同一组约束。 */
function validateOptionalText(value: string, label: string): string {
  const normalized = normalizeIdentityText(value);
  if (!normalized) return '';
  return validateIdentityText(normalized, label);
}

function validateIdentityText(normalized: string, label: string): string {
  if (normalized === '.' || normalized === '..') throw new ProjectInfoValidationError(`${label}不能为 ${normalized}`);
  if (normalized.includes('/') || normalized.includes('\\')) throw new ProjectInfoValidationError(`${label}不能包含路径分隔符`);
  if (WINDOWS_FORBIDDEN_CHARS.test(normalized)) throw new ProjectInfoValidationError(`${label}包含非法字符`);
  if (CONTROL_CHARS.test(normalized)) throw new ProjectInfoValidationError(`${label}包含控制字符`);
  return normalized;
}

/**
 * 解析并校验前端提交的生产身份字段。所有身份字段都必须是字符串；
 * 店铺/生产类型命中白名单，型号/剪辑师必填，子型号选填。
 */
export function parseProductionIdentityInput(body: Record<string, unknown>): ProductionIdentityFields {
  const storeCode = typeof body.storeCode === 'string' ? body.storeCode : '';
  const productCode = typeof body.productCode === 'string' ? body.productCode : '';
  const productSubmodel = typeof body.productSubmodel === 'string' ? body.productSubmodel : '';
  const productionType = typeof body.productionType === 'string' ? body.productionType : '';
  const editorName = typeof body.editorName === 'string' ? body.editorName : '';

  const store = normalizeIdentityText(storeCode);
  if (!STORE_CODES.includes(store as StoreCode)) {
    throw new ProjectInfoValidationError(`店铺仅支持 ${STORE_CODES.join('、')}`);
  }

  const type = normalizeIdentityText(productionType);
  if (!PRODUCTION_TYPES.includes(type as ProductionType)) {
    throw new ProjectInfoValidationError(`生产类型仅支持 ${PRODUCTION_TYPES.join('、')}`);
  }

  return {
    storeCode: store,
    productCode: validateRequiredText(productCode, '型号'),
    productSubmodel: validateOptionalText(productSubmodel, '子型号'),
    productionType: type,
    editorName: validateRequiredText(editorName, '剪辑师'),
  };
}

/** 增量更新校验：只接受生产身份字段，逐个字段本地校验，返回部分更新。 */
export function parseProductionIdentityUpdate(body: Record<string, unknown>): Partial<ProductionIdentityFields> {
  const update: Partial<ProductionIdentityFields> = {};
  if (typeof body.storeCode === 'string') {
    const store = normalizeIdentityText(body.storeCode);
    if (!STORE_CODES.includes(store as StoreCode)) {
      throw new ProjectInfoValidationError(`店铺仅支持 ${STORE_CODES.join('、')}`);
    }
    update.storeCode = store;
  }
  if (typeof body.productCode === 'string') {
    update.productCode = validateRequiredText(body.productCode, '型号');
  }
  if (typeof body.productSubmodel === 'string') {
    update.productSubmodel = validateOptionalText(body.productSubmodel, '子型号');
  }
  if (typeof body.productionType === 'string') {
    const type = normalizeIdentityText(body.productionType);
    if (!PRODUCTION_TYPES.includes(type as ProductionType)) {
      throw new ProjectInfoValidationError(`生产类型仅支持 ${PRODUCTION_TYPES.join('、')}`);
    }
    update.productionType = type;
  }
  if (typeof body.editorName === 'string') {
    update.editorName = validateRequiredText(body.editorName, '剪辑师');
  }
  return update;
}

/** 把 `YYYYMMDD` 日期字符串按上海时区格式化（用于历史项目从 createdAt 派生）。 */
export function formatShanghaiIdentityDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year || ''}${value.month || ''}${value.day || ''}`;
}

/** 历史项目从 `createdAt`（SQLite UTC 时间）按上海时区派生 `YYYYMMDD`；解析失败返回空串。 */
export function formatShanghaiTaskDateFromCreatedAt(createdAt: string): string {
  const trimmed = (createdAt || '').trim();
  const sqliteUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed;
  const date = new Date(sqliteUtc);
  if (!Number.isFinite(date.getTime())) return '';
  return formatShanghaiIdentityDate(date);
}

/** 从项目行读取生产身份字段（缺省空串）。 */
export function readProductionIdentityFields(row: Record<string, unknown>): ProductionIdentityFields {
  return {
    storeCode: typeof row.storeCode === 'string' ? row.storeCode : '',
    productCode: typeof row.productCode === 'string' ? row.productCode : '',
    productSubmodel: typeof row.productSubmodel === 'string' ? row.productSubmodel : '',
    productionType: typeof row.productionType === 'string' ? row.productionType : '',
    editorName: typeof row.editorName === 'string' ? row.editorName : '',
  };
}

/**
 * 项目命名日期：`namingDate` 已冻结则原样返回；历史项目空值才从 `createdAt` 按
 * 上海时区派生。派生结果应在历史项目第一次确认新身份时落库，之后不可随系统时间改变。
 */
export function deriveProjectNamingDate(row: { namingDate?: string; createdAt?: string | null }): string {
  if (row.namingDate && /^\d{8}$/.test(row.namingDate)) return row.namingDate;
  return formatShanghaiTaskDateFromCreatedAt(row.createdAt ?? '');
}

/** 项目是否已具备完整生产身份（四个必填字段全部非空）。 */
export function projectHasProductionIdentity(row: Record<string, unknown>): boolean {
  const fields = readProductionIdentityFields(row);
  return Boolean(fields.storeCode && fields.productCode && fields.productionType && fields.editorName);
}

/** 唯一构造公式：`{YYYYMMDD}-{店铺}-{型号}[-{子型号}]-{生产类型}-{剪辑师}`。 */
export function buildProjectBaseName(identity: ProjectProductionIdentity): string {
  if (!/^\d{8}$/.test(identity.namingDate)) {
    throw new ProjectInfoValidationError('项目日期格式无效');
  }
  const submodelPart = identity.productSubmodel ? `-${identity.productSubmodel}` : '';
  return `${identity.namingDate}-${identity.storeCode}-${identity.productCode}${submodelPart}-${identity.productionType}-${identity.editorName}`;
}

/**
 * 路径安全最终守卫：项目名/目录名只允许中文、字母、数字、内部连字符、合法内部空格、
 * `.` 与 `_`，不得为 `.`/`..`、不得含路径分隔符。与导出目录名共用同一语义。
 */
export function assertSafeIdentityName(name: string): void {
  if (
    !name
    || name === '.'
    || name === '..'
    || name.includes('/')
    || name.includes('\\')
    || name.includes('\0')
    || !/^[A-Za-z0-9._\-\s一-龥]+$/.test(name)
  ) {
    throw new ProjectIdentityError('unsafe_path', '项目名称不能用于导出路径', 400);
  }
}

/**
 * 同名项目碰撞消解：基础名被其他项目占用时追加 `-02`、`-03` 两位序号。
 * 项目名称与导出目录名使用同一个消解结果。
 */
export function resolveUniqueProjectBaseName(
  db: Database.Database,
  baseName: string,
  excludeProjectId?: string,
): string {
  assertSafeIdentityName(baseName);
  let candidate = baseName;
  for (let sequence = 2; ; sequence += 1) {
    const occupied = db
      .prepare(`SELECT id FROM projects WHERE name = ? AND id != ?`)
      .get(candidate, excludeProjectId ?? '');
    if (!occupied) return candidate;
    candidate = `${baseName}-${String(sequence).padStart(2, '0')}`;
  }
}
