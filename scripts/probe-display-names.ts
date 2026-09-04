import { listSystemFonts } from '../lib/media-core/system-fonts.ts';

const fonts = listSystemFonts();
const zh = fonts.filter((f) => f.displayName !== f.family);
console.log('总数:', fonts.length, '有中文名:', zh.length);
for (const f of zh.slice(0, 10)) console.log(`${f.family} -> ${f.displayName}`);
