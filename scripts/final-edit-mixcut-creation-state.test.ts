import assert from 'node:assert/strict';
import {
  createScriptEditorState,
  editActiveScript,
  markScriptSaved,
  restoreImportedScript,
  resolveScriptSwitch,
  type ScriptChoice,
} from '../lib/final-edit/mixcut-creation-state.ts';

const first: ScriptChoice = { id: 'draft-1', narrationText: '第一版原文' };
const second: ScriptChoice = { id: 'draft-2', narrationText: '第二版原文' };

const initial = createScriptEditorState(first);
assert.equal(initial.activeDraftId, 'draft-1');
assert.equal(initial.editedNarrationText, '第一版原文');
assert.equal(initial.dirty, false);
assert.equal(initial.modified, false);

const changed = editActiveScript(initial, '第一版手动修改');
assert.equal(changed.dirty, true);
assert.equal(changed.modified, true);

const saved = markScriptSaved(changed);
assert.equal(saved.dirty, false, '落库后不应继续提示未保存');
assert.equal(saved.modified, true, '落库后仍应标记为相对导入稿已手改');

const hydrated = createScriptEditorState(first, { editedNarrationText: '已保存的手改稿' });
assert.equal(hydrated.dirty, false, '刷新后恢复的服务端文案必须视为已保存');
assert.equal(hydrated.modified, true);
const restoredHydrated = restoreImportedScript(hydrated, first);
assert.equal(restoredHydrated.dirty, true, '恢复导入稿也是一次待落库修改');
assert.equal(restoredHydrated.modified, false);

const cancelled = resolveScriptSwitch(changed, second, 'cancel');
assert.deepEqual(cancelled, changed, '取消切换必须原样保留当前编辑');

const preserved = resolveScriptSwitch(changed, second, 'preserve');
assert.equal(preserved.activeDraftId, 'draft-2');
assert.equal(preserved.editedNarrationText, '第二版原文');
assert.equal(preserved.textByDraftId['draft-1'], '第一版手动修改');
const switchedBack = resolveScriptSwitch(preserved, first, 'preserve');
assert.equal(switchedBack.editedNarrationText, '第一版手动修改', '保留后切回旧草稿必须恢复手改内容');

const discarded = resolveScriptSwitch(changed, second, 'discard');
const discardedBack = resolveScriptSwitch(discarded, first, 'preserve');
assert.equal(discardedBack.editedNarrationText, '第一版原文', '放弃后切回必须使用导入原文');

const restored = restoreImportedScript(changed, first);
assert.equal(restored.editedNarrationText, '第一版原文');
assert.equal(restored.dirty, false);
assert.equal(restored.modified, false);

console.log('final-edit mixcut creation state tests passed');
