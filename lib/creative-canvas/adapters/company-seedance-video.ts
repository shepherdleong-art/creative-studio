import { createJimengAdapter } from '../../video-providers/jimeng.ts';
import { assertArkRequestSize } from '../../video-providers/seedance-contract.ts';
import { normalizeGatewayResultUrl } from '../../gateway-media-url.ts';

/** 用户确认公司网关透传方舟 content 合同；只适配网关 URL/响应封装。 */
export function createCompanySeedanceVideoAdapter(fetchImpl: typeof fetch = fetch) {
  const gatewayFetch: typeof fetch = async (input, init) => {
    let request = init;
    if (init?.method === 'POST' && typeof init.body === 'string') {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      const content = body.content as Array<{ type: string; text?: string }>;
      // 普通生成保留 LiteLLM /v1/videos 的 prompt/seconds 外层字段，原生 content 完整透传。
      // LiteLLM 要求 prompt 参数；Final 仅用空字符串占传输层位置，不能继承创作提示词。
      body.prompt = '';
      if (!content.some((item) => item.type === 'draft_task')) {
        body.prompt = content.find((item) => item.type === 'text')?.text ?? '';
        body.seconds = String(body.duration);
      }
      request = { ...init, body: assertArkRequestSize(body) };
    }
    const response = await fetchImpl(input, request);
    if (!response.ok) return response;
    const raw = await response.json();
    const url = String(input);
    const baseUrl = url.split('/v1/videos')[0];
    const status = ({ queued: 'queued', pending: 'queued', processing: 'running', in_progress: 'running', completed: 'succeeded', success: 'succeeded' } as Record<string, string>)[raw.status] ?? raw.status;
    const mediaUrl = raw.content?.video_url ?? raw.metadata?.url ?? raw.output?.url ?? raw.video?.url ?? raw.result?.video_url ?? raw.result?.url ?? raw.video_url ?? raw.url;
    const videoUrl = mediaUrl ?? (status === 'succeeded' ? `${url}/content` : undefined);
    const tailUrl = raw.content?.last_frame_url ?? raw.last_frame_url;
    return Response.json({
      ...raw,
      id: raw.id ?? raw.task_id,
      status,
      content: {
        ...(raw.content ?? {}),
        ...(videoUrl ? { video_url: normalizeGatewayResultUrl(videoUrl, baseUrl) } : {}),
        ...(tailUrl ? { last_frame_url: normalizeGatewayResultUrl(tailUrl, baseUrl) } : {}),
      },
    });
  };
  return createJimengAdapter({ fetchImpl: gatewayFetch, taskPath: '/v1/videos' });
}
