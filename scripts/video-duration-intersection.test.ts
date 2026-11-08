/**
 * 08 号票：批量检查「统一秒数」= 所选分镜模型都支持的秒数的交集。
 *
 * 现在面板只按第一行模型取 durations（换了统一供应商就会给出别的模型不支持的秒数），
 * 验收条件要求交集单独可测：单模型、两模型有交集、两模型无交集、三模型、空输入、
 * 重复值去重、升序。
 */
import assert from 'node:assert/strict';
import { intersectDurations, describeDurationIntersection } from '../lib/video-duration-intersection.ts';

// 单模型：交集的退化情形就是它自己的列表（升序、去重后）。
assert.deepEqual(intersectDurations([[5, 10]]), [5, 10], '单模型时交集就是它自己的列表');
assert.deepEqual(intersectDurations([[15, 5, 10]]), [5, 10, 15], '单模型也要升序输出');

// 两模型有交集。
assert.deepEqual(
  intersectDurations([[5, 10], [5, 10, 15]]),
  [5, 10],
  '两个模型的公共秒数才是可选项',
);
assert.deepEqual(
  intersectDurations([[4, 5, 6, 7, 8, 9, 10], [3, 4, 5, 6]]),
  [4, 5, 6],
  '连续区间的交集取重叠段',
);

// 两模型无交集：必须是空数组，不能退化成某一个模型的列表。
assert.deepEqual(
  intersectDurations([[5, 10], [3, 4, 6]]),
  [],
  '两个模型没有共同秒数时交集为空',
);

// 三模型：三方都支持的那几个。
assert.deepEqual(
  intersectDurations([[3, 4, 5, 6, 7], [4, 5, 6, 8], [5, 6, 9]]),
  [5, 6],
  '三个模型取三方公共部分',
);
assert.deepEqual(
  intersectDurations([[5], [5], [5]]),
  [5],
  '三个模型只有一个共同值时仍要给出它',
);

// 空输入与含空列表的输入。
assert.deepEqual(intersectDurations([]), [], '没有选中任何模型时交集为空');
assert.deepEqual(intersectDurations([[]]), [], '单个模型的列表为空时交集为空');
assert.deepEqual(intersectDurations([[5, 10], []]), [], '任一模型不支持任何秒数时无统一值可用');

// 重复值去重 + 升序：脏数据（含重复、乱序）也必须收敛到唯一升序列表。
assert.deepEqual(
  intersectDurations([[10, 10, 5, 5, 10], [5, 10, 10, 5]]),
  [5, 10],
  '重复值要去重，输出保持升序',
);
assert.deepEqual(
  intersectDurations([[15, 12, 9], [12, 15, 9], [9, 12, 15]]),
  [9, 12, 15],
  '输入乱序时输出仍然升序',
);

// 不修改入参（调用方直接传能力表里的只读数组）。
const first = Object.freeze([5, 10]) as readonly number[];
const second = Object.freeze([5, 10, 15]) as readonly number[];
const before = JSON.stringify([first, second]);
intersectDurations([first, second]);
assert.equal(JSON.stringify([first, second]), before, '交集计算不得修改传入的数组');

// 提示文案：连续区间与离散值分开写，空交集的说明不能是空字符串（界面要显示原因）。
assert.equal(describeDurationIntersection([4, 5, 6, 7]), '4–7 秒');
assert.equal(describeDurationIntersection([5, 10]), '5 / 10 秒');
assert.equal(describeDurationIntersection([7]), '7 秒');
assert.equal(describeDurationIntersection([]), '没有共同支持的秒数');

console.log('video-duration-intersection tests passed');
