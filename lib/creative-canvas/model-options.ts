/** 一个有效配置只显示一次；旧画布已选择的别名仍保留原键和参数。 */
export function canvasModelOptions<T extends { key: string; selectionAliasOf?: string }>(
  models: T[], selectedKey?: string | null,
): T[] {
  const selected = models.find(model => model.key === selectedKey);
  return models.filter(model => (!model.selectionAliasOf || model.key === selectedKey)
    && model.key !== selected?.selectionAliasOf);
}
