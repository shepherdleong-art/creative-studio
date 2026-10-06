/**
 * 公司模型能力表（技术约定 C6）。
 *
 * 键是「供应商类型 + 路由身份 + 精确别名」；每一项都写明模式、输入组合、输出参数、
 * 取消能力与证据层级。**证据层级不能靠测试提升**：
 * - verified：真实公司链路样例支持（本轮没有新增真实样本，故暂不出现）；
 * - mapped：请求映射已完成并有本地请求捕获测试，画布真实验收待 P7；
 * - candidate：只有平台文档，公司转发未核对，界面不开放。
 *
 * 首版必需模型：七牛可灵 3.0（qiniuyun/kling-3.0）与公司 Seedance 2.5
 * （doubao-seedance-2-5-260628）。两者的字段合同来自既有真实案例，
 * 画布侧只做输入语义与请求映射，不重写已验证字段。
 */

import { companyVideoCapsForModel } from '../../company-gateway-size.ts';
import { companyGatewayTailFrameCapability } from '../../company-gateway-tail-frame.ts';
import { videoDurationOptions } from '../../video-duration.ts';
import type { CanvasModelCapability } from '../capabilities.ts';

/**
 * 图片模型（默认开放）：公司网关 image2-medium。
 *
 * 选择它的原因是**路由存在**且已有真实成功案例（公司网关核对记录里 image2 Medium 成功 29 条），
 * 而 qiniuyun 图片模型在当前 config.yaml 里没有路由 —— 注册一个提交必然失败的模型会误导用户。
 */
export const COMPANY_CANVAS_IMAGE2_CAPABILITY: CanvasModelCapability = {
  key: 'company-image2-medium',
  displayName: '公司 image2-medium',
  providerKind: 'company',
  providerIdentity: 'company-gateway-image2-medium',
  modelAlias: 'image2-medium',
  mediaKind: 'image',
  modes: ['text-to-image', 'image-to-image'],
  inputs: [
    { kind: 'image', roles: ['subject', 'product', 'style', 'scene', 'reference'], min: 0, max: 6 },
    { kind: 'text', roles: ['reference'], min: 0, max: 1 },
  ],
  parameters: [
    { key: 'aspectRatio', label: '比例', type: 'enum', options: ['1:1', '3:4', '4:3', '16:9', '9:16'], default: '1:1' },
    { key: 'resolution', label: '清晰度', type: 'enum', options: ['1K', '2K', '4K'], default: '2K' },
  ],
  cancellation: false,
  evidence: 'mapped',
  evidenceNote:
    '尺寸白名单与原生像素交付来自公司网关既有真实案例（image2 Medium 成功 29 条）；'
    + '多图参考的顺序与用途由本地请求捕获验证（R02 待真实样本）。'
    + '**无图（文生图）模式只有平台文档支持（可省略 FileInfos、必须给 Prompt），公司路由未验证，'
    + '属于 candidate 组合**——R01 是其验证样本，公司网关不可达时不得按已接通对待。',
};

/**
 * 七牛图片模型：**当前未注册**——画布 config.yaml 里没有 `qiniuyun/gpt-image-2-medium` 路由
 * （原工作台配置同样没有）。保留定义作为 P7 候选：等公司侧补上路由再注册，
 * 不因为「代码写好了」就在界面上开放一个提交必然失败的模型。
 */
export const COMPANY_CANVAS_QINIUYUN_IMAGE_CAPABILITY: CanvasModelCapability = {
  key: 'company-qiniuyun-image-2',
  displayName: '公司七牛 GPT-Image-2 Medium',
  providerKind: 'company',
  providerIdentity: 'company-gateway-qiniuyun-gpt-image-2-medium',
  modelAlias: 'qiniuyun/gpt-image-2-medium',
  mediaKind: 'image',
  modes: ['text-to-image', 'image-to-image'],
  inputs: [
    // min=0：文生图不伪造占位底图；多参考按顺序进入 images。
    { kind: 'image', roles: ['subject', 'product', 'style', 'scene', 'reference'], min: 0, max: 6 },
    { kind: 'text', roles: ['reference'], min: 0, max: 1 },
  ],
  parameters: [
    { key: 'aspectRatio', label: '比例', type: 'enum', options: ['1:1', '3:4', '4:3', '16:9', '9:16'], default: '1:1' },
    { key: 'resolution', label: '清晰度', type: 'enum', options: ['2K', '4K'], default: '2K' },
  ],
  cancellation: false,
  evidence: 'candidate',
  evidenceNote:
    '尺寸白名单与原生像素交付按 2026-08-21 逐格真实任务探测；但当前 config.yaml 无该路由，'
    + '未注册到画布能力表，列为 P7 候选。',
};

