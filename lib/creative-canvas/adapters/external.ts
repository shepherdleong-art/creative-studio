import { assertDraftSourceMatches, canvasVideoMetadataForAsset, generationStage, requireCanvasDraftSource, sanitizeVideoMetadata } from '../video-metadata.ts';
import { precheckSeedanceMedia } from './seedance-media.ts';
import { SEEDANCE_25, SeedanceRequestError } from '../../video-providers/seedance-contract.ts';
/**
 * 外部（非公司）供应商的画布适配器。
 *
 * 与公司适配器的区别：素材按本机可访问地址交付（不强制 COS），不做公司专属的尺寸吸附与
 * 尾帧协议转换。复用仓库里已验证的适配器实现，不复制第二套协议：
 * - 图片：OpenAI 风格 `/v1/images/generations`（文生图）与 `/v1/images/edits`（图生图 + 多参考）；
 * - 视频：`lib/video-providers/` 里按供应商类型选择的适配器（当前支持即梦直连的文生视频、首帧、
 *   首尾帧与多模态参考）。参考视频／音频没有本机回退通道，必须经交付层（COS）拿到公网地址。
 *
 * 提示词按节点原文提交：**不叠加**旧工作台「图1 是待编辑底图…」那套自动前缀，
 * 多参考的用途由画布里的 @参考N 与角色显式表达。
 */

import fs from 'node:fs';
import sharp from 'sharp';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { resolveGptImage2Size } from '../../gpt-image-2-size-presets.ts';
import { downloadGatewayMedia, sanitizeGatewayMediaDiagnostic } from '../../gateway-media-url.ts';
import { getVideoAdapter } from '../../video-providers/index.ts';
import type { ReferenceVideoInput, SubmitVideoRequest } from '../../video-providers/types.ts';
import { findCanvasCapability, type CanvasInputRule, type CanvasModelCapability } from '../capabilities.ts';
import type { CanvasGenerationMode } from '../types.ts';
import { resolveCompanyCanvasRoute } from './company-providers.ts';
import { createDefaultCanvasDeliverer, precheckCanvasDeliveryMedia, type CanvasMediaDeliverer } from './media-delivery.ts';
import {
  CanvasAdapterError,
  type CanvasPollOutcome,
  type CanvasResolvedInput,
  type CanvasSubmitOutcome,
  type CanvasTaskAdapter,
  type CanvasTaskContext,
} from './types.ts';

export interface ExternalCanvasAdapterOptions {
  db: Database.Database;
  storageRoot: string;
  deliverer?: CanvasMediaDeliverer;
  fetchImpl?: typeof fetch;
  submitTimeoutMs?: number;
}

/** 多模态参考的入口：全能参考／智能多帧／智能编辑／超长视频（及 2.0 的两个参考模式），素材按角色进方舟 content 数组，不走首帧合同。 */
const REFERENCE_MODES: ReadonlyArray<CanvasGenerationMode> = [
  'video-to-video',
  'reference-to-video',
  'frames-to-video',
  'video-edit',
  'video-extend',
];

/** 方舟 2.0 系列的参考素材约束：视频／音频每段 2–15 秒，各类总时长不超过 15 秒。 */
const ARK_REFERENCE_SEGMENT_MIN_SEC = 2;
const ARK_REFERENCE_KIND_TOTAL_MAX_SEC = 15;
/** 方舟 2.5 系列：单段通常 2–30 秒，编辑视频 4–30 秒，各类总时长不超过 30 秒。 */
const ARK_2_5_REFERENCE_SEGMENT_MAX_SEC = 30;
/** ffprobe 对「2 秒」素材可能报 1.98，留一点余量，避免把合规素材判成过短。 */
const REFERENCE_DURATION_TOLERANCE_SEC = 0.25;

function isReferenceMode(mode: CanvasGenerationMode): boolean {
  return REFERENCE_MODES.includes(mode);
}

/** 参考素材的时长约束按模型代际区分（2.0 与 2.5 的单段上限不同）。 */
function referenceDurationLimits(modelAlias: string): { segmentMaxSec: number; kindTotalMaxSec: number | null } {
  if (/seedance-2-5[-.]/.test(modelAlias)) {
    return { segmentMaxSec: ARK_2_5_REFERENCE_SEGMENT_MAX_SEC, kindTotalMaxSec: ARK_2_5_REFERENCE_SEGMENT_MAX_SEC };
  }
  return { segmentMaxSec: ARK_REFERENCE_KIND_TOTAL_MAX_SEC, kindTotalMaxSec: ARK_REFERENCE_KIND_TOTAL_MAX_SEC };
}

