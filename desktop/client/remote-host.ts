import { app, dialog, session as electronSession, shell, type BrowserWindow, type Session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

import type { ClientStatus, RemoteUploadTarget } from '../bridge-types';
import type { RemoteDesktopWindowHost } from '../window';
import { RemoteTransferController, type TeamFileDownloadManifest } from './remote-transfer';
import { ClientDiagnosticReporter } from './client-diagnostic-reporter';
import { sanitizeClientDiagnostic, type ClientDiagnosticInput as DiagnosticInput } from './client-diagnostics';
import type { ClientDiagnosticInput } from '../bridge-types';

export type RemoteClientConfig = { mode: 'local' } | { mode: 'remote'; origin: string };

export function readRemoteClientConfig(env: Record<string, string | undefined> = process.env): RemoteClientConfig {
  const mode = env.CREATIVE_STUDIO_CLIENT_MODE?.trim() || 'local';
  if (mode === 'local') return { mode };
  if (mode !== 'remote') throw new Error('CREATIVE_STUDIO_CLIENT_MODE 只支持 local 或 remote');
  const value = env.CREATIVE_STUDIO_SERVER_ORIGIN?.trim();
  try {
    if (!value) throw new Error('missing');
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || (url.pathname !== '/' && url.pathname !== '')) throw new Error('invalid');
    return { mode, origin: url.origin };
  } catch {
    throw new Error('CREATIVE_STUDIO_SERVER_ORIGIN 必须是无路径、凭据或查询参数的 HTTPS origin');
  }
}

interface RemoteHostOptions {
  origin: string;
  stateRoot: string;
  preloadPath: string;
  session?: Session;
  isQuitRequested: () => boolean;
  setIpcHandlerRemover: (remover: (() => void) | null) => void;
  clearIpcHandlers: () => void;
  onWindowClosed: () => void;
  shutdown: () => Promise<void>;
  installUpdate?: (manifestUrl: string, transfers: RemoteTransferController) => Promise<{ started: boolean; message?: string }>;
}

interface Capabilities {
  deploymentId: string;
  apiVersion: number;
  supportedClientRange: string;
  maintenance: boolean;
  compatible: boolean;
  reason?: string;
  update?: { manifestUrl: string };
  uploadConstraints: { partSize: number; maxFilesPerBatch: number; maxFileSize: number };
}

function validateCapabilities(value: unknown): Capabilities {
  if (!value || typeof value !== 'object') throw new Error('客户端握手响应无效');
  const body = value as Partial<Capabilities>;
  if (typeof body.deploymentId !== 'string' || !body.deploymentId || body.apiVersion !== 1
    || typeof body.supportedClientRange !== 'string' || typeof body.maintenance !== 'boolean'
    || typeof body.compatible !== 'boolean' || !body.uploadConstraints
    || typeof body.uploadConstraints.partSize !== 'number') {
    throw new Error('客户端握手响应无效');
  }
  return body as Capabilities;
}

export class RemoteClientController {
  private capabilities: Capabilities | null = null;
  private transfers: RemoteTransferController | null = null;
  private identityTimer: ReturnType<typeof setInterval> | null = null;
  private readonly diagnostics: ClientDiagnosticReporter;
  private readonly installUpdateHandler?: RemoteHostOptions['installUpdate'];

  constructor(private readonly options: RemoteHostOptions, private readonly session: Session) {
    this.installUpdateHandler = options.installUpdate;
    let device: { clientDeviceId?: string } = {};
    try { device = JSON.parse(fs.readFileSync(path.join(options.stateRoot, 'device.json'), 'utf8')) as typeof device; } catch { /* transfer binds its persisted device below */ }
    this.diagnostics = new ClientDiagnosticReporter({
      origin: options.origin, stateRoot: options.stateRoot,
      clientDeviceId: device.clientDeviceId ?? '00000000-0000-4000-8000-000000000000',
      clientVersion: app.getVersion(), session: this.session,
    });
  }

