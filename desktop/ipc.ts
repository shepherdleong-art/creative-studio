import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import type { ThemePreference } from './theme';

export const CHANNELS = {
  platform: 'desktop:platform',
  chooseMediaFiles: 'desktop:choose-media-files',
  chooseFolder: 'desktop:choose-folder',
  getAppVersion: 'desktop:get-app-version',
  relocateLinkedSource: 'desktop:relocate-linked-source',
  openFolder: 'desktop:open-folder',
  revealItem: 'desktop:reveal-item',
  linkedImportProgress: 'desktop:linked-import-progress',
  setThemePreference: 'desktop:set-theme-preference',
  quitRequested: 'desktop:quit-requested',
} as const;

/** ipcMain.handle 允许同步或异步返回值。 */
type MaybePromise<T> = T | Promise<T>;

/** 主进程侧 IPC handler 集合（与渲染端 DesktopBridge 对应；onQuitRequested 由 preload 本地实现，不过 IPC）。 */
export interface DesktopIpcHandlers {
  platform(): MaybePromise<'macos' | 'windows'>;
  chooseMediaFiles(): MaybePromise<{ requestId: string; count: number }>;
  chooseFolder(): MaybePromise<{ requestId: string; count: number } | null>;
  getAppVersion(): MaybePromise<string>;
  relocateLinkedSource(assetId: string, sourceId: string): MaybePromise<{ relocated: boolean }>;
  openFolder(relativePath: string): MaybePromise<{ opened: boolean; message?: string }>;
  revealItem(relativePath: string): MaybePromise<{ revealed: boolean; message?: string }>;
  setThemePreference(preference: ThemePreference): MaybePromise<void>;
}

export interface RegisterIpcOptions {
  window: BrowserWindow;
  origin: string;
  handlers: DesktopIpcHandlers;
}

export function sameOrigin(left: string, right: string): boolean {
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

function assertAllowedSender(event: IpcMainInvokeEvent, options: RegisterIpcOptions): void {
  const senderFrame = event.senderFrame;
  if (
    !senderFrame ||
    senderFrame !== options.window.webContents.mainFrame ||
    !sameOrigin(senderFrame.url, options.origin)
  ) {
    throw new Error('拒绝来自非工作台主 frame 的桌面 IPC 请求');
  }
}

/** 注册全部桌面 IPC handler；返回移除函数（窗口销毁/停机时调用）。 */
export function registerIpcHandlers(options: RegisterIpcOptions): () => void {
  const protectedHandler = <Args extends unknown[], Result>(handler: (...args: Args) => Result) =>
    (event: IpcMainInvokeEvent, ...args: unknown[]): Result => {
      assertAllowedSender(event, options);
      return handler(...(args as Args));
    };
  ipcMain.handle(CHANNELS.platform, protectedHandler(() => options.handlers.platform()));
  ipcMain.handle(CHANNELS.chooseMediaFiles, protectedHandler(() => options.handlers.chooseMediaFiles()));
  ipcMain.handle(CHANNELS.chooseFolder, protectedHandler(() => options.handlers.chooseFolder()));
  ipcMain.handle(CHANNELS.getAppVersion, protectedHandler(() => options.handlers.getAppVersion()));
  ipcMain.handle(CHANNELS.relocateLinkedSource, protectedHandler((assetId: string, sourceId: string) => options.handlers.relocateLinkedSource(assetId, sourceId)));
  ipcMain.handle(CHANNELS.openFolder, protectedHandler((relativePath: string) => options.handlers.openFolder(relativePath)));
  ipcMain.handle(CHANNELS.revealItem, protectedHandler((relativePath: string) => options.handlers.revealItem(relativePath)));
  ipcMain.handle(CHANNELS.setThemePreference, protectedHandler((preference: ThemePreference) => options.handlers.setThemePreference(preference)));
  return () => {
    for (const channel of Object.values(CHANNELS)) {
      ipcMain.removeHandler(channel);
    }
  };
}