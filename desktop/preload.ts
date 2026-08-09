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

const desktopBridge: DesktopBridge = Object.freeze({
  platform: () => ipcRenderer.invoke(PLATFORM_CHANNEL),
  chooseMediaFiles: () => ipcRenderer.invoke(CHOOSE_MEDIA_FILES_CHANNEL),
  chooseFolder: () => ipcRenderer.invoke(CHOOSE_FOLDER_CHANNEL),
  getAppVersion: () => ipcRenderer.invoke(GET_APP_VERSION_CHANNEL),
});

contextBridge.exposeInMainWorld('desktopBridge', desktopBridge);
