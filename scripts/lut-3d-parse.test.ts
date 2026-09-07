// scripts/lut-3d-parse.test.ts
//
// C1 纯逻辑测试:.cube 解析(注释/DOMAIN 头/尺寸 2·17·33)、红轴变化最快的
// texel 排列、RGBA 展开(alpha=1)、损坏文件各报可识别错误、DOMAIN 归一数据。
// WebGL 部分(纹理上传/采样)依赖浏览器,不在此测试范围。
import assert from 'node:assert/strict';
import {
  CubeLutParseError,
  lutSampleOffset,
  lutSampleScale,
  parseCubeLut,
} from '../components/batch-production/lut-3d.ts';

/** 与 shader 同式的线性映射:(color − offset) × scale,验证 texel 中心修正后的落点 */
function sampleCoord(input: number, domainMin: number, domainMax: number, size: number): number {
  return (input - lutSampleOffset(domainMin, domainMax, size)) * lutSampleScale(domainMin, domainMax, size);
}

function identitySizeTenText(size: number, comments: boolean, domain = false): string {
  const header = [
    domain ? '# identity cube' : '# identity cube',
    'TITLE "identity"',
    domain ? 'DOMAIN_MIN 0.0 0.0 0.0' : 'DOMAIN_MIN 0 0 0',
    domain ? 'DOMAIN_MAX 1.0 1.0 1.0' : 'DOMAIN_MAX 1 1 1',
    `LUT_3D_SIZE ${size}`,
    ...(comments ? ['# data below'] : []),
  ];
  const lines = [...header];
  for (let b = 0; b < size; b += 1) {
    for (let g = 0; g < size; g += 1) {
      for (let r = 0; r < size; r += 1) {
        lines.push(`${(r / (size - 1)).toFixed(6)} ${(g / (size - 1)).toFixed(6)} ${(b / (size - 1)).toFixed(6)}`);
      }
    }
  }
  return lines.join('\n');
}

// ================================================================
// 合法解析:尺寸 2 / 17 / 33,含注释与 DOMAIN 头
// ================================================================
{
  for (const size of [2, 17, 33]) {
    const parsed = parseCubeLut(identitySizeTenText(size, true, true));
    assert.equal(parsed.size, size);
    assert.equal(parsed.data.length, size * size * size * 4, 'RGBA 展开必须为 size^3 * 4');
    assert.deepEqual(parsed.domainMin, [0, 0, 0]);
    assert.deepEqual(parsed.domainMax, [1, 1, 1]);
  }
  console.log('✓ 解析:size 2/17/33 + 注释 + DOMAIN 头');
}

// ================================================================
// 红轴变化最快:texel 行序 = .cube 数据顺序,r 逐项 +1
// ================================================================
{
  const parsed = parseCubeLut(identitySizeTenText(2, false));
  // 第 0 行:(0,0,0);第 1 行:(1,0,0);第 2 行:(0,1,0)……红轴(r)变化最快
  const row = (r: number, g: number, b: number): [number, number, number, number] => {
    const index = b * 2 * 2 + g * 2 + r; // 2×2×2 texel,按 r 最快展开
    return [
      parsed.data[index * 4],
      parsed.data[index * 4 + 1],
      parsed.data[index * 4 + 2],
      parsed.data[index * 4 + 3],
    ];
  };
  assert.deepEqual(row(0, 0, 0), [0, 0, 0, 1]);
  assert.deepEqual(row(1, 0, 0), [1, 0, 0, 1], '红轴必须变化最快');
  assert.deepEqual(row(0, 1, 0), [0, 1, 0, 1]);
  assert.deepEqual(row(0, 0, 1), [0, 0, 1, 1], '蓝轴变化最慢');
  assert.deepEqual(row(1, 1, 1), [1, 1, 1, 1], 'alpha 必须恒为 1');
  console.log('✓ 红轴变化最快的 texel 排列 + RGBA 展开');
}

// ================================================================
// DOMAIN 归一:非默认 DOMAIN_MIN/MAX 原样保留在解析结果
// ================================================================
{
  const lines = identitySizeTenText(2, false).split('\n');
  lines[2] = 'DOMAIN_MIN 0.1 0.2 0.3';
  lines[3] = 'DOMAIN_MAX 0.9 0.8 0.7';
  const parsed = parseCubeLut(lines.join('\n'));
  assert.deepEqual(parsed.domainMin, [0.1, 0.2, 0.3]);
  assert.deepEqual(parsed.domainMax, [0.9, 0.8, 0.7]);
  console.log('✓ DOMAIN_MIN/MAX 非默认值解析');
}

