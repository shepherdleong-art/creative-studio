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
  ['module4:video-a1', 'module4:video-a2'],
  '切到第二组不能修改第一组已选素材',
);

const deselected = toggleMaterialSelection(withSecondGroup, 'shot-set-a', 'module4:video-a1');
assert.deepEqual(materialSelectionForShotSet(deselected, 'shot-set-a'), ['module4:video-a2']);
assert.deepEqual(
  materialSelectionForShotSet(deselected, 'shot-set-b'),
  ['module4:video-b1'],
  '第一组的选择操作不能污染第二组',
);

const withExternal = toggleMaterialSelection(deselected, 'shot-set-a', 'external:asset-a1');
const refreshed = initializeMaterialSelection(
  withExternal,
  'shot-set-a',
  ['module4:video-a1', 'module4:video-a2', 'module4:video-a3'],
  ['module4:video-a1', 'module4:video-a2', 'module4:video-a3', 'external:asset-a1'],
);
assert.deepEqual(
  materialSelectionForShotSet(refreshed, 'shot-set-a'),
  ['module4:video-a2', 'external:asset-a1'],
  '用户已经调整过的组在刷新时不得被静默重置为全选',
);

const missingRemoved = initializeMaterialSelection(refreshed, 'shot-set-b', []);
assert.deepEqual(
  materialSelectionForShotSet(missingRemoved, 'shot-set-b'),
  [],
  '当前组文件全部丢失时必须清掉该组不可用选择',
);
assert.deepEqual(materialSelectionForShotSet(missingRemoved, 'shot-set-a'), ['module4:video-a2', 'external:asset-a1']);

console.log('final-edit mixcut material selection tests passed');
