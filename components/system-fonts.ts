// 字体下拉选项的共享加载器（仅客户端调用）。
//
// 两个数据源，打开下拉框时自动合并：
// 1. 服务端扫盘 /api/system-fonts——落盘安装的字体（系统目录 + per-user 目录），
//    会话级 stale-while-revalidate 缓存：首帧秒显，后台重校验静默更新。
// 2. 浏览器 queryLocalFonts()——OS 当前注册的字体，含字体管家（如字由）按需激活、
//    但未落盘到标准字体目录的会话字体；这是服务端扫盘原理上看不到的超集。
//
// 两个源都会话级缓存，任何面板重开都直接以合并结果作为初始 state，不再闪跳，
// 也不需要用户手动点「刷新」。

let sessionFontList: string[] | null = null;
let sessionFontRequest: Promise<string[]> | null = null;
let localFontList: string[] | null = null;
let localFontRequest: Promise<string[] | null> | null = null;

function readFontBody(body: unknown): string[] {
  const values = Array.isArray(body) ? body : (body as { fonts?: unknown } | null)?.fonts;
  const families = Array.isArray(values) ? values.map((item) => (typeof item === 'string' ? item : (item as { family?: string }).family)) : [];
  return [...new Set(['PingFang SC', ...families.filter((family): family is string => Boolean(family))])];
}

/** 服务端字体列表（stale-while-revalidate）：每次调用都后台重校验，返回最新结果。 */
export function requestSystemFonts(forceRefresh = false): Promise<string[]> {
  if (!forceRefresh && sessionFontRequest) return sessionFontRequest;
  const request = fetch(forceRefresh ? '/api/system-fonts?refresh=1' : '/api/system-fonts')
    .then((response) => response.json())
    .then((body: unknown) => {
      const next = readFontBody(body);
      const current = sessionFontList;
      // 内容未变时保留原引用，避免每次重校验都触发一次无意义的重渲染。
      const resolved = current !== null && next.length === current.length && next.every((family, index) => family === current[index]) ? current : next;
      sessionFontList = resolved;
      sessionFontRequest = null;
      return resolved;
    })
    .catch((error: unknown) => {
      sessionFontRequest = null;
      throw error;
    });
  sessionFontRequest = request;
  return request;
}

/** 浏览器枚举 OS 注册字体；不支持或未授权时静默返回 null（不影响服务端列表）。 */
export function requestLocalFonts(): Promise<string[] | null> {
  if (localFontRequest) return localFontRequest;
  const localWindow = typeof window === 'undefined' ? null : (window as Window & { queryLocalFonts?: () => Promise<Array<{ family: string }>> });
  if (!localWindow?.queryLocalFonts) return Promise.resolve(null);
  const request = localWindow.queryLocalFonts()
    .then((fonts) => {
      localFontList = [...new Set(fonts.map((font) => font.family).filter(Boolean))].sort((left, right) => left.localeCompare(right));
      localFontRequest = null;
      return localFontList;
    })
    .catch(() => {
      // 用户拒绝授权不阻塞编辑：退回仅服务端列表。
      localFontRequest = null;
      return null;
    });
  localFontRequest = request;
  return request;
}

/** 合并两个源的会话缓存（供组件初始化首帧使用）；都没有缓存时返回 null。 */
export function getCachedFontOptions(): string[] | null {
  if (!sessionFontList && !localFontList) return null;
  return [...new Set([...(sessionFontList ?? []), ...(localFontList ?? [])])];
}

/** 拉取并合并两个源的最新结果。 */
export function requestFontOptions(forceRefresh = false): Promise<string[]> {
  return Promise.all([requestSystemFonts(forceRefresh), requestLocalFonts()]).then(([server, local]) => [...new Set([...server, ...(local ?? [])])]);
}

/** 进入混剪步骤即预取两个源，让各字体下拉框打开的首帧就是全量。 */
export function preloadSystemFonts(): void {
  void requestSystemFonts().catch(() => undefined);
  void requestLocalFonts();
}
