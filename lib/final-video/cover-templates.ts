// lib/final-video/cover-templates.ts
/**
 * 封面模板配置。参考 docs/模块化标准整理.xlsx「封面样式」sheet 中 3 个样例重建。
 * 模板只表达"哪些文字放在哪里、用什么色彩和装饰"，具体渲染由 cover.ts 解释执行。
 */

export type CoverTemplateId = 'luxury-01' | 'minimal-01' | 'luxury-02';

export interface CoverTemplateLayout {
  /** 标题区域：位置百分比（左上角原点） */
  titleBox: { xPct: number; yPct: number; widthPct: number; align: 'left' | 'center' };
  /** 卖点列表区域 */
  sellingPointsBox?: { xPct: number; yPct: number; widthPct: number; maxItems: number };
  /** 标签区域 */
  tagBox?: { xPct: number; yPct: number; widthPct: number };
}

export interface CoverTemplateTheme {
  /** 半透明遮罩颜色，如 "black@0.35" */
  backgroundOverlay?: string;
  /** 强调色（装饰条/标签背景等） */
  accentColor: string;
  /** 标题颜色 */
  titleColor: string;
  /** 正文（卖点/标签）颜色 */
  bodyColor: string;
}

export interface CoverTemplate {
  id: CoverTemplateId;
  name: string;
  /** 溯源 */
  reference: {
    workbookSheet: string;
    cell: string;
    sourceImage: string;
  };
  theme: CoverTemplateTheme;
  layout: CoverTemplateLayout;
  /** 预渲染示例图，供面板卡片选择器展示。由 scripts/generate-cover-template-previews.mjs 生成。 */
  previewImage: string;
  /** 卡片上标注该模板会渲染哪些元素，如 ['标题','卖点'] */
  elements: string[];
}

export const COVER_TEMPLATES: Record<CoverTemplateId, CoverTemplate> = {
  'luxury-01': {
    id: 'luxury-01',
    name: '轻奢封面 01',
    reference: { workbookSheet: '封面样式', cell: 'B7', sourceImage: 'xl/media/image152.png' },
    theme: {
      backgroundOverlay: 'black@0.30',
      accentColor: '#C8A96E',
      titleColor: '#FFFFFF',
      bodyColor: '#E8DCC8',
    },
    layout: {
      titleBox: { xPct: 8, yPct: 68, widthPct: 84, align: 'left' },
      sellingPointsBox: { xPct: 8, yPct: 78, widthPct: 84, maxItems: 3 },
    },
    previewImage: '/cover-templates/luxury-01.jpg',
    elements: ['标题', '卖点'],
  },
  'minimal-01': {
    id: 'minimal-01',
    name: '简约封面 01',
    reference: { workbookSheet: '封面样式', cell: 'C5', sourceImage: 'xl/media/image40.jpeg' },
    theme: {
      accentColor: '#FFFFFF',
      titleColor: '#FFFFFF',
      bodyColor: '#CCCCCC',
    },
    layout: {
      titleBox: { xPct: 10, yPct: 45, widthPct: 80, align: 'center' },
    },
    previewImage: '/cover-templates/minimal-01.jpg',
    elements: ['标题'],
  },
  'luxury-02': {
    id: 'luxury-02',
    name: '轻奢封面 02',
    reference: { workbookSheet: '封面样式', cell: 'B8', sourceImage: 'xl/media/image153.png' },
    theme: {
      backgroundOverlay: 'black@0.25',
      accentColor: '#D4AF37',
      titleColor: '#FFFFFF',
      bodyColor: '#F0E6D3',
    },
    layout: {
      titleBox: { xPct: 10, yPct: 60, widthPct: 80, align: 'left' },
      sellingPointsBox: { xPct: 10, yPct: 72, widthPct: 80, maxItems: 3 },
      tagBox: { xPct: 10, yPct: 88, widthPct: 80 },
    },
    previewImage: '/cover-templates/luxury-02.jpg',
    // 注意：layout.tagBox 目前未被 cover.ts 消费（无渲染实现），故不在 elements 中标注"标签"，
    // 避免用户以为选这个模板会有标签渲染。详见计划文档末尾"计划外偏差记录"。
    elements: ['标题', '卖点'],
  },
};

export function resolveTemplate(id: CoverTemplateId | string | undefined): CoverTemplate {
  if (id && id in COVER_TEMPLATES) return COVER_TEMPLATES[id as CoverTemplateId];
  return COVER_TEMPLATES['minimal-01'];
}

export const TEMPLATE_OPTIONS: Array<{ id: CoverTemplateId; name: string; previewImage: string; elements: string[] }> =
  Object.values(COVER_TEMPLATES).map((t) => ({ id: t.id, name: t.name, previewImage: t.previewImage, elements: t.elements }));