  async start(): Promise<void> {
    await this.handshake();
    this.transfers = new RemoteTransferController({
      origin: this.options.origin,
      deploymentId: this.capabilities!.deploymentId,
      stateRoot: this.options.stateRoot,
      session: this.session,
      platform: process.platform === 'win32' ? 'windows' : 'macos',
      reveal: (target) => shell.showItemInFolder(target),
      diagnostics: this.diagnostics,
    });
    if (!this.capabilities!.compatible || this.capabilities!.maintenance || this.updateGateBlocked()) {
      await this.transfers.pauseForUpdate();
    }
    await this.transfers.synchronizeIdentity();
    void this.transfers.syncDeliveries().catch(() => undefined);
    this.session.cookies.on('changed', (_event, cookie) => {
      if (cookie.name === '__Host-team_session') void this.transfers?.synchronizeIdentity().catch(() => undefined);
    });
    this.identityTimer = setInterval(() => {
      void this.syncUpdateGate().catch(() => undefined);
      void this.transfers?.synchronizeIdentity()
        .then(() => this.transfers?.syncDeliveries())
        .catch(() => undefined);
    }, 1000);
    this.identityTimer.unref();
  }

  private updateGateBlocked(): boolean {
    const gatePath = path.join(this.options.stateRoot, 'run', 'transfer-gate.json');
    if (!fs.existsSync(gatePath)) return false;
    try {
      const gate = JSON.parse(fs.readFileSync(gatePath, 'utf8')) as { blocked?: unknown };
      return gate.blocked !== false;
    } catch {
      return true;
    }
  }

  private async syncUpdateGate(): Promise<void> {
    if (!this.transfers) return;
    if (!this.capabilities?.compatible || this.capabilities.maintenance || this.updateGateBlocked()) {
      await this.transfers.pauseForUpdate();
    } else {
      this.transfers.resumeAfterUpdate();
    }
  }

  async pauseForUpdate(): Promise<void> {
    await this.transfers?.pauseForUpdate();
  }

  async resumeAfterUpdate(): Promise<void> {
    await this.syncUpdateGate();
  }

  reportUiError(input: ClientDiagnosticInput): void {
    this.diagnostics.report(sanitizeClientDiagnostic({ ...input, stage: 'client_ui' }) as DiagnosticInput);
  }

  private async handshake(): Promise<void> {
    const response = await this.session.fetch(`${this.options.origin}/api/team/client-capabilities`, {
      headers: {
        accept: 'application/json',
        'x-creative-studio-client-version': app.getVersion(),
        'x-creative-studio-client-api': '1',
      },
      credentials: 'include', cache: 'no-store', redirect: 'error',
    });
    if (!response.ok) throw new Error(`客户端握手失败（HTTP ${response.status}）`);
    this.capabilities = validateCapabilities(await response.json());
  }

  async getClientStatus(): Promise<ClientStatus> {
    await this.handshake();
    await this.syncUpdateGate();
    return {
      mode: 'remote', origin: this.options.origin, version: app.getVersion(), apiVersion: 1,
      deploymentId: this.capabilities!.deploymentId,
      compatible: this.capabilities!.compatible,
      maintenance: this.capabilities!.maintenance,
      reason: this.capabilities!.reason,
      updateAvailable: Boolean(this.capabilities!.update?.manifestUrl),
      transfers: this.transfers?.listTransfers() ?? [],
    };
  }

  async chooseUploadFiles(window: BrowserWindow, target: RemoteUploadTarget): Promise<{ transferIds: string[] }> {
    const selection = await dialog.showOpenDialog(window, {
      title: '选择要上传到统一生产服务的本机文件', properties: ['openFile', 'multiSelections'],
    });
    if (selection.canceled || selection.filePaths.length === 0) return { transferIds: [] };
    return { transferIds: await this.requireTransfers().createUploads(selection.filePaths, target) };
  }

