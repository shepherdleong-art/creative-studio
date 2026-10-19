// §8 ⑤ / §10 ② 用户字体（三槽：主标题/副标题/卖点）共享逻辑
// 存储：<packagingDir>/fonts/user/user-<slot>-<sha256前12>.<ext>（内容寻址，杜绝渲染竞态）
// 渲染：package-video.mjs / 预览端点按配置注入别名 "UserTitle"/"UserSubtitle"/"UserPoint" 的 @font-face。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSyncHidden } from '../spawn-hidden.ts';
import { openSync } from 'fontkit';
import { dataRoot } from '../data-root.ts';
import os from 'node:os';

export const USER_FONT_MAX_BYTES = 20 * 1024 * 1024;
/** 上传白名单（§8.5 自定义字体入口）。 */
export const USER_FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.woff2']);
/** 读取/注入白名单：额外含 .ttc（§9 系统字体物化，如微软雅黑合集）。 */
export const USER_FONT_READ_EXTENSIONS = new Set(['.ttf', '.otf', '.woff2', '.ttc']);
export const USER_FONT_FORMATS: Record<string, string> = { '.ttf': 'truetype', '.otf': 'opentype', '.woff2': 'woff2', '.ttc': 'truetype' };

/** 字体槽 → @font-face 别名（模板 font-family 链首位的固定别名）。 */
export const FONT_SLOT_ALIASES = { point: 'UserPoint', title: 'UserTitle', subtitle: 'UserSubtitle' } as const;
export type FontSlot = keyof typeof FONT_SLOT_ALIASES;
export const FONT_SLOTS: readonly FontSlot[] = ['title', 'subtitle', 'point'];

export function userFontDir(): string {
  return path.join(dataRoot(), 'storage', 'packaging', 'fonts');
}

/** §10.2-1 内容寻址物化：写新文件、返回 `user-<slot>-<hash>.<ext>`；同内容幂等不重复写。 */
export function materializeFontBuffer(buffer: Buffer, ext: string, slot: FontSlot): string {
  let hash = '';
  try { hash = createHash('sha256').update(buffer).digest('hex').slice(0, 12); } catch { hash = Date.now().toString(36); }
  const dir = userFontDir();
  fs.mkdirSync(dir, { recursive: true });
  const filename = `user-${slot}-${hash}${ext}`;
  const target = path.join(dir, filename);
  if (!fs.existsSync(target)) fs.writeFileSync(target, buffer, { flag: 'wx' });
  return filename;
}

/** §10.2-1 定期清理：删除超过 maxAgeMs 且未被任何 packagingJson 引用的物化字体（含旧固定名 user-point.*）；返回删除数。 */
export function cleanupOrphanUserFonts(referencedFiles: readonly string[], maxAgeMs = 7 * 24 * 3600_000): number {
  const refs = new Set(referencedFiles.map((file) => path.basename(file)));
  const dir = userFontDir();
  let removed = 0;
  let entries: string[] = [];
  try { entries = fs.readdirSync(dir); } catch { return 0; }
  const slotPattern = /^user-(point|title|subtitle)-[0-9a-f]{12,16}\.(ttf|ttc|otf|woff2)$/i;
  const legacyPattern = /^user-point\.(ttf|ttc|otf|woff2)$/i;
  for (const entry of entries) {
    if (!slotPattern.test(entry) && !legacyPattern.test(entry)) continue;
    if (refs.has(entry)) continue;
    const abs = path.join(dir, entry);
    try {
      if (Date.now() - fs.statSync(abs).mtimeMs > maxAgeMs) { fs.unlinkSync(abs); removed += 1; }
    } catch { /* 被占用/已删除忽略 */ }
  }
  return removed;
}

