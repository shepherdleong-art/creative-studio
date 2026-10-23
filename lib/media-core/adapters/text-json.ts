/** 共享文本模型入口；调用方只拿公开模型身份，密钥仍由原适配器在服务端解析。 */
export interface TextJsonModel {
  id: string; name: string; model: string;
  complete(input: { systemPrompt: string; userPrompt: string; signal: AbortSignal }): Promise<unknown>;
}

export async function listTextJsonModels(): Promise<Array<Pick<TextJsonModel, 'id' | 'name' | 'model'>>> {
  const { getAvailableProviders } = await import('../../script-providers/index.ts');
  return getAvailableProviders().filter(item => item.configured && item.enabled !== 0)
    .map(({ id, name, model }) => ({ id, name, model }));
}

export async function resolveTextJsonModel(providerId: string, usage: { projectId: string; refType: string; refId: string }): Promise<TextJsonModel> {
  const selected = (await listTextJsonModels()).find(item => item.id === providerId);
  if (!selected) throw new Error('所选脚本模型未配置或不可用，请到设置中检查，也可手动选择列');
  return { ...selected, complete: async input => {
    const { completeJson } = await import('../../script-providers/index.ts');
    return completeJson<unknown>({ providerId: selected.id, model: selected.model, ...input,
      temperature: 1, maxTokens: 4096, timeoutMs: 60_000, usageContext: usage });
  } };
}
