import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Session } from 'electron';
import { ClientDiagnosticQueue, type ClientDiagnosticInput, type ClientDiagnosticEvent } from './client-diagnostics';

interface ReporterOptions {
  origin: string;
  deploymentId?: string;
  stateRoot: string;
  clientDeviceId: string;
  clientVersion: string;
  session: Pick<Session, 'fetch' | 'cookies'>;
}

/** Reporting failures stop here. They never become another diagnostic event. */
export class ClientDiagnosticReporter {
  private readonly origin: string;
  private identity: string | null = null;
  private queue: ClientDiagnosticQueue | null = null;
  private readonly queues = new Map<string, ClientDiagnosticQueue>();
  private readonly verifiedAccounts = new Set<string>();
  private csrfToken: string | null = null;
  private flushing: Promise<void> | null = null;

  constructor(private readonly options: ReporterOptions) {
    this.origin = new URL(options.origin).origin;
  }

  private accountRoot(userId: string): string {
    const key = createHash('sha256').update([
      this.options.deploymentId ?? '', this.origin, userId, this.options.clientDeviceId,
    ].join('\n')).digest('hex');
    return path.join(this.options.stateRoot, 'accounts', key);
  }

  rebindIdentity(identity: { deploymentId: string; clientDeviceId: string }): void {
    this.options.deploymentId = identity.deploymentId;
    this.options.clientDeviceId = identity.clientDeviceId;
    this.queues.clear();
    const current = this.identity;
    this.identity = null;
    this.queue = null;
    this.setIdentity(current);
  }

  setIdentity(userId: string | null): void {
    if (this.identity === userId) return;
    this.identity = userId;
    if (userId) this.verifiedAccounts.add(userId);
    this.csrfToken = null;
    this.queue = userId
      ? this.queues.get(userId) ?? new ClientDiagnosticQueue(path.join(this.accountRoot(userId), 'diagnostics.json'))
      : null;
    if (userId && this.queue) this.queues.set(userId, this.queue);
  }

  capture(input: ClientDiagnosticInput): void {
    const owner = input.actorUserId ?? this.identity;
    if (!owner || !this.verifiedAccounts.has(owner)) return;
    try {
      let queue = this.queues.get(owner);
      if (!queue) {
        queue = new ClientDiagnosticQueue(path.join(this.accountRoot(owner), 'diagnostics.json'));
        this.queues.set(owner, queue);
      }
      queue.capture({ ...input, clientVersion: input.clientVersion || this.options.clientVersion });
    } catch { /* A full or unavailable diagnostic disk must not interrupt work. */ }
  }

  report(input: ClientDiagnosticInput): void {
    this.capture(input);
    void this.flush().catch(() => undefined);
  }

  pending(): ClientDiagnosticEvent[] {
    return this.queue?.pending() ?? [];
  }

  private async cookieHeader(): Promise<string> {
    const cookies = await this.options.session.cookies.get({ url: this.origin });
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  }

  private async csrf(): Promise<string> {
    if (this.csrfToken) return this.csrfToken;
    const response = await this.options.session.fetch(`${this.origin}/api/team/auth/csrf`, {
      headers: { accept: 'application/json', cookie: await this.cookieHeader() },
      credentials: 'include', cache: 'no-store', redirect: 'error',
    });
    if (!response.ok) throw new Error('diagnostic_csrf_unavailable');
    const body = await response.json() as { csrfToken?: unknown };
    if (typeof body.csrfToken !== 'string' || !body.csrfToken) throw new Error('diagnostic_csrf_unavailable');
    this.csrfToken = body.csrfToken;
    return body.csrfToken;
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      const identity = this.identity;
      const queue = this.queue;
      if (!identity || !queue) return;
      for (const event of queue.pending()) {
        if (identity !== this.identity || queue !== this.queue) return;
        try {
          const { clientEventId, stage, phase, code, transferId } = event;
          const taskId = event.taskId;
          const { resourceType, resourceId } = event;
          const csrfToken = await this.csrf();
          const response = await this.options.session.fetch(`${this.origin}/api/team/errors/report`, {
            method: 'POST',
            headers: {
              accept: 'application/json', 'content-type': 'application/json',
              cookie: await this.cookieHeader(), origin: this.origin,
              'x-csrf-token': csrfToken,
              'x-creative-studio-client-version': this.options.clientVersion,
              'x-creative-studio-client-api': '1',
            },
            body: JSON.stringify({ clientEventId, stage, phase, code, taskId, transferId, resourceType, resourceId }), credentials: 'include', cache: 'no-store', redirect: 'error',
          });
          if (!response.ok) {
            if (response.status === 401 || response.status === 403) return;
            continue;
          }
          queue.acknowledge(event.clientEventId);
        } catch { return; }
      }
    })().finally(() => { this.flushing = null; });
    return this.flushing;
  }
}
