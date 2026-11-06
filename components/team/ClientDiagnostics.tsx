'use client';

import { useEffect } from 'react';

type DiagnosticStage = 'client_ui' | 'upload' | 'download' | 'client_update';
type DiagnosticEvent = {
  clientEventId: string;
  stage: DiagnosticStage;
  phase: string;
  code: string;
};
type AccountQueue = { userId: string; events: DiagnosticEvent[] };
type StoredQueue = AccountQueue & { updatedAt: number };

const STORAGE_KEY = 'creative-studio-client-diagnostics-v1';
const MAX_EVENTS = 100;
const MAX_ACCOUNTS = 8;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function token(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[a-z][a-z0-9_.-]{0,79}$/i.test(value) ? value : fallback;
}

function normalize(value: unknown): DiagnosticEvent | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<DiagnosticEvent>;
  if (typeof candidate.clientEventId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/i.test(candidate.clientEventId)
    || !['client_ui', 'upload', 'download', 'client_update'].includes(candidate.stage ?? '')) return null;
  return {
    clientEventId: candidate.clientEventId,
    stage: candidate.stage as DiagnosticStage,
    phase: token(candidate.phase, 'unknown'), code: token(candidate.code, 'client_error'),
  };
}

function readQueues(): StoredQueue[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as { accounts?: unknown } : null;
    if (!Array.isArray(parsed?.accounts)) return [];
    const cutoff = Date.now() - MAX_AGE_MS;
    return parsed.accounts.flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const account = value as Partial<StoredQueue>;
      if (typeof account.userId !== 'string' || !Array.isArray(account.events)
        || typeof account.updatedAt !== 'number' || account.updatedAt < cutoff) return [];
      const events = account.events.flatMap((event) => {
        const safe = normalize(event);
        return safe ? [safe] : [];
      });
      return events.length ? [{ userId: account.userId, events: events.slice(-MAX_EVENTS), updatedAt: account.updatedAt }] : [];
    }).slice(-MAX_ACCOUNTS);
  } catch { return []; }
}

function writeQueues(accounts: StoredQueue[]): void {
  try {
    if (accounts.length) localStorage.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: 1, accounts }));
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* Storage failures never interrupt the workbench. */ }
}

export default function ClientDiagnostics() {
  useEffect(() => {
    if (document.documentElement.dataset.deploymentMode !== 'server') return;
    let identity: string | null = null;
    let active = true;
    let flushing = false;
    const seen = new WeakSet<object>();
    const reported = new Set<string>();
    let queues = readQueues();

    const save = () => writeQueues(queues);
    const flush = async () => {
      if (!identity || flushing || !active) return;
      flushing = true;
      try {
        const account = queues.find((candidate) => candidate.userId === identity);
        if (!account) return;
        for (const event of [...account.events]) {
          if (!active || !identity) return;
          try {
            const response = await fetch('/api/team/errors/report', {
              method: 'POST', credentials: 'same-origin', cache: 'no-store',
              headers: { 'content-type': 'application/json' }, body: JSON.stringify(event),
            });
            if (!response.ok) {
              if ([400, 401, 403].includes(response.status)) {
                // Retain ownership/validation failures for an administrator to
                // inspect locally; never reassign them to the next account.
                return;
              }
              continue;
            }
            account.events = account.events.filter((candidate) => candidate.clientEventId !== event.clientEventId);
            queues = queues.filter((candidate) => candidate.events.length > 0);
            save();
          } catch { return; }
        }
      } finally { flushing = false; }
    };

    const synchronize = async () => {
      try {
        const response = await fetch('/api/team/auth/session', { credentials: 'same-origin', cache: 'no-store' });
        if (!response.ok) return;
        const body = await response.json() as { authenticated?: boolean; user?: { id?: unknown } };
        const next = body.authenticated && typeof body.user?.id === 'string' ? body.user.id : null;
        if (next !== identity) {
          identity = next;
          await flush();
        }
      } catch { /* Offline events remain bounded and untouched. */ }
    };

    const report = (event: DiagnosticEvent) => {
      if (!identity) return;
      try {
        const safe = normalize(event);
        if (!safe) return;
        const now = Date.now();
        const account = queues.find((candidate) => candidate.userId === identity)
          ?? { userId: identity, events: [], updatedAt: now };
        account.updatedAt = now;
        if (account.events.some((candidate) => candidate.clientEventId === safe.clientEventId)) return;
        account.events = [...account.events, safe].slice(-MAX_EVENTS);
        queues = [...queues.filter((candidate) => candidate.userId !== identity), account].slice(-MAX_ACCOUNTS);
        save();
        void flush();
      } catch { /* Never report a reporting failure recursively. */ }
    };

    const emit = (reason: unknown, phase: 'error' | 'unhandledrejection') => {
      if (reason instanceof DOMException && reason.name === 'AbortError') return;
      if (reason && typeof reason === 'object') {
        if (seen.has(reason)) return;
        seen.add(reason);
      } else {
        const key = `${phase}:${typeof reason}:${String(reason).slice(0, 80)}`;
        if (reported.has(key)) return;
        reported.add(key);
      }
      report({ clientEventId: crypto.randomUUID(), stage: 'client_ui', phase,
        code: phase === 'error' ? 'ui_runtime_error' : 'unhandled_rejection' });
    };
    const onError = (event: ErrorEvent) => emit(event.error ?? 'unknown_ui_error', 'error');
    const onRejection = (event: PromiseRejectionEvent) => emit(event.reason, 'unhandledrejection');
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    const timer = window.setInterval(() => { void synchronize(); }, 15_000);
    const online = () => { void synchronize(); };
    window.addEventListener('online', online);
    const bridged = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!detail || typeof detail !== 'object') return;
      const candidate = detail as Partial<DiagnosticEvent>;
      report({ clientEventId: typeof candidate.clientEventId === 'string' ? candidate.clientEventId : crypto.randomUUID(),
        stage: 'client_ui', phase: token(candidate.phase, 'error'), code: token(candidate.code, 'ui_runtime_error') });
    };
    window.addEventListener('creative-studio:client-diagnostic', bridged);
    void synchronize();
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('online', online);
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
      window.removeEventListener('creative-studio:client-diagnostic', bridged);
    };
  }, []);
  return null;
}