/** 魔数校验：ttf/otf/woff2 文件头；不认识的头部视为损坏。 */
export function sniffFontMagic(buffer: Buffer, ext: string): boolean {
  if (ext === '.woff2') return buffer.length >= 4 && buffer.readUInt32BE(0) === 0x774f4646; // 'wOFF2'
  if (ext === '.otf') return buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'OTTO';
  if (ext === '.ttf') {
    if (buffer.length >= 4) {
      const tag = buffer.toString('ascii', 0, 4);
      const sfnt = buffer.readUInt32BE(0);
      return sfnt === 0x00010000 || tag === 'true' || tag === 'typ1';
    }
    return false;
  }
  return false;
}

/** 读取当前卖点槽字体文件名（兼容旧固定名 user-point.<ext> 与新内容寻址名；无则 null）。 */
export function readUserFontFilename(): string | null {
  const dir = userFontDir();
  let entries: string[] = [];
  try { entries = fs.readdirSync(dir); } catch { return null; }
  let newest: { name: string; mtimeMs: number } | null = null;
  for (const entry of entries) {
    const ext = path.extname(entry).toLowerCase();
    if (!USER_FONT_READ_EXTENSIONS.has(ext)) continue;
    if (!entry.startsWith('user-point')) continue;
    const mtimeMs = fs.statSync(path.join(dir, entry)).mtimeMs;
    if (!newest || mtimeMs > newest.mtimeMs) newest = { name: entry, mtimeMs };
  }
  return newest?.name ?? null;
}

/** 与 package-video.mjs 同款的 @font-face 注入块（按槽注入对应别名）。 */
export function buildUserFontFaceCss(slot: FontSlot, fontFile: string): string {
  const ext = path.extname(fontFile).toLowerCase();
  const format = USER_FONT_FORMATS[ext] ?? 'truetype';
  return `<style>@font-face{font-family:"${FONT_SLOT_ALIASES[slot]}";src:url("fonts/user/${fontFile}") format("${format}");font-weight:100 900;}</style>`;
}

/** 合法物化文件名（防 HTML/路径注入）；非法返回 null。 */
export function safeFontFilename(file: string | undefined): string | null {
  if (!file) return null;
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(file)) return null;
  const ext = path.extname(file).toLowerCase();
  if (!USER_FONT_READ_EXTENSIONS.has(ext)) return null;
  return file;
}

/** 按包装配置三槽注入 @font-face（文件存在才注入；预览与成片共用）。 */
export function buildConfigFontFacesCss(config: {
  pointFont?: { family: string; file: string };
  titleFont?: { family: string; file: string };
  subtitleFont?: { family: string; file: string };
}): string {
  const blocks: string[] = [];
  const slots: Array<[FontSlot, string | undefined]> = [
    ['title', config.titleFont?.file],
    ['subtitle', config.subtitleFont?.file],
    ['point', config.pointFont?.file],
  ];
  for (const [slot, file] of slots) {
    const safe = safeFontFilename(file);
    if (safe && fs.existsSync(path.join(userFontDir(), safe))) blocks.push(buildUserFontFaceCss(slot, safe));
  }
  return blocks.join('');
}

// ---- §9 ② 系统字体枚举（fontkit cmap 检测 + 缓存 + 白名单物化） ----

export interface SystemFontEntry {
  /** 稳定键：绝对路径 + face 序号。 */
  key: string;
  /** 文件名（含扩展名）。 */
  file: string;
  /** 绝对路径（白名单内）。 */
  absPath: string;
  /** fontkit familyName（英文注册名）。 */
  family: string;
  /** 字体内置中文名（无则空，UI 双名显示）。 */
  nameZh: string;
  /** cmap 真实中文覆盖（非名字判断）。 */
  supportsCn: boolean;
  /** TTC 集合内的 face 序号（普通字体 0）。 */
  faceIndex: number;
  source: 'system';
}

/** 注册字体文件目录清单（条目内 path 与 file 已分离）。 */
export interface FontScanFile {
  absPath: string;
  file: string;
}

const CN_SAMPLE = '的一是了我不人在他有这上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被高已亲其进此话常与活正感';

