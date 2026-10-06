import { videoDurationError } from '../../video-duration.ts';
/**
 * 公司执行器的画布适配器（技术约定 C6）。
 *
 * 与旧工作台共用同一批已验证原语（尺寸吸附、尾帧交付门禁、结果 URL 归一化、
 * 带鉴权下载），但按画布的统一请求重新表达：
 * - prepare 只做素材交付与输入校验，任何失败都在生成 POST 之前结束；
 * - submit 是可以精确计数的单次 POST，接收外部 AbortSignal；
 * - 公司自由创作按节点里显式写下的角色与提示词提交，**不自动叠加**旧场景工作流的
 *   「图1是底图、图2-N 是参考图」参考前缀（referenceGuidanceMode 恒为 none）。
 */

import sharp from 'sharp';
import type Database from 'better-sqlite3';
import { snapCompanyImageSize, companyImageCapsForModel, companyVideoCapsForModel, snapCompanyVideoSize } from '../../company-gateway-size.ts';
import { downloadGatewayMedia, normalizeGatewayResultUrl, sanitizeGatewayMediaDiagnostic } from '../../gateway-media-url.ts';
import { resolveGptImage2Size } from '../../gpt-image-2-size-presets.ts';
import { findCanvasCapability, type CanvasModelCapability } from '../capabilities.ts';
import {
  COMPANY_CANVAS_SEEDANCE_2_5_CAPABILITY,
  COMPANY_CANVAS_QINIUYUN_KLING_CAPABILITY,
  companyCanvasModelRequiresCos,
  companyCanvasSupportsTailFrame,
  companySeedanceResolutionOptions,
} from './company-capabilities.ts';
import { resolveCompanyCanvasRoute, type CanvasProviderRoute } from './company-providers.ts';
import { precheckCanvasDeliveryMedia, type CanvasMediaDeliverer } from './media-delivery.ts';
import {
  CanvasAdapterError,
  type CanvasDownloadOutcome,
  type CanvasPollOutcome,
  type CanvasResolvedInput,
  type CanvasSubmitOutcome,
  type CanvasTaskAdapter,
  type CanvasTaskContext,
} from './types.ts';

const SUBMIT_TIMEOUT_MS = 120_000;
const POLL_TIMEOUT_MS = 30_000;

interface GatewayVideoResponse {
  id?: string;
  status?: string;
  progress?: number;
  metadata?: { url?: string };
  output?: { url?: string };
  video?: { url?: string };
  result?: { video_url?: string; url?: string };
  video_url?: string;
  url?: string;
  error?: { code?: string; message?: string } | string;
}

function extractMediaUrl(data: GatewayVideoResponse): string | undefined {
  return data.metadata?.url
    ?? data.output?.url
    ?? data.video?.url
    ?? data.result?.video_url
    ?? data.result?.url
    ?? data.video_url
    ?? data.url
    ?? undefined;
}

function normalizeStatus(raw: string | undefined): CanvasPollOutcome['status'] {
  if (!raw) return 'pending';
  switch (raw.toLowerCase()) {
    case 'queued':
    case 'initializing':
    case 'pending':
      return 'pending';
    case 'in_progress':
    case 'downloading':
    case 'uploading':
    case 'processing':
    case 'running':
      return 'running';
    case 'completed':
    case 'succeeded':
    case 'success':
      return 'succeeded';
    case 'failed':
    case 'expired':
    case 'cancelled':
      return 'failed';
    default:
      return 'pending';
  }
}

function errorTextOf(data: GatewayVideoResponse): string {
  if (typeof data.error === 'string') return data.error;
  return data.error?.message ?? `任务状态 ${data.status ?? 'unknown'}`;
}

async function probeImageDimensions(filePath: string): Promise<{ width: number; height: number } | null> {
  try {
    const metadata = await sharp(filePath).metadata();
    return metadata.width && metadata.height ? { width: metadata.width, height: metadata.height } : null;
  } catch {
    return null;
  }
}

