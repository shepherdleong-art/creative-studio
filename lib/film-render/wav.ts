import fs from 'node:fs';
import { requireInput } from './errors.ts';

export interface PcmWav {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  sampleFrames: number;
  pcm: Buffer;
}

/** Walk RIFF chunks; ffmpeg's LIST/JUNK chunks and odd-byte padding are legal. */
export function parsePcmWav(bytes: Buffer): PcmWav {
  const valid = (ok: unknown, message: string) => requireInput(ok, 'INVALID_WAV', message);
  valid(bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE', '需要 RIFF/WAVE 文件');
  const end = bytes.readUInt32LE(4) + 8;
  valid(end === bytes.length, 'RIFF 长度与文件大小不符');
  let format: Buffer | undefined, pcm: Buffer | undefined;
  let offset = 12;
  while (offset < end) {
    valid(offset + 8 <= end, 'WAV 块头被截断');
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const next = offset + 8 + size;
    valid(next + (size % 2) <= end, `WAV ${id} 块被截断`);
    if (id === 'fmt ') {
      valid(!format && size >= 16, 'WAV fmt 块缺失字段或重复');
      format = bytes.subarray(offset + 8, next);
    } else if (id === 'data') {
      valid(!pcm, 'WAV data 块重复');
      pcm = bytes.subarray(offset + 8, next);
    }
    offset = next + (size % 2);
  }
  requireInput(format && pcm, 'INVALID_WAV', 'WAV 缺少 fmt 或 data 块');
  const channels = format.readUInt16LE(2), sampleRate = format.readUInt32LE(4);
  const byteRate = format.readUInt32LE(8), blockAlign = format.readUInt16LE(12), bitsPerSample = format.readUInt16LE(14);
  valid(format.readUInt16LE(0) === 1 && bitsPerSample === 16, 'WAV 必须为 PCM16');
  valid(channels > 0 && sampleRate > 0 && blockAlign === channels * 2 && byteRate === sampleRate * blockAlign && pcm.length % blockAlign === 0,
    'WAV 采样参数或 data 长度不合法');
  return { channels, sampleRate, bitsPerSample, sampleFrames: pcm.length / blockAlign, pcm };
}

export function readPcmWav(file: string): PcmWav { return parsePcmWav(fs.readFileSync(file)); }

export function encodePcmWav(pcm: Buffer, sampleRate = 48000, channels = 1): Buffer {
  requireInput(Number.isInteger(sampleRate) && sampleRate > 0 && Number.isInteger(channels) && channels > 0 &&
    channels <= 32 && pcm.length % (channels * 2) === 0 && pcm.length <= 0xffffffff - 36,
    'INVALID_WAV', 'PCM 数据或 WAV 参数不合法');
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
