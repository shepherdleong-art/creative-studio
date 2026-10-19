import path from 'node:path';

export type MediaTransportKind = 'image' | 'video' | 'frame';

/**
 * 一次任务尝试允许传输的唯一媒体身份。Adapter 只能处理这里明确列出的文件，
 * 不能扫描项目、storage 或整个工作台目录。
 */
export interface MediaTransportInput {
  projectId: string;
  batchId: string;
  taskId: string;
  attemptId: string;
  assetId: string;
  mediaKind: MediaTransportKind;
  absolutePath: string;
  contentFingerprint: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * Adapter 返回的限时媒体句柄。opaqueUrl 只交给对应供应商 Adapter 使用，
 * Creative Studio 不推断它是 COS、预签名 URL 或专用上传接口。
 */
export interface PreparedMediaLease {
  id: string;
  transportId: string;
  opaqueUrl: string;
  contentFingerprint: string;
  issuedAt: string;
  expiresAt: string;
}

export interface MediaTransport {
  id: string;
  prepare(input: MediaTransportInput, options?: { signal?: AbortSignal }): Promise<PreparedMediaLease>;
  /** 必须幂等；成功、失败和取消路径都会调用。 */
  release(lease: PreparedMediaLease, options?: { signal?: AbortSignal }): Promise<void>;
}

function requiredIdentity(value: string, label: string): void {
  if (!value.trim() || value.length > 512) throw new Error(`${label} 无效`);
}

export function validateMediaTransportInput(input: MediaTransportInput): MediaTransportInput {
  requiredIdentity(input.projectId, 'projectId');
  requiredIdentity(input.batchId, 'batchId');
  requiredIdentity(input.taskId, 'taskId');
  requiredIdentity(input.attemptId, 'attemptId');
  requiredIdentity(input.assetId, 'assetId');
  if (!path.isAbsolute(input.absolutePath)) throw new Error('媒体传输只接受已核验的绝对路径');
  if (!/^sha256:[a-f0-9]{64}$/i.test(input.contentFingerprint)) {
    throw new Error('媒体传输必须使用完整 SHA-256 内容指纹');
  }
  if (!input.mimeType.trim() || input.mimeType.length > 255) throw new Error('媒体 MIME 类型无效');
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) throw new Error('媒体大小无效');
  return input;
}

function validatePreparedMediaLease(
  transport: MediaTransport,
  input: MediaTransportInput,
  lease: PreparedMediaLease,
  now: () => Date,
): void {
  requiredIdentity(lease.id, '媒体租约 ID');
  if (lease.transportId !== transport.id) throw new Error('媒体租约 Adapter 身份不一致');
  if (!lease.opaqueUrl.trim() || lease.opaqueUrl.length > 4096) throw new Error('媒体租约地址无效');
  if (lease.contentFingerprint !== input.contentFingerprint) throw new Error('媒体租约内容指纹不一致');
  const issuedAt = Date.parse(lease.issuedAt);
  const expiresAt = Date.parse(lease.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    throw new Error('媒体租约有效期无效');
  }
  const currentTime = now().getTime();
  if (!Number.isFinite(currentTime)) throw new Error('媒体租约校验时间无效');
  if (expiresAt <= currentTime) throw new Error('媒体租约已过期');
}

/**
 * 任务级租约生命周期：prepare 后无论使用成功、失败还是取消都 release。
 * release 使用独立清理调用，不沿用已经 aborted 的业务 signal。
 */
export async function withPreparedMediaLease<T>(
  transport: MediaTransport,
  rawInput: MediaTransportInput,
  consume: (lease: PreparedMediaLease) => Promise<T>,
  options: { signal?: AbortSignal; now?: () => Date } = {},
): Promise<T> {
  const input = validateMediaTransportInput(rawInput);
  options.signal?.throwIfAborted();
  const lease = await transport.prepare(input, { signal: options.signal });
  try {
    validatePreparedMediaLease(transport, input, lease, options.now ?? (() => new Date()));
    options.signal?.throwIfAborted();
    return await consume(lease);
  } finally {
    await transport.release(lease);
  }
}