/** 没有底图时用请求比例构造吸附输入，避免文生视频被迫伪造首帧。 */
export function ratioToSnapDims(ratio: string | undefined): { width: number; height: number } | null {
  const match = /^(\d+):(\d+)$/.exec((ratio ?? '').trim());
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

export interface CompanyCanvasAdapterOptions {
  db: Database.Database;
  deliverer: CanvasMediaDeliverer;
  fetchImpl?: typeof fetch;
  submitTimeoutMs?: number;
  pollTimeoutMs?: number;
}

/**
 * 网关类执行器同时服务公司路由与外部（自建/第三方）OpenAI 风格网关：
 * 两者的提交协议一致，区别只在素材交付与公司专属参数（尺寸吸附、尾帧协议、渠道开关）。
 */
function findGatewayCapability(key: string): CanvasModelCapability {
  const capability = findCanvasCapability(key);
  if (!capability) {
    throw new CanvasAdapterError('prepare', `画布能力表里没有模型 ${key}，任务未提交。`, {
      code: 'capability_unavailable',
    });
  }
  if (capability.providerKind !== 'company') {
    // 外部供应商必须走 external 适配器；这里显式失败，避免用公司协议去发外部请求
    throw new CanvasAdapterError('prepare', `模型 ${key} 不是公司能力，应由外部适配器处理。`, {
      code: 'provider_kind_mismatch',
    });
  }
  return capability;
}

function isCompanyCapability(capability: CanvasModelCapability): boolean {
  return capability.providerKind === 'company';
}

function inputRuleFor(capability: CanvasModelCapability, input: CanvasResolvedInput) {
  const kind = input.kind === 'text' ? 'text' : input.kind;
  const candidates = capability.inputs.filter((rule) => rule.kind === kind);
  return candidates.find((rule) => rule.roles.includes(input.role)) ?? null;
}

function isFrameRole(role: string): boolean {
  return role === 'first-frame' || role === 'last-frame';
}

export function createCompanyCanvasAdapter(options: CompanyCanvasAdapterOptions): CanvasTaskAdapter {
  const { db, deliverer } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const submitTimeoutMs = options.submitTimeoutMs ?? SUBMIT_TIMEOUT_MS;
  const pollTimeoutMs = options.pollTimeoutMs ?? POLL_TIMEOUT_MS;

  const routeFor = (context: CanvasTaskContext): CanvasProviderRoute => resolveCompanyCanvasRoute(db, {
    providerIdentity: context.providerIdentity,
    modelAlias: context.modelAlias,
    mediaKind: context.mediaKind,
  });

  /** 组合外部停机信号与本地超时；任一触发都会中止请求。 */
  function composeSignal(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    // 已经中止的信号不会触发 abort 事件，必须显式判断，否则停机后仍会发出请求
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    return {
      signal: controller.signal,
      dispose: () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      },
    };
  }

  return {
    kind: 'company',

    async prepare(context, signal) {
      const capability = findGatewayCapability(context.capabilityKey);
      routeFor(context);

      const mediaInputs = context.inputs.filter((input) => input.kind !== 'text');
      // COS 强交付是公司渠道的红线；外部网关按自己的可达地址交付
      const requiresCos = isCompanyCapability(capability)
        && companyCanvasModelRequiresCos(capability.modelAlias);
      const hasTailRole = mediaInputs.some((input) => input.role === 'last-frame');

      for (const input of mediaInputs) {
        const rule = inputRuleFor(capability, input);
        if (!rule) {
          throw new CanvasAdapterError(
            'prepare',
            `输入 @${input.refId} 的类型或用途不被 ${capability.displayName} 接受，任务未提交。`,
            { code: 'input_not_supported' },
          );
        }
        if (!input.absolutePath || !input.mimeType || input.byteSize === null) {
          throw new CanvasAdapterError(
            'prepare',
            `输入 @${input.refId} 的本地文件不可用，任务未提交。`,
            { code: 'input_file_missing' },
          );
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
        // 尾帧必须走 COS（公司尾帧红线）；七牛渠道的所有素材都走 COS。
        const requireCos = requiresCos || (hasTailRole && isFrameRole(input.role));
        input.deliveryRef = await deliverer.deliver({
          kind: input.kind as 'image' | 'video' | 'audio',
          absolutePath: input.absolutePath,
          mimeType: input.mimeType,
          byteSize: input.byteSize,
          durationSec: input.durationSec,
          role: input.role,
          requireCos,
          isFrameImage: input.kind === 'image' && isFrameRole(input.role),
        }, signal);
      }

      // 尾帧声明必须落在已核验的精确别名内，否则不许提交（公司渠道专属约束）
      if (isCompanyCapability(capability) && hasTailRole && !companyCanvasSupportsTailFrame(capability.modelAlias)) {
        throw new CanvasAdapterError(
          'prepare',
          `模型 ${capability.modelAlias} 未核验尾帧协议，请移除尾帧参考或更换模型，任务未提交。`,
          { code: 'tail_frame_unsupported' },
        );
      }
    },

    async submit(context, signal) {
      const capability = findGatewayCapability(context.capabilityKey);
      const route = routeFor(context);
      const mediaInputs = context.inputs.filter((input) => input.kind !== 'text');
      const imageInputs = mediaInputs.filter((input) => input.kind === 'image');
      const imageRefs = imageInputs.map((input) => input.deliveryRef ?? '');
      if (imageRefs.some((ref) => !ref)) {
        throw new CanvasAdapterError('submit', '素材交付地址缺失，任务未提交。', { code: 'delivery_ref_missing' });
      }
      const lastFrameInput = imageInputs.find((input) => input.role === 'last-frame') ?? null;
      const lastFrameRef = lastFrameInput?.deliveryRef ?? null;
      // 可灵渠道尾帧走专用字段：尾帧不能同时留在 images 里（会被下游当参考图且比例落回默认值）
      const dedicatedTailField = lastFrameRef !== null
        && (lastFrameInput?.deliveryRef !== null)
        && (capability.modelAlias.startsWith('qiniuyun/kling') || capability.modelAlias === 'kling-3.0');
      const bodyImageInputs = dedicatedTailField
        ? imageInputs.filter((input) => input !== lastFrameInput)
        : imageInputs;
      const bodyImageRefs = bodyImageInputs.map((input) => input.deliveryRef ?? '');

      const body: Record<string, unknown> = {
        model: capability.modelAlias,
        prompt: context.prompt || '保持产品主体，自然运镜',
      };

      const companyModel = true;
      if (capability.mediaKind === 'image') {
        const companyCaps = companyModel ? companyImageCapsForModel(capability.modelAlias) : null;
        const requestedResolution = String(context.parameters.resolution ?? '2K');
        const requestedRatio = String(context.parameters.aspectRatio ?? '1:1');
        const presetSize = resolveGptImage2Size(requestedRatio, requestedResolution.toLowerCase()) ;
        body.size = companyCaps ? snapCompanyImageSize(presetSize === 'auto' ? null : presetSize, companyCaps) : presetSize;
        // response_format 是公司渠道的约定（七牛 png / 其余 jpeg）；外部网关不替它决定
        if (companyModel) {
          body.response_format = capability.modelAlias.startsWith('qiniuyun/') ? 'png' : 'jpeg';
        }
        // 无图输入时不发送 images：文生图不伪造占位底图
        if (bodyImageRefs.length > 0) body.images = bodyImageRefs;
      } else {
        if (bodyImageRefs.length > 0) body.images = bodyImageRefs;
        body.seconds = String(context.parameters.durationSec ?? 5);

        const isQiniuKling = companyModel
          && capability.modelAlias === COMPANY_CANVAS_QINIUYUN_KLING_CAPABILITY.modelAlias;
        const isSeedance = companyModel && capability.modelAlias.startsWith('doubao-seedance');
        const companyCaps = companyModel ? companyVideoCapsForModel(capability.modelAlias) : null;
        const durationSec = Number(context.parameters.durationSec ?? 5);
        if (isSeedance) {
          const problem = videoDurationError('openai-video', capability.modelAlias, durationSec);
          if (problem) throw new CanvasAdapterError('prepare', problem, { code: 'invalid_duration' });
          const resolutions = companySeedanceResolutionOptions(capability.modelAlias);
          const legacyFastDefault = capability.modelAlias === 'doubao-seedance-2-0-fast-260128' && context.parameters.resolution === 'gateway-default';
          if (!legacyFastDefault && context.parameters.resolution !== undefined && !resolutions.includes(String(context.parameters.resolution))) throw new CanvasAdapterError('prepare', '公司渠道尚未验证该分辨率', { code: 'invalid_resolution' });
        }

        if (!Number.isInteger(durationSec)) {
          throw new CanvasAdapterError('submit', '视频时长必须是整数秒，任务未提交。', { code: 'invalid_duration' });
        }
        if (isQiniuKling && (durationSec < 3 || durationSec > 15)) {
          throw new CanvasAdapterError('submit', '七牛可灵 3.0 时长必须为 3–15 秒，任务未提交。', { code: 'invalid_duration' });
        }

        const sourceDims = imageInputs[0]?.absolutePath
          ? await probeImageDimensions(imageInputs[0].absolutePath)
          : ratioToSnapDims(context.parameters.aspectRatio ? String(context.parameters.aspectRatio) : undefined);
        if (isQiniuKling && !sourceDims) {
          throw new CanvasAdapterError(
            'submit',
            '无法确定七牛可灵输出比例（既没有首帧尺寸，也没有显式比例），任务未提交。',
            { code: 'missing_output_ratio' },
          );
        }

        // 尾帧协议按精确别名分派（与 company-gateway-tail-frame 的 allowlist 一致）
        if (lastFrameRef) {
          if (isQiniuKling) {
            body.end_image_url = lastFrameRef;
          } else if (capability.modelAlias === 'kling-3.0') {
            body.LastFrameUrl = lastFrameRef;
          } else if (isSeedance && capability.modelAlias !== COMPANY_CANVAS_SEEDANCE_2_5_CAPABILITY.modelAlias) {
            body.images = [imageRefs[0], lastFrameRef];
          }
          // Seedance 2.5：双图按参考图模式提交，不声明严格首尾帧锚定
        }

        if (isQiniuKling) {
          body.mode = 'pro';
          body.generate_audio = true;
          const multiShot = context.parameters.multiShot === true;
          body.multi_shot = multiShot;
          if (multiShot) body.shot_type = 'intelligent';
        } else if (capability.modelAlias === 'kling-3.0') {
          body.response_format = 'mp4';
        }
        if (context.parameters.withAudio !== undefined) {
          body.generate_audio = context.parameters.withAudio === true;
        }

        if (companyModel && companyCaps) {
          if (lastFrameRef && capability.modelAlias === 'kling-3.0') {
            // 腾讯可灵尾帧分支：网关忽略 size，比例与时长走 OutputConfig
            const outputConfig: Record<string, unknown> = { Duration: durationSec };
            const snappedAspect = sourceDims && companyCaps
              ? snapCompanyVideoSize(sourceDims.width, sourceDims.height, companyCaps)
              : null;
            if (snappedAspect) outputConfig.Resolution = '1080P';
            if (context.parameters.aspectRatio) outputConfig.AspectRatio = String(context.parameters.aspectRatio);
            body.OutputConfig = outputConfig;
          } else if (sourceDims) {
            const snappedSize = snapCompanyVideoSize(sourceDims.width, sourceDims.height, companyCaps);
            if (snappedSize) body.size = snappedSize;
          }
        }
      }

      const composed = composeSignal(signal, submitTimeoutMs);
      try {
        const response = await fetchImpl(`${route.baseUrl}/v1/videos`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${route.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: composed.signal,
        });
        const text = await response.text();
        if (!response.ok) {
          throw new CanvasAdapterError(
            'submit',
            `公司网关提交失败 ${response.status}：${sanitizeGatewayMediaDiagnostic(text, route.apiKey).slice(0, 500)}`,
            { code: 'gateway_submit_rejected' },
          );
        }
        let parsed: GatewayVideoResponse;
        try {
          parsed = JSON.parse(text) as GatewayVideoResponse;
        } catch {
          throw new CanvasAdapterError('submit', '公司网关返回了非 JSON 响应，提交结果不明。', {
            uncertain: true,
            code: 'gateway_response_unparsable',
          });
        }
        const providerTaskId = parsed.id;
        if (!providerTaskId) {
          throw new CanvasAdapterError('submit', '公司网关没有返回任务 ID，提交结果不明。', {
            uncertain: true,
            code: 'gateway_task_id_missing',
          });
        }
        return { providerTaskId, raw: undefined } satisfies CanvasSubmitOutcome;
      } catch (error) {
        if (error instanceof CanvasAdapterError) throw error;
        // 网络中断／超时：请求可能已经送达，按待核查处理（保守保留名额、不自动重发）
        throw new CanvasAdapterError(
          'submit',
          `公司网关提交中断：${error instanceof Error ? error.message : String(error)}`,
          { uncertain: true, code: 'gateway_submit_uncertain' },
        );
      } finally {
        composed.dispose();
      }
    },

    async poll(context, signal) {
      const route = routeFor(context);
      const composed = composeSignal(signal, pollTimeoutMs);
      try {
        const response = await fetchImpl(`${route.baseUrl}/v1/videos/${context.providerTaskId}`, {
          headers: { Authorization: `Bearer ${route.apiKey}` },
          signal: composed.signal,
        });
        const text = await response.text();
        if (!response.ok) {
          // 4xx 视为确定性失败（任务不存在／被拒）；5xx 与网络错误交给下一轮重试
          if (response.status >= 400 && response.status < 500) {
            return {
              status: 'failed',
              code: 'gateway_task_query_rejected',
              message: `查询公司任务被拒绝（${response.status}）`,
            } satisfies CanvasPollOutcome;
          }
          throw new CanvasAdapterError('poll', `查询公司任务失败（${response.status}）`, {
            code: 'gateway_poll_failed',
          });
        }
        const parsed = JSON.parse(text) as GatewayVideoResponse;
        const status = normalizeStatus(parsed.status);
        if (status === 'failed') {
          return { status, code: 'gateway_task_failed', message: errorTextOf(parsed) };
        }
        return { status };
      } catch (error) {
        // 查询失败不改写远端身份：交给下一轮轮询重试
        throw new CanvasAdapterError(
          'poll',
          `查询公司任务失败：${error instanceof Error ? error.message : String(error)}`,
          { code: 'gateway_poll_failed' },
        );
      } finally {
        composed.dispose();
      }
    },

    async download(context, signal) {
      const route = routeFor(context);
      const query = await fetchImpl(`${route.baseUrl}/v1/videos/${context.providerTaskId}`, {
        headers: { Authorization: `Bearer ${route.apiKey}` },
      });
      const queryText = await query.text();
      let mediaUrl: string | undefined;
      if (query.ok) {
        const parsed = JSON.parse(queryText) as GatewayVideoResponse;
        mediaUrl = extractMediaUrl(parsed);
      }
      // 完成态常不带产物 URL：回退用提交时保存的原始任务 ID 拼 /content
      const resolved = normalizeGatewayResultUrl(
        mediaUrl ?? `${route.baseUrl}/v1/videos/${context.providerTaskId}/content`,
        route.baseUrl,
      );
      if (!resolved) {
        throw new CanvasAdapterError('download', '公司网关没有返回可下载的产物地址。', {
          code: 'gateway_result_url_missing',
        });
      }
      void signal;
      const downloaded = await downloadGatewayMedia(resolved, route.baseUrl, route.apiKey);
      if (!downloaded.ok) {
        throw new CanvasAdapterError(
          'download',
          `下载公司产物失败${downloaded.status ? `（${downloaded.status}）` : ''}：${downloaded.errorMessage}`,
          { code: 'gateway_download_failed' },
        );
      }
      return {
        bytes: downloaded.buffer,
        mimeType: context.mediaKind === 'image' ? 'image/png' : 'video/mp4',
      } satisfies CanvasDownloadOutcome;
    },
  };
}
