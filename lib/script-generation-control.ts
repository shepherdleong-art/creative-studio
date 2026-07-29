interface ActiveScriptGeneration {
  projectId: string;
  controller: AbortController;
}

const activeScriptGenerations = new Map<string, ActiveScriptGeneration>();
const pendingScriptCancellations = new Map<string, { projectId: string; expiresAt: number }>();
const PENDING_CANCELLATION_TTL_MS = 60_000;

function deleteExpiredCancellations(): void {
  const now = Date.now();
  for (const [generationId, pending] of pendingScriptCancellations) {
    if (pending.expiresAt <= now) pendingScriptCancellations.delete(generationId);
  }
}

export function registerScriptGeneration(generationId: string, projectId: string): AbortController {
  deleteExpiredCancellations();
  activeScriptGenerations.get(generationId)?.controller.abort();
  const controller = new AbortController();
  activeScriptGenerations.set(generationId, { projectId, controller });
  const pending = pendingScriptCancellations.get(generationId);
  if (pending?.projectId === projectId) {
    pendingScriptCancellations.delete(generationId);
    controller.abort();
  }
  return controller;
}

export function cancelScriptGeneration(generationId: string, projectId: string): boolean {
  deleteExpiredCancellations();
  const active = activeScriptGenerations.get(generationId);
  if (!active) {
    pendingScriptCancellations.set(generationId, {
      projectId,
      expiresAt: Date.now() + PENDING_CANCELLATION_TTL_MS,
    });
    return true;
  }
  if (active.projectId !== projectId) return false;
  active.controller.abort();
  return true;
}

export function finishScriptGeneration(generationId: string, controller: AbortController): void {
  const active = activeScriptGenerations.get(generationId);
  if (active?.controller === controller) activeScriptGenerations.delete(generationId);
}
