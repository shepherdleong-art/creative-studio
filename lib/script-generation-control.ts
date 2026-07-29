interface ActiveScriptGeneration {
  projectId: string;
  controller: AbortController;
}

const activeScriptGenerations = new Map<string, ActiveScriptGeneration>();

export function registerScriptGeneration(generationId: string, projectId: string): AbortController {
  activeScriptGenerations.get(generationId)?.controller.abort();
  const controller = new AbortController();
  activeScriptGenerations.set(generationId, { projectId, controller });
  return controller;
}

export function cancelScriptGeneration(generationId: string, projectId: string): boolean {
  const active = activeScriptGenerations.get(generationId);
  if (!active || active.projectId !== projectId) return false;
  active.controller.abort();
  return true;
}

export function finishScriptGeneration(generationId: string, controller: AbortController): void {
  const active = activeScriptGenerations.get(generationId);
  if (active?.controller === controller) activeScriptGenerations.delete(generationId);
}
