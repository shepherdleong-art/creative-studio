import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Session } from 'electron';

export interface TeamFileDownloadManifest {
  fileId: string;
  seriesId: string;
  version: number;
  size: number;
  sha256: string;
  etag: string;
  displayName: string;
}

export interface RemoteUploadTarget {
  resourceType: string;
  resourceId: string;
  targetKind?: string;
}

type TransferKind = 'upload' | 'download';
type TransferState = 'queued' | 'running' | 'paused' | 'ready' | 'failed' | 'cancelled';
type PauseReason = 'identity' | 'manual' | 'update';

interface TransferRecord {
  id: string;
  kind: TransferKind;
  state: TransferState;
  pauseReason?: PauseReason;
  failureCode?: string;
  sourcePath?: string;
  sourceFingerprint?: string;
  expectedSha256?: string;
  expectedSize?: number;
  relativeName?: string;
  mimeType?: string;
  idempotencyKey?: string;
  target?: RemoteUploadTarget;
  uploadId?: string;
  partSize?: number;
  missingParts?: number[];
  manifest?: TeamFileDownloadManifest;
  localPath?: string;
  partPath?: string;
  serverDeviceId?: string;
}

interface AccountState {
  schemaVersion: 1;
  serverDeviceId?: string;
  transfers: TransferRecord[];
}

export interface PublicTransfer {
  id: string;
  kind: TransferKind;
  state: TransferState;
  pauseReason?: PauseReason;
  failureCode?: string;
  uploadId?: string;
  downloadId?: string;
  fileId?: string;
  displayName?: string;
}

interface RemoteTransferOptions {
  origin: string;
  deploymentId: string;
  stateRoot: string;
  session: Pick<Session, 'fetch' | 'cookies' | 'clearCache' | 'clearStorageData'>;
  platform: 'windows' | 'macos';
  reveal: (absolutePath: string) => void | Promise<void>;
}

const MANAGED_ID = /^[a-f0-9-]{36}$/;

function updateHashWithFile(hash: ReturnType<typeof createHash>, filePath: string): void {
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally { fs.closeSync(fd); }
}

function hashFile(filePath: string): string {
  const hash = createHash('sha256');
  updateHashWithFile(hash, filePath);
  return hash.digest('hex');
}

function atomicJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  fs.renameSync(temporary, filePath);
}

function emptyAccount(): AccountState {
  return { schemaVersion: 1, transfers: [] };
}

function safeDisplayName(value: string): string {
  if (!value || value.length > 255 || value !== path.basename(value) || /[\\/:\u0000-\u001f]/.test(value)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value) || /[. ]$/.test(value)) {
    throw new Error('交付文件名无效');
  }
  return value;
}

