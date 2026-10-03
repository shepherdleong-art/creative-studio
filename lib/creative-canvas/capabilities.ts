/**
 * 画布模型能力表（技术约定 C6）。
 *
 * 能力表以「供应商类型 + 路由身份 + 精确别名 + 合同版本」为键，记录模式、媒体组合、
 * 输出参数、取消能力与证据层级。P1 只提供接口与注册表；公司模型的注册在 P4 完成。
 *
 * 红线：证据层级只能由真实链路样例提升。测试 fixture 通过不能把 mapped 变成 verified，
 * 原生平台文档出现过的新字段先是 candidate。
 */

import type {
  CanvasCapabilityEvidence,
  CanvasGenerationMode,
  CanvasMediaKind,
  CanvasReferenceRole,
} from './types.ts';

export type CanvasCapabilityParameterType = 'enum' | 'integer' | 'number' | 'boolean' | 'string';

export interface CanvasCapabilityParameter {
  key: string;
  label: string;
  type: CanvasCapabilityParameterType;
  options?: ReadonlyArray<string>;
  specialValues?: ReadonlyArray<number>;
  min?: number;
  max?: number;
  default?: string | number | boolean;
  /** true 表示该参数只允许出现在列出的模式里；未列出时对所有模式可用。 */
  modes?: ReadonlyArray<CanvasGenerationMode>;
}

export interface CanvasInputRule {
  kind: CanvasMediaKind | 'text';
  roles: ReadonlyArray<CanvasReferenceRole>;
  /** 只在这些模式下生效；缺省表示所有模式。用于「图生视频要首帧、文生视频不要」这类差异。 */
  modes?: ReadonlyArray<CanvasGenerationMode>;
  /** 该规则至少需要几份输入；0 表示可选。 */
  min: number;
  /** 该规则最多接受几份输入。 */
  max: number;
  /** 模型级更严的 MIME 白名单（缺省用交付层的类型默认值）。 */
  mimeTypes?: ReadonlyArray<string>;
  /** 模型级更严的单文件字节上限。 */
  maxBytes?: number;
  /** 模型级时长上限（秒）：覆盖交付层默认值（可严可宽，需有官方依据）；null 表示该模型不限制时长。 */
  maxDurationSec?: number | null;
}

export interface CanvasModelCapability {
  /** 画布内部稳定键，写入节点 data.modelKey 与任务快照。 */
  key: string;
  displayName: string;
  providerKind: 'company' | 'external';
  /** 供应商路由身份，例如 company-qiniuyun-kling-3-0。 */
  providerIdentity: string;
  /** 精确模型别名，例如 qiniuyun/kling-3.0。 */
  modelAlias: string;
  mediaKind: Exclude<CanvasMediaKind, 'audio'>;
  modes: ReadonlyArray<CanvasGenerationMode>;
  legacyModes?: ReadonlyArray<CanvasGenerationMode>;
  inputs: ReadonlyArray<CanvasInputRule>;
  parameters: ReadonlyArray<CanvasCapabilityParameter>;
  cancellation: boolean;
  evidence: CanvasCapabilityEvidence;
  /** 证据来源或未验证边界说明；界面与执行记录引用这一行。 */
  evidenceNote: string;
  /** 跨类型最小素材数：当前模式下非 text 输入合计至少 N 份（单规则 min 表达不了「图/视频/音频混搭 ≥1」）。 */
  mediaInputMinimums?: ReadonlyArray<{ modes: ReadonlyArray<CanvasGenerationMode>; min: number; kinds?: ReadonlyArray<'image' | 'video' | 'audio'> }>;
  /** 按模型覆盖界面模式名（缺省用全局文案）。 */
  modeLabels?: Partial<Record<CanvasGenerationMode, string>>;
  /** 按模型覆盖界面模式提示（缺省用全局提示）。 */
  modeHints?: Partial<Record<CanvasGenerationMode, string>>;
}

export interface CanvasCapabilityInputRef {
  kind: CanvasMediaKind | 'text';
  role: CanvasReferenceRole;
}

