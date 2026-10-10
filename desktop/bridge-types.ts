export type ThemePreference = 'light' | 'dark' | 'system';

export interface DesktopBridge {
  platform(): Promise<'macos' | 'windows'>;
  chooseMediaFiles(): Promise<{ requestId: string; count: number }>;
  chooseFolder(): Promise<{ requestId: string; count: number } | null>;
  getAppVersion(): Promise<string>;
  relocateLinkedSource(assetId: string, sourceId: string): Promise<{ relocated: boolean }>;
  openFolder(relativePath: string): Promise<{ opened: boolean; message?: string }>;
  revealItem(relativePath: string): Promise<{ revealed: boolean; message?: string }>;
  setThemePreference(preference: ThemePreference): Promise<void>;
  onQuitRequested(callback: () => void): () => void;
}

declare global {
  interface Window {
    desktopBridge?: DesktopBridge;
  }
}
