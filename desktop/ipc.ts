import { ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';

import {
  DESKTOP_IPC_CHANNELS,
  type DesktopServiceStatus,
} from './bridge-types';

export interface DesktopServiceController {
  getStatus(): DesktopServiceStatus;
}

interface RegisterIpcOptions {
  window: BrowserWindow;
  origin: string;
  service: DesktopServiceController;
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
  const getServiceStatus = (event: IpcMainInvokeEvent): DesktopServiceStatus => {
    assertAllowedSender(event, options);
    return options.service.getStatus();
  };

  const openExternal = async (
    event: IpcMainInvokeEvent,
    value: unknown,
  ): Promise<void> => {
    assertAllowedSender(event, options);
    if (typeof value !== 'string') {
      throw new TypeError('外部链接必须是字符串');
    }

    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('只允许打开 HTTP(S) 外部链接');
    }
    await shell.openExternal(url.toString());
  };

  ipcMain.handle(DESKTOP_IPC_CHANNELS.getServiceStatus, getServiceStatus);
  ipcMain.handle(DESKTOP_IPC_CHANNELS.openExternal, openExternal);

  return () => {
    ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.getServiceStatus);
    ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.openExternal);
  };
}
