import { nativeTheme } from 'electron';

import type { ThemePreference } from './bridge-types';

// 原生控件（select 弹出列表、右键菜单、滚动条）的主题由主进程 nativeTheme
// 决定，不跟随页面 CSS 的 color-scheme。'system' 保持跟随系统，显式偏好则钉住。
export function applyThemePreference(preference: ThemePreference): void {
  if (preference !== 'light' && preference !== 'dark' && preference !== 'system') {
    throw new Error(`未知的外观偏好：${String(preference)}`);
  }
  nativeTheme.themeSource = preference;
}