/** 参考视频单段下限：2.5 编辑子任务官方硬性要求 4 秒，其余模式维持 2 秒（官方对延长仅为建议）。 */
function referenceVideoSegmentMinSec(modelAlias: string, mode: CanvasGenerationMode): number {
  if (mode === 'video-edit' && /seedance-2-5[-.]/.test(modelAlias)) return 4;
  return ARK_REFERENCE_SEGMENT_MIN_SEC;
}

function inputRuleFor(
  capability: CanvasModelCapability,
  input: CanvasResolvedInput,
  mode: CanvasGenerationMode,
): CanvasInputRule | null {
  const candidates = capability.inputs.filter(
    (rule) => rule.kind === input.kind && (!rule.modes || rule.modes.includes(mode)),
  );
  return candidates.find((rule) => rule.roles.includes(input.role)) ?? null;
}

/** 参考素材组合校验（方舟规则）：音频必须与图或视频同时出现；分段与分类总时长有上限（按模型代际与模式）。 */
type ReferenceDurationInput = Pick<CanvasResolvedInput, 'kind' | 'durationSec' | 'refId'>;
export function referenceCombinationProblems(
  inputs: ReadonlyArray<ReferenceDurationInput>,
  modelAlias: string,
  mode: CanvasGenerationMode,
): string[] {
  const problems: string[] = [];
  const limits = referenceDurationLimits(modelAlias);
  const videoSegmentMinSec = referenceVideoSegmentMinSec(modelAlias, mode);
  const videos = inputs.filter((input) => input.kind === 'video');
  const audios = inputs.filter((input) => input.kind === 'audio');
  const hasVisual = inputs.some((input) => input.kind === 'image' || input.kind === 'video');
  if (audios.length > 0 && !hasVisual && modelAlias !== SEEDANCE_25) {
    problems.push('参考音频必须与参考图或参考视频同时出现');
  }
  const groups: Array<{ label: string; items: ReferenceDurationInput[]; segmentMinSec: number }> = [
    { label: '视频', items: videos, segmentMinSec: videoSegmentMinSec },
    { label: '音频', items: audios, segmentMinSec: ARK_REFERENCE_SEGMENT_MIN_SEC },
  ];
  for (const group of groups) {
    for (const input of group.items) {
      const duration = input.durationSec;
      if (duration === null || !Number.isFinite(duration) || duration <= 0) {
        problems.push(`参考${group.label} @${input.refId} 缺少有效时长，必须先完成媒体探测`);
        continue;
      }
      if (duration + REFERENCE_DURATION_TOLERANCE_SEC < group.segmentMinSec) {
        problems.push(`参考${group.label} @${input.refId} 时长 ${duration.toFixed(1)}s 短于 ${group.segmentMinSec}s 下限`);
      }
      if (duration > limits.segmentMaxSec) {
        problems.push(`参考${group.label} @${input.refId} 时长 ${duration.toFixed(1)}s 超过 ${limits.segmentMaxSec}s 上限`);
      }
    }
    if (limits.kindTotalMaxSec === null) continue;
    const total = group.items.reduce((sum, input) => sum + (input.durationSec ?? 0), 0);
    if (total > limits.kindTotalMaxSec + REFERENCE_DURATION_TOLERANCE_SEC) {
      problems.push(`参考${group.label}总时长 ${total.toFixed(1)}s 超过 ${limits.kindTotalMaxSec}s 上限`);
    }
  }
  return problems;
}

/** 方舟 2.5 omni 子任务的提示词意图前置校验：配置与子任务不一致会在上游异步失败，这里提前拦下。 */
const OMNI_PROMPT_KEYWORDS: Record<string, { pattern: RegExp; examples: string }> = {
  'video-edit': {
    pattern: /编辑|修改|替换|改成|改為|改为|换成|变成|删除|删掉|去掉|去除|抹除|清除|移除|增加|添加|加上|换上|edit|remove|delete|replace|add|change/i,
    examples: '替换／删除／增加／修改',
  },
  'video-extend': {
    pattern: /延长|延续|续写|向前|向后|继续|接着|续接|补全|过渡|extend|continue/i,
    examples: '向前延长／向后延长／续写',
  },
};

function omniPromptProblems(prompt: string, mode: CanvasGenerationMode): string[] {
  const rule = OMNI_PROMPT_KEYWORDS[mode];
  if (!rule) return [];
  if (rule.pattern.test(prompt)) return [];
  return [`提示词需包含至少一个${rule.examples}类关键词，模型才能按预期子任务执行`];
}

