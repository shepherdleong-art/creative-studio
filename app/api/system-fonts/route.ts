import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextResponse } from 'next/server';

export async function GET() {
  const directories = process.platform === 'darwin'
    ? ['/System/Library/Fonts', '/Library/Fonts', path.join(os.homedir(), 'Library', 'Fonts')]
    : process.platform === 'win32'
      ? [path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts')]
      : ['/usr/share/fonts', path.join(os.homedir(), '.local', 'share', 'fonts')];
  const names = new Set<string>();
  const visit = (directory: string, depth: number) => {
    if (depth > 3 || !fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full, depth + 1);
      else if (/\.(ttf|otf|ttc)$/i.test(entry.name)) names.add(path.basename(entry.name, path.extname(entry.name)).replace(/[-_](Regular|Bold|Light|Medium|Semibold).*$/i, ''));
    }
  };
  directories.forEach((directory) => visit(directory, 0));
  return NextResponse.json({ fonts: [...names].sort((a, b) => a.localeCompare(b)).map((family) => ({ family, fullName: family })) });
}
