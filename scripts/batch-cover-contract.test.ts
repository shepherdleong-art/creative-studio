import assert from 'node:assert/strict';
import {
  computeCoverContractHash,
  computeFullRenderContractHash,
  canonicalJson,
  type CoverContractInput,
  type FullRenderContractInput,
} from '../lib/batch-production/cover-contract.ts';
import { COLOR_SNAPSHOT_OFF, type ColorSnapshotV1 } from '../lib/batch-production/color-pipeline.ts';
import { defaultTextStyle } from '../lib/media-core/cover-domain.ts';

const baseTitle = {
  primary: '主标题',
  secondary: '副标题',
  styles: {
    primary: defaultTextStyle('coverPrimary', 1080),
    secondary: defaultTextStyle('coverSecondary', 1080),
  },
} satisfies NonNullable<CoverContractInput['title']>;

const baseCover: CoverContractInput = {
  outputVersionId: 'ov-1',
  coverRendererVersion: 'batch-cover-v1',
  assetId: 'asset-a',
  assetFingerprint: 'sha256:aaa',
  timeUs: 1_500_000,
  preset: '3:4',
  outputWidth: 1080,
  outputHeight: 1440,
  colorSnapshot: COLOR_SNAPSHOT_OFF,
  lutFingerprint: null,
  framing: { scale: 1, offsetX: 0, offsetY: 0 },
  title: baseTitle,
};

const baseLutSnapshot: ColorSnapshotV1 = {
  lutId: 'lut-1',
  lutFingerprint: 'sha256:lut',
  colorPipelineVersion: 'v1',
  interpolation: 'trilinear',
  outputContract: 'srgb-v1',
};

function mutate<K extends keyof CoverContractInput>(key: K, value: CoverContractInput[K]): CoverContractInput {
  return { ...baseCover, [key]: value };
}

// 同一输入必须产生同一哈希(键顺序无关的规范化 JSON)。
assert.equal(computeCoverContractHash(baseCover), computeCoverContractHash({ ...baseCover }));
const reordered = JSON.parse(canonicalJson(baseCover)) as Record<string, unknown>;
const { assetId, ...rest } = reordered;
assert.equal(
  canonicalJson({ assetId, ...rest }),
  canonicalJson(baseCover),
  '规范化 JSON 必须与键插入顺序无关',
);

// 封面契约的每个有效输入变化都必须改变哈希。
assert.notEqual(computeCoverContractHash(mutate('assetId', 'asset-b')), computeCoverContractHash(baseCover));
assert.notEqual(computeCoverContractHash(mutate('assetFingerprint', 'sha256:bbb')), computeCoverContractHash(baseCover));
assert.notEqual(computeCoverContractHash(mutate('timeUs', 2_500_000)), computeCoverContractHash(baseCover));
assert.notEqual(computeCoverContractHash(mutate('preset', '9:16')), computeCoverContractHash(baseCover));
assert.notEqual(computeCoverContractHash(mutate('outputWidth', 1920)), computeCoverContractHash(baseCover));
assert.notEqual(
  computeCoverContractHash(mutate('colorSnapshot', baseLutSnapshot)),
  computeCoverContractHash(baseCover),
  '色彩链变化必须改变哈希',
);
assert.notEqual(computeCoverContractHash(mutate('lutFingerprint', 'sha256:lut')), computeCoverContractHash(baseCover));
assert.notEqual(
  computeCoverContractHash(mutate('framing', { scale: 1.2, offsetX: 0.1, offsetY: 0 })),
  computeCoverContractHash(baseCover),
  '构图变化必须改变哈希',
);
assert.notEqual(
  computeCoverContractHash(mutate('title', { ...baseTitle, primary: '新主标题' })),
  computeCoverContractHash(baseCover),
  '主标题变化必须改变哈希',
);
assert.notEqual(
  computeCoverContractHash(mutate('title', {
    ...baseTitle,
    styles: {
      primary: { ...baseTitle.styles.primary, fontSizePx: 120 },
      secondary: baseTitle.styles.secondary,
    },
  })),
  computeCoverContractHash(baseCover),
  '标题样式变化必须改变哈希',
);
assert.ok(computeCoverContractHash(baseCover).startsWith('cov_'), '封面契约哈希格式');

// 完整渲染契约:editRevision、封面契约与画面安排任一变化都必须改变哈希。
const baseFull: FullRenderContractInput = {
  outputVersionId: 'ov-1',
  editRevision: 3,
  adapterVersion: 'batch-render-v3',
  preset: '3:4',
  outputWidth: 1080,
  outputHeight: 1440,
  coverContractHash: computeCoverContractHash(baseCover),
  clips: [{
    clipId: 'clip-1',
    assetId: 'asset-a',
    sourceStartUs: 0,
    sourceEndUs: 2_000_000,
    timelineStartUs: 0,
    timelineEndUs: 2_000_000,
  }],
  narration: { relativePath: 'batch-narration/n.wav', fingerprint: 'sha256:narr', durationUs: 2_000_000 },
  subtitles: null,
  music: null,
};
assert.equal(computeFullRenderContractHash(baseFull), computeFullRenderContractHash({ ...baseFull }));
assert.notEqual(
  computeFullRenderContractHash({ ...baseFull, editRevision: 4 }),
  computeFullRenderContractHash(baseFull),
  '编辑修订号变化必须改变完整渲染契约',
);
assert.notEqual(
  computeFullRenderContractHash({ ...baseFull, coverContractHash: 'cov_other' }),
  computeFullRenderContractHash(baseFull),
  '封面契约变化必须改变完整渲染契约',
);
assert.notEqual(
  computeFullRenderContractHash({
    ...baseFull,
    clips: [{ ...baseFull.clips[0]!, sourceStartUs: 500_000 }],
  }),
  computeFullRenderContractHash(baseFull),
  '画面安排变化必须改变完整渲染契约',
);
assert.notEqual(
  computeFullRenderContractHash({ ...baseFull, narration: null }),
  computeFullRenderContractHash(baseFull),
  '口播变化必须改变完整渲染契约',
);
assert.ok(computeFullRenderContractHash(baseFull).startsWith('rnd_'), '完整渲染契约哈希格式');

console.log('batch cover contract tests passed');