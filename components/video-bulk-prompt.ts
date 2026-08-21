export const MAX_ROWS_PER_SHOT = 10;

export interface BulkPromptTemplate {
  id: string;
  name?: string;
  description?: string;
  prompt: string;
}

export interface BulkPromptRow {
  prompt: string;
  templateId?: string | null;
}

export interface BulkPromptShot<Row extends BulkPromptRow = BulkPromptRow> {
  shotId: string;
  rows: readonly Row[];
}

export interface BulkPromptFillOptions {
  random?: () => number;
  overwriteEdited?: boolean;
}

export interface BulkPromptFillShotPlan<Row extends BulkPromptRow = BulkPromptRow> {
  shotId: string;
  rows: Row[];
  filledRows: number;
  keptRows: number;
}

export interface BulkPromptFillPlan<Row extends BulkPromptRow = BulkPromptRow> {
  shots: BulkPromptFillShotPlan<Row>[];
  filledRows: number;
  keptRows: number;
}

export interface BulkVideoGenerationShot<Row extends BulkPromptRow = BulkPromptRow> {
  shotId: string;
  rows: readonly Row[];
}

export interface BulkVideoGenerationOptions<Row extends BulkPromptRow = BulkPromptRow> {
  includeShotsWithExistingJobs?: boolean;
  shotsWithExistingJobs?: ReadonlySet<string> | readonly string[];
  rowIssue?: (row: Row, shot: BulkVideoGenerationShot<Row>) => string | null | undefined;
}

export interface BulkVideoReadyShot<Row extends BulkPromptRow = BulkPromptRow> {
  shotId: string;
  rows: Row[];
}

export interface BulkVideoSkippedShot<Row extends BulkPromptRow = BulkPromptRow> {
  shotId: string;
  rows: Row[];
}

export interface BulkVideoBlockedShot<Row extends BulkPromptRow = BulkPromptRow>
  extends BulkVideoSkippedShot<Row> {
  reason: string;
}

export interface BulkVideoGenerationPlan<Row extends BulkPromptRow = BulkPromptRow> {
  ready: BulkVideoReadyShot<Row>[];
  skippedEmpty: BulkVideoSkippedShot<Row>[];
  skippedExisting: BulkVideoSkippedShot<Row>[];
  blocked: BulkVideoBlockedShot<Row>[];
  overflow: BulkVideoSkippedShot<Row>[];
  totalClips: number;
}

type RandomSource = () => number;

function randomIndex(random: RandomSource, length: number): number {
  const value = random();
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(length - 1, Math.floor(value * length));
}

