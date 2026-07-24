export interface ScriptChoice {
  id: string;
  narrationText: string;
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
