import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { dataRoot } from './data-root.ts';
import { videoReferenceCapability } from './video-reference-contract.ts';
import { companyNativeVideoModel } from './company-gateway-video-models.ts';
import { DEFAULT_VIDEO_MAX_BYTES } from './cos-media.ts';
import { authorizeManagedFileRead, registerManagedFile } from './media-core/access-context.ts';

/**
 * 视频源图预处理合同（票 04，规格 §7）。
 *
 * 背景：创建阶段与队列阶段原先都按「原图上流上限」直接拒绝，11 MiB 的图在
 * 校验函数就被打回，永远进不了 COS 压缩。这里把两件事分开：
 *
 * 1. **本机原图保护**（`videoSourceImageLocalLimits`）——能不能安全读取/解码：
 *    文件大小、像素总量、可解码性、非动画。这些是保护本机的闸门，与上游无关。
 * 2. **上游交付预算**（`videoImageBudget`）——发往上游的派生副本必须满足的
 *    MIME / 字节 / 尺寸。预算按「供应商类型 + 精确模型 + 该图片在请求中的角色」
 *    确定，创建阶段与队列阶段共用同一份定义，避免两套阈值。
 *
 * 原图始终原样保存（字节、mtime、哈希都不动），只有超预算或格式不可交付时
 * 才物化派生副本到 `dataRoot()/storage/video-derivatives/`。该模型链路不允许
 * 「压缩失败就回退发送不合格原图」——压不到预算就抛 `budget_unreachable`。
 */

/** 上游交付预算：派生副本必须同时满足 MIME、字节与单边尺寸。 */
export interface VideoImageDeliveryBudget {
  /** 上游允许的 MIME 白名单。 */
  mimeTypes: readonly string[];
  /** 上游允许的最大字节数（严格 ≤）。 */
  maxBytes: number;
  /** 上游允许的最大单边像素；本机保护上限也用它兜底。 */
  maxDimension: number;
}

/** 图片在视频请求里的角色；三种角色预算不同（尾帧比首帧严）。 */
export type VideoImageRole = 'reference' | 'first-frame' | 'last-frame';

const MIB = 1024 * 1024;

/**
 * 腾讯 CreateAigcVideoTask 的两条硬限：FileInfos（首帧/参考图）≤10M，
 * LastFrameUrl（尾帧）<5M。取更小者并按 4.8MB 留余量（沿用既有 COS 阈值），
 * 见 docs/reference/公司网关与COS中转.md。
 */
const TENCENT_FIRST_FRAME_MAX_BYTES = 10 * MIB;
/** 复用 COS 的单一来源，别再写一份字面量。 */
const TENCENT_LAST_FRAME_MAX_BYTES = DEFAULT_VIDEO_MAX_BYTES;
/** 上游对图片单边的实际限制；公司网关实测 4096 内安全（沿用既有 COS MAX_DIM）。 */
const COMPANY_IMAGE_MAX_DIMENSION = 4_096;

/** 本机原图保护默认值：可安全解码的上限，与上游预算无关。 */
const DEFAULT_SOURCE_MAX_BYTES = 60 * MIB;
const DEFAULT_SOURCE_MAX_PIXELS = 80_000_000;

export interface VideoSourceImageLocalLimits {
  maxBytes: number;
  maxPixels: number;
}

function positiveIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt((process.env[name] || '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * 本机原图保护上限。环境变量只用于测试与现场排查；默认值按「本机能安全
 * 解码一张 8K 级图片」设定，远高于上游 10 MiB 预算。
 */
export function videoSourceImageLocalLimits(): VideoSourceImageLocalLimits {
  return {
    maxBytes: positiveIntEnv('CREATIVE_STUDIO_VIDEO_SOURCE_MAX_BYTES', DEFAULT_SOURCE_MAX_BYTES),
    maxPixels: positiveIntEnv('CREATIVE_STUDIO_VIDEO_SOURCE_MAX_PIXELS', DEFAULT_SOURCE_MAX_PIXELS),
  };
}

/**
 * 统一预算合同。只对规格 §7 覆盖的两个模型（`minimax-h3` / `wan-3.0`）
 * 返回严格预算；其他模型返回 `null`，调用方沿用各自既有处理行为——
 * 不许把本票的阈值扩散到所有图片供应商。
 */
export function videoImageBudget(
  providerType: string,
  model: string,
  role: VideoImageRole,
): VideoImageDeliveryBudget | null {
  if (providerType !== 'openai-video') return null;
  const contract = companyNativeVideoModel(model);
  if (!contract) return null;
  // 参考图预算来自共享能力表，避免这里再造一份 maxBytes。
  const capability = videoReferenceCapability(providerType, model);
  const referenceImageBudget = capability.supported ? capability.image : null;
  if (role === 'reference') {
    if (!referenceImageBudget) return null;
    return {
      mimeTypes: referenceImageBudget.mimeTypes,
      maxBytes: referenceImageBudget.maxBytes,
      maxDimension: COMPANY_IMAGE_MAX_DIMENSION,
    };
  }
  // 首帧/尾帧走腾讯 FileInfos / LastFrameUrl；两者的 MIME 合同一致。
  const mimeTypes = referenceImageBudget?.mimeTypes ?? ['image/jpeg', 'image/png'];
  return {
    mimeTypes,
    maxBytes: role === 'last-frame' ? TENCENT_LAST_FRAME_MAX_BYTES : TENCENT_FIRST_FRAME_MAX_BYTES,
    maxDimension: COMPANY_IMAGE_MAX_DIMENSION,
  };
}

export type VideoPreprocessErrorCode =
  | 'source_missing'
  | 'source_unreadable'
  | 'source_animated'
  | 'source_too_large'
  | 'source_pixels_exceeded'
  | 'budget_unreachable'
  | 'aborted';

/** 预处理失败一律带稳定错误码，调用方据此区分「拒绝」与「可重试」。 */
export class VideoPreprocessError extends Error {
  readonly code: VideoPreprocessErrorCode;

  constructor(code: VideoPreprocessErrorCode, message: string) {
    super(message);
    this.name = 'VideoPreprocessError';
    this.code = code;
  }
}

/** 调用方稳定判码的入口（避免跨模块 instanceof 因模块实例不同而失效）。 */
export function videoPreprocessErrorCode(error: unknown): VideoPreprocessErrorCode | null {
  if (error instanceof VideoPreprocessError) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return null;
  switch (code) {
    case 'source_missing':
    case 'source_unreadable':
    case 'source_animated':
    case 'source_too_large':
    case 'source_pixels_exceeded':
    case 'budget_unreachable':
    case 'aborted':
      return code;
    default:
      return null;
  }
}

/** 预处理结果：要么原样交付（`derived: false`），要么是已经验过的派生副本。 */
export interface PreparedVideoImage {
  /** 实际要发给上游的文件绝对路径。 */
  absolutePath: string;
  mimeType: string;
  byteSize: number;
  width: number;
  height: number;
  /** true 表示这一份是派生副本，原图未被改动。 */
  derived: boolean;
  /** 源图绝对路径（身份，永远指向原图）。 */
  sourcePath: string;
  /** 安全指标：只含字节与尺寸，供调用方写日志用；不含路径与签名。 */
  metrics: {
    sourceByteSize: number;
    sourceWidth: number;
    sourceHeight: number;
    deliveredByteSize: number;
    deliveredWidth: number;
    deliveredHeight: number;
    deliveredMimeType: string;
    derived: boolean;
  };
}

export interface PrepareVideoJobImageInput {
  providerType: string;
  model: string;
  role: VideoImageRole;
  absolutePath: string;
  /** 取消信号：读到一半被取消也要停，且不落派生物。 */
  signal?: AbortSignal;
  /** 测试/特殊链路用的显式覆盖预算；生产调用不传，走统一合同。 */
  budget?: VideoImageDeliveryBudget;
}

const DERIVATIVE_DIR = path.join('storage', 'video-derivatives');

// 有限、确定性的压缩阶梯：先按质量降，再按边长降。参数固定，不做自适应搜索，
// 保证同一输入 + 同一预算永远得到同一输出（内容指纹可复用）。
const QUALITY_LADDER = [92, 86, 78, 70, 62];
const DIMENSION_LADDER = [1, 0.75, 0.5, 0.375];

/** 同进程内对同一 (源图, 预算) 只编码一次，避免并发任务重复压缩。 */
const inFlight = new Map<string, Promise<PreparedVideoImage>>();

/**
 * 派生物保留策略（规格 §7「并发、取消与清理有界」）。
 *
 * 派生物按 (源图哈希, 预算) 内容寻址，同一张图重复用不会无限增长；但源图会累积，
 * 所以这里给一条确定性的有界回收：超过 `maxAgeMs` 且总量超过 `maxBytes` 时，
 * 从最旧的开始删，直到回落到上限。只删 `DERIVATIVE_DIR` 下的文件。
 *
 * 安全约束：
 * - **跳过正在进行中的编码**（`inFlight`），否则会删掉刚要交付的副本；
 * - 只碰 `dataRoot()/storage/video-derivatives`，绝不碰原图；
 * - 返回的统计只含数量与字节，不含路径或签名，可直接写日志。
 */
export interface VideoDerivativeCleanupResult {
  scanned: number;
  deleted: number;
  freedBytes: number;
}

export function cleanupVideoDerivatives(options: {
  maxAgeMs?: number;
  maxBytes?: number;
  now?: () => number;
} = {}): VideoDerivativeCleanupResult {
  const maxAgeMs = options.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024 * 1024;
  const now = options.now ?? Date.now;
  const dir = path.join(dataRoot(), DERIVATIVE_DIR);
  const result: VideoDerivativeCleanupResult = { scanned: 0, deleted: 0, freedBytes: 0 };
  let entries: import('node:fs').Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return result; // 目录还没建：无事可做。
  }
  const files = entries
    .filter((entry) => entry.isFile() && !entry.name.endsWith('.tmp'))
    .map((entry) => {
      const absolutePath = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(absolutePath);
        return { absolutePath, size: stat.size, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((item): item is { absolutePath: string; size: number; mtimeMs: number } => Boolean(item));
  result.scanned = files.length;
  let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  // 最旧的先删，保证回收结果与输入顺序无关（确定性）。
  for (const file of files.sort((left, right) => left.mtimeMs - right.mtimeMs)) {
    const tooOld = now() - file.mtimeMs > maxAgeMs;
    if (!tooOld && totalBytes <= maxBytes) break;
    if (inFlight.has(file.absolutePath)) continue; // 正在编码/交付，绝不删。
    try {
      fs.unlinkSync(file.absolutePath);
      result.deleted += 1;
      result.freedBytes += file.size;
      totalBytes -= file.size;
    } catch { /* 单个文件删不掉不影响其余回收 */ }
  }
  return result;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new VideoPreprocessError('aborted', '图片预处理已取消，任务未提交');
}

function mimeFromSharpFormat(format: string | undefined): string | null {
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'png') return 'image/png';
  if (format === 'webp') return 'image/webp';
  return null;
}

function extensionForMime(mimeType: string): string {
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/webp') return '.webp';
  return '.jpg';
}

interface SourceProbe {
  buffer: Buffer<ArrayBuffer>;
  mimeType: string | null;
  width: number;
  height: number;
  hasAlpha: boolean;
  byteSize: number;
}

/**
 * 读取并探测源图：本机保护闸门全部在这里。任何不可安全处理的情况都抛
 * 明确错误，绝不返回「将就用原图」的结果。
 */
async function probeSource(input: PrepareVideoJobImageInput): Promise<SourceProbe> {
  const limits = videoSourceImageLocalLimits();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(input.absolutePath);
  } catch {
    throw new VideoPreprocessError('source_missing', '源图文件不存在或无法读取，请重新选择有效的 PNG、JPEG 或 WebP 图片');
  }
  if (!stat.isFile()) {
    throw new VideoPreprocessError('source_missing', '源图路径不是普通文件，请重新选择有效的 PNG、JPEG 或 WebP 图片');
  }
  if (stat.size > limits.maxBytes) {
    throw new VideoPreprocessError(
      'source_too_large',
      `源图 ${(stat.size / MIB).toFixed(1)} MiB 超过本机可安全处理上限 ${Math.round(limits.maxBytes / MIB)} MiB，请先在本机压缩后再试`,
    );
  }
  throwIfAborted(input.signal);
  const buffer = (await fs.promises.readFile(input.absolutePath)) as Buffer<ArrayBuffer>;
  throwIfAborted(input.signal);

  let metadata: sharp.Metadata;
  try {
    // 本机保护：限制解码像素总量，防止解压炸弹。
    metadata = await sharp(buffer, { limitInputPixels: limits.maxPixels, failOn: 'error' }).metadata();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/pixel limit|limitInputPixels|too large/i.test(message)) {
      throw new VideoPreprocessError('source_pixels_exceeded', '源图像素总量超过本机可安全处理上限，请先缩放后再试');
    }
    throw new VideoPreprocessError('source_unreadable', '源图已损坏或格式不受支持，请重新选择有效的 PNG、JPEG 或 WebP 图片');
  }
  if (!metadata.width || !metadata.height) {
    throw new VideoPreprocessError('source_unreadable', '源图已损坏或格式不受支持，请重新选择有效的 PNG、JPEG 或 WebP 图片');
  }
  if (metadata.width * metadata.height > limits.maxPixels) {
    throw new VideoPreprocessError('source_pixels_exceeded', '源图像素总量超过本机可安全处理上限，请先缩放后再试');
  }
  if ((metadata.pages ?? 1) > 1) {
    throw new VideoPreprocessError('source_animated', '源图是多帧动画，视频生成只接受单帧图片，请先导出静帧');
  }

  return {
    buffer,
    mimeType: mimeFromSharpFormat(metadata.format),
    width: metadata.width,
    height: metadata.height,
    hasAlpha: Boolean(metadata.hasAlpha),
    byteSize: buffer.byteLength,
  };
}

/** 按预算选输出格式：优先保持 PNG 无损（有 alpha 时），否则 jpeg；都不允许时抛错。 */
function chooseOutputMimeType(budget: VideoImageDeliveryBudget, source: SourceProbe): string {
  if (source.hasAlpha && budget.mimeTypes.includes('image/png')) return 'image/png';
  if (budget.mimeTypes.includes('image/jpeg')) return 'image/jpeg';
  if (budget.mimeTypes.includes('image/png')) return 'image/png';
  if (budget.mimeTypes.includes('image/webp')) return 'image/webp';
  throw new VideoPreprocessError(
    'budget_unreachable',
    `上游只接受 ${budget.mimeTypes.join('、')}，源图格式无法转换为受支持格式，任务未提交`,
  );
}

async function encode(
  source: SourceProbe,
  mimeType: string,
  maxDimension: number,
  quality: number,
  signal: AbortSignal | undefined,
): Promise<{ buffer: Buffer<ArrayBuffer>; width: number; height: number }> {
  throwIfAborted(signal);
  let pipeline = sharp(source.buffer).rotate().resize({
    width: Math.max(1, Math.round(maxDimension)),
    height: Math.max(1, Math.round(maxDimension)),
    fit: 'inside',
    withoutEnlargement: true,
  });
  if (mimeType === 'image/jpeg') {
    // flatten 把透明通道压到白底：jpeg 不支持 alpha，否则 sharp 会报错或丢通道。
    pipeline = pipeline.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true });
  } else if (mimeType === 'image/png') {
    pipeline = pipeline.png({ compressionLevel: 9 });
  } else {
    pipeline = pipeline.webp({ quality, alphaQuality: quality });
  }
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  throwIfAborted(signal);
  return { buffer: data as Buffer<ArrayBuffer>, width: info.width, height: info.height };
}

