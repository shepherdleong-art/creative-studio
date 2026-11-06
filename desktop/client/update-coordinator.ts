import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { atomicJson } from './atomic-json';
import type { ClientDiagnosticInput } from './client-diagnostics';
import { extractZipSafely } from './safe-zip';
import {
  rangeIncludes,
  verifyUpdateManifest,
  type SignedUpdateManifest,
} from './update-package';

interface CurrentPointer {
  schemaVersion: 1;
  releaseId: string;
  directory: string;
  manifest: SignedUpdateManifest;
}

interface Health {
  healthy: boolean;
  stateSchema: number;
  apiVersion: number;
}

interface VersionProcess {
  waitForHealth(): Promise<Health>;
  stop(): Promise<void>;
}

interface ProcessControl {
  pauseTransfers(): Promise<void>;
  resumeTransfers(): Promise<void>;
  stopCurrent(): Promise<void>;
  startVersion(input: {
    releaseId: string;
    directory: string;
    stateRoot: string;
    transfersEnabled: false;
  }): Promise<VersionProcess>;
  stopVersion?(releaseId: string): Promise<void>;
}

interface CoordinatorOptions {
  rootDir: string;
  publicKey: string;
  platform: 'win32' | 'darwin';
  arch: 'x64' | 'arm64';
  trustedOrigins: string[];
  fetch: (url: string) => Promise<Response>;
  spaceProbe?: (requiredBytes: number) => void | Promise<void>;
  processControl: ProcessControl;
  onDiagnostic?: (event: ClientDiagnosticInput) => void;
  clientEventId?: string;
}

export interface UpdateResult {
  status: 'committed' | 'rejected' | 'rolled_back' | 'recovery_required';
  releaseId?: string;
  message?: string;
  clientEventId?: string;
  phase?: string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDownloadStatePath(relative: string): boolean {
  const parts = relative.split(path.sep);
  return parts[0] === 'downloads' || (parts[0] === 'accounts' && parts[2] === 'downloads');
}

export class ClientUpdateCoordinator {
  private readonly rootDir: string;
  private readonly pointerPath: string;
  private readonly stateRoot: string;
  private paused = false;
  private diagnosticPhase = 'check';

  constructor(private readonly options: CoordinatorOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.pointerPath = path.join(this.rootDir, 'current.json');
    this.stateRoot = path.join(this.rootDir, 'client-state');
    this.options.clientEventId ??= randomUUID();
  }

  private pointer(): CurrentPointer {
    const value = JSON.parse(fs.readFileSync(this.pointerPath, 'utf8')) as CurrentPointer;
    if (value.schemaVersion !== 1 || !value.releaseId || !value.directory || !value.manifest) {
      throw new Error('当前客户端版本指针无效');
    }
    return value;
  }

  private async pause(): Promise<void> {
    if (this.paused) return;
    await this.options.processControl.pauseTransfers();
    this.paused = true;
  }

  private async resume(): Promise<void> {
    if (!this.paused) return;
    await this.options.processControl.resumeTransfers();
    this.paused = false;
  }

  private failure(error: unknown): string {
    const code = error && typeof error === 'object' && typeof (error as NodeJS.ErrnoException).code === 'string'
      && /^[a-z][a-z0-9_.-]{0,79}$/i.test((error as NodeJS.ErrnoException).code!)
      ? (error as NodeJS.ErrnoException).code! : 'update_failed';
    try {
      this.options.onDiagnostic?.({
        clientEventId: this.options.clientEventId ?? randomUUID(),
        stage: 'client_update', phase: this.diagnosticPhase, code,
      });
    } catch { /* Updating must not be blocked by diagnostic storage. */ }
    return code;
  }

  private async rejected(releaseId: string | undefined, error: unknown, resume: boolean): Promise<UpdateResult> {
    if (resume) await this.resume();
    return { status: 'rejected', releaseId, message: message(error), clientEventId: this.options.clientEventId, phase: this.diagnosticPhase };
  }

