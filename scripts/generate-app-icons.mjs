import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = process.cwd();
const sourceSvg = path.join(root, 'app', 'icon.svg');
const publicIconDir = path.join(root, 'public', 'icons');
const pngSizes = [16, 32, 48, 64, 128, 256, 512, 1024];
const icoSizes = [16, 32, 48, 64, 128, 256];

function encodeIcoDirectory(pngEntries) {
  const headerSize = 6;
  const entrySize = 16;
  const directory = Buffer.alloc(headerSize + entrySize * pngEntries.length);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(pngEntries.length, 4);

  let imageOffset = directory.length;
  pngEntries.forEach((entry, index) => {
    const offset = headerSize + index * entrySize;
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, offset);
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, offset + 1);
    directory.writeUInt8(0, offset + 2);
    directory.writeUInt8(0, offset + 3);
    directory.writeUInt16LE(1, offset + 4);
    directory.writeUInt16LE(32, offset + 6);
    directory.writeUInt32LE(entry.buffer.length, offset + 8);
    directory.writeUInt32LE(imageOffset, offset + 12);
    imageOffset += entry.buffer.length;
  });

  return Buffer.concat([directory, ...pngEntries.map((entry) => entry.buffer)]);
}

async function renderPng(size) {
  const svg = await fs.readFile(sourceSvg);
  return sharp(svg).resize(size, size).png().toBuffer();
}

await fs.mkdir(publicIconDir, { recursive: true });
await fs.copyFile(sourceSvg, path.join(publicIconDir, 'app-icon.svg'));

for (const size of pngSizes) {
  const buffer = await renderPng(size);
  await fs.writeFile(path.join(publicIconDir, `app-icon-${size}.png`), buffer);
}

const appleIcon = await renderPng(180);
await fs.writeFile(path.join(root, 'app', 'apple-icon.png'), appleIcon);

const icoEntries = [];
for (const size of icoSizes) {
  icoEntries.push({ size, buffer: await renderPng(size) });
}
await fs.writeFile(path.join(root, 'app', 'favicon.ico'), encodeIcoDirectory(icoEntries));

console.log(`Generated app icon assets from ${path.relative(root, sourceSvg)}`);
