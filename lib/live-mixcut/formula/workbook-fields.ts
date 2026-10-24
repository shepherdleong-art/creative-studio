/** 可由浏览器引用的字段名；不依赖 ExcelJS、文件或数据库。 */
export const FORMULA_WORKBOOK_FIELDS = {
  scripts: ['序号', '平台', '镜头数', '预估时长(s)', '画面分镜(逻辑镜号组合)', '脚本文案'],
  materials: ['逻辑编号', '画面描述'],
} as const;