/** 参考输入按节点顺序（orderIndex）进请求，@参考N 与提示词的对应关系不随数组顺序漂移。 */
function orderedMediaInputs(context: CanvasTaskContext): CanvasResolvedInput[] {
  return context.inputs
    .filter((input) => input.kind !== 'text')
    .slice()
    .sort((left, right) => left.orderIndex - right.orderIndex);
}

/** 图片回退通道：交付层不可用时按本机文件转 data URL（方舟接受图片 data URL）。 */
function localFileDataUrl(input: CanvasResolvedInput): string {
  if (!input.absolutePath || !input.mimeType) {
    throw new CanvasAdapterError('submit', `输入 @${input.refId} 缺少可读的本地文件，任务未提交。`, {
      code: 'input_file_missing',
    });
  }
  return `data:${input.mimeType};base64,${fs.readFileSync(input.absolutePath).toString('base64')}`;
}

/** 同步出图的图片供应商：把产物写到任务专属临时文件，下载阶段再读回来（可跨重启）。 */
function syncImageTempPath(storageRoot: string, canvasId: string, taskId: string): string {
  return path.join(storageRoot, 'canvas', canvasId, 'tmp', `${taskId}.img`);
}

function syncImageReceiptPath(storageRoot: string, canvasId: string, taskId: string): string {
  return path.join(storageRoot, 'canvas', canvasId, 'tmp', `${taskId}.receipt.json`);
}

function writeAtomic(filePath: string, content: string | Buffer): void {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, content, { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

type SyncImageReceipt = { version: 1; kind: 'url'; url: string };

function writeSyncImageUrlReceipt(storageRoot: string, canvasId: string, taskId: string, url: string): void {
  const receiptPath = syncImageReceiptPath(storageRoot, canvasId, taskId);
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
  writeAtomic(receiptPath, JSON.stringify({ version: 1, kind: 'url', url } satisfies SyncImageReceipt));
}

function readSyncImageUrlReceipt(storageRoot: string, canvasId: string, taskId: string): string | null {
  const receiptPath = syncImageReceiptPath(storageRoot, canvasId, taskId);
  if (!fs.existsSync(receiptPath)) return null;
  try {
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Partial<SyncImageReceipt>;
    return receipt.version === 1 && receipt.kind === 'url' && typeof receipt.url === 'string' && receipt.url
      ? receipt.url
      : null;
  } catch {
    return null;
  }
}

function candidateSizes(parameters: Record<string, string | number | boolean>): string {
  const ratio = String(parameters.aspectRatio ?? '1:1');
  const resolution = String(parameters.resolution ?? '1K').toLowerCase();
  try {
    const size = resolveGptImage2Size(ratio, resolution);
    return size === 'auto' ? '1024x1024' : size;
  } catch {
    return '1024x1024';
  }
}

function imageInputsOf(context: CanvasTaskContext) {
  return context.inputs.filter((input) => input.kind === 'image');
}

function linkedTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  return AbortSignal.any([signal, timeout]);
}

async function decodeImageResponse(response: Response, apiKey: string): Promise<Buffer | { url: string }> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new CanvasAdapterError('submit', '外部图片网关响应读取中断，提交结果不明。', {
      uncertain: true,
      code: 'external_response_read_uncertain',
    });
  }
  if (!response.ok) {
    const uncertain = response.status >= 500;
    throw new CanvasAdapterError(
      'submit',
      `外部图片网关提交失败 ${response.status}：${sanitizeGatewayMediaDiagnostic(text, apiKey).slice(0, 300)}`,
      { uncertain, code: uncertain ? 'external_submit_uncertain' : 'external_submit_rejected' },
    );
  }
  let payload: { data?: Array<{ b64_json?: string; url?: string }>; error?: unknown };
  try {
    payload = JSON.parse(text) as typeof payload;
  } catch {
    throw new CanvasAdapterError('submit', '外部图片网关返回了非 JSON 响应，提交结果不明。', {
      uncertain: true,
      code: 'external_response_unparsable',
    });
  }
  const item = payload.data?.[0];
  if (item?.b64_json) return Buffer.from(item.b64_json, 'base64');
  if (item?.url) return { url: item.url };
  throw new CanvasAdapterError('submit', '外部图片网关没有返回图片内容，提交结果不明。', {
    uncertain: true,
    code: 'external_result_missing',
  });
}

function isHttpClientRejection(error: unknown): boolean {
  return /^(?:Jimeng(?: text-to-video| reference-to-video| final-from-draft)?|Kling|Video gateway) submit error 4\d\d:/i
    .test(error instanceof Error ? error.message : String(error));
}

