import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { dataRoot } from '@/lib/data-root';

export const runtime = 'nodejs';

const BGM_EXTS = ['.mp3', '.m4a', '.wav', '.aac', '.flac'];

function bgmDir(): string {
  const dir = path.join(dataRoot(), 'storage', 'bgm');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function GET() {
  try {
    const dir = bgmDir();
    const files = fs
      .readdirSync(dir)
      .filter((name) => BGM_EXTS.includes(path.extname(name).toLowerCase()))
      .sort()
      .map((name) => ({ name, path: path.join(dir, name) }));
    return NextResponse.json({ bgm: files, dir });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return NextResponse.json({ error: '缺少文件' }, { status: 400 });
    const ext = path.extname(file.name).toLowerCase();
    if (!BGM_EXTS.includes(ext)) {
      return NextResponse.json({ error: `不支持的音频格式：${ext}（支持 ${BGM_EXTS.join(' ')}）` }, { status: 400 });
    }
    const base = path
      .basename(file.name, ext)
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .slice(0, 80) || 'bgm';
    const dir = bgmDir();
    let target = path.join(dir, `${base}${ext}`);
    if (fs.existsSync(target)) target = path.join(dir, `${base}-${Date.now()}${ext}`);
    fs.writeFileSync(target, Buffer.from(await file.arrayBuffer()));
    return NextResponse.json({ success: true, name: path.basename(target), path: target });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