  private async fetchManifest(url: string): Promise<SignedUpdateManifest> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !this.options.trustedOrigins.includes(parsed.origin)) {
      throw new Error('更新 manifest URL 不在受控来源内');
    }
    const response = await this.options.fetch(parsed.href);
    if (!response.ok) throw new Error(`更新 manifest 下载失败（HTTP ${response.status}）`);
    const text = await response.text();
    if (Buffer.byteLength(text) > 1024 ** 2) throw new Error('更新 manifest 超过大小上限');
    return verifyUpdateManifest(JSON.parse(text), this.options.publicKey, {
      platform: this.options.platform, arch: this.options.arch, trustedOrigins: this.options.trustedOrigins,
    });
  }

  private async download(manifest: SignedUpdateManifest, destination: string): Promise<void> {
    const response = await this.options.fetch(manifest.packageUrl);
    if (!response.ok || !response.body) throw new Error('更新包下载失败');
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength && contentLength !== manifest.size) throw new Error('更新包大小与签名清单不一致');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const fd = fs.openSync(destination, 'wx');
    const hash = createHash('sha256');
    let size = 0;
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        size += value.byteLength;
        if (size > manifest.size) throw new Error('更新包超过签名大小');
        fs.writeSync(fd, value);
        hash.update(value);
      }
    } finally { fs.closeSync(fd); }
    if (size !== manifest.size || hash.digest('hex') !== manifest.sha256) throw new Error('更新包 SHA-256 校验失败');
  }

  private snapshot(releaseId: string): string {
    const snapshots = path.join(this.rootDir, 'updates', 'snapshots');
    const target = path.join(snapshots, releaseId);
    if (fs.existsSync(target)) throw new Error('更新状态快照已存在，拒绝覆盖');
    const temporary = `${target}.${randomUUID()}.tmp`;
    fs.mkdirSync(path.dirname(temporary), { recursive: true });
    fs.cpSync(this.stateRoot, temporary, {
      recursive: true,
      filter: (source) => {
        const relative = path.relative(this.stateRoot, source);
        return !relative || (relative.split(path.sep)[0] !== 'run' && !isDownloadStatePath(relative));
      },
    });
    fs.renameSync(temporary, target);
    return target;
  }

  private restoreSnapshot(snapshot: string): void {
    // Keep downloads and the live health/transfer gate out of snapshots. Preserve
    // the failed new state separately instead of overwriting any new records.
    const failed = path.join(this.rootDir, 'updates', 'failed-state', `${path.basename(snapshot)}-${randomUUID()}`);
    fs.mkdirSync(failed, { recursive: true });
    for (const entry of fs.readdirSync(this.stateRoot)) {
      if (['downloads', 'run'].includes(entry)) continue;
      if (entry === 'accounts') {
        const accountsRoot = path.join(this.stateRoot, entry);
        const failedAccounts = path.join(failed, entry);
        fs.mkdirSync(failedAccounts, { recursive: true });
        for (const accountEntry of fs.readdirSync(accountsRoot)) {
          const sourceAccount = path.join(accountsRoot, accountEntry);
          const failedAccount = path.join(failedAccounts, accountEntry);
          fs.mkdirSync(failedAccount, { recursive: true });
          for (const child of fs.readdirSync(sourceAccount)) {
            if (child === 'downloads') continue;
            fs.renameSync(path.join(sourceAccount, child), path.join(failedAccount, child));
          }
        }
        continue;
      }
      fs.renameSync(path.join(this.stateRoot, entry), path.join(failed, entry));
    }
    fs.cpSync(snapshot, this.stateRoot, { recursive: true, force: true });
  }

  private failedHealth(): Health {
    let stateSchema = 1;
    try {
      const state = JSON.parse(fs.readFileSync(path.join(this.stateRoot, 'state.json'), 'utf8')) as { schemaVersion?: unknown };
      if (typeof state.schemaVersion === 'number') stateSchema = state.schemaVersion;
    } catch { /* initial schema */ }
    return { healthy: false, stateSchema, apiVersion: 1 };
  }

  private compatible(manifest: SignedUpdateManifest, health: Health): boolean {
    return rangeIncludes(manifest.api, health.apiVersion)
      && rangeIncludes(manifest.clientStateSchema, health.stateSchema);
  }

  private journalPath(releaseId: string): string {
    return path.join(this.rootDir, 'updates', `${releaseId}.json`);
  }

  private cleanupStaging(staging: string): void {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* deferred cleanup on next controlled update */ }
  }

  private cleanupSupersededVersions(keep: string[]): void {
    const versions = path.join(this.rootDir, 'versions');
    if (!fs.existsSync(versions)) return;
    for (const entry of fs.readdirSync(versions)) {
      if (keep.includes(entry)) continue;
      try { fs.rmSync(path.join(versions, entry), { recursive: true, force: true }); } catch { /* occupied directories are deferred */ }
    }
  }

  private diagnosticResult(result: UpdateResult): UpdateResult {
    return result.status === 'committed' ? result : { ...result, clientEventId: this.options.clientEventId, phase: this.diagnosticPhase };
  }

  async applyFromUrl(manifestUrl: string): Promise<UpdateResult> {
    let releaseId: string | undefined;
    let staging = '';
    let newProcess: VersionProcess | null = null;
    let pointerChanged = false;
    let rollbackStarted = false;
    let previous: CurrentPointer | null = null;
    let snapshot = '';
    let oldStopped = false;
    try {
      this.diagnosticPhase = 'check';
      const manifest = await this.fetchManifest(manifestUrl);
      releaseId = manifest.releaseId;
      previous = this.pointer();
      if (previous.releaseId === releaseId) throw new Error('目标版本已是当前版本');
      this.diagnosticPhase = 'download';
      const requiredBytes = manifest.size * 2 + 64 * 1024 ** 2;
      if (this.options.spaceProbe) await this.options.spaceProbe(requiredBytes);
      else {
        const stat = fs.statfsSync(this.rootDir);
        if (Number(stat.bavail) * Number(stat.bsize) < requiredBytes) throw new Error('更新磁盘空间不足');
      }
      staging = path.join(this.rootDir, 'updates', 'staging', `${releaseId}-${randomUUID()}`);
      const archive = path.join(staging, 'package.zip.part');
      await this.download(manifest, archive);
      this.diagnosticPhase = 'verification';
      const payload = path.join(staging, 'payload');
      extractZipSafely(archive, payload);
      const releaseMetadata = JSON.parse(fs.readFileSync(path.join(payload, 'release.json'), 'utf8')) as {
        releaseId?: string; version?: string;
      };
      if (releaseMetadata.releaseId !== manifest.releaseId || releaseMetadata.version !== manifest.version) {
        throw new Error('包内 release 信息与签名清单不一致');
      }
      if (!fs.existsSync(path.join(payload, ...manifest.entry.split('/')))) throw new Error('更新包缺少签名入口');
      const versionDirectory = path.join(this.rootDir, 'versions', releaseId);
      if (fs.existsSync(versionDirectory)) throw new Error('目标版本目录已存在，拒绝覆盖');
      fs.mkdirSync(path.dirname(versionDirectory), { recursive: true });
      fs.renameSync(payload, versionDirectory);

      await this.pause();
      this.diagnosticPhase = 'installation';
      await this.options.processControl.stopCurrent();
      oldStopped = true;
      snapshot = this.snapshot(releaseId);
      atomicJson(this.journalPath(releaseId), {
        schemaVersion: 1, phase: 'pointer_pending', previous, next: manifest, snapshot, committed: false,
      });
      const nextPointer: CurrentPointer = {
        schemaVersion: 1, releaseId, directory: path.join('versions', releaseId), manifest,
      };
      atomicJson(this.pointerPath, nextPointer);
      pointerChanged = true;
      atomicJson(this.journalPath(releaseId), {
        schemaVersion: 1, phase: 'health_pending', previous, next: manifest, snapshot, committed: false,
      });
      try {
        newProcess = await this.options.processControl.startVersion({
          releaseId, directory: versionDirectory, stateRoot: this.stateRoot, transfersEnabled: false,
        });
      } catch {
        await this.options.processControl.stopVersion?.(releaseId).catch(() => undefined);
        newProcess = { waitForHealth: async () => this.failedHealth(), stop: async () => {} };
      }
      let health: Health;
      try { health = await newProcess.waitForHealth(); }
      catch { health = this.failedHealth(); }
      if (health.healthy && this.compatible(manifest, health)) {
        atomicJson(this.journalPath(releaseId), {
          schemaVersion: 1, phase: 'committed', previous, next: manifest, snapshot, committed: true, health,
        });
        await this.resume();
        this.cleanupStaging(staging);
        this.cleanupSupersededVersions([releaseId, previous.releaseId]);
        return { status: 'committed', releaseId };
      }

      await newProcess.stop();
      this.diagnosticPhase = 'recovery';
      this.failure(new Error('client_health_failed'));
      atomicJson(this.pointerPath, previous);
      pointerChanged = false;
      if (!this.compatible(previous.manifest, health)) {
        atomicJson(this.journalPath(releaseId), {
          schemaVersion: 1, phase: 'recovery_required', previous, next: manifest, snapshot, committed: false, health,
        });
        this.cleanupStaging(staging);
        return { status: 'recovery_required', releaseId, message: '新版 API 或本机状态 schema 与旧版不兼容，已保留现场并停止业务传输。' };
      }
      rollbackStarted = true;
      this.restoreSnapshot(snapshot);
      const oldProcess = await this.options.processControl.startVersion({
        releaseId: previous.releaseId,
        directory: path.join(this.rootDir, previous.directory),
        stateRoot: this.stateRoot,
        transfersEnabled: false,
      });
      const oldHealth = await oldProcess.waitForHealth();
      if (!oldHealth.healthy || !this.compatible(previous.manifest, oldHealth)) {
        await oldProcess.stop();
        return { status: 'recovery_required', releaseId, message: '旧版本健康确认失败，已保留快照和下载。' };
      }
      atomicJson(this.journalPath(releaseId), {
        schemaVersion: 1, phase: 'rolled_back', previous, next: manifest, snapshot, committed: false, health,
      });
      await this.resume();
      this.cleanupStaging(staging);
      this.cleanupSupersededVersions([previous.releaseId, releaseId]);
      return { status: 'rolled_back', releaseId };
    } catch (error) {
      this.failure(error);
      if (newProcess) await newProcess.stop().catch(() => undefined);
      else if (oldStopped && releaseId) await this.options.processControl.stopVersion?.(releaseId).catch(() => undefined);
      if (rollbackStarted) {
        if (staging) this.cleanupStaging(staging);
        return { status: 'recovery_required', releaseId, message: message(error) };
      }
      if (pointerChanged && previous) {
        try { atomicJson(this.pointerPath, previous); }
        catch (pointerError) {
          if (staging) this.cleanupStaging(staging);
          return { status: 'recovery_required', releaseId, message: message(pointerError) };
        }
      }
      if (oldStopped && previous) {
        rollbackStarted = true;
        let oldProcess: VersionProcess | null = null;
        try {
          if (!this.compatible(previous.manifest, this.failedHealth())) {
            return { status: 'recovery_required', releaseId, message: '当前状态与旧版不兼容，已停止业务传输并保留现场。' };
          }
          if (snapshot) this.restoreSnapshot(snapshot);
          oldProcess = await this.options.processControl.startVersion({
            releaseId: previous.releaseId,
            directory: path.join(this.rootDir, previous.directory),
            stateRoot: this.stateRoot,
            transfersEnabled: false,
          });
          const oldHealth = await oldProcess.waitForHealth();
          if (!oldHealth.healthy || !this.compatible(previous.manifest, oldHealth)) {
            await oldProcess.stop();
            return { status: 'recovery_required', releaseId, message: '旧版本健康确认失败，已保留快照和下载。' };
          }
          await this.resume();
          if (staging) this.cleanupStaging(staging);
          return { status: 'rolled_back', releaseId, message: message(error) };
        } catch (rollbackError) {
          if (oldProcess) await oldProcess.stop().catch(() => undefined);
          if (staging) this.cleanupStaging(staging);
          return { status: 'recovery_required', releaseId, message: message(rollbackError) };
        }
      }
      if (staging) this.cleanupStaging(staging);
      return this.rejected(releaseId, error, this.paused && !pointerChanged);
    }
  }
}
