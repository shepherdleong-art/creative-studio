/** 二级回退：LLM 提取卖点（复用素材分析 provider 通道）。供应商取组分析供应商或首个已配置脚本供应商。 */
export async function extractSellingPointsWithLLM(narrationText: string, analysisProviderId?: string, signal?: AbortSignal): Promise<string[]> {
  const text = (narrationText || '').trim();
  if (!text) return [];
  let completeJson: ((input: { providerId: string; systemPrompt: string; userPrompt: string; temperature?: number; maxTokens?: number; timeoutMs?: number; signal?: AbortSignal }) => Promise<{ points?: unknown }>) | undefined;
  let providerId: string | null = null;
  try {
    const mod = await import('../script-providers/index.ts');
    const metas: Array<{ id: string; configured: boolean }> = mod.getAvailableProviders?.() ?? [];
    const configured = metas.filter((meta) => meta.configured).map((meta) => meta.id);
    providerId = analysisProviderId && configured.includes(analysisProviderId) ? analysisProviderId : (configured[0] ?? null);
    completeJson = mod.completeJson as typeof completeJson;
  } catch { return []; }
  if (!providerId || !completeJson) return [];
  try {
    const result = await completeJson({
      providerId,
      systemPrompt: '你是短视频口播文案的卖点提炼助手。请从用户提供的口播脚本中，提取适合在画面上用「花字气泡/贴纸」随口播弹出的卖点短语。要求：每条 4-14 个汉字；口语化、突出具体卖点（数字、材质、功效、规格）；不提取寒暄、人物反应或泛泛推荐；尽量使用口播中连续出现的短语以便精确对时；严格按口播中出现顺序；最多 6 条。只输出 JSON：{"points":["…","…"]}，不要解释。',
      userPrompt: text.slice(0, 4000),
      temperature: 0.2,
      maxTokens: 1200,
      timeoutMs: 30_000,
      signal,
    });
    const points = Array.isArray(result?.points) ? result.points.map(String).filter(Boolean) : [];
    return points;
  } catch { return []; }
}

