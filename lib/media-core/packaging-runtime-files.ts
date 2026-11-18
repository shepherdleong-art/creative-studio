/** 收录路径以 chrome-headless-shell/ 为起点。Chromium 会在可执行文件旁生成这些日志。 */
export function isPackagingChromeLog(relative: string): boolean {
  return /^chrome-headless-shell\/(?:chrome_)?debug\.log$/i.test(relative);
}
