export type ScriptStep = 1 | 2 | 3;
export type ScriptStepState = 'active' | 'complete' | 'available' | 'locked';

export interface ScriptStepAvailability {
  hasAnalysis: boolean;
  hasScript: boolean;
}

export function canNavigateToScriptStep(
  targetStep: ScriptStep,
  availability: ScriptStepAvailability
): boolean {
  if (targetStep === 1) return true;
  if (targetStep === 2) return availability.hasAnalysis;
  return availability.hasAnalysis && availability.hasScript;
}

export function getScriptStepStatus({
  step,
  hasAnalysis,
  hasScript,
}: { step: ScriptStep } & ScriptStepAvailability): Record<ScriptStep, ScriptStepState> {
  return {
    1: step === 1 ? 'active' : 'complete',
    2: step === 2
      ? 'active'
      : hasAnalysis
        ? step > 2
          ? 'complete'
          : 'available'
        : 'locked',
    3: step === 3 ? 'active' : hasScript ? 'available' : 'locked',
  };
}
