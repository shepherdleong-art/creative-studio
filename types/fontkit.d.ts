// fontkit 最小类型补丁（包本身无 TS 类型；仅声明本项目用到的 API）
declare module 'fontkit' {
  /** 字形路径（可输出 SVG path d）。 */
  export interface FontkitPath {
    toSVG(): string;
  }
  export interface FontkitGlyph {
    path: FontkitPath;
  }
  /** layout() 的字形摆放位置（font units）。 */
  export interface FontkitPosition {
    xAdvance: number;
    yAdvance: number;
    xOffset: number;
    yOffset: number;
  }
  /** layout() 的排版结果。 */
  export interface FontkitRun {
    glyphs: FontkitGlyph[];
    positions: FontkitPosition[];
  }
  export interface FontkitFont {
    familyName?: string;
    fullName?: string;
    postscriptName?: string;
    unitsPerEm: number;
    /** TTC 集合内的全部 face。 */
    fonts?: FontkitFont[];
    /** OpenType name 表（records[nameID] = { 语言: 文本 }）。 */
    name?: { records?: Record<string, Record<string, string>> };
    hasGlyphForCodePoint(codepoint: number): boolean;
    /** 排版：返回字形序列与各自位置（font units）。 */
    layout(text: string): FontkitRun;
    /** 可变字体：按坐标轴(如 { wght: 400 })取具体字重实例。 */
    getVariation(coords: Record<string, number>): FontkitFont;
  }
  export function openSync(path: string): FontkitFont;
}