function transferFailure(error: unknown): string {
  if (error && typeof error === 'object' && typeof (error as NodeJS.ErrnoException).code === 'string') {
    return (error as NodeJS.ErrnoException).code!;
  }
  const message = error instanceof Error ? error.message : 'transfer_failed';
  if (message.length <= 200 && !/(?:[A-Za-z]:[\\/]|^\/|\\\\)/.test(message)) return message;
  return 'transfer_failed';
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export class RemoteTransferController {
  private readonly origin: string;
  private readonly deploymentId: string;
  private readonly stateRoot: string;
  private readonly session: RemoteTransferOptions['session'];
  private readonly platform: 'windows' | 'macos';
  private readonly reveal: RemoteTransferOptions['reveal'];
  private readonly clientDeviceId: string;
  private accountKey: string | null = null;
  private currentUserId: string | null = null;
  private account: AccountState = emptyAccount();
  private readonly running = new Map<string, Promise<void>>();
  private readonly aborts = new Map<string, AbortController>();
  private updateBlocked = false;
  private synchronizing: Promise<void> | null = null;
  private csrfToken: string | null = null;

  constructor(options: RemoteTransferOptions) {
    this.origin = new URL(options.origin).origin;
    this.deploymentId = options.deploymentId;
    this.stateRoot = path.resolve(options.stateRoot);
    this.session = options.session;
    this.platform = options.platform;
    this.reveal = options.reveal;
    const devicePath = path.join(this.stateRoot, 'device.json');
    let existing: { clientDeviceId?: string } = {};
    if (fs.existsSync(devicePath)) {
      try { existing = JSON.parse(fs.readFileSync(devicePath, 'utf8')) as { clientDeviceId?: string }; } catch { /* regenerate corrupt local identity */ }
    }
    this.clientDeviceId = existing.clientDeviceId && MANAGED_ID.test(existing.clientDeviceId)
      ? existing.clientDeviceId : randomUUID();
    if (this.clientDeviceId !== existing.clientDeviceId) atomicJson(devicePath, { schemaVersion: 1, clientDeviceId: this.clientDeviceId });
  }

  private keyFor(userId: string): string {
    return createHash('sha256').update(`${this.deploymentId}\n${this.origin}\n${userId}\n${this.clientDeviceId}`).digest('hex');
  }

  private accountRoot(key = this.accountKey): string {
    if (!key) throw new Error('尚未建立账号传输上下文');
    return path.join(this.stateRoot, 'accounts', key);
  }

  private accountPath(key = this.accountKey): string {
    return path.join(this.accountRoot(key), 'transfers.json');
  }

  private loadAccount(key: string): AccountState {
    const filePath = this.accountPath(key);
    if (!fs.existsSync(filePath)) return emptyAccount();
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as AccountState;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.transfers)) throw new Error('本机客户端传输状态不兼容');
    return parsed;
  }

  private save(): void {
    if (!this.accountKey) return;
    atomicJson(this.accountPath(), this.account);
  }

  private publicRecord(record: TransferRecord): PublicTransfer {
    return {
      id: record.id,
      kind: record.kind,
      state: record.state,
      pauseReason: record.pauseReason,
      failureCode: record.failureCode,
      uploadId: record.kind === 'upload' ? record.uploadId : undefined,
      downloadId: record.kind === 'download' ? record.id : undefined,
      fileId: record.manifest?.fileId,
      displayName: record.relativeName ?? record.manifest?.displayName,
    };
  }

  listTransfers(): PublicTransfer[] {
    return this.account.transfers.map((record) => this.publicRecord(record));
  }

  private requireRecord(id: string, kind?: TransferKind): TransferRecord {
    if (typeof id !== 'string' || !MANAGED_ID.test(id)) throw new Error('只接受受管传输或下载 ID');
    const record = this.account.transfers.find((candidate) => candidate.id === id && (!kind || candidate.kind === kind));
    if (!record) throw new Error('受管传输或下载 ID 不存在');
    return record;
  }

  private async cookieHeader(): Promise<string> {
    const cookies = await this.session.cookies.get({ url: this.origin });
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  }

  private async request(pathname: string, options: {
    method?: string;
    body?: Uint8Array | string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    csrf?: boolean;
  } = {}): Promise<Response> {
    const method = options.method ?? 'GET';
    const headers: Record<string, string> = {
      accept: 'application/json, application/octet-stream',
      cookie: await this.cookieHeader(),
      ...options.headers,
    };
    if (method !== 'GET' && method !== 'HEAD') {
      headers.origin = this.origin;
      if (options.csrf !== false) headers['x-csrf-token'] = await this.ensureCsrf(options.signal);
    }
    const fetchPromise = this.session.fetch(`${this.origin}${pathname}`, {
      method,
      headers,
      body: options.body as BodyInit | null | undefined,
      signal: options.signal,
      cache: 'no-store',
      redirect: 'error',
      credentials: 'include',
    });
    const response = options.signal
      ? await Promise.race([
        fetchPromise,
        new Promise<never>((_, reject) => {
          if (options.signal!.aborted) reject(new DOMException('Aborted', 'AbortError'));
          else options.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
        }),
      ])
      : await fetchPromise;
    if (!response.ok) throw new Error(`传输请求失败（HTTP ${response.status}）`);
    return response;
  }

  private async ensureCsrf(signal?: AbortSignal): Promise<string> {
    if (this.csrfToken) return this.csrfToken;
    const response = await this.request('/api/team/auth/csrf', { signal, csrf: false });
    const body = await response.json() as { csrfToken?: unknown };
    if (typeof body.csrfToken !== 'string' || !body.csrfToken) throw new Error('无法建立安全写入会话');
    this.csrfToken = body.csrfToken;
    return this.csrfToken;
  }

  private pauseForIdentity(): void {
    for (const record of this.account.transfers) {
      if (record.state === 'ready' || record.state === 'cancelled') continue;
      record.state = 'paused';
      record.pauseReason = 'identity';
      this.aborts.get(record.id)?.abort();
    }
    if (this.accountKey) this.save();
  }

  async synchronizeIdentity(): Promise<void> {
    if (this.synchronizing) return this.synchronizing;
    this.synchronizing = (async () => {
      const response = await this.request('/api/team/auth/session', { csrf: false });
      const body = await response.json() as { authenticated?: boolean; user?: { id?: unknown } };
      const userId = body.authenticated && typeof body.user?.id === 'string' ? body.user.id : null;
      if (userId === this.currentUserId) return;
      const previousKey = this.accountKey;
      if (previousKey) this.pauseForIdentity();
      this.csrfToken = null;
      this.currentUserId = userId;
      if (!userId) {
        this.accountKey = null;
        this.account = emptyAccount();
        return;
      }
      const nextKey = this.keyFor(userId);
      if (previousKey && previousKey !== nextKey) {
        await this.session.clearCache();
        await this.session.clearStorageData({
          storages: ['cachestorage', 'serviceworkers', 'indexdb', 'localstorage'],
        });
      }
      this.accountKey = nextKey;
      this.account = this.loadAccount(nextKey);
      if (!this.updateBlocked) this.resumeReason('identity');
    })();
    try { await this.synchronizing; } finally { this.synchronizing = null; }
  }

  private track(record: TransferRecord, operation: () => Promise<void>): void {
    if (this.running.has(record.id) || record.state !== 'queued' || this.updateBlocked || !this.accountKey) return;
    const key = this.accountKey;
    const abort = new AbortController();
    this.aborts.set(record.id, abort);
    record.state = 'running';
    this.save();
    const promise = operation()
      .then(() => {
        if (record.state !== 'ready' && record.state !== 'cancelled' && record.state !== 'paused') {
          record.state = 'ready';
          delete record.pauseReason;
        }
      })
      .catch((error: unknown) => {
        if (record.state === 'paused' || record.state === 'cancelled' || abort.signal.aborted) return;
        record.state = 'failed';
        record.failureCode = transferFailure(error);
      })
      .finally(() => {
        this.aborts.delete(record.id);
        this.running.delete(record.id);
        if (key === this.accountKey) this.save();
        else {
          const previous = this.account;
          const previousKey = this.accountKey;
          try { this.accountKey = key; this.account = this.loadAccount(key); this.save(); }
          finally { this.account = previous; this.accountKey = previousKey; }
        }
      });
    this.running.set(record.id, promise);
  }

  async waitForIdle(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running.values()]);
  }

  private requireActive(): void {
    if (!this.currentUserId || !this.accountKey) throw new Error('请先登录后再传输');
    if (this.updateBlocked) throw new Error('客户端更新期间传输已暂停');
  }

  async createUploads(filePaths: string[], target: RemoteUploadTarget): Promise<string[]> {
    this.requireActive();
    if (!Array.isArray(filePaths) || filePaths.length < 1 || filePaths.length > 100) throw new Error('上传文件数量无效');
    if (!target || typeof target.resourceType !== 'string' || typeof target.resourceId !== 'string') throw new Error('上传目标无效');
    const ids: string[] = [];
    for (const selected of filePaths) {
      const sourcePath = path.resolve(selected);
      const stat = fs.statSync(sourcePath);
      if (!stat.isFile()) throw new Error('只能上传本机普通文件');
      const expectedSha256 = hashFile(sourcePath);
      const record: TransferRecord = {
        id: randomUUID(), kind: 'upload', state: 'queued', sourcePath,
        sourceFingerprint: `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
        expectedSha256, expectedSize: stat.size, relativeName: path.basename(sourcePath),
        mimeType: 'application/octet-stream', idempotencyKey: randomUUID(), target: { ...target },
      };
      this.account.transfers.push(record);
      ids.push(record.id);
      this.save();
      this.track(record, () => this.runUpload(record));
    }
    return ids;
  }

  private async runUpload(record: TransferRecord): Promise<void> {
    const abort = this.aborts.get(record.id)!;
    const stat = fs.statSync(record.sourcePath!);
    const fingerprint = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (fingerprint !== record.sourceFingerprint) throw new Error('源文件已变化，请重新上传');
    if (!record.uploadId) {
      const response = await this.request('/api/team/uploads', {
        method: 'POST', signal: abort.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          target: record.target, targetKind: record.target?.targetKind,
          deviceId: await this.serverDeviceId(abort.signal),
          relativeName: record.relativeName, mimeType: record.mimeType,
          usage: record.target?.targetKind === 'project_image' ? 'image'
            : record.target?.targetKind === 'batch_asset' ? 'batch_asset'
              : record.target?.targetKind === 'canvas_asset' ? 'canvas_asset'
                : record.target?.targetKind === 'detail_page_source' ? 'detail_page' : 'input',
          expectedSize: record.expectedSize, expectedSha256: record.expectedSha256,
          sourceFingerprint: record.sourceFingerprint, idempotencyKey: record.idempotencyKey,
        }),
      });
      const body = await response.json() as { uploadId?: unknown; partSize?: unknown; missingParts?: unknown };
      if (typeof body.uploadId !== 'string' || typeof body.partSize !== 'number' || !Array.isArray(body.missingParts)) {
        throw new Error('上传登记响应无效');
      }
      record.uploadId = body.uploadId;
      record.partSize = body.partSize;
      record.missingParts = body.missingParts.filter((part): part is number => Number.isSafeInteger(part));
      this.save();
    }
    const fd = fs.openSync(record.sourcePath!, 'r');
    try {
      for (const part of record.missingParts ?? []) {
        if (abort.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const length = Math.min(record.partSize!, record.expectedSize! - (part - 1) * record.partSize!);
        const bytes = Buffer.allocUnsafe(length);
        fs.readSync(fd, bytes, 0, length, (part - 1) * record.partSize!);
        await this.request(`/api/team/uploads/${encodeURIComponent(record.uploadId)}/parts/${part}`, {
          method: 'PUT', signal: abort.signal, body: bytes,
          headers: { 'content-type': 'application/octet-stream' },
        });
        record.missingParts = record.missingParts!.filter((candidate) => candidate !== part);
        this.save();
      }
    } finally { fs.closeSync(fd); }
    if (hashFile(record.sourcePath!) !== record.expectedSha256) {
      throw new Error('源文件已变化，请重新上传');
    }
    await this.request(`/api/team/uploads/${encodeURIComponent(record.uploadId)}/complete`, {
      method: 'POST', signal: abort.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedSha256: record.expectedSha256, sourceFingerprint: record.sourceFingerprint }),
    });
    record.state = 'ready';
    delete record.pauseReason;
  }

  private async serverDeviceId(signal?: AbortSignal): Promise<string> {
    if (this.account.serverDeviceId) return this.account.serverDeviceId;
    const response = await this.request('/api/team/devices', {
      method: 'POST', signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientDeviceId: this.clientDeviceId, displayName: 'Creative Studio 轻客户端', platform: this.platform,
      }),
    });
    const body = await response.json() as { id?: unknown };
    if (typeof body.id !== 'string' || !body.id) throw new Error('设备登记响应无效');
    this.account.serverDeviceId = body.id;
    this.save();
    return body.id;
  }

  async createDownloads(manifests: TeamFileDownloadManifest[]): Promise<string[]> {
    this.requireActive();
    if (!Array.isArray(manifests)) throw new Error('下载清单无效');
    const ids: string[] = [];
    for (const manifest of manifests) {
      if (!manifest || typeof manifest.fileId !== 'string' || !Number.isSafeInteger(manifest.size) || manifest.size < 0
        || !/^[a-f0-9]{64}$/.test(manifest.sha256) || !Number.isSafeInteger(manifest.version) || manifest.version < 1) {
        throw new Error('下载清单无效');
      }
      const displayName = safeDisplayName(manifest.displayName);
      const existing = this.account.transfers.find((record) => record.kind === 'download'
        && record.manifest?.fileId === manifest.fileId && record.manifest.version === manifest.version
        && record.state !== 'cancelled');
      if (existing) { ids.push(existing.id); continue; }
      const id = randomUUID();
      const directory = path.join(this.accountRoot(), 'downloads', id);
      const record: TransferRecord = {
        id, kind: 'download', state: 'queued', manifest: { ...manifest, displayName },
        localPath: path.join(directory, displayName), partPath: path.join(directory, `${displayName}.part`),
      };
      this.account.transfers.push(record);
      ids.push(id);
      this.save();
      this.track(record, () => this.runDownload(record));
    }
    return ids;
  }

  private async runDownload(record: TransferRecord): Promise<void> {
    const manifest = record.manifest!;
    const abort = this.aborts.get(record.id)!;
    fs.mkdirSync(path.dirname(record.partPath!), { recursive: true });
    let offset = fs.existsSync(record.partPath!) ? fs.statSync(record.partPath!).size : 0;
    if (offset > manifest.size) { fs.rmSync(record.partPath!); offset = 0; }
    const headers: Record<string, string> = {};
    if (offset > 0) { headers.range = `bytes=${offset}-`; headers['if-range'] = manifest.etag; }
    const response = await this.request(`/api/team/files/${encodeURIComponent(manifest.fileId)}`, {
      signal: abort.signal, headers,
    });
    if (offset > 0 && response.status !== 206) { fs.rmSync(record.partPath!); offset = 0; }
    if (offset === 0 && response.status !== 200 && response.status !== 206) throw new Error('下载响应无效');
    if (!response.body) throw new Error('下载响应没有内容');
    const fd = fs.openSync(record.partPath!, offset > 0 ? 'a' : 'w');
    const hash = createHash('sha256');
    if (offset > 0) updateHashWithFile(hash, record.partPath!);
    let total = offset;
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > manifest.size) throw new Error('下载内容超过清单大小');
        fs.writeSync(fd, value);
        hash.update(value);
      }
    } finally { fs.closeSync(fd); }
    if (total !== manifest.size || hash.digest('hex') !== manifest.sha256) throw new Error('下载哈希校验失败');
    fs.copyFileSync(record.partPath!, record.localPath!, fs.constants.COPYFILE_EXCL);
    fs.rmSync(record.partPath!);
    await this.request('/api/team/downloads/receipts', {
      method: 'POST', signal: abort.signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: await this.serverDeviceId(abort.signal), fileId: manifest.fileId,
        artifactVersion: manifest.version, state: 'completed', etag: manifest.etag, verifiedSha256: manifest.sha256,
      }),
    });
    record.state = 'ready';
  }

  async syncDeliveries(): Promise<string[]> {
    this.requireActive();
    const deviceId = await this.serverDeviceId();
    const response = await this.request(`/api/team/downloads?deviceId=${encodeURIComponent(deviceId)}`);
    const body = await response.json() as {
      items?: Array<{ manifest?: TeamFileDownloadManifest; deliveryState?: string }>;
    };
    if (!Array.isArray(body.items)) throw new Error('设备交付清单响应无效');
    const manifests = body.items
      .filter((item) => item.deliveryState !== 'suppressed' && item.manifest)
      .map((item) => item.manifest!);
    return this.createDownloads(manifests);
  }

  async revealDownload(downloadId: string): Promise<boolean> {
    const record = this.requireRecord(downloadId, 'download');
    if (record.state !== 'ready' || !record.localPath || !fs.existsSync(record.localPath)) throw new Error('下载尚未完成或文件不存在');
    const downloadsRoot = path.join(this.accountRoot(), 'downloads');
    if (!contained(downloadsRoot, record.localPath)) throw new Error('只允许定位受管下载目录内的文件');
    await this.reveal(record.localPath);
    return true;
  }

  pauseTransfer(id: string): void {
    const record = this.requireRecord(id);
    if (record.state === 'ready' || record.state === 'cancelled') return;
    record.state = 'paused';
    record.pauseReason = 'manual';
    this.aborts.get(id)?.abort();
    this.save();
  }

  resumeTransfer(id: string): void {
    const record = this.requireRecord(id);
    if (record.state !== 'paused' && record.state !== 'failed') return;
    record.state = 'queued';
    delete record.pauseReason;
    delete record.failureCode;
    this.save();
    this.track(record, () => record.kind === 'upload' ? this.runUpload(record) : this.runDownload(record));
  }

  async cancelTransfer(id: string): Promise<void> {
    const record = this.requireRecord(id);
    record.state = 'cancelled';
    this.aborts.get(id)?.abort();
    if (record.kind === 'upload' && record.uploadId) {
      await this.request(`/api/team/uploads/${encodeURIComponent(record.uploadId)}`, { method: 'DELETE' });
    }
    if (record.partPath && fs.existsSync(record.partPath)) fs.rmSync(record.partPath);
    this.save();
  }

  private resumeReason(reason: PauseReason): void {
    for (const record of this.account.transfers) {
      if (record.state !== 'paused' || record.pauseReason !== reason) continue;
      record.state = 'queued';
      delete record.pauseReason;
      this.track(record, () => record.kind === 'upload' ? this.runUpload(record) : this.runDownload(record));
    }
    this.save();
  }

  async pauseForUpdate(): Promise<void> {
    if (this.updateBlocked) {
      await this.waitForIdle();
      return;
    }
    this.updateBlocked = true;
    for (const record of this.account.transfers) {
      if (record.state === 'ready' || record.state === 'cancelled' || record.pauseReason === 'manual') continue;
      record.state = 'paused';
      record.pauseReason = 'update';
      this.aborts.get(record.id)?.abort();
    }
    this.save();
    await this.waitForIdle();
  }

  resumeAfterUpdate(): void {
    if (!this.updateBlocked) return;
    this.updateBlocked = false;
    this.resumeReason('update');
  }

  async stop(): Promise<void> {
    if (!this.updateBlocked) this.pauseForIdentity();
    await this.waitForIdle();
    this.accountKey = null;
    this.currentUserId = null;
    this.account = emptyAccount();
  }
}
