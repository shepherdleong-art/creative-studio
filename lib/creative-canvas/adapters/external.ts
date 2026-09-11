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

/** 多模态参考的两个入口：素材按角色进方舟 content 数组，不走首帧合同。 */
const REFERENCE_MODES: ReadonlyArray<CanvasGenerationMode> = ['video-to-video', 'reference-to-video'];

/** 方舟 2.0 系列的参考素材约束：视频／音频每段 2–15 秒，各类总时长不超过 15 秒。 */
const ARK_REFERENCE_SEGMENT_MIN_SEC = 2;
const ARK_REFERENCE_KIND_TOTAL_MAX_SEC = 15;
/** ffprobe 对「2 秒」素材可能报 1.98，留一点余量，避免把合规素材判成过短。 */
const REFERENCE_DURATION_TOLERANCE_SEC = 0.25;

function isReferenceMode(mode: CanvasGenerationMode): boolean {
  return REFERENCE_MODES.includes(mode);
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

/** 参考素材组合校验（方舟规则）：音频必须与图或视频同时出现；分段与分类总时长有上限。 */
function referenceCombinationProblems(inputs: CanvasResolvedInput[]): string[] {
  const problems: string[] = [];
  const videos = inputs.filter((input) => input.kind === 'video');
  const audios = inputs.filter((input) => input.kind === 'audio');
  const hasVisual = inputs.some((input) => input.kind === 'image' || input.kind === 'video');
  if (audios.length > 0 && !hasVisual) {
    problems.push('参考音频必须与参考图或参考视频同时出现');
  }
  const groups: Array<{ label: string; items: CanvasResolvedInput[] }> = [
    { label: '视频', items: videos },
    { label: '音频', items: audios },
  ];
  for (const group of groups) {
    for (const input of group.items) {
      const duration = input.durationSec;
      if (duration === null) continue;
      if (duration + REFERENCE_DURATION_TOLERANCE_SEC < ARK_REFERENCE_SEGMENT_MIN_SEC) {
        problems.push(`参考${group.label} @${input.refId} 时长 ${duration.toFixed(1)}s 短于 ${ARK_REFERENCE_SEGMENT_MIN_SEC}s 下限`);
      }
      if (duration > ARK_REFERENCE_KIND_TOTAL_MAX_SEC) {
        problems.push(`参考${group.label} @${input.refId} 时长 ${duration.toFixed(1)}s 超过 ${ARK_REFERENCE_KIND_TOTAL_MAX_SEC}s 上限`);
      }
    }
    const total = group.items.reduce((sum, input) => sum + (input.durationSec ?? 0), 0);
    if (total > ARK_REFERENCE_KIND_TOTAL_MAX_SEC + REFERENCE_DURATION_TOLERANCE_SEC) {
      problems.push(`参考${group.label}总时长 ${total.toFixed(1)}s 超过 ${ARK_REFERENCE_KIND_TOTAL_MAX_SEC}s 上限`);
    }
  }
  return problems;
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

async function decodeImageResponse(response: Response, fetchImpl: typeof fetch): Promise<Buffer> {
  const text = await response.text();
  if (!response.ok) {
    throw new CanvasAdapterError(
      'submit',
      `外部图片网关提交失败 ${response.status}：${sanitizeGatewayMediaDiagnostic(text, '').slice(0, 300)}`,
      { code: 'external_submit_rejected' },
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
  if (item?.url) {
    const downloaded = await fetchImpl(item.url, { signal: AbortSignal.timeout(120_000) });
    if (!downloaded.ok) {
      throw new CanvasAdapterError('submit', `外部图片产物下载失败 ${downloaded.status}。`, {
        code: 'external_result_download_failed',
      });
    }
    return Buffer.from(await downloaded.arrayBuffer());
  }
  throw new CanvasAdapterError('submit', '外部图片网关没有返回图片内容，提交结果不明。', {
    uncertain: true,
    code: 'external_result_missing',
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
        const problems = referenceCombinationProblems(mediaInputs);
        if (problems.length > 0) {
          throw new CanvasAdapterError(
            'prepare',
            `参考素材组合不合法：${problems.join('；')}，任务未提交。`,
            { code: 'reference_combination_invalid' },
          );
        }
      }
    },

    async submit(context, signal): Promise<CanvasSubmitOutcome> {
      const capability = capabilityFor(context.capabilityKey);
      const route = routeFor(context);
      const imageInputs = imageInputsOf(context);

      if (capability.mediaKind === 'image') {
        const size = candidateSizes(context.parameters);
        let response: Response;
        if (imageInputs.length === 0) {
          // 文生图：不伪造占位底图
          response = await fetchImpl(`${route.baseUrl}/v1/images/generations`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${route.apiKey}` },
            body: JSON.stringify({ model: capability.modelAlias, prompt: context.prompt, size, n: 1 }),
            signal: AbortSignal.timeout(submitTimeoutMs),
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
            signal: AbortSignal.timeout(submitTimeoutMs),
          });
        }
        const buffer = await decodeImageResponse(response, fetchImpl);
        const tempPath = syncImageTempPath(storageRoot, context.task.canvasId, context.task.id);
        fs.mkdirSync(path.dirname(tempPath), { recursive: true });
        fs.writeFileSync(tempPath, buffer);
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
        const submitted = await adapter.submitText({
          model: capability.modelAlias,
          prompt: context.prompt,
          durationSec: Number(context.parameters.durationSec ?? 5),
          ...(context.parameters.aspectRatio ? { aspectRatio: String(context.parameters.aspectRatio) } : {}),
        }, route.apiKey, route.baseUrl, signal);
        if (!submitted.providerTaskId) {
          throw new CanvasAdapterError('submit', '视频供应商没有返回任务 ID，提交结果不明。', {
            uncertain: true,
            code: 'video_task_id_missing',
          });
        }
        return { providerTaskId: submitted.providerTaskId };
      }

      // 视频生视频／带参考生成：多模态参考合同，素材按角色进 content 数组
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
        const submitted = await adapter.submitReference({
          model: capability.modelAlias,
          prompt: context.prompt,
          references,
          durationSec: Number(context.parameters.durationSec ?? 5),
          ...(context.parameters.aspectRatio ? { aspectRatio: String(context.parameters.aspectRatio) } : {}),
        }, route.apiKey, route.baseUrl, signal);
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
      const submitted = await adapter.submit(request, route.apiKey, route.baseUrl, signal);
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
        if (!fs.existsSync(tempPath)) {
          throw new CanvasAdapterError('download', '本地图片产物已不存在，请重新生成。', {
            code: 'external_result_file_missing',
          });
        }
        return { bytes: fs.readFileSync(tempPath), mimeType: 'image/png' };
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
      return { bytes: downloaded.buffer, mimeType: 'video/mp4' };
    },
  };
}
