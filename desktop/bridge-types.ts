export const DESKTOP_IPC_CHANNELS = {
  getServiceStatus: 'desktop:get-service-status',
  openExternal: 'desktop:open-external',
} as const;

export type DesktopServiceState =
  | 'starting'
  | 'ready'
  | 'stopping'
  | 'stopped'
  | 'error';

export interface DesktopServiceStatus {
  state: DesktopServiceState;
  origin?: string;
  instanceId?: string;
  error?: string;
}

export interface DesktopBridge {
  getServiceStatus(): Promise<DesktopServiceStatus>;
  openExternal(url: string): Promise<void>;
}

declare global {
  interface Window {
    desktopBridge?: DesktopBridge;
  }
}
