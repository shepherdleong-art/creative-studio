import assert from 'node:assert/strict';
import {
  createScriptEditorState,
  editActiveScript,
  hasNewerScriptRevision,
  isMixcutScriptChoiceVisible,
  markScriptSaved,
  restoreImportedScript,
  resolveScriptSwitch,
  syncScriptToRevision,
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

// ---- 单条混剪前端统一可见性闸门：空 shotSetId 项目脚本任意组可见 ----
const validShotSetIds = new Set(['ss-a', 'ss-b']);
assert.equal(isMixcutScriptChoiceVisible({ id: 'ps-1', shotSetId: '' }, 'ss-a', validShotSetIds), true, '空 shotSetId 项目脚本必须在任意当前组可见');
assert.equal(isMixcutScriptChoiceVisible({ id: 'ps-1', shotSetId: '' }, 'ss-b', validShotSetIds), true, '项目脚本换当前组仍可见');
assert.equal(isMixcutScriptChoiceVisible({ id: 'legacy-a', shotSetId: 'ss-a' }, 'ss-a', validShotSetIds), true, '当前组的历史脚本可见');
assert.equal(isMixcutScriptChoiceVisible({ id: 'legacy-a', shotSetId: 'ss-a' }, 'ss-b', validShotSetIds), false, '非当前组的历史脚本必须隐藏');
assert.equal(isMixcutScriptChoiceVisible({ id: 'legacy-gone', shotSetId: 'ss-deleted' }, 'ss-a', validShotSetIds), false, '组已删除的历史脚本必须隐藏');

// ---- 源脚本新版本判定 ----
assert.equal(hasNewerScriptRevision(
  { sourceRevisionId: 'r1', sourceRevisionNumber: 1, sourceUpdatedAt: '2026-01-01T00:00:00.000Z' },
  { sourceKind: 'project', sourceRevisionId: 'r2', sourceRevisionNumber: 2, createdAt: '2026-02-01T00:00:00.000Z' },
), true, 'revision id 不同必须提示新版本');
assert.equal(hasNewerScriptRevision(
  { sourceRevisionId: 'r1', sourceRevisionNumber: 1, sourceUpdatedAt: '2026-01-01T00:00:00.000Z' },
  { sourceKind: 'project', sourceRevisionId: 'r1', sourceRevisionNumber: 1, createdAt: '2026-02-01T00:00:00.000Z' },
), false, 'revision id 相同不得提示');
assert.equal(hasNewerScriptRevision(
  { sourceRevisionId: null, sourceRevisionNumber: 1, sourceUpdatedAt: null },
  { sourceKind: 'project', sourceRevisionId: null, sourceRevisionNumber: 2 },
), true, '只有 revisionNumber 时按号比较');
assert.equal(hasNewerScriptRevision(
  { sourceRevisionId: null, sourceRevisionNumber: null, sourceUpdatedAt: '2026-01-01T00:00:00.000Z' },
  { sourceKind: 'project', sourceRevisionId: 'r2', sourceRevisionNumber: 2, createdAt: '2026-02-01T00:00:00.000Z' },
), true, '旧快照无 revision 身份时对项目脚本回退 timestamp 比较');
assert.equal(hasNewerScriptRevision(
  { sourceRevisionId: null, sourceRevisionNumber: null, sourceUpdatedAt: '2026-01-01T00:00:00.000Z' },
  { sourceKind: 'legacy', sourceRevisionId: null, sourceRevisionNumber: null, createdAt: '2026-01-01T00:00:00.000Z' },
), false, '历史脚本没有 revision 概念，不得提示');
assert.equal(hasNewerScriptRevision(
  { sourceRevisionId: null, sourceRevisionNumber: null, sourceUpdatedAt: null },
  { sourceKind: 'project', sourceRevisionId: 'r2', sourceRevisionNumber: 2 },
), false, '双方都没有可比身份时不得提示');

// ---- 同步同 id 脚本到新 revision ----
const modifiedEditor = createScriptEditorState(first, { editedNarrationText: '手改稿' });
const newerRevision: ScriptChoice = { id: 'draft-1', narrationText: '第一版新 revision 原文' };
const syncCancelled = syncScriptToRevision(modifiedEditor, newerRevision, 'cancel');
assert.deepEqual(syncCancelled, modifiedEditor, '取消同步必须原样保留当前编辑');
const syncForeign = syncScriptToRevision(modifiedEditor, second, 'discard');
assert.deepEqual(syncForeign, modifiedEditor, '目标不是当前脚本 id 时必须拒绝同步');

const syncDiscarded = syncScriptToRevision(modifiedEditor, newerRevision, 'discard');
assert.equal(syncDiscarded.activeDraftId, 'draft-1', '同步不切换脚本 id');
assert.equal(syncDiscarded.editedNarrationText, '第一版新 revision 原文', '放弃修改同步必须采用新 revision 正文');
assert.equal(syncDiscarded.importedNarrationText, '第一版新 revision 原文');
assert.equal(syncDiscarded.modified, false);
assert.equal(syncDiscarded.dirty, true, '正文变化后必须视为待保存');

const syncPreserved = syncScriptToRevision(modifiedEditor, newerRevision, 'preserve');
assert.equal(syncPreserved.editedNarrationText, '手改稿', '保留修改同步不得覆盖用户手改文案');
assert.equal(syncPreserved.importedNarrationText, '第一版新 revision 原文', '保留修改同步仍要更新导入源');
assert.equal(syncPreserved.modified, true);
assert.equal(syncPreserved.textByDraftId['draft-1'], '第一版新 revision 原文');

console.log('final-edit mixcut creation state tests passed');
