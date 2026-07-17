import fs from 'node:fs';

export interface AlignmentWordTiming {
  text: string;
  startUs: number;
  endUs: number;
}
export interface AlignmentAdapter {
  configured: boolean;
  align(input: { audioPath: string; text: string }): Promise<AlignmentWordTiming[]>;
}

function transcriptionUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  if (base.endsWith('/audio/transcriptions')) return base;
  return base.endsWith('/v1') ? `${base}/audio/transcriptions` : `${base}/v1/audio/transcriptions`;
}

export function createOpenAiAlignmentAdapter(env: NodeJS.ProcessEnv = process.env): AlignmentAdapter {
  const baseUrl = (env.FINAL_EDIT_ALIGNMENT_BASE_URL || '').trim();
  const apiKey = (env.FINAL_EDIT_ALIGNMENT_API_KEY || '').trim();
  const model = (env.FINAL_EDIT_ALIGNMENT_MODEL || 'whisper-1').trim();
  const configured = Boolean(baseUrl && apiKey && model);
  return {
    configured,
    async align({ audioPath, text }) {
      if (!configured) throw new Error('生产强制对齐尚未配置：需要 FINAL_EDIT_ALIGNMENT_BASE_URL / API_KEY / MODEL');
      const bytes = fs.readFileSync(audioPath);
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'segment.wav');
      form.append('model', model);
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'word');
      form.append('prompt', text);
      const response = await fetch(transcriptionUrl(baseUrl), {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`强制对齐服务返回 ${response.status}: ${body.slice(0, 300)}`);
      }
      const payload = await response.json() as { words?: Array<{ word?: string; start?: number; end?: number }> };
      const words = (payload.words || []).map((word) => ({
        text: String(word.word || '').trim(),
        startUs: Math.round(Number(word.start || 0) * 1_000_000),
        endUs: Math.round(Number(word.end || 0) * 1_000_000),
      })).filter((word) => word.text && word.endUs > word.startUs);
      if (words.length === 0) throw new Error('强制对齐服务没有返回逐词时间戳');
      return words;
    },
  };
}