const SYSTEM_FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.woff2']);

/** 白名单字体根（安全边界，防目录穿越）。 */
export function systemFontRoots(): string[] {
  if (process.platform === 'darwin') return ['/System/Library/Fonts', '/Library/Fonts', path.join(os.homedir(), 'Library/Fonts')];
  if (process.platform !== 'win32') return ['/usr/share/fonts', '/usr/local/share/fonts', path.join(os.homedir(), '.local/share/fonts')];
  const roots = [path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts')];
  const local = process.env.LOCALAPPDATA;
  if (local) roots.push(path.join(local, 'Microsoft', 'Windows', 'Fonts'));
  return roots;
}

export function isAllowedSystemFontPath(absPath: string): boolean {
  const normalized = path.resolve(absPath).toLowerCase();
  if (!SYSTEM_FONT_EXTENSIONS.has(path.extname(normalized))) return false;
  return systemFontRoots().some((root) => {
    const r = path.resolve(root).toLowerCase();
    return normalized === r || normalized.startsWith(`${r}${path.sep}`);
  });
}

/** 扫描白名单目录 + 注册表补充（用户安装到非标准位置的字体），按路径去重。 */
export function collectSystemFontFiles(): FontScanFile[] {
  const seen = new Set<string>();
  const files: FontScanFile[] = [];
  const addDir = (dir: string) => {
    let entries: string[] = [];
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const absPath = path.join(dir, name);
      const usedName = absPath.toLowerCase();
      if (!SYSTEM_FONT_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
      if (seen.has(usedName)) continue;
      seen.add(usedName);
      files.push({ absPath, file: name });
    }
  };
  for (const root of systemFontRoots()) addDir(root);
  // 注册表补充（reg query 直接列出绝对路径值）；解析失败静默跳过（目录扫描已覆盖系统字体目录）
  for (const hive of process.platform === 'win32' ? ['HKLM', 'HKCU'] : []) {
    try {
      const result = spawnSyncHidden('reg', ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts`], {
        encoding: 'latin1',
        windowsHide: true,
        timeout: 10_000,
      });
      const output: string = result.stdout || '';
      for (const line of output.split(/\r?\n/)) {
        const match = /^\s+[^ ]+[\t ]+REG_(?:SZ|EXPAND_SZ|MULTI_SZ)[\t ]+(.+)$/.exec(line.trim());
        if (!match) continue;
        const value = match[1].trim();
        let absPath: string | null = null;
        if (path.isAbsolute(value)) absPath = value;
        else if (/^[a-zA-Z]:[\\/]/.test(value)) absPath = value;
        if (!absPath) continue;
        // reg query latin1 解码下中文路径可能乱码——存在性校验会兜底过滤
        if (!fs.existsSync(absPath)) continue;
        const usedName = absPath.toLowerCase();
        if (seen.has(usedName)) continue;
        if (!SYSTEM_FONT_EXTENSIONS.has(path.extname(absPath).toLowerCase())) continue;
        // 仅接受白名单根或注册表显式路径存在且扩展白名单
        const extOk = SYSTEM_FONT_EXTENSIONS.has(path.extname(absPath).toLowerCase());
        const rootOk = isAllowedSystemFontPath(absPath);
        if (!extOk || !rootOk) continue;
        seen.add(usedName);
        files.push({ absPath, file: path.basename(absPath) });
      }
    } catch { /* 注册表不可读忽略 */ }
  }
  return files;
}

/** fontkit 单文件解析：返回 {family, nameZh, supportsCn}；失败返回 null（静默跳过）。 */
export function inspectFontFile(absPath: string, faceIndex: number): { family: string; nameZh: string; supportsCn: boolean } | null {
  try {
    const opened = faceIndex > 0 ? null : openSync(absPath);
    if (!opened) return null;
    const font = opened.fonts?.[faceIndex] ?? opened;
    const family = String(font.familyName || path.basename(absPath, path.extname(absPath)));
    let nameZh = '';
    try {
      // fontkit 2.x 的 name 表按语义键组织（fontFamily/fullName/...），值为 { 语言: 文本 }
      const familyRecord = font.name?.records?.fontFamily;
      if (familyRecord && typeof familyRecord === 'object') {
        const zh = familyRecord['zh'] ?? familyRecord['zh-CN'] ?? familyRecord['zh-Hans'];
        if (typeof zh === 'string') nameZh = zh.trim();
      }
    } catch { /* 无中文名记录 */ }
    let supportsCn = false;
    try {
      supportsCn = [...CN_SAMPLE].every((ch) => font.hasGlyphForCodePoint(ch.codePointAt(0) as number));
    } catch { supportsCn = false; }
    return { family, nameZh, supportsCn };
  } catch { return null; }
}

interface FontCacheFile {
  version: 1;
  rootsMtime: Record<string, number>;
  fonts: SystemFontEntry[];
  scannedAt: string;
}

function cachePath(): string {
  return path.join(dataRoot(), 'storage', 'packaging', 'font-scan-cache.json');
}

function rootsMtime(): Record<string, number> {
  const result: Record<string, number> = {};
  for (const root of systemFontRoots()) {
    try { result[root] = fs.statSync(root).mtimeMs; } catch { result[root] = 0; }
  }
  return result;
}

/** 全量扫描（fontkit 解析全部字体文件）；先查缓存，目录 mtime 一致且缓存存在则直接复用。 */
export function scanSystemFonts(force = false): { fonts: SystemFontEntry[]; scannedAt: string; fromCache: boolean } {
  const mtimes = rootsMtime();
  if (!force) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath(), 'utf-8')) as FontCacheFile;
      if (cached?.version === 1 && JSON.stringify(cached.rootsMtime) === JSON.stringify(mtimes) && Array.isArray(cached.fonts)) {
        return { fonts: cached.fonts, scannedAt: cached.scannedAt, fromCache: true };
      }
    } catch { /* 缓存不可用则重扫 */ }
  }
  const fonts: SystemFontEntry[] = [];
  for (const { absPath, file } of collectSystemFontFiles()) {
    // @font-face 对 ttc 只加载首个 face；faceIndex>0 不提供（避免 UI 上选了不生效）
    const inspected = inspectFontFile(absPath, 0);
    if (!inspected) continue;
    fonts.push({ key: `system:${absPath}`, file, absPath, family: inspected.family, nameZh: inspected.nameZh, supportsCn: inspected.supportsCn, faceIndex: 0, source: 'system' });
  }
  fonts.sort((a, b) => {
    if (a.supportsCn !== b.supportsCn) return a.supportsCn ? -1 : 1;
    return (a.nameZh || a.family).localeCompare(b.nameZh || b.family, 'zh');
  });
  const scannedAt = new Date().toISOString();
  try {
    fs.mkdirSync(path.dirname(cachePath()), { recursive: true });
    fs.writeFileSync(cachePath(), JSON.stringify({ version: 1, rootsMtime: mtimes, fonts, scannedAt } satisfies FontCacheFile), 'utf-8');
  } catch { /* 缓存写失败不影响返回 */ }
  return { fonts, scannedAt, fromCache: false };
}

/** 物化系统字体到 packaging/fonts/user/user-<slot>-<hash>.<ext>（§10.2-1 内容寻址；TTC 仅首 face）。 */
export function materializeSystemFont(absPath: string, slot: FontSlot = 'point'): string {
  if (!isAllowedSystemFontPath(absPath) || !fs.existsSync(absPath)) {
    throw new Error('字体文件不在允许的目录内或已不存在');
  }
  const buffer = fs.readFileSync(absPath);
  if (buffer.length === 0) throw new Error('字体文件为空');
  return materializeFontBuffer(buffer, path.extname(absPath).toLowerCase(), slot);
}
