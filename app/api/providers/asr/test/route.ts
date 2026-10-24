import { NextResponse } from 'next/server';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDb } from '@/lib/db';
import { asrEnvFromDatabase, readAsrProviderRow } from '@/lib/live-mixcut/asr-provider';
import { createVolcFlashAsrAdapter } from '@/lib/media-core/adapters/volc-asr';

/**
 * 真实连通性测试：造一段 1 秒的合成语音，走一遍 adapter.transcribe。
 *
 * 只看「有没有填 Key」没有意义——Key 有效但 Resource-Id 没开通时，
 * 配置照样显示「已配置」却一跑就失败。这里用真实请求把这种情况提前暴露。
 *
 * 合成音频用系统 TTS 生成，避免往仓库里塞一个测试音频文件；
 * 没有任何可用的本地 TTS 时退回一段静音，此时只验证鉴权与资源授权，不验证识别精度。
 */
export const runtime = 'nodejs';

const TEST_TEXT = '你好';

function run(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

async function buildProbeAudio(directory: string): Promise<string> {
  const wav = path.join(directory, 'asr-probe.wav');
  // macOS 自带 say；Linux 常见 espeak。拿不到就退回静音。
  if (process.platform === 'darwin') {
    const aiff = path.join(directory, 'asr-probe.aiff');
    if (await run('say', ['-o', aiff, TEST_TEXT]) && await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', aiff, '-ar', '16000', '-ac', '1', wav])) {
      return wav;
    }
  }
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '1', wav]);
  return wav;
}

export async function POST() {
  const row = readAsrProviderRow(getDb());
  if (!row) return NextResponse.json({ ok: false, message: '实拍混剪未启用，或数据库尚未升级到 v2。' }, { status: 503 });

  const adapter = createVolcFlashAsrAdapter(asrEnvFromDatabase(getDb()));
  if (!adapter.configured) return NextResponse.json({ ok: false, message: '还没有可用的 Key，请先填写并保存。' });

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-test-'));
  try {
    const audioPath = await buildProbeAudio(directory);
    const stat = fs.statSync(audioPath);
    if (!stat.size) return NextResponse.json({ ok: false, message: '无法生成测试音频（本机缺少 ffmpeg）。' });
    // adapter 需要「已核验的真实时长」，这里按 16kHz/16bit/单声道推算。
    const durationUs = Math.round((stat.size - 44) / (16000 * 2) * 1_000_000);
    const started = Date.now();
    const result = await adapter.transcribe({ audioPath, durationUs: Math.max(durationUs, 1_000_000) });
    return NextResponse.json({ ok: true, text: result.text, words: result.words.length, elapsedMs: Date.now() - started });
  } catch (error) {
    return NextResponse.json({ ok: false, message: error instanceof Error ? error.message : String(error) });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
