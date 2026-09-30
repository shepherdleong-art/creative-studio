import assert from 'node:assert/strict';
import { readFurniturePrompt, updateFurniturePrompt } from '../lib/furniture-prompt.ts';

const scene = '保持图中书柜的一致性不变，更换其他家具和软装布置，风格参考原图，让书房温馨舒适，全景图';
assert.deepEqual(readFurniturePrompt(scene), { furniture: '书柜', room: '书房' });
assert.equal(updateFurniturePrompt(scene, 'furniture', '沙发'), scene.replace('图中书柜', '图中沙发'));
assert.equal(updateFurniturePrompt(scene, 'room', '客厅'), scene.replace('让书房', '让客厅'));

const shot = '图1是待编辑分镜图，是本次修改的主要对象。\n图2是场景参考图。\n参考图2，修改图1，保持图中床和模特的一致性不变，更换卧室的其他家具和软装布置，构图和机位景别严格参考图1。';
assert.deepEqual(readFurniturePrompt(shot), { furniture: '床', room: '卧室' });
const updated = updateFurniturePrompt(updateFurniturePrompt(shot, 'furniture', '餐桌和餐椅'), 'room', '餐厅');
assert.equal(updated, shot.replace('图中床和模特', '图中餐桌和餐椅和模特').replace('更换卧室', '更换餐厅'));
assert.deepEqual(readFurniturePrompt(updated), { furniture: '餐桌和餐椅', room: '餐厅' });
assert.equal(updateFurniturePrompt(updated, 'furniture', '床'), shot.replace('更换卧室', '更换餐厅'));

const custom = `${scene}，书柜上放一本书房设计杂志，保留窗外景色。`;
assert.equal(updateFurniturePrompt(custom, 'furniture', '展示柜'), custom.replace('图中书柜', '图中展示柜'));
assert.equal(updateFurniturePrompt(custom, 'room', '展厅'), custom.replace('让书房', '让展厅'));
assert.deepEqual(readFurniturePrompt('完全自定义的提示词'), { furniture: '', room: '' });
assert.equal(updateFurniturePrompt('完全自定义的提示词', 'furniture', '床'), '完全自定义的提示词');
assert.equal(updateFurniturePrompt(scene, 'room', ''), scene);

console.log('furniture-prompt tests passed');