function shuffle<T>(items: readonly T[], random: RandomSource): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(random, index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

/** 按整副模板牌洗牌轮转，保证跨牌接缝也不会相邻撞模板。 */
export function buildTemplateSequence(
  templates: readonly BulkPromptTemplate[],
  count: number,
  random: RandomSource = Math.random,
): BulkPromptTemplate[] {
  const targetCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (targetCount === 0 || templates.length === 0) return [];
  if (templates.length === 1) return Array.from({ length: targetCount }, () => templates[0]);

  const sequence: BulkPromptTemplate[] = [];
  let previousId: string | null = null;
  while (sequence.length < targetCount) {
    const round = shuffle(templates, random);
    if (round[0].id === previousId) {
      const swapIndex = round.findIndex((template, index) => index > 0 && template.id !== previousId);
      if (swapIndex > 0) [round[0], round[swapIndex]] = [round[swapIndex], round[0]];
    }
    for (const template of round) {
      if (sequence.length >= targetCount) break;
      sequence.push(template);
      previousId = template.id;
    }
  }
  return sequence;
}

/** 与单行 updateRowTemplate 共用的“自动填充可覆盖”判定。 */
export function isPromptReplaceable(
  row: Pick<BulkPromptRow, 'prompt' | 'templateId'>,
  templates: readonly BulkPromptTemplate[],
): boolean {
  if (!row.prompt.trim()) return true;
  if (!row.templateId) return false;
  const template = templates.find((candidate) => candidate.id === row.templateId);
  return Boolean(template && row.prompt.trim() === template.prompt.trim());
}

/** 把还没有访问过的分镜补成一条空行，并保持分镜显示顺序。 */
export function materializeShotDrafts<T>(
  shotIds: readonly string[],
  read: (shotId: string) => readonly T[] | null | undefined,
  makeRow: () => T,
): Array<{ shotId: string; rows: T[] }> {
  return shotIds.map((shotId) => {
    const currentRows = read(shotId);
    return {
      shotId,
      rows: currentRows && currentRows.length > 0 ? [...currentRows] : [makeRow()],
    };
  });
}

export function planBulkPromptFill<Row extends BulkPromptRow>(
  shots: readonly BulkPromptShot<Row>[],
  templates: readonly BulkPromptTemplate[],
  options: BulkPromptFillOptions = {},
): BulkPromptFillPlan<Row> {
  const overwriteEdited = options.overwriteEdited === true;
  const fillableCount = templates.length === 0
    ? 0
    : shots.reduce((count, shot) => count + shot.rows.filter((row) => (
      overwriteEdited || isPromptReplaceable(row, templates)
    )).length, 0);
  const sequence = buildTemplateSequence(templates, fillableCount, options.random);
  let sequenceIndex = 0;
  let filledRows = 0;
  let keptRows = 0;

  const plannedShots = shots.map((shot) => {
    const rows = shot.rows.map((row) => {
      const replaceable = overwriteEdited || isPromptReplaceable(row, templates);
      if (!replaceable || sequenceIndex >= sequence.length) {
        keptRows += 1;
        return row;
      }
      const template = sequence[sequenceIndex++];
      filledRows += 1;
      return {
        ...row,
        templateId: template.id,
        prompt: template.prompt,
      };
    });
    return {
      shotId: shot.shotId,
      rows,
      filledRows: rows.filter((row, index) => row !== shot.rows[index]).length,
      keptRows: rows.filter((row, index) => row === shot.rows[index]).length,
    };
  });

  return { shots: plannedShots, filledRows, keptRows };
}

function hasExistingJobs(
  shotId: string,
  existing: ReadonlySet<string> | readonly string[] | undefined,
): boolean {
  if (!existing) return false;
  if (Array.isArray(existing)) return existing.includes(shotId);
  return (existing as ReadonlySet<string>).has(shotId);
}

function copyRows<Row extends BulkPromptRow>(rows: readonly Row[]): Row[] {
  return [...rows];
}

export function planBulkVideoGeneration<Row extends BulkPromptRow>(
  shots: readonly BulkVideoGenerationShot<Row>[],
  options: BulkVideoGenerationOptions<Row> = {},
): BulkVideoGenerationPlan<Row> {
  const ready: BulkVideoReadyShot<Row>[] = [];
  const skippedEmpty: BulkVideoSkippedShot<Row>[] = [];
  const skippedExisting: BulkVideoSkippedShot<Row>[] = [];
  const blocked: BulkVideoBlockedShot<Row>[] = [];
  const overflow: BulkVideoSkippedShot<Row>[] = [];

  for (const shot of shots) {
    const rows = copyRows(shot.rows);
    if (!options.includeShotsWithExistingJobs && hasExistingJobs(shot.shotId, options.shotsWithExistingJobs)) {
      skippedExisting.push({ shotId: shot.shotId, rows });
      continue;
    }

    const issues = rows
      .map((row) => options.rowIssue?.(row, shot) ?? null)
      .filter((issue): issue is string => Boolean(issue));
    if (issues.length > 0) {
      blocked.push({ shotId: shot.shotId, rows, reason: issues[0] });
      continue;
    }

    const filledRows = rows.filter((row) => row.prompt.trim().length > 0);
    if (filledRows.length === 0) {
      skippedEmpty.push({ shotId: shot.shotId, rows });
      continue;
    }

    if (filledRows.length > MAX_ROWS_PER_SHOT) {
      overflow.push({ shotId: shot.shotId, rows });
      continue;
    }

    ready.push({ shotId: shot.shotId, rows: filledRows });
  }

  return {
    ready,
    skippedEmpty,
    skippedExisting,
    blocked,
    overflow,
    totalClips: ready.reduce((total, shot) => total + shot.rows.length, 0),
  };
}
