import { isScriptVisibleInContext } from '../media-core/script-visibility.ts';

export interface ScriptChoice {
  id: string;
  narrationText: string;
}

export interface MixcutScriptChoiceLike {
  id: string;
  shotSetId: string;
}

/**
 * 单条混剪前端统一可见性闸门：空 shotSetId 项目脚本对任意当前组可见，
 * 非空 shotSetId 历史脚本必须匹配当前组且组仍有效。契约与服务端
 * isScriptVisibleInContext 一致，Mixcut 前端三处脚本选择不得各自另写过滤。
 */
export function isMixcutScriptChoiceVisible(
  choice: MixcutScriptChoiceLike,
  currentShotSetId: string | null,
  validShotSetIds: ReadonlySet<string>,
): boolean {
  return isScriptVisibleInContext({
    shotSetId: choice.shotSetId,
    requestedShotSetId: currentShotSetId ?? undefined,
    validShotSetIds,
  });
}

export interface ScriptSourceRevisionState {
  sourceRevisionId: string | null;
  sourceRevisionNumber: number | null;
  sourceUpdatedAt: string | null;
}

export interface ScriptChoiceRevisionView {
  sourceKind?: string;
  sourceRevisionId?: string | null;
  sourceRevisionNumber?: number | null;
  createdAt?: string;
}

/**
 * 判断已有混剪的源脚本快照是否落后于当前可选脚本 revision。
 * - 双方都有 revision id 时按 id 比较（权威）；
 * - 否则双方都有 revisionNumber 时按号比较；
 * - 旧快照没有任何 revision 身份时，仅对项目脚本回退到 timestamp 比较
 *   （历史 script_drafts 的 createdAt 不可变，比较它没有意义）。
 */
export function hasNewerScriptRevision(source: ScriptSourceRevisionState, current: ScriptChoiceRevisionView): boolean {
  if (source.sourceRevisionId && current.sourceRevisionId) return source.sourceRevisionId !== current.sourceRevisionId;
  if (source.sourceRevisionNumber != null && current.sourceRevisionNumber != null) {
    return source.sourceRevisionNumber !== current.sourceRevisionNumber;
  }
  if (!source.sourceRevisionId && source.sourceRevisionNumber == null && source.sourceUpdatedAt && current.sourceKind === 'project' && current.createdAt) {
    return source.sourceUpdatedAt !== current.createdAt;
  }
  return false;
}

export interface ScriptEditorState {
  activeDraftId: string;
  editedNarrationText: string;
  importedNarrationText: string;
  savedNarrationText: string;
  dirty: boolean;
  modified: boolean;
  textByDraftId: Record<string, string>;
}

export type ScriptSwitchResolution = 'preserve' | 'discard' | 'cancel';

export function createScriptEditorState(
  choice: ScriptChoice,
  persisted?: { editedNarrationText: string },
): ScriptEditorState {
  const editedNarrationText = persisted?.editedNarrationText ?? choice.narrationText;
  return {
    activeDraftId: choice.id,
    editedNarrationText,
    importedNarrationText: choice.narrationText,
    savedNarrationText: editedNarrationText,
    dirty: false,
    modified: editedNarrationText !== choice.narrationText,
    textByDraftId: {},
  };
}

export function editActiveScript(state: ScriptEditorState, text: string): ScriptEditorState {
  return {
    ...state,
    editedNarrationText: text,
    dirty: text !== state.savedNarrationText,
    modified: text !== state.importedNarrationText,
  };
}

export function markScriptSaved(state: ScriptEditorState): ScriptEditorState {
  return { ...state, savedNarrationText: state.editedNarrationText, dirty: false };
}

export function restoreImportedScript(state: ScriptEditorState, choice: ScriptChoice): ScriptEditorState {
  return {
    ...state,
    editedNarrationText: choice.narrationText,
    importedNarrationText: choice.narrationText,
    dirty: choice.narrationText !== state.savedNarrationText,
    modified: false,
    textByDraftId: { ...state.textByDraftId, [choice.id]: choice.narrationText },
  };
}

export function resolveScriptSwitch(
  state: ScriptEditorState,
  target: ScriptChoice,
  resolution: ScriptSwitchResolution,
): ScriptEditorState {
  if (resolution === 'cancel' || target.id === state.activeDraftId) return state;
  const textByDraftId = { ...state.textByDraftId };
  if (resolution === 'preserve') textByDraftId[state.activeDraftId] = state.editedNarrationText;
  else delete textByDraftId[state.activeDraftId];
  const targetText = textByDraftId[target.id] ?? target.narrationText;
  return {
    activeDraftId: target.id,
    editedNarrationText: targetText,
    importedNarrationText: target.narrationText,
    savedNarrationText: state.savedNarrationText,
    dirty: targetText !== state.savedNarrationText || target.id !== state.activeDraftId,
    modified: targetText !== target.narrationText,
    textByDraftId,
  };
}

/**
 * 把当前脚本的编辑器状态同步到同一脚本 id 的最新 revision。
 * 与 resolveScriptSwitch 不同：目标 id 就是当前 id，不切换 activeDraftId。
 * - discard：文案替换为新 revision 正文（等价恢复导入版本）；
 * - preserve：保留用户手改文案，仅把导入源换成新 revision 正文；
 * - cancel：原样返回。
 * 无论哪种结果，调用方都需触发一次持久化，让服务端快照记下新 revision 身份。
 */
export function syncScriptToRevision(
  state: ScriptEditorState,
  choice: ScriptChoice,
  resolution: ScriptSwitchResolution,
): ScriptEditorState {
  if (resolution === 'cancel' || choice.id !== state.activeDraftId) return state;
  if (resolution === 'discard') return restoreImportedScript(state, choice);
  return {
    ...state,
    importedNarrationText: choice.narrationText,
    modified: state.editedNarrationText !== choice.narrationText,
    textByDraftId: { ...state.textByDraftId, [choice.id]: choice.narrationText },
  };
}
