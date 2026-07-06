import { NextRequest, NextResponse } from 'next/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFfmpeg } from '@/lib/ffmpeg';
import { resolveNarrationRuntime, synthesizeOne } from '@/lib/final-video/tts';

export const runtime = 'nodejs';

const PREVIEW_TEXT = '你好，这是口播试听，欢迎使用创意工作室。';

/**
 * 试听：用固定短句合成一段音频（走与正式合成相同的 synthesizeOne adapter），转码为 m4a 返回。
 * 请求体可指定 voice 试听指定音色，须在该供应商已配置的音色列表内；缺省时用第一个配置音色。
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let tmpDir: string | null = null;
  try {
    const { id } = await params;
    const rt = await resolveNarrationRuntime(id);
    const body = (await request.json().catch(() => ({}))) as { voice?: unknown };
    const requested = typeof body.voice === 'string' ? body.voice.trim() : '';
    if (requested && !rt.voices.includes(requested)) {
      return NextResponse.json(
        { error: `音色「${requested}」不在该供应商已配置的音色列表中` },
        { status: 400 }
      );
    }
    const voice = requested || rt.voices[0] || 'Cherry';
    const { buffer } = await synthesizeOne(PREVIEW_TEXT, voice, 1, rt);

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'narration-preview-'));
    const raw = path.join(tmpDir, 'raw');
    const out = path.join(tmpDir, 'preview.m4a');
    fs.writeFileSync(raw, buffer);
    await runFfmpeg(['-i', raw, '-c:a', 'aac', '-b:a', '128k', '-y', out], { timeoutMs: 30_000 });
    const audio = fs.readFileSync(out);

    return new NextResponse(audio, {
      headers: { 'Content-Type': 'audio/mp4', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 400 });
  } finally {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
