export const FURNITURE_OPTIONS = [
  '床', '床垫', '沙发', '书柜', '书桌', '餐桌', '餐椅', '茶几', '电视柜',
  '衣柜', '床头柜', '斗柜', '玄关柜', '鞋柜', '梳妆台', '床和床头柜', '餐桌和餐椅',
];

export const ROOM_OPTIONS = ['卧室', '客厅', '书房', '餐厅', '儿童房', '玄关', '阳台', '办公室'];

// 只识别模板中的变量位置，避免改到额外要求或把“模特”当成家具替换。
const FURNITURE_SLOT = /(保持图中)([^，。；\n]+?)(和模特|与模特|及模特)?(的一致性不变)/;
const ROOM_SLOTS = [
  /(让)([^，。；\n]+?)(温馨舒适)/,
  /(更换)([^，。；\n]+?)(的其他家具)/,
];

export function readFurniturePrompt(prompt: string) {
  return {
    furniture: FURNITURE_SLOT.exec(prompt)?.[2] || '',
    room: ROOM_SLOTS.map((pattern) => pattern.exec(prompt)?.[2]).find(Boolean) || '',
  };
}

export function updateFurniturePrompt(prompt: string, field: 'furniture' | 'room', value: string): string {
  if (!value.trim()) return prompt;
  if (field === 'furniture') {
    return prompt.replace(FURNITURE_SLOT, (_match, prefix, _previous, model, suffix) =>
      `${prefix}${value}${model || ''}${suffix}`);
  }
  return ROOM_SLOTS.reduce((text, pattern) => text.replace(pattern, (_match, prefix, _previous, suffix) =>
    `${prefix}${value}${suffix}`), prompt);
}