/** 派生物内容寻址：同一源图内容 + 同一预算 → 同一文件名，天然幂等。 */
function derivativeKey(sourceHash: string, budget: VideoImageDeliveryBudget, mimeType: string): string {
  return crypto.createHash('sha256')
    .update(`${sourceHash}\0${budget.maxBytes}\0${budget.maxDimension}\0${mimeType}\0${budget.mimeTypes.join(',')}`)
    .digest('hex');
}

/**
 * 统一预处理入口：创建阶段和执行阶段**都必须**用这一个函数，避免两套阈值。
 *
 * 返回值语义：
 * - `null`：该模型没有严格预算（不属本票对象），调用方沿用既有行为。
 * - `{ derived: false }`：原图已经合规，直接用原图（不重编码）。
 * - `{ derived: true }`：派生副本已落盘并通过实际 MIME/字节/尺寸验证。
 *
 * 抛 `VideoPreprocessError`：不允许提交生成请求。该模型链路**不提供**
 * 「压缩失败回退原图」的兜底。
 */
export async function prepareVideoJobImage(
  input: PrepareVideoJobImageInput,
): Promise<{ prepared: PreparedVideoImage } | null> {
  const budget = input.budget
    ?? videoImageBudget(input.providerType, input.model, input.role);
  if (!budget) return null;

  throwIfAborted(input.signal);
  const source = await probeSource(input);
  const sourceHash = crypto.createHash('sha256').update(source.buffer).digest('hex');
  const sourceMimeType = source.mimeType;

  // 原图已经合规：原样交付，绝不为了「统一」而做无谓的有损重编码。
  if (
    sourceMimeType
    && budget.mimeTypes.includes(sourceMimeType)
    && source.byteSize <= budget.maxBytes
    && source.width <= budget.maxDimension
    && source.height <= budget.maxDimension
  ) {
    return {
      prepared: {
        absolutePath: input.absolutePath,
        mimeType: sourceMimeType,
        byteSize: source.byteSize,
        width: source.width,
        height: source.height,
        derived: false,
        sourcePath: input.absolutePath,
        metrics: {
          sourceByteSize: source.byteSize,
          sourceWidth: source.width,
          sourceHeight: source.height,
          deliveredByteSize: source.byteSize,
          deliveredWidth: source.width,
          deliveredHeight: source.height,
          deliveredMimeType: sourceMimeType,
          derived: false,
        },
      },
    };
  }

  const outputMimeType = chooseOutputMimeType(budget, source);
  const key = derivativeKey(sourceHash, budget, outputMimeType);
  const targetRelative = path.join(DERIVATIVE_DIR, `${key}${extensionForMime(outputMimeType)}`);
  const targetPath = path.join(dataRoot(), targetRelative);

  const cached = inFlight.get(targetPath);
  if (cached) return { prepared: await cached };

  const job = (async (): Promise<PreparedVideoImage> => {
    // 已物化过（例如上一个任务压过同一张图）：复用，并重新按磁盘字节验证一次。
    const reuse = await verifyExistingDerivative(targetPath, outputMimeType, budget, input.absolutePath);
    if (reuse) {
      // 复用命中同样要登记团队读取权限（规格 §7）：否则只有「本次新编码」的派生物
      // 有登记，复用路径会让团队上下文读不到既有副本。登记是幂等的。
      registerDerivativeForTeam(targetPath, reuse.mimeType, input.absolutePath);
      return reuse;
    }

    const result = await compressToBudget(source, budget, outputMimeType, input);
    const bytes = result.buffer;
    // 落盘：先写临时文件再原子改名，取消/失败不会留下半成品。
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const temporaryPath = `${targetPath}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, bytes);
      throwIfAborted(input.signal);
      fs.renameSync(temporaryPath, targetPath);
    } catch (error) {
      if (fs.existsSync(temporaryPath)) {
        try { fs.unlinkSync(temporaryPath); } catch { /* 清理失败不掩盖主错误 */ }
      }
      throw error;
    }

    // 落盘后按磁盘实际字节再验一次；指标只含格式/字节/尺寸，日志由调用方写。
    const onDisk = fs.readFileSync(targetPath);
    const verified = await verifyOutput(onDisk, outputMimeType, budget);
    registerDerivativeForTeam(targetPath, verified.mimeType, input.absolutePath);
    return {
      absolutePath: targetPath,
      mimeType: verified.mimeType,
      byteSize: verified.byteSize,
      width: verified.width,
      height: verified.height,
      derived: true,
      sourcePath: input.absolutePath,
      metrics: {
        sourceByteSize: source.byteSize,
        sourceWidth: source.width,
        sourceHeight: source.height,
        deliveredByteSize: verified.byteSize,
        deliveredWidth: verified.width,
        deliveredHeight: verified.height,
        deliveredMimeType: verified.mimeType,
        derived: true,
      },
    };
  })();

  inFlight.set(targetPath, job);
  try {
    return { prepared: await job };
  } finally {
    if (inFlight.get(targetPath) === job) inFlight.delete(targetPath);
  }
}

async function verifyExistingDerivative(
  targetPath: string,
  outputMimeType: string,
  budget: VideoImageDeliveryBudget,
  sourcePath: string,
): Promise<PreparedVideoImage | null> {
  if (!fs.existsSync(targetPath)) return null;
  try {
    const bytes = fs.readFileSync(targetPath);
    const verified = await verifyOutput(bytes, outputMimeType, budget);
    return {
      absolutePath: targetPath,
      mimeType: verified.mimeType,
      byteSize: verified.byteSize,
      width: verified.width,
      height: verified.height,
      derived: true,
      sourcePath,
      metrics: {
        sourceByteSize: 0,
        sourceWidth: 0,
        sourceHeight: 0,
        deliveredByteSize: verified.byteSize,
        deliveredWidth: verified.width,
        deliveredHeight: verified.height,
        deliveredMimeType: verified.mimeType,
        derived: true,
      },
    };
  } catch {
    // 磁盘上已有的同内容派生物不达标（例如预算收紧过）：删掉重做。
    try { fs.unlinkSync(targetPath); } catch { /* 忽略 */ }
    return null;
  }
}

/**
 * 团队模式下的派生物登记：派生副本必须挂到原图的 team_files 记录上，
 * 否则团队文件读取权限拿不到这份副本。local 模式下 `registerManagedFile`
 * 直接返回 null，不产生任何登记副作用。
 *
 * 失败不阻断主流程：登记是权限系统的事，图片本身已经验过并可用；
 * 但也不静默吞成"登记成功"——调用方按返回 null 走既有本地行为。
 */
function registerDerivativeForTeam(targetPath: string, mimeType: string, sourcePath: string): void {
  try {
    const sourceFileId = authorizeManagedFileRead(sourcePath)?.fileId ?? null;
    if (!sourceFileId) return;
    registerManagedFile({
      absolutePath: targetPath,
      mimeType,
      derivedFromFileId: sourceFileId,
    });
  } catch {
    // local 模式或非团队镜像：没有登记注入即视为无需登记。
  }
}

/** 按实际字节验证：MIME、字节数、尺寸都必须达标，否则不许交付。 */
async function verifyOutput(
  bytes: Buffer<ArrayBuffer>,
  expectedMimeType: string,
  budget: VideoImageDeliveryBudget,
): Promise<{ mimeType: string; byteSize: number; width: number; height: number }> {
  if (bytes.byteLength === 0) {
    throw new VideoPreprocessError('budget_unreachable', '压缩产物为空，任务未提交');
  }
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(bytes, { failOn: 'error' }).metadata();
  } catch {
    throw new VideoPreprocessError('budget_unreachable', '压缩产物无法解码，任务未提交');
  }
  const actualMimeType = mimeFromSharpFormat(metadata.format);
  if (!actualMimeType || actualMimeType !== expectedMimeType) {
    throw new VideoPreprocessError('budget_unreachable', '压缩产物格式与预期不一致，任务未提交');
  }
  if (!budget.mimeTypes.includes(actualMimeType)) {
    throw new VideoPreprocessError('budget_unreachable', `压缩产物格式 ${actualMimeType} 不被上游接受，任务未提交`);
  }
  if (bytes.byteLength > budget.maxBytes) {
    throw new VideoPreprocessError('budget_unreachable', `压缩产物 ${bytes.byteLength}B 仍超过上游 ${budget.maxBytes}B 预算，任务未提交`);
  }
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (!width || !height) {
    throw new VideoPreprocessError('budget_unreachable', '压缩产物尺寸无效，任务未提交');
  }
  if (width > budget.maxDimension || height > budget.maxDimension) {
    throw new VideoPreprocessError('budget_unreachable', `压缩产物 ${width}x${height} 超过上游单边 ${budget.maxDimension}px 上限，任务未提交`);
  }
  return { mimeType: actualMimeType, byteSize: bytes.byteLength, width, height };
}

/**
 * 有限、确定性的压缩阶梯：按固定顺序试 (质量 × 边长) 组合，第一个达标即返回。
 * 全部试完仍不达标就抛 `budget_unreachable`——绝不返回不合格结果。
 */
async function compressToBudget(
  source: SourceProbe,
  budget: VideoImageDeliveryBudget,
  outputMimeType: string,
  input: PrepareVideoJobImageInput,
): Promise<{ buffer: Buffer<ArrayBuffer> }> {
  for (const dimensionScale of DIMENSION_LADDER) {
    const maxDimension = Math.max(64, Math.round(budget.maxDimension * dimensionScale));
    for (const quality of QUALITY_LADDER) {
      throwIfAborted(input.signal);
      const encoded = await encode(source, outputMimeType, maxDimension, quality, input.signal);
      if (encoded.buffer.byteLength <= budget.maxBytes) return { buffer: encoded.buffer };
    }
  }
  // PNG 无质量档：单独再降一次边长，给无损格式留一条确定性出路。
  if (outputMimeType === 'image/png') {
    for (const maxDimension of [1024, 640, 320]) {
      throwIfAborted(input.signal);
      const encoded = await encode(source, outputMimeType, maxDimension, 100, input.signal);
      if (encoded.buffer.byteLength <= budget.maxBytes) return { buffer: encoded.buffer };
    }
  }
  throw new VideoPreprocessError(
    'budget_unreachable',
    `图片无法压到上游预算 ${Math.round(budget.maxBytes / MIB * 10) / 10} MiB / ${budget.maxDimension}px 内，任务未提交`,
  );
}

/** 测试与排查用：清空进程内去重表。 */
export function _resetVideoPreprocessStateForTest(): void {
  inFlight.clear();
}
