import { contextBridge, ipcRenderer } from 'electron';

import type { DesktopBridge } from './bridge-types';

// Keep the sandboxed preload's runtime dependency surface limited to Electron.
// The shared bridge-types file is intentionally type-only here; importing its
// value exports would make Electron try to resolve a local CommonJS module in
// the sandboxed preload bundle.
const PLATFORM_CHANNEL = 'desktop:platform';
const CHOOSE_MEDIA_FILES_CHANNEL = 'desktop:choose-media-files';
const CHOOSE_FOLDER_CHANNEL = 'desktop:choose-folder';
const GET_APP_VERSION_CHANNEL = 'desktop:get-app-version';
const RELOCATE_LINKED_SOURCE_CHANNEL = 'desktop:relocate-linked-source';
const OPEN_FOLDER_CHANNEL = 'desktop:open-folder';
const LINKED_IMPORT_PROGRESS_CHANNEL = 'desktop:linked-import-progress';

function isLinkedImportProgress(value: unknown): value is { requestId: string; completed: number; total: number } {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  const completed = candidate.completed;
  const total = candidate.total;
  return typeof candidate.requestId === 'string'
    && candidate.requestId.length > 0
    && candidate.requestId.length <= 128
    && typeof completed === 'number'
    && typeof total === 'number'
    && Number.isInteger(completed)
    && Number.isInteger(total)
    && completed >= 0
    && completed <= total
    && total <= 500;
}

const desktopBridge: DesktopBridge = Object.freeze({
  platform: () => ipcRenderer.invoke(PLATFORM_CHANNEL),
  chooseMediaFiles: () => ipcRenderer.invoke(CHOOSE_MEDIA_FILES_CHANNEL),
  chooseFolder: () => ipcRenderer.invoke(CHOOSE_FOLDER_CHANNEL),
  getAppVersion: () => ipcRenderer.invoke(GET_APP_VERSION_CHANNEL),
  relocateLinkedSource: (assetId: string, sourceId: string) => ipcRenderer.invoke(
    RELOCATE_LINKED_SOURCE_CHANNEL,
    assetId,
    sourceId,
  ),
  openFolder: (relativePath: string) => ipcRenderer.invoke(OPEN_FOLDER_CHANNEL, relativePath),
});

contextBridge.exposeInMainWorld('desktopBridge', desktopBridge);

// Progress is an internal main→preload event, not a renderer bridge
// method. Only validated counts cross the isolation boundary; paths never do.
ipcRenderer.on(LINKED_IMPORT_PROGRESS_CHANNEL, (_event, payload: unknown) => {
  if (!isLinkedImportProgress(payload)) return;
  window.dispatchEvent(new CustomEvent('creative-studio:linked-import-progress', { detail: payload }));
});
