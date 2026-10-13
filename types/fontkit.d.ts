// fontkit 最小类型补丁（包本身无 TS 类型；仅声明本项目用到的 API）
declare module 'fontkit' {
  export interface FontkitFont {
    familyName?: string;
    fullName?: string;
    postscriptName?: string;
    /** TTC 集合内的全部 face。 */
    fonts?: FontkitFont[];
    /** OpenType name 表（records[nameID] = { 语言: 文本 }）。 */
    name?: { records?: Record<string, Record<string, string>> };
    hasGlyphForCodePoint(codepoint: number): boolean;
  }
  export function openSync(path: string): FontkitFont;
}