/** 七牛可灵 3.0：首帧 images[0] + 尾帧 end_image_url；Pro 默认、音频开启、1K 名义尺寸。 */
export const COMPANY_CANVAS_QINIUYUN_KLING_CAPABILITY: CanvasModelCapability = {
  key: 'company-qiniuyun-kling-3-0',
  displayName: '公司七牛可灵 3.0',
  providerKind: 'company',
  providerIdentity: 'company-qiniuyun-kling-3-0',
  modelAlias: 'qiniuyun/kling-3.0',
  mediaKind: 'video',
  modes: ['text-to-video', 'image-to-video'],
  inputs: [
    { kind: 'image', roles: ['first-frame', 'last-frame', 'reference', 'subject'], min: 0, max: 2 },
    { kind: 'text', roles: ['reference'], min: 0, max: 1 },
  ],
  parameters: [
    { key: 'durationSec', label: '时长（秒）', type: 'integer', min: 3, max: 15, default: 5 },
    { key: 'multiShot', label: '智能分镜', type: 'boolean', default: false },
  ],
  cancellation: false,
  evidence: 'mapped',
  evidenceNote:
    '首帧 images[0] + 尾帧 end_image_url、Pro 与 1K 名义 size、multi_shot 显式 false 来自 '
    + '2026-09-10 七牛 Kling v3 公司通道首尾帧验证；画布侧映射本轮由请求捕获验证，R05 待 P7。',
};

/** 公司 Seedance 2.5：双图按参考图模式，固定 1080p，不声明严格首尾帧锚定。 */
export const COMPANY_CANVAS_SEEDANCE_2_5_CAPABILITY: CanvasModelCapability = {
  key: 'company-seedance-2-5',
  displayName: '公司即梦 Seedance 2.5',
  providerKind: 'company',
  providerIdentity: 'company-seedance-2-5',
  modelAlias: 'doubao-seedance-2-5-260628',
  mediaKind: 'video',
  modes: ['text-to-video', 'image-to-video'],
  inputs: [
    // 双图是「参考图」，不是严格首尾帧：角色允许首/尾帧的意图表达，但不做像素锚定承诺。
    { kind: 'image', roles: ['first-frame', 'last-frame', 'reference', 'subject'], min: 0, max: 2 },
    { kind: 'text', roles: ['reference'], min: 0, max: 1 },
  ],
  parameters: [
    { key: 'resolution', label: '分辨率（公司已验证档位）', type: 'enum', options: companySeedanceResolutionOptions('doubao-seedance-2-5-260628'), default: companySeedanceResolutionOptions('doubao-seedance-2-5-260628')[0] },
    { key: 'durationSec', label: '时长（秒）', type: 'integer', min: Math.min(...videoDurationOptions('openai-video', 'doubao-seedance-2-5-260628')), max: Math.max(...videoDurationOptions('openai-video', 'doubao-seedance-2-5-260628')), default: 5 },
    // 纯文本模式没有首帧可吸附，必须显式给比例才能确定输出像素
    { key: 'aspectRatio', label: '比例', type: 'enum', options: companyVideoCapsForModel('doubao-seedance-2-5-260628')!.ratios, default: '16:9' },
    { key: 'withAudio', label: '生成声音', type: 'boolean', default: false },
  ],
  cancellation: false,
  evidence: 'mapped',
  evidenceNote:
    '1080p 像素表与「双图按参考图处理、首帧会重构」来自 2026-09-08 两条真实任务；'
    + '不声明严格首尾帧锚定。画布侧映射本轮由请求捕获验证，R06 待 P7。',
};