// ================================================================
// 损坏文件:各报可识别错误(带 code),不静默
// ================================================================
{
  assert.throws(() => parseCubeLut(''), (error) => error instanceof CubeLutParseError && error.code === 'missing_size');
  assert.throws(() => parseCubeLut('# 只有注释\nTITLE "x"'), (error) => error instanceof CubeLutParseError && error.code === 'missing_size');

  assert.throws(
    () => parseCubeLut('LUT_3D_SIZE 1\n' + identitySizeTenText(1, false)),
    (error) => error instanceof CubeLutParseError && error.code === 'invalid_size',
  );
  assert.throws(
    () => parseCubeLut('LUT_3D_SIZE 999\n' + '0 0 0\n'),
    (error) => error instanceof CubeLutParseError && error.code === 'invalid_size',
  );
  assert.throws(
    () => parseCubeLut('LUT_3D_SIZE abc\n'),
    (error) => error instanceof CubeLutParseError && error.code === 'invalid_size',
  );

  // 数据截断(行数不足):只保留 SIZE 头 + 2 行数据(2³ 需要 8 行)
  const twoCube = identitySizeTenText(2, false).split('\n');
  assert.throws(
    () => parseCubeLut([twoCube[4], ...twoCube.slice(5, 7)].join('\n')),
    (error) => error instanceof CubeLutParseError && error.code === 'data_shape_mismatch',
  );

  // 非数字数据
  assert.throws(
    () => parseCubeLut('LUT_3D_SIZE 2\n' + '0 1 2\n' + '0 1 xx\n' + '0 1 2\n' + '0 1 2\n' + '0 1 2\n' + '0 1 2\n' + '0 1 2\n' + '0 1 2\n'),
    (error) => error instanceof CubeLutParseError && error.code === 'invalid_channel',
  );

  // DOMAIN 反向:MIN >= MAX
  assert.throws(
    () => parseCubeLut('LUT_3D_SIZE 2\nDOMAIN_MIN 1 0 0\nDOMAIN_MAX 1 1 1\n' + identitySizeTenText(2, false).split('\n').slice(4).join('\n')),
    (error) => error instanceof CubeLutParseError && error.code === 'invalid_domain',
  );

  // 数据值越界:钳制到 [0,1] 而非报错(与 GL 采样语义一致)
  const outOfRange = 'LUT_3D_SIZE 2\n' + '-1 2 0.5\n' + '0 0 0\n' + '0 0 0\n' + '0 0 0\n' + '0 0 0\n' + '0 0 0\n' + '0 0 0\n' + '0 0 0\n';
  const clamped = parseCubeLut(outOfRange);
  assert.deepEqual([clamped.data[0], clamped.data[1], clamped.data[2]], [0, 1, 0.5], '越界通道必须钳制到 [0,1]');
  console.log('✓ 损坏文件可识别错误(缺失 SIZE/非法尺寸/截断/非数字/反向 DOMAIN)+ 越界钳制');
}

// ================================================================
// 采样坐标 texel 中心修正(DOMAIN 归一 → texel 映射复合)
// ================================================================
{
  // v=0 → 0.5/n;v=1 → 1−0.5/n(默认 DOMAIN)
  for (const size of [2, 4, 17, 33]) {
    assert.ok(Math.abs(sampleCoord(0, 0, 1, size) - 0.5 / size) < 1e-9, `n=${size} v=0 必须落在 0.5/n`);
    assert.ok(Math.abs(sampleCoord(1, 0, 1, size) - (1 - 0.5 / size)) < 1e-9, `n=${size} v=1 必须落在 1−0.5/n`);
    // v = i/(n−1) → texel i 中心 (i+0.5)/n(ffmpeg lut3d trilinear 语义,防半格偏移复发)
    for (let i = 0; i < size; i += 1) {
      const v = i / (size - 1);
      const sampled = sampleCoord(v, 0, 1, size);
      assert.ok(Math.abs(sampled - (i + 0.5) / size) < 1e-9, `n=${size} i=${i} 应落在 (i+0.5)/n,实际 ${sampled}`);
    }
  }

  // 非默认 DOMAIN:先归一再 texel 映射
  {
    const dMin = 0.1;
    const dMax = 0.9;
    const size = 4;
    assert.ok(Math.abs(sampleCoord(dMin, dMin, dMax, size) - 0.5 / size) < 1e-9);
    assert.ok(Math.abs(sampleCoord(dMax, dMin, dMax, size) - (1 - 0.5 / size)) < 1e-9);
    for (let i = 0; i < size; i += 1) {
      const input = dMin + (i / (size - 1)) * (dMax - dMin);
      const sampled = sampleCoord(input, dMin, dMax, size);
      assert.ok(Math.abs(sampled - (i + 0.5) / size) < 1e-9, `DOMAIN ${dMin}..${dMax} i=${i} 应落在 (i+0.5)/n,实际 ${sampled}`);
    }
  }

  // scale/offset 公式本身:等价于 t' = t·(n−1)/n + 0.5/n
  {
    const size = 33;
    const t = 0.37;
    const folded = sampleCoord(t, 0, 1, size);
    const explicit = t * (size - 1) / size + 0.5 / size;
    assert.ok(Math.abs(folded - explicit) < 1e-12, '折叠后的 offset/scale 必须与显式公式 t·(n−1)/n+0.5/n 等价');
  }
  console.log('✓ texel 中心修正:0.5/n、1−0.5/n、i/(n−1)→(i+0.5)/n、DOMAIN 复合顺序、公式等价');
}

console.log('lut-3d-parse tests passed');