function submitError(stage: 'submit', message: string, error: unknown, signal?: AbortSignal): CanvasAdapterError {
  if (error instanceof SeedanceRequestError) return new CanvasAdapterError('prepare', error.message, { code: 'seedance_request_invalid' });
  if (signal?.aborted && !isHttpClientRejection(error)) {
    return new CanvasAdapterError(stage, '提交被中止，生成请求结果不明。', {
      uncertain: true,
      code: 'submit_uncertain',
    });
  }
  return new CanvasAdapterError(stage, message, {
    uncertain: !isHttpClientRejection(error),
    code: isHttpClientRejection(error) ? 'external_submit_rejected' : 'external_submit_uncertain',
  });
}

export function createExternalCanvasAdapter(options: ExternalCanvasAdapterOptions): CanvasTaskAdapter {
  const { db, storageRoot } = options;
  const deliverer = options.deliverer ?? createDefaultCanvasDeliverer();
  const fetchImpl = options.fetchImpl ?? fetch;
  const submitTimeoutMs = options.submitTimeoutMs ?? 180_000;

  const capabilityFor = (key: string): CanvasModelCapability => {
    const capability = findCanvasCapability(key);
    if (!capability) {
      throw new CanvasAdapterError('prepare', `画布能力表里没有模型 ${key}，任务未提交。`, {
        code: 'capability_unavailable',
      });
    }
    return capability;
  };

  const routeFor = (context: CanvasTaskContext) => resolveCompanyCanvasRoute(db, {
    providerIdentity: context.providerIdentity,
    modelAlias: context.modelAlias,
    mediaKind: context.mediaKind,
  });

  return {
    kind: 'external',

    async prepare(context, signal) {
      if (generationStage(context.parameters) === 'final-from-draft') {
        try {
          const source = requireCanvasDraftSource(db, context.task.canvasId, String(context.parameters.draftAssetId ?? ''));
          assertDraftSourceMatches(source, context.modelAlias, context.providerIdentity);
        } catch (error) { throw new CanvasAdapterError('prepare', (error as Error).message, { code: 'draft_source_invalid' }); }
        return;
      }

      const capability = capabilityFor(context.capabilityKey);
      routeFor(context);
      const referenceMode = isReferenceMode(context.generationMode);
      const mediaInputs = context.inputs.filter((entry) => entry.kind !== 'text');

      for (const input of mediaInputs) {
        const rule = inputRuleFor(capability, input, context.generationMode);
        if (!rule) {
          throw new CanvasAdapterError(
            'prepare',
            `输入 @${input.refId} 的类型或用途不被 ${capability.displayName} 接受，任务未提交。`,
            { code: 'input_not_supported' },
          );
        }
        if (!input.absolutePath || !input.mimeType || input.byteSize === null) {
          throw new CanvasAdapterError('prepare', `输入 @${input.refId} 的本地文件不可用，任务未提交。`, {
            code: 'input_file_missing',
          });
        }
        if (context.mediaKind === 'video') await precheckSeedanceMedia(input, context.modelAlias);
        const problems = precheckCanvasDeliveryMedia({
          kind: input.kind as 'image' | 'video' | 'audio',
          mimeType: input.mimeType,
          byteSize: input.byteSize,
          durationSec: input.durationSec,
          absolutePath: input.absolutePath,
        }, {
          ...(rule.mimeTypes ? { mimeTypes: rule.mimeTypes } : {}),
          ...(rule.maxBytes !== undefined ? { maxBytes: rule.maxBytes } : {}),
          ...(rule.maxDurationSec !== undefined ? { maxDurationSec: rule.maxDurationSec } : {}),
        });
        if (problems.length > 0) {
          throw new CanvasAdapterError(
            'prepare',
            `输入 @${input.refId} 未通过交付校验：${problems.join('；')}，任务未提交。`,
            { code: 'media_precheck_failed' },
          );
        }

        if (!referenceMode) {
          // 首帧／尾帧图片按本机文件读取（提交时转 data URL），不经交付层
          input.deliveryRef = input.absolutePath;
          continue;
        }

        if (input.kind === 'image') {
          // 参考图优先走交付层（COS 预签名 URL，避免多图 Base64 撑大请求体）；
          // 交付层不可用时回退 data URL，由 submit 生成。
          try {
            input.deliveryRef = await deliverer.deliver({
              kind: 'image',
              absolutePath: input.absolutePath,
              mimeType: input.mimeType,
              byteSize: input.byteSize,
              durationSec: input.durationSec,
              role: input.role,
              requireCos: false,
              isFrameImage: false,
            }, signal);
          } catch {
            input.deliveryRef = null;
          }
          continue;
        }

        // 视频／音频参考只接受上游可访问的 URL，没有本机回退通道：缺 COS 或上传失败一律 fail closed
        input.deliveryRef = await deliverer.deliver({
          kind: input.kind as 'video' | 'audio',
          absolutePath: input.absolutePath,
          mimeType: input.mimeType,
          byteSize: input.byteSize,
          durationSec: input.durationSec,
          role: input.role,
          requireCos: false,
          isFrameImage: false,
        }, signal);
      }

      if (referenceMode) {
        const problems = referenceCombinationProblems(mediaInputs, context.modelAlias, context.generationMode);
        if (problems.length > 0) {
          throw new CanvasAdapterError(
            'prepare',
            `参考素材组合不合法：${problems.join('；')}，任务未提交。`,
            { code: 'reference_combination_invalid' },
          );
        }
        const promptProblems = context.modelAlias === SEEDANCE_25 ? omniPromptProblems(context.prompt, context.generationMode) : [];
        if (promptProblems.length > 0) {
          throw new CanvasAdapterError(
            'prepare',
            `${promptProblems.join('；')}，任务未提交。`,
            { code: 'prompt_keyword_missing' },
          );
        }
      }
    },

    async submit(context, signal): Promise<CanvasSubmitOutcome> {
      const capability = capabilityFor(context.capabilityKey);
      const route = routeFor(context);
      const imageInputs = imageInputsOf(context);
      if (generationStage(context.parameters) === 'final-from-draft') {
        const adapter = getVideoAdapter(route.type);
        if (!adapter?.submitFinal) throw new CanvasAdapterError('prepare', '该渠道未验证样片转正式', { code: 'draft_channel_unverified' });
        let source;
        try {
          source = requireCanvasDraftSource(db, context.task.canvasId, String(context.parameters.draftAssetId ?? ''));
          assertDraftSourceMatches(source, context.modelAlias, context.providerIdentity);
          // Revalidate remote availability using the current credentials/route immediately before POST.
          const remote = await adapter.poll(source.providerTaskId, route.apiKey, route.baseUrl, signal);
          const raw = remote.rawResponse as { model?: string; draft?: boolean; created_at?: number };
          if (remote.status !== 'succeeded' || raw.model !== source.model || raw.draft !== true
            || Number(raw.created_at) * 1000 !== Date.parse(source.remoteCreatedAt)) throw new Error('供应商样片身份或状态无法确认，请重新生成样片');
          assertDraftSourceMatches({ ...source, expired: Date.parse(source.expiresAt) <= Date.now() }, context.modelAlias, context.providerIdentity);
        } catch (error) { throw new CanvasAdapterError('prepare', sanitizeGatewayMediaDiagnostic((error as Error).message, route.apiKey), { code: 'draft_source_invalid' }); }
        try {
          const submitted = await adapter.submitFinal({
            model: source.model, draftTaskId: source.providerTaskId,
            outputFormat: context.parameters.outputFormat === 'mov' ? 'mov' : 'mp4',
            watermark: context.parameters.watermark === true, returnLastFrame: context.parameters.returnLastFrame === true,
          }, route.apiKey, route.baseUrl, signal);
          if (!submitted.providerTaskId) throw new CanvasAdapterError('submit', '供应商未返回任务 ID', { uncertain: true });
          return { providerTaskId: submitted.providerTaskId };
        } catch (error) { throw submitError('submit', '样片转正式提交失败，结果不明。', error, signal); }
      }


      if (capability.mediaKind === 'image') {
        if (signal?.aborted) {
          throw new CanvasAdapterError('submit', '提交在生成请求前已中止，任务未提交。', { code: 'submit_aborted' });
        }
        const size = candidateSizes(context.parameters);
        let response: Response;
        try {
          if (imageInputs.length === 0) {
            // 文生图：不伪造占位底图
            response = await fetchImpl(`${route.baseUrl}/v1/images/generations`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${route.apiKey}` },
              body: JSON.stringify({ model: capability.modelAlias, prompt: context.prompt, size, n: 1 }),
              signal: linkedTimeoutSignal(signal, submitTimeoutMs),
            });
          } else {
            // 图生图 + 多参考：图1 = 底图，其后按节点顺序追加参考图；提示词原样提交
            const form = new FormData();
            form.append('model', capability.modelAlias);
            form.append('prompt', context.prompt);
            form.append('size', size);
            form.append('n', '1');
            for (const [index, input] of imageInputs.entries()) {
              const bytes = fs.readFileSync(input.absolutePath as string);
              form.append(
                'image',
                new Blob([bytes], { type: input.mimeType ?? 'image/png' }),
                `${index === 0 ? 'base' : `ref${index}`}-${path.basename(input.absolutePath as string)}`,
              );
            }
            response = await fetchImpl(`${route.baseUrl}/v1/images/edits`, {
              method: 'POST',
              headers: { authorization: `Bearer ${route.apiKey}` },
              body: form,
              signal: linkedTimeoutSignal(signal, submitTimeoutMs),
            });
          }
        } catch (error) {
          throw submitError('submit', '外部图片网关提交请求失败，结果不明。', error, signal);
        }
        const result = await decodeImageResponse(response, route.apiKey);
        try {
          if (Buffer.isBuffer(result)) {
            const tempPath = syncImageTempPath(storageRoot, context.task.canvasId, context.task.id);
            fs.mkdirSync(path.dirname(tempPath), { recursive: true, mode: 0o700 });
            writeAtomic(tempPath, result);
          } else {
            writeSyncImageUrlReceipt(storageRoot, context.task.canvasId, context.task.id, result.url);
          }
        } catch {
          throw new CanvasAdapterError('submit', '外部图片同步结果持久化失败，提交结果不明。', {
            uncertain: true,
            code: 'external_result_persist_uncertain',
          });
        }
        return { providerTaskId: `external-image:${context.task.id}` };
      }

      // 视频：复用仓库里按供应商类型选择的适配器（当前配置的是即梦直连）
      const adapter = getVideoAdapter(route.type);
      if (!adapter) {
        throw new CanvasAdapterError('prepare', `没有 ${route.type} 类型的视频适配器，任务未提交。`, {
          code: 'video_adapter_missing',
        });
      }
      // 文生视频：没有首帧，走适配器的显式文本合同（不伪造占位首帧）
      if (context.generationMode === 'text-to-video') {
        if (!adapter.submitText) {
          throw new CanvasAdapterError(
            'prepare',
            `${route.type} 类型的视频适配器不支持文生视频，任务未提交。`,
            { code: 'text_to_video_unsupported' },
          );
        }
        if (signal?.aborted) throw new CanvasAdapterError('submit', '提交在生成请求前已中止，任务未提交。', { code: 'submit_aborted' });
        let submitted;
        try {
          submitted = await adapter.submitText({
            model: capability.modelAlias,
            ...videoOutputOptions(context),
            prompt: context.prompt,
            durationSec: Number(context.parameters.durationSec ?? 5),
            ...(context.parameters.aspectRatio ? { aspectRatio: String(context.parameters.aspectRatio) } : {}),
          }, route.apiKey, route.baseUrl, signal);
        } catch (error) {
          throw submitError('submit', '外部视频提交请求失败，结果不明。', error, signal);
        }
        if (!submitted.providerTaskId) {
          throw new CanvasAdapterError('submit', '视频供应商没有返回任务 ID，提交结果不明。', {
            uncertain: true,
            code: 'video_task_id_missing',
          });
        }
        return { providerTaskId: submitted.providerTaskId };
      }

      // 全能参考／智能多帧／智能编辑／超长视频：多模态参考合同，素材按角色进 content 数组
      if (isReferenceMode(context.generationMode)) {
        if (!adapter.submitReference) {
          throw new CanvasAdapterError(
            'prepare',
            `${route.type} 类型的视频适配器不支持多模态参考，任务未提交。`,
            { code: 'reference_video_unsupported' },
          );
        }
        const references: ReferenceVideoInput[] = orderedMediaInputs(context).map((input) => ({
          kind: input.kind as ReferenceVideoInput['kind'],
          // 视频／音频在 prepare 阶段必须已拿到公网地址；图片允许回退 data URL
          url: input.deliveryRef || localFileDataUrl(input),
          mimeType: input.mimeType ?? 'application/octet-stream',
          durationSec: input.durationSec,
        }));
        // 方舟 2.5 omni 子任务映射：编辑锁 ratio=adaptive＋duration=-1，延长锁 ratio=adaptive（2.0 由适配器门掉不发送）
        const omniReferenceTaskType = context.generationMode === 'video-edit'
          ? 'edit' as const
          : context.generationMode === 'video-extend'
            ? 'extend' as const
            : 'reference' as const;
        const locksAdaptiveRatio = context.modelAlias === SEEDANCE_25 && (context.generationMode === 'video-edit' || context.generationMode === 'video-extend');
        if (signal?.aborted) throw new CanvasAdapterError('submit', '提交在生成请求前已中止，任务未提交。', { code: 'submit_aborted' });
        let submitted;
        try {
          submitted = await adapter.submitReference({
            model: capability.modelAlias,
            ...videoOutputOptions(context),
            prompt: context.prompt,
            references,
            durationSec: context.modelAlias === SEEDANCE_25 && context.generationMode === 'video-edit' ? -1 : Number(context.parameters.durationSec ?? 5),
            ...(locksAdaptiveRatio
              ? { aspectRatio: 'adaptive' }
              : context.parameters.aspectRatio ? { aspectRatio: String(context.parameters.aspectRatio) } : {}),
            omniReferenceTaskType,
          }, route.apiKey, route.baseUrl, signal);
        } catch (error) {
          throw submitError('submit', '外部视频提交请求失败，结果不明。', error, signal);
        }
        if (!submitted.providerTaskId) {
          throw new CanvasAdapterError('submit', '视频供应商没有返回任务 ID，提交结果不明。', {
            uncertain: true,
            code: 'video_task_id_missing',
          });
        }
        return { providerTaskId: submitted.providerTaskId };
      }

      // 图生视频：首帧必填，尾帧可选（方舟 role=first_frame／last_frame）
      const lastFrame = imageInputs.find((input) => input.role === 'last-frame');
      if (imageInputs.length > 1 && !lastFrame) {
        // 两张图都没有尾帧角色时，第二张在首帧合同里没有位置：显式失败，不静默丢掉一张素材
        throw new CanvasAdapterError(
          'prepare',
          '图生视频接入两张图片时，必须把其中一张的角色标为「尾帧」（严格首尾帧）；'
          + '只想提供参考图请改用「参考生成（参考图／音频）」模式，任务未提交。',
          { code: 'last_frame_role_required' },
        );
      }
      const firstFrame = imageInputs.find((input) => input !== lastFrame) ?? imageInputs[0];
      if (!firstFrame?.absolutePath || !firstFrame.mimeType) {
        throw new CanvasAdapterError(
          'prepare',
          '该视频供应商需要首帧图片：请把一个素材节点接到视频生成节点上。',
          { code: 'video_first_frame_required' },
        );
      }
      const request: SubmitVideoRequest = {
        model: capability.modelAlias,
        ...videoOutputOptions(context),
        prompt: context.prompt,
        sourceImagePath: firstFrame.absolutePath,
        sourceMimeType: firstFrame.mimeType as SubmitVideoRequest['sourceMimeType'],
        durationSec: Number(context.parameters.durationSec ?? 5),
        ...(lastFrame?.absolutePath && lastFrame.mimeType
          ? {
            tailImagePath: lastFrame.absolutePath,
            tailMimeType: lastFrame.mimeType as NonNullable<SubmitVideoRequest['tailMimeType']>,
          }
          : {}),
      };
      if (signal?.aborted) throw new CanvasAdapterError('submit', '提交在生成请求前已中止，任务未提交。', { code: 'submit_aborted' });
      let submitted;
      try {
        submitted = await adapter.submit(request, route.apiKey, route.baseUrl, signal);
      } catch (error) {
        throw submitError('submit', '外部视频提交请求失败，结果不明。', error, signal);
      }
      if (!submitted.providerTaskId) {
        throw new CanvasAdapterError('submit', '视频供应商没有返回任务 ID，提交结果不明。', {
          uncertain: true,
          code: 'video_task_id_missing',
        });
      }
      return { providerTaskId: submitted.providerTaskId };
    },

    async poll(context, signal): Promise<CanvasPollOutcome> {
      // 同步出图的供应商在 submit 阶段就已经拿到产物
      if (context.providerTaskId.startsWith('external-image:')) {
        return { status: 'succeeded' };
      }
      const route = routeFor(context);
      const adapter = getVideoAdapter(route.type);
      if (!adapter) {
        throw new CanvasAdapterError('poll', `没有 ${route.type} 类型的视频适配器。`, {
          code: 'video_adapter_missing',
        });
      }
      const result = await adapter.poll(context.providerTaskId, route.apiKey, route.baseUrl, signal);
      if (result.status === 'failed') {
        return { status: 'failed', code: 'external_video_failed', message: result.errorMessage ?? '视频生成失败' };
      }
      if (result.status === 'succeeded') return { status: 'succeeded' };
      return { status: result.status === 'processing' ? 'running' : 'pending' };
    },

    async download(context, signal) {
      if (context.providerTaskId.startsWith('external-image:')) {
        const tempPath = syncImageTempPath(storageRoot, context.task.canvasId, context.task.id);
        if (fs.existsSync(tempPath)) {
          return { bytes: fs.readFileSync(tempPath), mimeType: 'image/png' };
        }
        const resultUrl = readSyncImageUrlReceipt(storageRoot, context.task.canvasId, context.task.id);
        if (!resultUrl) {
          throw new CanvasAdapterError('download', '本地图片产物已不存在，请重新生成。', {
            code: 'external_result_file_missing',
          });
        }
        let response: Response;
        try {
          response = await fetchImpl(resultUrl, { signal: linkedTimeoutSignal(signal, 120_000) });
        } catch {
          throw new CanvasAdapterError('download', '外部图片产物下载请求失败。', {
            code: 'external_result_download_failed',
          });
        }
        if (!response.ok) {
          throw new CanvasAdapterError('download', `外部图片产物下载失败 ${response.status}。`, {
            code: 'external_result_download_failed',
          });
        }
        let bytes: ArrayBuffer;
        try {
          bytes = await response.arrayBuffer();
        } catch {
          throw new CanvasAdapterError('download', '外部图片产物响应读取失败。', {
            code: 'external_result_download_failed',
          });
        }
        try {
          writeAtomic(tempPath, Buffer.from(bytes));
        } catch {
          throw new CanvasAdapterError('download', '外部图片产物缓存失败。', {
            code: 'external_result_cache_failed',
          });
        }
        return { bytes: Buffer.from(bytes), mimeType: 'image/png' };
      }
      const route = routeFor(context);
      const adapter = getVideoAdapter(route.type);
      if (!adapter) {
        throw new CanvasAdapterError('download', `没有 ${route.type} 类型的视频适配器。`, {
          code: 'video_adapter_missing',
        });
      }
      const polled = await adapter.poll(context.providerTaskId, route.apiKey, route.baseUrl, signal);
      if (!polled.videoUrl) {
        throw new CanvasAdapterError('download', '视频供应商没有返回可下载地址。', {
          code: 'external_result_url_missing',
        });
      }
      const downloaded = await downloadGatewayMedia(polled.videoUrl, route.baseUrl, route.apiKey);
      if (!downloaded.ok) {
        throw new CanvasAdapterError(
          'download',
          `下载视频产物失败${downloaded.status ? `（${downloaded.status}）` : ''}：${downloaded.errorMessage}`,
          { code: 'external_download_failed' },
        );
      }
      let tailFrame: { bytes: Buffer; mimeType: string } | undefined;
      const tailUrl = (polled.rawResponse as { content?: { last_frame_url?: string } } | null)?.content?.last_frame_url;
      if (context.parameters.returnLastFrame === true && tailUrl) {
        const tail = await downloadGatewayMedia(tailUrl, route.baseUrl, route.apiKey);
        if (!tail.ok) throw new CanvasAdapterError('download', '返回尾帧下载失败，可重试下载', { code: 'tail_download_failed' });
        const format = (await sharp(tail.buffer).metadata()).format;
        tailFrame = { bytes: tail.buffer, mimeType: format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : 'image/jpeg' };
      }
      const outputFormat = (polled.rawResponse as { output_format?: string } | null)?.output_format ?? context.parameters.outputFormat;
      const brand = downloaded.buffer.subarray(8, 12).toString('latin1');
      const mimeType = brand === 'qt  ' ? 'video/quicktime' : ['isom', 'iso2', 'mp41', 'mp42', 'avc1'].includes(brand) ? 'video/mp4' : outputFormat === 'mov' ? 'video/quicktime' : 'video/mp4';
      const videoMetadata = sanitizeVideoMetadata(polled.rawResponse, context.parameters, context.modelAlias);
      videoMetadata.outputFormat = mimeType === 'video/quicktime' ? 'mov' : 'mp4';
      videoMetadata.referenceVideoDurationSec = generationStage(context.parameters) === 'final-from-draft'
        ? canvasVideoMetadataForAsset(db, String(context.parameters.draftAssetId ?? ''))?.referenceVideoDurationSec
        : context.inputs.filter((input) => input.kind === 'video').reduce((sum, input) => sum + (input.durationSec ?? 0), 0);
      return { bytes: downloaded.buffer, mimeType, videoMetadata, tailFrame };
    },
  };
}

function videoOutputOptions(context: CanvasTaskContext) {
  return {
    resolution: generationStage(context.parameters) === 'draft' ? '480p' : String(context.parameters.resolution ?? '1080p'),
    ...(generationStage(context.parameters) === 'draft' ? { draft: true } : {}),
    generateAudio: Boolean(context.parameters.withAudio ?? true),
    ...(context.parameters.outputFormat ? { outputFormat: context.parameters.outputFormat as 'mp4' | 'mov' } : {}),
    watermark: Boolean(context.parameters.watermark ?? false),
    returnLastFrame: Boolean(context.parameters.returnLastFrame ?? false),
  };
}
