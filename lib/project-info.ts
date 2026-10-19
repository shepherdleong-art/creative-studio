/**
 * 项目信息领域类型与旧字段校验。
 *
 * 2026-09-03 起，新项目只填写生产身份字段（店铺/型号/子型号/生产类型/剪辑师），
 * 项目名称由服务端按唯一构造公式生成；`productName`/`productCategory` 等旧列为兼容
 * 历史数据保留，但不再出现在新建页与项目信息编辑表单。身份字段的解析、归一、校验与
 * 基础名构造在 `lib/project-production-identity.ts`。
 */

export interface ProjectInfo {
  /** 项目名称：服务端生成（新项目）；旧项目保留历史手填值。 */
  name: string;
  /** 旧产品名称列：兼容历史数据保留，新建页/新编辑表单不再提供。 */
  productName: string;
  /** 产品型号（`projects.productCode`），与图片供应商的 `projects.model` 无关。 */
  productCode: string;
  /** 旧品类列：兼容历史数据保留。 */
  productCategory: string;
  /** 店铺：仅允许 B店、D店、K店、京东 */
  storeCode: string;
  /** 子型号：选填 */
  productSubmodel: string;
  /** 生产类型：仅允许 新品种草、AI种草 */
  productionType: string;
  /** 剪辑师 */
  editorName: string;
  /** 项目日期 `YYYYMMDD`（上海时区，创建时冻结） */
  namingDate: string;
  /** 是否已冻结过正式导出身份（冻结后编辑需显式确认新名称） */
  hasExportIdentity: boolean;
}

export class ProjectInfoValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectInfoValidationError';
  }
}

const OPTIONAL_PROJECT_INFO_KEYS = [
  'productName',
  'productCode',
  'productCategory',
] as const;

/**
 * 旧项目信息字段的增量校验（历史项目继续使用）。新项目请使用
 * `lib/project-production-identity.ts` 的 `parseProductionIdentityInput` /
 * `parseProductionIdentityUpdate`。
 */
export function parseProjectInfoUpdate(body: Record<string, unknown>): Partial<ProjectInfo> {
  const update: Partial<ProjectInfo> = {};

  if (typeof body.name === 'string') {
    const name = body.name.trim();
    if (!name) throw new ProjectInfoValidationError('项目名称不能为空');
    update.name = name;
  }

  for (const key of OPTIONAL_PROJECT_INFO_KEYS) {
    if (typeof body[key] === 'string') update[key] = body[key].trim();
  }

  return update;
}
