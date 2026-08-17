import { isCosMediaConfigured, tryUploadToCosAndSign } from './cos-media.ts';
import {
  assertProviderExecutionAvailable,
} from './provider-execution-gate.ts';
import type {
  CompanyProviderRuntimeStatus,
  InspectCompanyProviderRuntimeOptions,
} from './company-provider-runtime.ts';
import type { TailFrameCapability, TailFrameProtocol } from './video-providers/types.ts';

/**
 * 公司网关（本机 LiteLLM → 公司中转站 → 腾讯云 CreateAigcVideoTask）视频模型的
 * 尾帧精确映射。
 *
 * 合同（2026-08-17 免费字段探测 + 真实任务双重验证，详见
 * docs/2026-08-16-视频首尾帧-执行方案.md §4.2）：
 * - 网关把未翻译的字段原样透传给腾讯校验，参数错误在任务创建前 400 返回；
 *   因此腾讯原生 PascalCase 参数可直接使用。
 * - 可灵（kling-3.0）：首帧 images[0]，尾帧 LastFrameUrl，比例
 *   OutputConfig.AspectRatio。images[1] 会被下游当参考图（Reference），
 *   比例落回 16:9 默认值且末帧不收束——禁止用 images 双图表达可灵尾帧。
 * - 公司 Seedance（doubao-seedance-2-0(-fast)-260128）：images[1] 即尾帧，
 *   比例跟随图片，末帧收束，实测正确。
 * - 下游支持 SessionId 去重，但网关侧幂等键字段未核验，本轮不发送；
 *   providerTaskId 防重复与 submission_unknown 语义不变。
 *
 * 门禁（方案 D9）：公司尾帧只允许 本机回环 LiteLLM + COS 预签名 URL，
 * 首帧尾帧都必须走 COS，禁止回退本机/公网 URL；任一条件不满足在
 * POST /v1/videos 前失败关闭。
 */

/** 卡 0 核验的精确模型别名 → 尾帧协议；禁止宽泛正则，新增别名需独立证据 */
const COMPANY_TAIL_FRAME_MODEL_PROTOCOLS: Record<string, TailFrameProtocol> = {
  'kling-3.0': 'company-gateway-kling',
  'doubao-seedance-2-0-260128': 'company-gateway-seedance',
  'doubao-seedance-2-0-fast-260128': 'company-gateway-seedance',
};

export function companyGatewayTailFrameCapability(model: string): TailFrameCapability {
  const protocol = COMPANY_TAIL_FRAME_MODEL_PROTOCOLS[model];
  if (protocol) return { supported: true, protocol };
  return { supported: false, reason: 'contract_unverified' };
}

type RuntimeInspector = (
  options: InspectCompanyProviderRuntimeOptions,
) => Promise<CompanyProviderRuntimeStatus>;

let runtimeInspectorForTest: RuntimeInspector | null = null;

/** 测试专用：注入公司运行时检查器（仅脚本测试使用；生产路径不调用）。 */
export function _setCompanyTailFrameRuntimeInspectorForTest(inspector: RuntimeInspector | null): void {
  runtimeInspectorForTest = inspector;
}

/**
 * 公司尾帧传输门禁：回环 LiteLLM 地址 + sidecar 健康 + COS 可用，
 * 复用 provider execution gate 的 media 能力检查。任一不满足抛错，
 * 调用方不得在门禁失败后发出 /v1/videos 请求。
 */
export async function assertCompanyTailFrameTransport(baseUrl: string): Promise<void> {
  await assertProviderExecutionAvailable(
    {
      id: 'company-gateway-video',
      executionScope: 'company',
      baseUrl,
      enabled: true,
      configured: true,
    },
    {
      capability: 'media',
      mediaTransportAvailable: isCosMediaConfigured(),
      ...(runtimeInspectorForTest ? { inspectRuntime: runtimeInspectorForTest } : {}),
    },
  );
}

/**
 * 首帧 + 尾帧都上传 COS 并返回预签名 URL。公司尾帧禁止本机/公网 URL 兜底：
 * 任一图片上传失败直接抛错，调用方必须失败关闭、不得发出生成请求。
 */
export async function uploadCompanyTailFrameImages(
  sourceImagePath: string,
  tailImagePath: string,
  tailMimeType?: string,
): Promise<[string, string]> {
  let firstRef: string | null = null;
  try {
    firstRef = await tryUploadToCosAndSign(sourceImagePath);
  } catch (error) {
    throw new Error(`首帧图上传 COS 失败，公司尾帧任务未提交：${error instanceof Error ? error.message : error}`);
  }
  if (!firstRef) {
    throw new Error('首帧图上传 COS 未返回可用地址，公司尾帧任务未提交');
  }

  let tailRef: string | null = null;
  try {
    tailRef = await tryUploadToCosAndSign(tailImagePath, tailMimeType);
  } catch (error) {
    throw new Error(`尾帧图上传 COS 失败，公司尾帧任务未提交：${error instanceof Error ? error.message : error}`);
  }
  if (!tailRef) {
    throw new Error('尾帧图上传 COS 未返回可用地址，公司尾帧任务未提交');
  }

  return [firstRef, tailRef];
}
