import assert from 'node:assert/strict';
import {
  initializeMaterialSelection,
  materialSelectionForShotSet,
  toggleMaterialSelection,
} from '../lib/final-edit/material-selection.ts';

const initial = initializeMaterialSelection({}, 'shot-set-a', ['module4:video-a1', 'module4:video-a2']);
assert.deepEqual(
  materialSelectionForShotSet(initial, 'shot-set-a'),
  ['module4:video-a1', 'module4:video-a2'],
  '进入分镜组时应默认选中该组全部可用模块 4 视频',
);

const withSecondGroup = initializeMaterialSelection(initial, 'shot-set-b', ['module4:video-b1']);
assert.deepEqual(
  materialSelectionForShotSet(withSecondGroup, 'shot-set-b'),
  ['module4:video-b1'],
  '第二组必须建立自己的默认选择，不能继承第一组视频',
);
assert.deepEqual(
  materialSelectionForShotSet(withSecondGroup, 'shot-set-a'),
  [],
  '切到第二组后必须清空第一组缓存，任何时刻只保留当前组选择',
);

const deselected = toggleMaterialSelection(withSecondGroup, 'shot-set-b', 'module4:video-b1');
assert.deepEqual(
  materialSelectionForShotSet(deselected, 'shot-set-b'),
  [],
  '当前组可以清空自己的默认选择',
);

const withExternal = toggleMaterialSelection(deselected, 'shot-set-b', 'external:asset-b1');
const refreshed = initializeMaterialSelection(
  withExternal,
  'shot-set-b',
  ['module4:video-b1', 'module4:video-b2'],
  ['module4:video-b1', 'module4:video-b2', 'external:asset-b1'],
);
assert.deepEqual(
  materialSelectionForShotSet(refreshed, 'shot-set-b'),
  ['external:asset-b1'],
  '用户已经调整过的组在刷新时不得被静默重置为全选',
);

const switchedBack = initializeMaterialSelection(refreshed, 'shot-set-a', ['module4:video-a1', 'module4:video-a2']);
assert.deepEqual(
  materialSelectionForShotSet(switchedBack, 'shot-set-a'),
  ['module4:video-a1', 'module4:video-a2'],
  '切回旧组时应按当前可用模块 4 视频重新初始化，不恢复旧缓存',
);
assert.deepEqual(materialSelectionForShotSet(switchedBack, 'shot-set-b'), []);

console.log('final-edit mixcut material selection tests passed');
