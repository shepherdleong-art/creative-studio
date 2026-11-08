/**
 * 窄窗口收法（15 号票，临时开关）。
 *
 * 规格「小窗口与画面尺寸」要求「宽度小于 1280 时侧栏收成只有图标的窄条（悬停显示名称）」，
 * 但原型没有覆盖这一条，实施时必须**先出截图请用户确认**。为了让三种收法能在同一个构建里
 * 分别截图比较，这里留一个**只用一次的试用开关**（`?narrow=icon|hover|drawer`）：
 *
 *   icon    图标窄条 + 悬停浮出名称（规格原文，默认）
 *   hover   图标窄条，悬停整条展开
 *   drawer  44px 让位 + 覆盖式抽屉
 *
 * 样式规则在 `workspace.module.css` 里按 aside 的 `data-narrow-style` 分派。
 * 用户选定后：这个文件和 CSS 里的另外两套一起删掉，只留选中的那套（见 15 号票 Comments）。
 */

export type NarrowStyle = 'icon' | 'hover' | 'drawer';

const STYLES: NarrowStyle[] = ['icon', 'hover', 'drawer'];

export function isNarrowStyle(value: unknown): value is NarrowStyle {
  return STYLES.includes(value as NarrowStyle);
}

/**
 * 当前收法：URL 的 `?narrow=` 优先（只用于截图比较，不写存储、不落库），
 * 否则退回规格原文的图标窄条。
 */
export function resolveNarrowStyle(search: string): NarrowStyle {
  const value = new URLSearchParams(search).get('narrow');
  return isNarrowStyle(value) ? value : 'icon';
}