export type CanvasCapabilityProblemCode =
  | 'unknown_model'
  | 'mode_not_supported'
  | 'input_kind_not_supported'
  | 'input_role_not_supported'
  | 'input_count_below_minimum'
  | 'input_count_above_maximum'
  | 'parameter_not_supported'
  | 'parameter_value_invalid';

export interface CanvasCapabilityProblem {
  code: CanvasCapabilityProblemCode;
  message: string;
  refId?: string;
  parameterKey?: string;
}

/**
 * Next 会把 instrumentation 与路由分别打包，模块级 Map 在两边可能是两份实例。
 * 能力表放在 globalThis 上，保证启动期注册的模型在 API 里可见。
 */
const REGISTRY_KEY = Symbol.for('creative-studio.creative-canvas-capabilities');

function registry(): Map<string, CanvasModelCapability> {
  const scope = globalThis as Record<PropertyKey, unknown>;
  const existing = scope[REGISTRY_KEY] as Map<string, CanvasModelCapability> | undefined;
  if (existing) return existing;
  const created = new Map<string, CanvasModelCapability>();
  scope[REGISTRY_KEY] = created;
  return created;
}

function normalizeInputKind(kind: CanvasMediaKind | 'text'): string {
  return kind;
}

/**
 * 注册或覆盖一项能力。返回是否新增（覆盖返回 false），便于测试断言重复注册。
 */
export function registerCanvasCapability(capability: CanvasModelCapability): boolean {
  const existed = registry().has(capability.key);
  registry().set(capability.key, capability);
  return !existed;
}

export function findCanvasCapability(key: string | null | undefined): CanvasModelCapability | null {
  if (!key) return null;
  return registry().get(key) ?? null;
}

export function listCanvasCapabilities(): CanvasModelCapability[] {
  return [...registry().values()].sort((left, right) => left.key.localeCompare(right.key));
}

/** 只用于测试与显式重置；运行期注册表由 ensureCanvasCapabilitiesRegistered 填充。 */
export function clearCanvasCapabilities(): void {
  registry().clear();
}

export function canvasCapabilityModeSupported(
  capability: CanvasModelCapability,
  mode: CanvasGenerationMode,
): boolean {
  return capability.modes.includes(mode);
}

function ruleAppliesToMode(rule: CanvasInputRule, mode: CanvasGenerationMode): boolean {
  return !rule.modes || rule.modes.includes(mode);
}

function ruleFor(
  capability: CanvasModelCapability,
  ref: CanvasCapabilityInputRef,
  mode: CanvasGenerationMode,
): CanvasInputRule | null {
  const kind = normalizeInputKind(ref.kind);
  const candidates = capability.inputs.filter(
    (rule) => normalizeInputKind(rule.kind) === kind && ruleAppliesToMode(rule, mode),
  );
  if (candidates.length === 0) return null;
  return candidates.find((rule) => rule.roles.includes(ref.role)) ?? null;
}

/**
 * 校验一组已固定顺序的输入是否符合能力表。返回空数组表示这组输入可以提交。
 */
