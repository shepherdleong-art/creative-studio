import {
  parseArrangementPlanJson,
  parseClipPoolJson,
  parseFinalVideoWorkflowConfigJson,
  parseNarrationBeatsJson,
  parseTimelineIssuesJson,
  type ArrangementPlan,
  type FinalVideoDraftRow,
  type FinalVideoWorkflowConfig,
} from './types.ts';

export type ParsedFinalVideoDraft = Omit<FinalVideoDraftRow,
  'workflowConfigJson' | 'narrationBeatsJson' | 'clipPoolJson' | 'arrangementJson' | 'issuesJson'
> & {
  workflowConfig: FinalVideoWorkflowConfig;
  narrationBeats: ReturnType<typeof parseNarrationBeatsJson>;
  clipPool: ReturnType<typeof parseClipPoolJson>;
  arrangement: ArrangementPlan;
  issues: ReturnType<typeof parseTimelineIssuesJson>;
};

export function parseDraftResponse(row: FinalVideoDraftRow): ParsedFinalVideoDraft {
  const { workflowConfigJson, narrationBeatsJson, clipPoolJson, arrangementJson, issuesJson, ...fields } = row;
  return {
    ...fields,
    workflowConfig: parseFinalVideoWorkflowConfigJson(workflowConfigJson),
    narrationBeats: parseNarrationBeatsJson(narrationBeatsJson),
    clipPool: parseClipPoolJson(clipPoolJson),
    arrangement: parseArrangementPlanJson(arrangementJson),
    issues: parseTimelineIssuesJson(issuesJson),
  };
}

export function parseWorkflowConfig(value: unknown): FinalVideoWorkflowConfig {
  return parseFinalVideoWorkflowConfigJson(JSON.stringify(value));
}

export function parseArrangement(value: unknown): ArrangementPlan {
  return parseArrangementPlanJson(JSON.stringify(value));
}

type StorePatch = Parameters<typeof import('./draft-store.ts').updateFinalVideoDraft>[2];
const EMPTY_ARRANGEMENT = JSON.stringify({ assignments: [], gaps: [] });

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function buildDraftApiPatch(input: {
  row: FinalVideoDraftRow;
  workflowConfig?: FinalVideoWorkflowConfig;
  arrangement?: ArrangementPlan;
}): StorePatch {
  const oldConfig = parseFinalVideoWorkflowConfigJson(input.row.workflowConfigJson);
  const patch: StorePatch = {};
  if (input.arrangement !== undefined) {
    patch.arrangementJson = JSON.stringify(input.arrangement);
    patch.previewJobId = null;
    patch.previewRevision = null;
  }
  if (input.workflowConfig === undefined) return patch;

  const next = input.workflowConfig;
  patch.workflowConfigJson = JSON.stringify(next);
  if (equal(oldConfig, next)) return patch;

  patch.previewJobId = null;
  patch.previewRevision = null;
  const oldPackage = oldConfig.packageConfig;
  const nextPackage = next.packageConfig;
  const narrationChanged = !equal(
    {
      mode: oldPackage.mode,
      targetDurationSec: oldPackage.targetDurationSec,
      introDurationSec: oldPackage.cover.introDurationSec,
      narration: oldPackage.narration,
      narrationScriptProviderId: oldConfig.narrationScriptProviderId,
    },
    {
      mode: nextPackage.mode,
      targetDurationSec: nextPackage.targetDurationSec,
      introDurationSec: nextPackage.cover.introDurationSec,
      narration: nextPackage.narration,
      narrationScriptProviderId: next.narrationScriptProviderId,
    },
  );
  const visionChanged = oldConfig.visionProviderId !== next.visionProviderId;
  const orchestrationChanged = oldConfig.orchestrationProviderId !== next.orchestrationProviderId;
  const selectedClipsChanged = !equal(oldConfig.selectedClipIds, next.selectedClipIds);
  const solverChanged = oldPackage.fps !== nextPackage.fps
    || oldPackage.durationTolerancePct !== nextPackage.durationTolerancePct;

  if (narrationChanged) {
    patch.narrationBeatsJson = '[]';
    patch.arrangementJson = EMPTY_ARRANGEMENT;
    patch.issuesJson = '[]';
  }
  if (visionChanged) {
    const clips = parseClipPoolJson(input.row.clipPoolJson).map((clip) => ({
      ...clip, visualDescription: '', descriptionProviderId: null, descriptionModel: null,
    }));
    patch.clipPoolJson = JSON.stringify(clips);
    patch.arrangementJson = EMPTY_ARRANGEMENT;
    patch.issuesJson = '[]';
  }
  if (orchestrationChanged || selectedClipsChanged) {
    patch.arrangementJson = EMPTY_ARRANGEMENT;
    patch.issuesJson = '[]';
  }
  if (solverChanged) patch.issuesJson = '[]';
  return patch;
}
