export type ThemePreference = 'light' | 'dark' | 'system';

export interface RemoteUploadTarget {
  resourceType: string;
  resourceId: string;
  targetKind?: string;
}

/** 轻客户端「一键下载全部」交给现有交付下载的清单项（11 号票）。 */
export interface ClientDownloadManifest {
  fileId: string;
  seriesId: string;
  version: number;
  size: number;
  sha256: string;
  etag: string;
  displayName: string;
  /** 下载根下的受管相对子目录（按项目与导出版本分目录）。 */
  relativeDirectory?: string;
}

export interface ClientTransferStatus {
  id: string;
  kind: 'upload' | 'download';
  state: 'queued' | 'running' | 'paused' | 'ready' | 'failed' | 'cancelled';
  pauseReason?: 'identity' | 'manual' | 'update';
  failureCode?: string;
  uploadId?: string;
  downloadId?: string;
  fileId?: string;
  displayName?: string;
}

export interface ClientDiagnosticInput {
  clientEventId?: string;
  stage: 'client_ui';
  phase: 'error' | 'unhandledrejection';
  code: 'ui_runtime_error' | 'unhandled_rejection';
}

export interface ClientStatus {
  mode: 'remote';
  origin: string;
  version: string;
  apiVersion: number;
  deploymentId: string;
  compatible: boolean;
  maintenance: boolean;
  reason?: string;
  updateAvailable: boolean;
  updaterVersion?: number;
  transfers: ClientTransferStatus[];
}

export interface DesktopBridge {
  platform(): Promise<'macos' | 'windows'>;
  chooseMediaFiles(): Promise<{ requestId: string; count: number }>;
  chooseFolder(): Promise<{ requestId: string; count: number } | null>;
  getAppVersion(): Promise<string>;
  relocateLinkedSource(assetId: string, sourceId: string): Promise<{ relocated: boolean }>;
  openFolder(relativePath: string): Promise<{ opened: boolean; message?: string }>;
  revealItem(relativePath: string): Promise<{ revealed: boolean; message?: string }>;
  setThemePreference(preference: ThemePreference): Promise<void>;
  chooseUploadFiles(target: RemoteUploadTarget): Promise<{ transferIds: string[] }>;
  /** 一键下载全部：把服务器清单交给现有交付下载（11 号票）。 */
  createDownloads(manifests: ClientDownloadManifest[]): Promise<{ transferIds: string[] }>;
  pauseTransfer(transferId: string): Promise<void>;
  resumeTransfer(transferId: string): Promise<void>;
  cancelTransfer(transferId: string): Promise<void>;
  revealDownload(downloadId: string): Promise<{ revealed: boolean }>;
  getClientStatus(): Promise<ClientStatus>;
  installClientUpdate(): Promise<{ started: boolean; message?: string; upToDate?: boolean }>;
  reportClientError(input: ClientDiagnosticInput): Promise<void>;
  onQuitRequested(callback: () => void): () => void;
}

declare global {
  interface Window {
    desktopBridge?: DesktopBridge;
  }
}
