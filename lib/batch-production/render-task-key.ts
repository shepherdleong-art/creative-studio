export type RenderTaskContractKind = 'full' | 'cover';

export interface ParsedRenderTaskRequestKey {
  kind: RenderTaskContractKind;
  outputVersionId: string;
  contractHash: string;
}

const RENDER_TASK_REQUEST_KEY_RE = /^(render|cover):([^:]+):((?:rnd|cov)_[0-9a-f]{32})$/u;

/** 只解析带完整契约哈希的新格式；旧 requestKey 返回 null 走兼容路径。 */
export function parseRenderTaskRequestKey(value: string | null | undefined): ParsedRenderTaskRequestKey | null {
  const match = RENDER_TASK_REQUEST_KEY_RE.exec(value ?? '');
  if (!match) return null;
  const kind = match[1] === 'render' ? 'full' : 'cover';
  const contractHash = match[3];
  if (
    (kind === 'full' && !contractHash.startsWith('rnd_'))
    || (kind === 'cover' && !contractHash.startsWith('cov_'))
  ) return null;
  return { kind, outputVersionId: match[2], contractHash };
}

export function buildCoverRenderTaskRequestKey(outputVersionId: string, coverContractHash: string): string {
  return `cover:${outputVersionId}:${coverContractHash}`;
}

export function buildFullRenderTaskRequestKey(outputVersionId: string, fullRenderContractHash: string): string {
  return `render:${outputVersionId}:${fullRenderContractHash}`;
}
