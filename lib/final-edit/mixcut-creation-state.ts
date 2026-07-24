export interface ScriptChoice {
  id: string;
  narrationText: string;
}

export interface ScriptEditorState {
  activeDraftId: string;
  editedNarrationText: string;
  importedNarrationText: string;
  dirty: boolean;
  textByDraftId: Record<string, string>;
}

export type ScriptSwitchResolution = 'preserve' | 'discard' | 'cancel';

export function createScriptEditorState(choice: ScriptChoice): ScriptEditorState {
  return {
    activeDraftId: choice.id,
    editedNarrationText: choice.narrationText,
    importedNarrationText: choice.narrationText,
    dirty: false,
    textByDraftId: {},
  };
}

export function editActiveScript(state: ScriptEditorState, text: string): ScriptEditorState {
  return {
    ...state,
    editedNarrationText: text,
    dirty: text !== state.importedNarrationText,
  };
}

export function restoreImportedScript(state: ScriptEditorState, choice: ScriptChoice): ScriptEditorState {
  return {
    ...state,
    editedNarrationText: choice.narrationText,
    importedNarrationText: choice.narrationText,
    dirty: false,
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
    dirty: targetText !== target.narrationText,
    textByDraftId,
  };
}
