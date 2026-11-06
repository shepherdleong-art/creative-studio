import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { atomicJson } from './atomic-json';

export type ClientDiagnosticStage = 'client_ui' | 'upload' | 'download' | 'client_update';

/** Only this deliberately safe projection may cross the client/server boundary. */
export interface ClientDiagnosticInput {
  clientEventId?: string;
  stage: ClientDiagnosticStage;
  phase: string;
  code: string;
  taskId?: string;
  transferId?: string;
  clientVersion?: string;
  actorUserId?: string;
  resourceType?: string;
  resourceId?: string;
  // Accepted at the adapter boundary, deliberately never retained or uploaded.
  message?: unknown;
  [key: string]: unknown;
}

export interface ClientDiagnosticEvent {
  clientEventId: string;
  capturedAt?: string;
  stage: ClientDiagnosticStage;
  phase: string;
  code: string;
  taskId?: string;
  transferId?: string;
  resourceType?: string;
  resourceId?: string;
  clientVersion: string;
}

interface DiagnosticFile {
  schemaVersion: 1;
  events: ClientDiagnosticEvent[];
}

const TOKEN = /^[a-z][a-z0-9_.-]*$/i;
const MANAGED_ID = /^[a-z0-9][a-z0-9-]{0,127}$/i;
const STAGES = new Set<ClientDiagnosticStage>(['client_ui', 'upload', 'download', 'client_update']);

function safeToken(value: unknown, fallback: string, maximum = 80): string {
  return typeof value === 'string' && value.length <= maximum && TOKEN.test(value) ? value : fallback;
}

function safeId(value: unknown): string | undefined {
  return typeof value === 'string' && MANAGED_ID.test(value) ? value : undefined;
}

export function sanitizeClientDiagnostic(input: ClientDiagnosticInput): ClientDiagnosticEvent {
  if (!input || !STAGES.has(input.stage)) throw new Error('客户端诊断阶段无效');
  return {
    clientEventId: safeId(input.clientEventId) ?? randomUUID(),
    capturedAt: typeof input.capturedAt === 'string' && !Number.isNaN(Date.parse(input.capturedAt))
      ? new Date(input.capturedAt).toISOString() : new Date().toISOString(),
    stage: input.stage,
    phase: safeToken(input.phase, 'unknown'),
    code: safeToken(input.code, 'client_error'),
    ...(safeId(input.taskId) ? { taskId: input.taskId } : {}),
    ...(safeId(input.transferId) ? { transferId: input.transferId } : {}),
    ...(safeToken(input.resourceType, '') ? { resourceType: input.resourceType } : {}),
    ...(safeId(input.resourceId) ? { resourceId: input.resourceId } : {}),
    clientVersion: safeToken(input.clientVersion, 'unknown'),
  };
}

export class ClientDiagnosticQueue {
  private readonly maximum: number;
  private events: ClientDiagnosticEvent[];

  constructor(private readonly filePath: string, options: { maxEvents?: number } = {}) {
    this.maximum = options.maxEvents ?? 200;
    if (!Number.isSafeInteger(this.maximum) || this.maximum < 1 || this.maximum > 1000) {
      throw new Error('客户端诊断队列容量无效');
    }
    this.events = this.load();
  }

  private load(): ClientDiagnosticEvent[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Partial<DiagnosticFile>;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.events)) return [];
      // Ignore malformed local entries; never let diagnostics block the client.
      return parsed.events.flatMap((value) => {
        try {
          const event = sanitizeClientDiagnostic(value as ClientDiagnosticInput);
          return Date.now() - Date.parse(event.capturedAt!) <= 7 * 24 * 60 * 60 * 1000 ? [event] : [];
        } catch { return []; }
      }).slice(-this.maximum);
    } catch { return []; }
  }

  private save(): void {
    atomicJson(this.filePath, { schemaVersion: 1, events: this.events } satisfies DiagnosticFile);
  }

  capture(input: ClientDiagnosticInput): { kind: 'pending' | 'duplicate'; clientEventId: string } {
    const event = sanitizeClientDiagnostic(input);
    if (this.events.some((candidate) => candidate.clientEventId === event.clientEventId)) {
      return { kind: 'duplicate', clientEventId: event.clientEventId };
    }
    this.events = [...this.events.filter((candidate) => candidate.clientEventId !== event.clientEventId
      && Date.now() - Date.parse(candidate.capturedAt!) <= 7 * 24 * 60 * 60 * 1000), event]
      .filter((candidate) => Date.now() - Date.parse(candidate.capturedAt!) <= 7 * 24 * 60 * 60 * 1000)
      .slice(-this.maximum);
    this.save();
    return { kind: 'pending', clientEventId: event.clientEventId };
  }

  pending(): ClientDiagnosticEvent[] {
    return this.events.map((event) => ({ ...event }));
  }

  acknowledge(clientEventId: string): boolean {
    const count = this.events.length;
    this.events = this.events.filter((event) => event.clientEventId !== clientEventId);
    if (this.events.length === count) return false;
    this.save();
    return true;
  }
}
