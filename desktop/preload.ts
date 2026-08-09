import { contextBridge, ipcRenderer } from 'electron';

import type { DesktopBridge } from './bridge-types';

// Keep the sandboxed preload's runtime dependency surface limited to Electron.
// The shared bridge-types file is intentionally type-only here; importing its
// value exports would make Electron try to resolve a local CommonJS module in
// the sandboxed preload bundle.
const GET_SERVICE_STATUS_CHANNEL = 'desktop:get-service-status';
const OPEN_EXTERNAL_CHANNEL = 'desktop:open-external';

const desktopBridge: DesktopBridge = Object.freeze({
  getServiceStatus: () =>
    ipcRenderer.invoke(GET_SERVICE_STATUS_CHANNEL),
  openExternal: (url: string) =>
    ipcRenderer.invoke(OPEN_EXTERNAL_CHANNEL, url),
});

contextBridge.exposeInMainWorld('desktopBridge', desktopBridge);
