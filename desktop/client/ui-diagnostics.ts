import { randomUUID } from 'node:crypto';
import type { ClientDiagnosticInput } from './client-diagnostics';

interface UiDiagnosticTarget {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

function aborted(reason: unknown): boolean {
  return typeof DOMException !== 'undefined' && reason instanceof DOMException && reason.name === 'AbortError'
    || Boolean(reason && typeof reason === 'object'
      && ((reason as { name?: unknown }).name === 'AbortError' || (reason as { code?: unknown }).code === 'ABORT_ERR'));
}

function expectedFormFailure(reason: unknown): boolean {
  return Boolean(reason && typeof reason === 'object'
    && [400, 409, 422].includes(Number((reason as { response?: { status?: unknown } }).response?.status)));
}

/** Never retain error.message, stack, URL, request data or rejected values. */
export const CLIENT_UI_DIAGNOSTICS_SCRIPT = `(() => {
  if (window.__creativeStudioDiagnosticsInstalled) return;
  window.__creativeStudioDiagnosticsInstalled = true;
  const seen = new WeakSet();
  const reported = new Set();
  const emit = (reason, phase) => {
    if (reason && reason.name === 'AbortError') return;
    if (reason && (typeof reason === 'object' || typeof reason === 'function')) {
      if (seen.has(reason)) return;
      seen.add(reason);
    } else {
      const identity = phase + ':' + typeof reason + ':' + String(reason).slice(0, 80);
      if (reported.has(identity)) return;
      reported.add(identity);
    }
    try { void window.desktopBridge?.reportClientError({
      clientEventId: crypto.randomUUID(), stage: 'client_ui', phase,
      code: phase === 'error' ? 'ui_runtime_error' : 'unhandled_rejection',
    }); } catch { /* Diagnostics never interrupt the workbench. */ }
  };
  window.addEventListener('error', (event) => emit(event.error || 'unknown_ui_error', 'error'));
  window.addEventListener('unhandledrejection', (event) => emit(event.reason, 'unhandledrejection'));
})();`;

export function installClientUiDiagnostics(
  target: UiDiagnosticTarget,
  reporter: { report(input: ClientDiagnosticInput): void },
): () => void {
  const seen = new WeakSet<object>();
  const reported = new Set<string>();
  const emit = (reason: unknown, phase: 'error' | 'unhandledrejection'): void => {
    if (aborted(reason) || expectedFormFailure(reason)) return;
    if (reason && (typeof reason === 'object' || typeof reason === 'function')) {
      if (seen.has(reason)) return;
      seen.add(reason);
    } else {
      // Same-primitive rejections are commonly the same failure notification.
      const identity = `${phase}:${typeof reason}:${String(reason).slice(0, 80)}`;
      if (reported.has(identity)) return;
      reported.add(identity);
    }
    try {
      reporter.report({
        clientEventId: randomUUID(), stage: 'client_ui', phase,
        code: phase === 'error' ? 'ui_runtime_error' : 'unhandled_rejection',
      });
    } catch { /* Never create an exception-reporting loop. */ }
  };
  const onError = (event: { error?: unknown }): void => emit(event.error ?? 'unknown_ui_error', 'error');
  const onRejection = (event: { reason?: unknown }): void => emit(event.reason, 'unhandledrejection');
  target.addEventListener('error', onError as never);
  target.addEventListener('unhandledrejection', onRejection as never);
  return () => {
    target.removeEventListener('error', onError as never);
    target.removeEventListener('unhandledrejection', onRejection as never);
  };
}
