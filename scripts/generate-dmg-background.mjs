import { writeFileSync } from 'node:fs';
import sharp from 'sharp';

const out = process.argv[2] ?? 'dist/macos/dmg/.background/background.png';
const width = 640;
const height = 420;

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#f7f7f5"/>
      <stop offset="100%" stop-color="#e9edf1"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#1c2430" flood-opacity="0.18"/>
    </filter>
  </defs>
  <rect width="640" height="420" rx="0" fill="url(#bg)"/>
  <text x="320" y="58" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif" font-size="24" font-weight="700" fill="#19202a">安装产品素材工作台</text>
  <text x="320" y="88" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif" font-size="14" fill="#657080">将左侧应用拖到右侧 Applications 文件夹</text>
  <g filter="url(#shadow)">
    <rect x="74" y="144" width="168" height="144" rx="22" fill="#ffffff" opacity="0.78"/>
    <rect x="398" y="144" width="168" height="144" rx="22" fill="#ffffff" opacity="0.78"/>
  </g>
  <path d="M284 214h72" stroke="#2f6df6" stroke-width="8" stroke-linecap="round"/>
  <path d="M346 190l34 28-34 28" fill="none" stroke="#2f6df6" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="158" y="326" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif" font-size="14" font-weight="600" fill="#2b3340">产品素材工作台</text>
  <text x="482" y="326" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif" font-size="14" font-weight="600" fill="#2b3340">Applications</text>
</svg>`;

const png = await sharp(Buffer.from(svg)).png().toBuffer();
writeFileSync(out, png);