  private requireTransfers(): RemoteTransferController {
    if (!this.transfers) throw new Error('客户端尚未完成握手');
    if (!this.capabilities?.compatible) throw new Error('客户端版本不兼容，请先修复并更新');
    if (this.capabilities.maintenance) throw new Error('服务维护期间暂停新的传输');
    return this.transfers;
  }

  pauseTransfer(id: string): void { this.requireTransfers().pauseTransfer(id); }
  resumeTransfer(id: string): void { this.requireTransfers().resumeTransfer(id); }
  async cancelTransfer(id: string): Promise<void> { await this.requireTransfers().cancelTransfer(id); }
  async revealDownload(id: string): Promise<{ revealed: boolean }> {
    return { revealed: await this.requireTransfers().revealDownload(id) };
  }
  async createDownloads(manifests: TeamFileDownloadManifest[]): Promise<string[]> {
    return this.requireTransfers().createDownloads(manifests);
  }

  async installClientUpdate(): Promise<{ started: boolean; message?: string }> {
    await this.handshake();
    const manifestUrl = this.capabilities?.update?.manifestUrl;
    if (!manifestUrl) return { started: false, message: '服务尚未提供受控更新入口，请联系管理员修复。' };
    if (!this.installUpdateHandler) return { started: false, message: '此安装尚未配置独立更新助手，请使用受控修复包。' };
    return this.installUpdateHandler(manifestUrl, this.requireTransfers());
  }

  async stop(): Promise<void> {
    if (this.identityTimer) clearInterval(this.identityTimer);
    this.identityTimer = null;
    await this.transfers?.stop();
  }
}

export async function createRemoteClientHost(options: RemoteHostOptions): Promise<RemoteDesktopWindowHost> {
  const clientSession = options.session ?? electronSession.fromPartition('persist:creative-studio-team-client');
  const origin = new URL(options.origin).origin;
  clientSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  clientSession.setPermissionCheckHandler(() => false);
  clientSession.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, callback) => {
    const requestHeaders = {
      ...details.requestHeaders,
      'x-creative-studio-client-version': app.getVersion(),
      'x-creative-studio-client-api': '1',
    };
    callback({ requestHeaders });
  });
  const remote = new RemoteClientController({ ...options, origin }, clientSession);
  await remote.start();
  return {
    mode: 'remote', origin, preloadPath: options.preloadPath,
    session: clientSession, remote,
    isQuitRequested: options.isQuitRequested,
    setIpcHandlerRemover: options.setIpcHandlerRemover,
    clearIpcHandlers: options.clearIpcHandlers,
    onWindowClosed: options.onWindowClosed,
    shutdown: options.shutdown,
  };
}

export async function confirmRemoteClientHealth(
  stateRoot: string,
  remote: RemoteDesktopWindowHost['remote'],
): Promise<void> {
  const releaseId = process.env.CREATIVE_STUDIO_CLIENT_RELEASE_ID;
  if (!releaseId) return;
  const status = await remote.getClientStatus();
  let stateSchema = 1;
  try {
    const state = JSON.parse(fs.readFileSync(path.join(stateRoot, 'state.json'), 'utf8')) as { schemaVersion?: unknown };
    if (typeof state.schemaVersion === 'number') stateSchema = state.schemaVersion;
  } catch { /* schema 1 is the initial on-disk state */ }
  const healthPath = path.join(stateRoot, 'run', 'client-health.json');
  fs.mkdirSync(path.dirname(healthPath), { recursive: true });
  const temporary = `${healthPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({
    releaseId, pid: process.pid, healthy: status.compatible, stateSchema, apiVersion: 1,
  }));
  fs.renameSync(temporary, healthPath);
}

export function defaultClientStateRoot(): string {
  return process.env.CREATIVE_STUDIO_CLIENT_STATE_ROOT
    ? path.resolve(process.env.CREATIVE_STUDIO_CLIENT_STATE_ROOT)
    : path.join(app.getPath('appData'), 'CreativeStudioClient');
}