/** 公司 Seedance 2.0 Fast：保留既有合同（双图进真首尾帧、固定 720p、显式送 size）。 */
export const COMPANY_CANVAS_SEEDANCE_2_0_FAST_CAPABILITY: CanvasModelCapability = {
  key: 'company-seedance-2-0-fast',
  displayName: '公司即梦 Seedance 2.0 Fast',
  providerKind: 'company',
  providerIdentity: 'company-seedance-2-0-fast',
  modelAlias: 'doubao-seedance-2-0-fast-260128',
  mediaKind: 'video',
  modes: ['text-to-video', 'image-to-video'],
  inputs: [
    { kind: 'image', roles: ['first-frame', 'last-frame', 'reference', 'subject'], min: 0, max: 2 },
    { kind: 'text', roles: ['reference'], min: 0, max: 1 },
  ],
  parameters: [
    { key: 'resolution', label: '分辨率（公司已验证档位）', type: 'enum', options: companySeedanceResolutionOptions('doubao-seedance-2-0-fast-260128'), default: companySeedanceResolutionOptions('doubao-seedance-2-0-fast-260128')[0] },
    { key: 'durationSec', label: '时长（秒）', type: 'integer', min: Math.min(...videoDurationOptions('openai-video', 'doubao-seedance-2-0-fast-260128')), max: Math.max(...videoDurationOptions('openai-video', 'doubao-seedance-2-0-fast-260128')), default: 5 },
  ],
  cancellation: false,
  evidence: 'mapped',
  evidenceNote: '沿用公司首尾帧合同；720p 像素表来自主项目 2026-09-21 单图实测，其他比例和双图由请求回归覆盖，画布链路仍待真实样本。',
};

/** 腾讯可灵 3.0：首帧 images[0] + 尾帧 LastFrameUrl，比例与时长走 OutputConfig。 */
export const COMPANY_CANVAS_KLING_3_0_CAPABILITY: CanvasModelCapability = {
  key: 'company-kling-3-0',
  displayName: '公司可灵 3.0（腾讯）',
  providerKind: 'company',
  providerIdentity: 'company-kling-3-0',
  modelAlias: 'kling-3.0',
  mediaKind: 'video',
  modes: ['text-to-video', 'image-to-video'],
  inputs: [
    { kind: 'image', roles: ['first-frame', 'last-frame', 'reference', 'subject'], min: 0, max: 2 },
    { kind: 'text', roles: ['reference'], min: 0, max: 1 },
  ],
  parameters: [
    { key: 'durationSec', label: '时长（秒）', type: 'integer', min: 3, max: 15, default: 5 },
    { key: 'aspectRatio', label: '比例', type: 'enum', options: ['3:4', '4:3', '16:9', '9:16'], default: '3:4' },
    { key: 'multiShot', label: '智能分镜', type: 'boolean', default: false },
  ],
  cancellation: false,
  evidence: 'mapped',
  evidenceNote: 'LastFrameUrl + OutputConfig 合同来自 2026-08-17／18 真实任务；画布侧映射本轮由请求捕获验证。',
};

export const COMPANY_CANVAS_CAPABILITIES: ReadonlyArray<CanvasModelCapability> = [
  COMPANY_CANVAS_IMAGE2_CAPABILITY,
  COMPANY_CANVAS_QINIUYUN_KLING_CAPABILITY,
  COMPANY_CANVAS_SEEDANCE_2_5_CAPABILITY,
  COMPANY_CANVAS_SEEDANCE_2_0_FAST_CAPABILITY,
  COMPANY_CANVAS_KLING_3_0_CAPABILITY,
];

/** Existing company route and billing evidence do not prove the Canvas creation contract. Not registered. */
export const COMPANY_CANVAS_SEEDANCE_2_0_CANDIDATE: CanvasModelCapability = {
  ...COMPANY_CANVAS_SEEDANCE_2_0_FAST_CAPABILITY,
  key: 'company-seedance-2-0', displayName: '公司即梦 Seedance 2.0（待验证）',
  providerIdentity: 'company-seedance-2-0', modelAlias: 'doubao-seedance-2-0-260128',
  evidence: 'candidate', evidenceNote: '公司路由和历史账单已存在；画布字段与输出档位待受控探测，尚未注册。',
};

/** 必须走 COS 预签名交付的公司模型（缺 COS 时 fail closed，不回退本机 URL）。 */
export function companyCanvasModelRequiresCos(modelAlias: string): boolean {
  return modelAlias.startsWith('qiniuyun/');
}

/** 公司尾帧协议按精确别名判定（与 company-gateway-tail-frame 的 allowlist 保持一致）。 */
export function companyCanvasSupportsTailFrame(modelAlias: string): boolean {
  return companyGatewayTailFrameCapability(modelAlias).supported;
}

/** A missing size contract remains visibly unknown, never a claimed 720p request. */
export function companySeedanceResolutionOptions(modelAlias: string): string[] {
  return companyVideoCapsForModel(modelAlias)?.tiers.map((tier) => tier.toLowerCase()) ?? ['gateway-default'];
}
