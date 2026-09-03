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

export interface FontOption {
  /** 真实 family 名，可直接写进 CSS / SVG / Canvas */
  family: string;
  /** 展示名；中文字体为中文名，英文字体为英文名 */
  displayName: string;
}

let sessionFontList: FontOption[] | null = null;
let sessionFontRequest: Promise<FontOption[]> | null = null;
let localFontList: FontOption[] | null = null;
let localFontRequest: Promise<FontOption[] | null> | null = null;

function readFontBody(body: unknown): FontOption[] {
  const values = Array.isArray(body) ? body : (body as { fonts?: unknown } | null)?.fonts;
  const items = Array.isArray(values) ? values : [];
  const out = new Map<string, FontOption>();
  for (const item of items) {
    if (typeof item === 'string') {
      if (!out.has(item)) out.set(item, { family: item, displayName: item });
      continue;
    }
    const family = (item as { family?: string }).family;
    if (!family) continue;
    const displayName = (item as { displayName?: string }).displayName ?? family;
    if (!out.has(family)) out.set(family, { family, displayName });
  }
  return [...out.values()];
}

/** 服务端字体列表（stale-while-revalidate）：每次调用都后台重校验，返回最新结果。 */
export function requestSystemFonts(forceRefresh = false): Promise<FontOption[]> {
  if (!forceRefresh && sessionFontRequest) return sessionFontRequest;
  const request = fetch(forceRefresh ? '/api/system-fonts?refresh=1' : '/api/system-fonts')
    .then((response) => response.json())
    .then((body: unknown) => {
      const next = readFontBody(body);
      const current = sessionFontList;
      // 内容未变时保留原引用，避免每次重校验都触发一次无意义的重渲染。
      const resolved = current !== null
        && next.length === current.length
        && next.every((font, index) => font.family === current[index]?.family && font.displayName === current[index]?.displayName)
        ? current
        : next;
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
export function requestLocalFonts(): Promise<FontOption[] | null> {
  if (localFontRequest) return localFontRequest;
  const localWindow = typeof window === 'undefined' ? null : (window as Window & { queryLocalFonts?: () => Promise<Array<{ family: string; fullName?: string }>> });
  if (!localWindow?.queryLocalFonts) return Promise.resolve(null);
  const request = localWindow.queryLocalFonts()
    .then((fonts) => {
      const out = new Map<string, FontOption>();
      for (const font of fonts) {
        if (!font.family) continue;
        // queryLocalFonts 的 fullName 在中文系统上通常是中文 family，作为 displayName。
        const displayName = font.fullName && font.fullName !== font.family ? font.fullName : font.family;
        if (!out.has(font.family)) out.set(font.family, { family: font.family, displayName });
      }
      localFontList = [...out.values()].sort((left, right) => left.family.localeCompare(right.family));
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
export function getCachedFontOptions(): FontOption[] | null {
  if (!sessionFontList && !localFontList) return null;
  return [...new Map([...(sessionFontList ?? []), ...(localFontList ?? [])].map((font) => [font.family, font])).values()];
}

/** 拉取并合并两个源的最新结果。 */
export function requestFontOptions(forceRefresh = false): Promise<FontOption[]> {
  return Promise.all([requestSystemFonts(forceRefresh), requestLocalFonts()]).then(([server, local]) => {
    const merged = new Map<string, FontOption>();
    for (const font of server) merged.set(font.family, font);
    for (const font of local ?? []) if (!merged.has(font.family)) merged.set(font.family, font);
    return [...merged.values()];
  });
}

/** 进入混剪步骤即预取两个源，让各字体下拉框打开的首帧就是全量。 */
export function preloadSystemFonts(): void {
  void requestSystemFonts().catch(() => undefined);
  void requestLocalFonts();
}
