// scripts/batch-color-pipeline.test.ts
import assert from 'node:assert/strict';
import {
  buildColorFilterFragments,
  escapeFfmpegFilterPath,
  COLOR_SNAPSHOT_OFF,
  makeColorSnapshot,
  isValidColorSnapshot,
} from '../lib/batch-production/color-pipeline.ts';

const SDR_CONTRACT = 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv';

// --- LUT 关闭:不产生任何 lut3d 片段,但 SDR 输出合同片段始终存在 ---
// SDR 输出合同是真实 filter(sdr-v1),不是字符串标签:输出显式声明为
// BT.709 受限范围,绝不依赖 FFmpeg 默认值。
assert.deepEqual(
  buildColorFilterFragments({ colorSnapshot: COLOR_SNAPSHOT_OFF, resolveLutAbsolutePath: () => '/should/not/be/called' }),
  [SDR_CONTRACT],
  'LUT 关闭时仍必须输出 SDR 合同片段(真实 filter,不是标签)',
);

// --- LUT 开启:lut3d 片段 + SDR 合同片段,路径正确传入 resolve 回调,显式三线性插值 ---
let resolvedWith = '';
const fragments = buildColorFilterFragments({
  colorSnapshot: makeColorSnapshot('lut-1', `sha256:${'a'.repeat(64)}`),
  resolveLutAbsolutePath: (lutId) => {
    resolvedWith = lutId;
    return '/data/storage/luts/project-1/lut-1.cube';
  },
});
assert.equal(resolvedWith, 'lut-1');
assert.deepEqual(fragments, [
  `lut3d='/data/storage/luts/project-1/lut-1.cube':interp=trilinear`,
  SDR_CONTRACT,
], 'LUT 开启时必须先应用显式插值的 lut3d,再输出 SDR 合同片段');

// --- Windows 风格带盘符冒号的路径必须被正确转义,不能破坏 filtergraph 语法 ---
const windowsFragments = buildColorFilterFragments({
  colorSnapshot: makeColorSnapshot('lut-2', `sha256:${'b'.repeat(64)}`),
  resolveLutAbsolutePath: () => String.raw`C:\Users\demo\AppData\storage\luts\project-1\lut-2.cube`,
});
assert.deepEqual(windowsFragments, [
  String.raw`lut3d='C\:\\Users\\demo\\AppData\\storage\\luts\\project-1\\lut-2.cube':interp=trilinear`,
  SDR_CONTRACT,
]);

// --- 单引号必须被转义,不能提前闭合 filter 取值 ---
assert.equal(escapeFfmpegFilterPath("/tmp/it's-a-lut.cube"), String.raw`/tmp/it\'s-a-lut.cube`);

// --- 完整快照校验:关闭必须空指纹;引用 LUT 必须非空、不能是 unresolved 标记 ---
assert.ok(isValidColorSnapshot(COLOR_SNAPSHOT_OFF), '关闭快照(空指纹)必须有效');
assert.ok(isValidColorSnapshot(makeColorSnapshot('lut-1', `sha256:${'a'.repeat(64)}`)), '引用 LUT 的完整快照必须有效');
assert.ok(!isValidColorSnapshot({ ...COLOR_SNAPSHOT_OFF, lutFingerprint: 'whatever' }), '关闭快照带非空指纹无效');
assert.ok(!isValidColorSnapshot({ ...makeColorSnapshot('lut-1', `sha256:${'a'.repeat(64)}`), lutFingerprint: '' }), '引用 LUT 但空指纹无效');
assert.ok(!isValidColorSnapshot({ ...makeColorSnapshot('lut-1', `sha256:${'a'.repeat(64)}`), lutFingerprint: 'unresolved:lut-1' }), 'unresolved 标记不能冒充有效指纹');

// --- makeColorSnapshot 拒绝空指纹/标记,禁止空字符串绕过冻结合同 ---
assert.throws(() => makeColorSnapshot('lut-1', ''), /非空且可解析/);
assert.throws(() => makeColorSnapshot('lut-1', 'unresolved:lut-1'), /非空且可解析/);

console.log('batch-color-pipeline tests passed');
