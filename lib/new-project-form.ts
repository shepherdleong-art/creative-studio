/**
 * 新建项目表单的纯逻辑（06 号票）。
 *
 * 抽出来是因为两条验收都要能断言，而页面本身在浏览器里：
 *   1. 缺项提示写在按钮旁——所以「缺什么」必须是一份可测试的清单，不是散在 JSX 里的 alert；
 *   2. 新建项目页不再出现超时 / 并发 / 图片预处理四个控件——清单放这里，
 *      `scripts/new-project-form.test.ts` 会同时读页面源码确认它们真的没回去。
 */

export interface NewProjectDraft {
  storeCode: string;
  productCode: string;
  productSubmodel: string;
  productionType: string;
  editorName: string;
}

export interface ProviderSummary {
  id: string;
  name: string;
  model: string;
  type: string;
  hasApiKey?: boolean;
}

export interface DraftValidation {
  missing: string[];
  message: string;
}

/**
 * 缺项校验：顺序与表单视觉顺序一致，返回第一条提示语。
 * 供应商/API Key 也在这里，因为它们同样是「填完就能创建」的前置条件。
 */
export function validateNewProjectDraft(
  draft: NewProjectDraft,
  provider: ProviderSummary | null,
): DraftValidation {
  const missing: string[] = [];
  if (!draft.storeCode) missing.push('店铺');
  if (!draft.productCode.trim()) missing.push('型号');
  if (!draft.productionType) missing.push('生产类型');
  if (!draft.editorName.trim()) missing.push('剪辑师');
  if (!provider) missing.push('供应商');
  else if (!provider.hasApiKey) missing.push('供应商 API Key');
  return {
    missing,
    message: missing.length === 0 ? '' : `还差${missing.join('、')}，填完就能创建。`,
  };
}

/**
 * 从新建项目页移除的控件（V06）。
 * 这四个以前让员工自己填：超时、并发数、图片预处理开关 + 最长边 + JPEG 质量。
 * 团队版改由服务器统一管理后，页面上不能再出现它们。
 */
export const REMOVED_NEW_PROJECT_CONTROLS = ['超时', '并发数', '图片预处理', 'JPEG 质量'] as const;

/** 创建成功后第 1 步的空状态：写明下一步，而不是只说「暂无」。 */
export const FIRST_STEP_EMPTY_HINT = '先放一张原始场景图，AI 换场景时会保持产品不变。';
