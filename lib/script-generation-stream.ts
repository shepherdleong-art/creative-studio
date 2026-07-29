import type { ScriptGenerationProgress } from './script-generation-v3.ts';

export interface ScriptGenerationResult {
  status: number;
  body: Record<string, unknown>;
}

export type ScriptGenerationStreamEvent =
  | { type: 'progress'; progress: ScriptGenerationProgress }
  | ({ type: 'result' } & ScriptGenerationResult)
  | ({ type: 'error' } & ScriptGenerationResult);

export class ScriptGenerationStreamError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown>) {
    super(String(body.message || body.error || '脚本生成失败'));
    this.name = 'ScriptGenerationStreamError';
    this.status = status;
    this.body = body;
  }
}

export function encodeScriptGenerationStreamEvent(event: ScriptGenerationStreamEvent): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(event)}\n`);
}

export async function readScriptGenerationStream(
  response: Response,
  onProgress: (progress: ScriptGenerationProgress) => void,
): Promise<ScriptGenerationResult> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` })) as Record<string, unknown>;
    throw new ScriptGenerationStreamError(response.status, body);
  }
  if (!response.body) throw new Error('脚本生成没有返回进度流');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: ScriptGenerationResult | null = null;

  const consumeLine = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as ScriptGenerationStreamEvent;
    if (event.type === 'progress') {
      onProgress(event.progress);
    } else if (event.type === 'error') {
      throw new ScriptGenerationStreamError(event.status, event.body);
    } else if (event.type === 'result') {
      result = { status: event.status, body: event.body };
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) consumeLine(line);
  }
  buffer += decoder.decode();
  if (buffer.trim()) consumeLine(buffer);
  if (!result) throw new Error('脚本生成进度流提前结束');
  return result;
}
