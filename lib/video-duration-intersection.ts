/**
 * 批量检查窗口的「统一秒数」：只允许**所选分镜的模型都支持**的秒数。
 *
 * 现状（改前）是取第一行的 `capabilities.durations`，换个统一供应商、或某个分镜
 * 换了更严格的模型（例如公司网关 Kling 2.5 只给 5/10 秒）之后，下拉里就会出现
 * 某些模型根本不接受的秒数，提交时才在服务端被 `videoDurationError` 拒掉。
 *
 * 这里只做纯计算，不读供应商、不猜模型：调用方传入每个模型的秒数表，
 * 拿回交集。能力表的权威来源仍是 `lib/video-duration.ts` 与
 * `lib/video-model-capabilities.ts`——本函数不会放宽任何一条限制。
 */

/**
 * 取各模型都支持的秒数（交集），**升序、去重**。
 *
 * 边界（验收要求逐条断言）：
 * - 空输入 → `[]`（还没选模型，没有可统一的秒数）；
 * - 只有一个模型 → 它自己的列表（去重升序后）；
 * - 任一模型的列表为空 → `[]`（那个模型什么秒数都不支持）；
 * - 交集为空 → `[]`（界面必须给出说明，不能静默给一个空下拉）。
 */
export function intersectDurations(models: ReadonlyArray<readonly number[]>): number[] {
  if (models.length === 0) return [];
  const normalized = models.map((durations) => {
    const unique = new Set<number>();
    for (const value of durations) {
      // 只接受有限数值；NaN / Infinity 一律丢弃，避免把脏数据当成合法秒数。
      if (typeof value === 'number' && Number.isFinite(value)) unique.add(value);
    }
    return unique;
  });
  if (normalized.some((values) => values.size === 0)) return [];
  const [first, ...rest] = normalized;
  const shared = [...first!].filter((value) => rest.every((values) => values.has(value)));
  return shared.sort((left, right) => left - right);
}

/**
 * 交集的中文说明：连续区间写「4–7 秒」，离散值写「5 / 10 秒」，空交集如实说明。
 * 空交集必须有一句人话（界面不能只显示一个空下拉）。
 */
export function describeDurationIntersection(durations: readonly number[]): string {
  const values = [...durations].sort((left, right) => left - right);
  if (values.length === 0) return '没有共同支持的秒数';
  if (values.length === 1) return `${values[0]} 秒`;
  const contiguous = values.every((value, index) => index === 0 || value === values[index - 1] + 1);
  return contiguous
    ? `${values[0]}–${values[values.length - 1]} 秒`
    : `${values.join(' / ')} 秒`;
}
