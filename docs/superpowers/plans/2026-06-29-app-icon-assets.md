# App Icon Assets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and integrate the approved N2 app icon as SVG, PNG, web favicon, and Windows `.ico` assets.

**Architecture:** Keep the icon source as a single SVG in `app/icon.svg`, then generate all raster outputs from that source with a local Node script. The script uses existing `sharp` for PNG resizing and a small ICO writer for Windows compatibility, avoiding new dependencies.

**Tech Stack:** Next.js App Router icon conventions, SVG, Node.js ESM scripts, `sharp`, PowerShell/npm verification.

---

## File Structure

- `app/icon.svg`: canonical N2 source icon and Next.js SVG icon route.
- `app/favicon.ico`: generated multi-size Windows/browser ICO consumed by the existing installer build script.
- `app/apple-icon.png`: generated 180px Apple touch icon for Next.js App Router conventions.
- `public/icons/app-icon.svg`: public copy of the source SVG for docs, preview, and direct asset access.
- `public/icons/app-icon-{16,32,48,64,128,256,512,1024}.png`: generated PNG exports required by the icon spec.
- `scripts/generate-app-icons.mjs`: deterministic asset generation script.
- `package.json`: add an `icons` script for regenerating icon assets.
- `app/layout.tsx`: explicitly declare the icon metadata paths used by the app.

---

### Task 1: Add the N2 SVG Source

**Files:**
- Create: `app/icon.svg`
- Create: `public/icons/app-icon.svg`

- [ ] **Step 1: Create the canonical SVG**

Create `app/icon.svg` with a 1024 viewBox, a deep neutral rounded square, the N2 Studio glyph, and rounded blue/green/purple accent shapes:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="Creative Studio app icon">
  <rect width="1024" height="1024" rx="216" fill="#202124"/>
  <path fill="#F5F5F7" d="M312 312h392v136H464v120h200v144H312z"/>
  <rect x="672" y="272" width="136" height="136" rx="68" fill="#0071E3"/>
  <rect x="312" y="696" width="136" height="136" rx="68" fill="#34C759"/>
  <rect x="696" y="544" width="136" height="136" rx="40" fill="#5331D8"/>
</svg>
```

- [ ] **Step 2: Copy the same SVG to the public asset path**

Create `public/icons/app-icon.svg` with the same content as `app/icon.svg`.

- [ ] **Step 3: Inspect the SVG manually**

Run: `Get-Content -LiteralPath app\icon.svg`

Expected: the SVG contains the exact color palette `#202124`, `#F5F5F7`, `#0071E3`, `#34C759`, and `#5331D8`.

---

### Task 2: Add Deterministic Asset Generation

**Files:**
- Create: `scripts/generate-app-icons.mjs`
- Modify: `package.json`

- [ ] **Step 1: Create the generator script**

Create `scripts/generate-app-icons.mjs` that:

```js
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
```

- [ ] **Step 2: Add an npm script**

Modify `package.json` scripts to include:

```json
"icons": "node scripts/generate-app-icons.mjs"
```

- [ ] **Step 3: Run the generator**

Run: `npm run icons`

Expected: command prints `Generated app icon assets from app\icon.svg` or the platform-equivalent path.

---

### Task 3: Wire Icon Metadata

**Files:**
- Modify: `app/layout.tsx`

- [ ] **Step 1: Add explicit metadata icons**

Update `metadata` in `app/layout.tsx` to include:

```ts
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icons/app-icon.svg", type: "image/svg+xml" },
      { url: "/icons/app-icon-32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: [
      { url: "/apple-icon.png", sizes: "180x180", type: "image/png" },
    ],
  },
```

- [ ] **Step 2: Run lint**

Run: `npm run lint`

Expected: command exits successfully with no ESLint errors from the metadata change.

---

### Task 4: Verify Generated Assets

**Files:**
- Verify: `app/favicon.ico`
- Verify: `app/apple-icon.png`
- Verify: `public/icons/app-icon-*.png`
- Verify: `public/icons/app-icon.svg`

- [ ] **Step 1: Check expected files exist**

Run:

```powershell
Get-ChildItem -LiteralPath app,public\icons -File | Where-Object { $_.Name -match 'icon|favicon' } | Select-Object Name,Length
```

Expected: includes `favicon.ico`, `apple-icon.png`, `app-icon.svg`, and all PNG sizes from 16 through 1024.

- [ ] **Step 2: Inspect raster dimensions with sharp**

Run:

```powershell
node -e "const sharp=require('sharp'); const fs=require('fs'); (async()=>{ for (const f of ['public/icons/app-icon-16.png','public/icons/app-icon-32.png','public/icons/app-icon-1024.png','app/apple-icon.png']) { const m=await sharp(f).metadata(); console.log(f, m.width+'x'+m.height); } })()"
```

Expected:

```text
public/icons/app-icon-16.png 16x16
public/icons/app-icon-32.png 32x32
public/icons/app-icon-1024.png 1024x1024
app/apple-icon.png 180x180
```

- [ ] **Step 3: Verify ICO header**

Run:

```powershell
node -e "const fs=require('fs'); const b=fs.readFileSync('app/favicon.ico'); console.log(b.readUInt16LE(0), b.readUInt16LE(2), b.readUInt16LE(4));"
```

Expected: `0 1 6`, meaning ICO reserved field, icon type, and six embedded image sizes.

---

### Task 5: Final Review

**Files:**
- Review: all changed files

- [ ] **Step 1: Review git diff**

Run: `git diff -- app public scripts package.json`

Expected: changes only add icon assets, generator script, package script, and icon metadata.

- [ ] **Step 2: Check working tree**

Run: `git status --short`

Expected: icon-related files are modified/untracked. Existing unrelated untracked files, if present, remain untouched.
