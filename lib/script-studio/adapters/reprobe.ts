import type { ScriptStudioCompleteJson } from '../llm-contract.ts';

export interface EvidenceTile {
  mimeType: string;
  imageBase64: string;
}

export interface EvidenceReprobeClaim {
  /** 由服务端分配的不透明 ID，用于防止模型调换多条结果。 */
  id: string;
  claim: string;
  /** 该条候选允许查看的图片位置，1-based。 */
  imageIndexes: number[];
}

export interface EvidenceReprobe {
  readonly kind: 'vision_closed_question' | 'ocr';
  verify(input: {
    claim: string;
    tiles: EvidenceTile[];
    signal?: AbortSignal;
  }): Promise<{ quote: string | null }>;
  /**
   * 可选的小批处理契约。每条 claim 仍是独立封闭问题，只是共享一次视觉请求；
   * 最终准入仍由服务端按 id 取回 quote 后逐条做字符串匹配。
   */
  verifyMany?(input: {
    claims: EvidenceReprobeClaim[];
    tiles: EvidenceTile[];
    signal?: AbortSignal;
  }): Promise<{ results: Array<{ id: string; quote: string | null }> }>;
}

function normalize(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function createVisionClosedQuestionReprobe(
  completeJson: ScriptStudioCompleteJson,
  options: { maxTokens?: number } = {},
): EvidenceReprobe {
  const verifyMany = async (input: {
    claims: EvidenceReprobeClaim[];
    tiles: EvidenceTile[];
    signal?: AbortSignal;
  }): Promise<{ results: Array<{ id: string; quote: string | null }> }> => {
    const raw = await completeJson({
      systemPrompt: '你是图片证据核验器。只做封闭问题，不猜测、不补全、不总结。每条只能查看它指定的图片。',
      userPrompt: JSON.stringify({
        task: 'visual_evidence_closed_questions',
        imageNumbering: '随附图片按 1-based 编号',
        claims: input.claims,
        requirement: '逐条检查 imageIndexes 指定图片中是否真的出现候选关键事实。若出现，逐字返回包含它的原文行，不得改写；若未出现或无法确认，quote 返回 null。每个 id 必须且只能返回一条结果。',
        output: { results: [{ id: '原样返回 claim id', quote: 'string 或 null' }] },
      }),
      temperature: 1,
      maxTokens: options.maxTokens ?? 2048,
      images: input.tiles,
      signal: input.signal,
    });
    const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const values = Array.isArray(value.results) ? value.results : [];
    const allowedIds = new Set(input.claims.map((claim) => claim.id));
    const seen = new Set<string>();
    const results: Array<{ id: string; quote: string | null }> = [];
    for (const item of values) {
      const record = item && typeof item === 'object' && !Array.isArray(item)
        ? item as Record<string, unknown>
        : {};
      const id = normalize(record.id);
      if (!allowedIds.has(id) || seen.has(id)) continue;
      seen.add(id);
      const quote = normalize(record.quote);
      results.push({ id, quote: quote || null });
    }
    return { results };
  };

  return {
    kind: 'vision_closed_question',
    async verify(input) {
      const result = await verifyMany({
        claims: [{ id: 'claim_1', claim: input.claim, imageIndexes: input.tiles.map((_, index) => index + 1) }],
        tiles: input.tiles,
        signal: input.signal,
      });
      return { quote: result.results.find((item) => item.id === 'claim_1')?.quote ?? null };
    },
    verifyMany,
  };
}
