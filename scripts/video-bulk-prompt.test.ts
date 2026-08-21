import assert from 'node:assert/strict';
import {
  MAX_ROWS_PER_SHOT,
  buildTemplateSequence,
  isPromptReplaceable,
  materializeShotDrafts,
  planBulkPromptFill,
  planBulkVideoGeneration,
} from '../components/video-bulk-prompt.ts';

type Template = { id: string; prompt: string };
type Row = {
  key: string;
  prompt: string;
  templateId: string;
  providerId: string;
  durationSec: number;
};

const templates: Template[] = Array.from({ length: 5 }, (_, index) => ({
  id: `template-${index + 1}`,
  prompt: `模板原文 ${index + 1}`,
}));

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function makeRow(
  key: string,
  prompt = '',
  templateId = '',
): Row {
  return {
    key,
    prompt,
    templateId,
    providerId: 'provider-a',
    durationSec: 5,
  };
}

assert.equal(MAX_ROWS_PER_SHOT, 10, 'the client limit must mirror the batch API');

for (let seed = 1; seed <= 50; seed += 1) {
  const sequence = buildTemplateSequence(templates, 60, seededRandom(seed));
  assert.equal(sequence.length, 60, `seed ${seed} must produce all requested rows`);
  for (let index = 1; index < sequence.length; index += 1) {
    assert.notEqual(
      sequence[index - 1]?.id,
      sequence[index]?.id,
      `seed ${seed} must not repeat adjacent templates`,
    );
  }

  const counts = new Map(templates.map((template) => [template.id, 0]));
  for (const template of sequence) counts.set(template.id, (counts.get(template.id) ?? 0) + 1);
  assert.equal(counts.size, templates.length, `seed ${seed} must use every template`);
  const values = [...counts.values()];
  assert.ok(Math.max(...values) - Math.min(...values) <= 1, `seed ${seed} must balance template usage`);
}

assert.deepEqual(
  buildTemplateSequence(templates, 60, seededRandom(20260821)),
  buildTemplateSequence(templates, 60, seededRandom(20260821)),
  'the same injected random stream must produce the same sequence',
);
assert.equal(
  new Set(buildTemplateSequence(templates, 3, () => 0.25)).size,
  3,
  'a partial round must not repeat a template',
);
assert.deepEqual(buildTemplateSequence(templates, 0, () => 0.5), [], 'count zero must be empty');
assert.deepEqual(buildTemplateSequence([], 10, () => 0.5), [], 'an empty template pool must be empty');
assert.deepEqual(
  buildTemplateSequence([{ id: 'only', prompt: '唯一模板' }], 4, () => 0.5).map((template) => template.id),
  ['only', 'only', 'only', 'only'],
  'one template is allowed to repeat',
);

const firstTemplate = templates[0]!;
assert.equal(isPromptReplaceable(makeRow('empty'), templates), true, 'an empty prompt is replaceable');
assert.equal(isPromptReplaceable(makeRow('spaces', '  \n\t'), templates), true, 'whitespace is replaceable');
assert.equal(
  isPromptReplaceable(makeRow('auto', firstTemplate.prompt, firstTemplate.id), templates),
  true,
  'the current template original is replaceable',
);
assert.equal(
  isPromptReplaceable(makeRow('edited', `${firstTemplate.prompt}，手改`, firstTemplate.id), templates),
  false,
  'a prompt edited from a template is protected',
);
assert.equal(
  isPromptReplaceable(makeRow('manual', '手写提示词'), templates),
  false,
  'a non-template manual prompt is protected',
);

let madeRows = 0;
const visitedRow = makeRow('visited-row', '已有草稿');
const materialized = materializeShotDrafts(
  ['shot-2', 'shot-1', 'shot-3'],
  (shotId) => (shotId === 'shot-1' ? [visitedRow] : undefined),
  () => {
    madeRows += 1;
    return makeRow(`new-row-${madeRows}`);
  },
);
assert.deepEqual(materialized.map(({ shotId }) => shotId), ['shot-2', 'shot-1', 'shot-3']);
assert.deepEqual(materialized[1]?.rows, [visitedRow], 'visited rows must remain in place');
assert.equal(materialized[0]?.rows.length, 1, 'an unvisited shot receives one draft row');
assert.equal(materialized[2]?.rows.length, 1, 'every unvisited shot receives one draft row');
assert.equal(madeRows, 2, 'makeRow must run only for unvisited shots');
assert.deepEqual(
  materializeShotDrafts(['visited-empty'], () => [], () => makeRow('must-not-be-created'))[0]?.rows,
  [makeRow('must-not-be-created')],
  'an empty read result is the unvisited draft marker and receives one row',
);

