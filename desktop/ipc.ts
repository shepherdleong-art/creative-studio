import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';

import type { DesktopBridge } from './bridge-types';

const CHANNELS = {
  platform: 'desktop:platform',
  chooseMediaFiles: 'desktop:choose-media-files',
  chooseFolder: 'desktop:choose-folder',
  getAppVersion: 'desktop:get-app-version',
} as const;

export type DesktopPlatform = Awaited<ReturnType<DesktopBridge['platform']>>;
export type MediaSelectionResult = Awaited<
  ReturnType<DesktopBridge['chooseMediaFiles']>
>;
export type FolderSelectionResult = Awaited<
  ReturnType<DesktopBridge['chooseFolder']>
>;

export interface DesktopIpcHandlers {
  platform(): DesktopPlatform;
  chooseMediaFiles(): Promise<MediaSelectionResult>;
  chooseFolder(): Promise<FolderSelectionResult>;
  getAppVersion(): string;
}

interface RegisterIpcOptions {
  window: BrowserWindow;
  origin: string;
  handlers: DesktopIpcHandlers;
}

function sameOrigin(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return (
      leftUrl.protocol === rightUrl.protocol &&
      leftUrl.hostname === rightUrl.hostname &&
      leftUrl.port === rightUrl.port
    );
  } catch {
    return false;
  }
}

function assertAllowedSender(
  event: IpcMainInvokeEvent,
  options: RegisterIpcOptions,
): void {
  const senderFrame = event.senderFrame;
  if (
    !senderFrame ||
    senderFrame !== options.window.webContents.mainFrame ||
    !sameOrigin(senderFrame.url, options.origin)
  ) {
    throw new Error('拒绝来自非工作台主 frame 的桌面 IPC 请求');
  }
}

export function registerIpcHandlers(options: RegisterIpcOptions): () => void {
  const protectedHandler = <TArgs extends unknown[], TResult>(
    handler: (...args: TArgs) => TResult,
  ) =>
    (event: IpcMainInvokeEvent, ...args: TArgs): TResult => {
      assertAllowedSender(event, options);
      return handler(...args);
    };

  ipcMain.handle(
    CHANNELS.platform,
    protectedHandler(() => options.handlers.platform()),
  );
  ipcMain.handle(
    CHANNELS.chooseMediaFiles,
    protectedHandler(() => options.handlers.chooseMediaFiles()),
  );
  ipcMain.handle(
    CHANNELS.chooseFolder,
    protectedHandler(() => options.handlers.chooseFolder()),
  );
  ipcMain.handle(
    CHANNELS.getAppVersion,
    protectedHandler(() => options.handlers.getAppVersion()),
  );

  return () => {
    for (const channel of Object.values(CHANNELS)) {
      ipcMain.removeHandler(channel);
    }
  };
}