export function validateCapabilityInputs(params: {
  capability: CanvasModelCapability;
  mode: CanvasGenerationMode;
  refs: ReadonlyArray<CanvasCapabilityInputRef & { refId?: string }>;
  parameters?: Record<string, unknown>;
}): CanvasCapabilityProblem[] {
  const { capability, mode, refs, parameters } = params;
  const problems: CanvasCapabilityProblem[] = [];

  if (!canvasCapabilityModeSupported(capability, mode)) {
    problems.push({
      code: 'mode_not_supported',
      message: `${capability.displayName} 不支持该生成模式。`,
    });
  }

  const matchedRules = new Map<CanvasInputRule, number>();
  let matchedMediaCount = 0;
  for (const ref of refs) {
    const rule = ruleFor(capability, ref, mode);
    if (!rule) {
      const kindSupported = capability.inputs.some(
        (candidate) => normalizeInputKind(candidate.kind) === normalizeInputKind(ref.kind)
          && ruleAppliesToMode(candidate, mode),
      );
      problems.push({
        code: kindSupported ? 'input_role_not_supported' : 'input_kind_not_supported',
        message: kindSupported
          ? `${capability.displayName} 不接受该用途的输入。`
          : `${capability.displayName} 不接受这种输入类型。`,
        ...(ref.refId ? { refId: ref.refId } : {}),
      });
      continue;
    }
    matchedRules.set(rule, (matchedRules.get(rule) ?? 0) + 1);
    if (normalizeInputKind(ref.kind) !== 'text') matchedMediaCount += 1;
  }

  for (const rule of capability.inputs) {
    if (!ruleAppliesToMode(rule, mode)) continue;
    const count = matchedRules.get(rule) ?? 0;
    if (count < rule.min) {
      problems.push({
        code: 'input_count_below_minimum',
        message: `${capability.displayName} 至少需要 ${rule.min} 份${rule.kind === 'text' ? '文本' : '媒体'}输入。`,
      });
    } else if (count > rule.max) {
      problems.push({
        code: 'input_count_above_maximum',
        message: `${capability.displayName} 最多接受 ${rule.max} 份${rule.kind === 'text' ? '文本' : '媒体'}输入。`,
      });
    }
  }

  // 跨类型最小素材数（「图／视频／音频混搭至少 1 份」这类约束，单规则 min 表达不了）
  for (const minimum of capability.mediaInputMinimums ?? []) {
    if (!minimum.modes.includes(mode)) continue;
    const count = minimum.kinds ? refs.filter((ref) => minimum.kinds!.includes(ref.kind as 'image' | 'video' | 'audio')).length : matchedMediaCount;
    if (count < minimum.min) {
      problems.push({
        code: 'input_count_below_minimum',
        message: `${capability.displayName} 至少需要 ${minimum.min} 份参考素材（图／视频／音频可混搭）。`,
      });
    }
  }

  if (parameters) {
    const known = new Map(capability.parameters.map((parameter) => [parameter.key, parameter]));
    for (const [key, value] of Object.entries(parameters)) {
      const parameter = known.get(key);
      if (!parameter) {
        problems.push({
          code: 'parameter_not_supported',
          message: `${capability.displayName} 不接受参数 ${key}。`,
          parameterKey: key,
        });
        continue;
      }
      if (parameter.modes && !parameter.modes.includes(mode)) {
        problems.push({
          code: 'parameter_not_supported',
          message: `${capability.displayName} 在当前模式不接受参数 ${key}。`,
          parameterKey: key,
        });
        continue;
      }
      if (parameter.type === 'enum' && parameter.options && !parameter.options.includes(String(value))) {
        problems.push({
          code: 'parameter_value_invalid',
          message: `参数 ${key} 的取值不在允许范围内。`,
          parameterKey: key,
        });
      }
      if (parameter.type === 'integer' && (!Number.isInteger(value) || typeof value !== 'number')) {
        problems.push({
          code: 'parameter_value_invalid',
          message: `参数 ${key} 需要整数。`,
          parameterKey: key,
        });
      }
      if (parameter.type === 'number' && typeof value !== 'number') {
        problems.push({
          code: 'parameter_value_invalid',
          message: `参数 ${key} 需要数值。`,
          parameterKey: key,
        });
      }
      if ((parameter.type === 'string' && typeof value !== 'string') || (parameter.type === 'boolean' && typeof value !== 'boolean')) {
        problems.push({
          code: 'parameter_value_invalid',
          message: `参数 ${key} 需要布尔值。`,
          parameterKey: key,
        });
      }
      if (
        typeof value === 'number'
        && !parameter.specialValues?.includes(value)
        && ((parameter.min !== undefined && value < parameter.min)
          || (parameter.max !== undefined && value > parameter.max))
      ) {
        problems.push({
          code: 'parameter_value_invalid',
          message: `参数 ${key} 超出允许范围。`,
          parameterKey: key,
        });
      }
    }
  }

  return problems;
}