const fillInput = [
  {
    shotId: 'shot-1',
    rows: [
      makeRow('blank-1'),
      makeRow('manual-1', '用户手写内容'),
      makeRow('auto-1', templates[1]!.prompt, templates[1]!.id),
    ],
  },
  {
    shotId: 'shot-2',
    rows: [makeRow('blank-2')],
  },
];
const fillPlan = planBulkPromptFill(fillInput, templates, {
  random: seededRandom(7),
});
assert.equal(fillPlan.filledRows, 3, 'only replaceable rows must be filled');
assert.equal(fillPlan.keptRows, 1, 'edited rows must be counted as kept');
const expectedFillSequence = buildTemplateSequence(templates, 3, seededRandom(7));
assert.deepEqual(
  [
    fillPlan.shots[0]!.rows[0]!,
    fillPlan.shots[0]!.rows[2]!,
    fillPlan.shots[1]!.rows[0]!,
  ].map((row) => row.templateId),
  expectedFillSequence.map((template) => template.id),
  'replaceable rows must receive templates in flattened shot display order',
);
assert.deepEqual(
  fillPlan.shots.flatMap(({ rows }) => rows).map((row) => row.prompt),
  [
    fillPlan.shots[0]!.rows[0]!.prompt,
    '用户手写内容',
    fillPlan.shots[0]!.rows[2]!.prompt,
    fillPlan.shots[1]!.rows[0]!.prompt,
  ],
  'the plan must preserve the flattened display order and manual row',
);
for (const shot of fillPlan.shots) {
  for (const row of shot.rows) {
    if (row.key === 'manual-1') continue;
    assert.ok(
      templates.some((template) => template.id === row.templateId && template.prompt === row.prompt),
      `row ${row.key} must contain a template original`,
    );
  }
}
assert.notEqual(
  fillPlan.shots[0]!.rows[0]!.templateId,
  fillPlan.shots[1]!.rows[0]!.templateId,
  'template assignment must continue across the shot boundary',
);

const editedFill = planBulkPromptFill(
  [{ shotId: 'shot-edited', rows: [makeRow('edited-row', '用户手写内容')] }],
  templates,
  { overwriteEdited: true, random: () => 0.1 },
);
assert.equal(editedFill.filledRows, 1, 'overwriteEdited must include manual rows');
assert.equal(editedFill.keptRows, 0, 'overwritten manual rows are not kept');
assert.ok(
  templates.some((template) => (
    template.id === editedFill.shots[0]?.rows[0]?.templateId
    && template.prompt === editedFill.shots[0]?.rows[0]?.prompt
  )),
  'overwriteEdited must write a template original',
);
assert.deepEqual(
  planBulkPromptFill(
    [{ shotId: 'empty-templates', rows: [makeRow('empty-template-row')] }],
    [],
    { random: () => 0.5 },
  ).shots[0]?.rows[0],
  makeRow('empty-template-row'),
  'an empty template pool must not write an empty prompt',
);

const overflowRows = Array.from({ length: MAX_ROWS_PER_SHOT + 1 }, (_, index) => makeRow(`overflow-${index}`, `片段 ${index}`));
const generationShots = [
  { shotId: 'ready', rows: [makeRow('ready-1', '准备一'), makeRow('ready-2', '准备二')] },
  { shotId: 'empty', rows: [makeRow('empty-row')] },
  { shotId: 'existing', rows: [makeRow('existing-row', '已有任务')] },
  { shotId: 'blocked', rows: [makeRow('blocked-row', '有尾帧问题')] },
  { shotId: 'overflow', rows: overflowRows },
];
const generationPlan = planBulkVideoGeneration(generationShots, {
  shotsWithExistingJobs: new Set(['existing']),
  rowIssue: (row) => row.key === 'blocked-row' ? '尾帧协议不可用' : null,
});
assert.deepEqual(
  generationPlan.ready.map(({ shotId, rows }) => ({ shotId, rowCount: rows.length })),
  [{ shotId: 'ready', rowCount: 2 }],
  'ready must contain only filled, unblocked, in-limit shots',
);
assert.deepEqual(generationPlan.skippedEmpty.map(({ shotId }) => shotId), ['empty']);
assert.deepEqual(generationPlan.skippedExisting.map(({ shotId }) => shotId), ['existing']);
assert.deepEqual(
  generationPlan.blocked.map(({ shotId, reason }) => ({ shotId, reason })),
  [{ shotId: 'blocked', reason: '尾帧协议不可用' }],
);
assert.deepEqual(
  generationPlan.overflow.map(({ shotId, rows }) => ({ shotId, count: rows.length })),
  [{ shotId: 'overflow', count: MAX_ROWS_PER_SHOT + 1 }],
);
assert.equal(generationPlan.totalClips, 2, 'totalClips must count ready rows, not shots');

const includedExisting = planBulkVideoGeneration(generationShots, {
  includeShotsWithExistingJobs: true,
  shotsWithExistingJobs: new Set(['existing']),
  rowIssue: (row) => row.key === 'blocked-row' ? '尾帧协议不可用' : null,
});
assert.deepEqual(
  includedExisting.ready.map(({ shotId }) => shotId),
  ['ready', 'existing'],
  'includeShotsWithExistingJobs must include otherwise skipped shots',
);

const blockedEmpty = planBulkVideoGeneration(
  [{ shotId: 'blocked-empty', rows: [makeRow('blocked-empty-row')] }],
  { rowIssue: () => '空提示词仍带着尾帧' },
);
assert.deepEqual(
  blockedEmpty.blocked.map(({ shotId, reason }) => ({ shotId, reason })),
  [{ shotId: 'blocked-empty', reason: '空提示词仍带着尾帧' }],
  'rowIssue must be able to block a row before empty-prompt routing',
);

console.log('video-bulk-prompt tests passed');
