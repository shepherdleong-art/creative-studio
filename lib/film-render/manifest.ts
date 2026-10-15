import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectFile, sha256, CLASSIC_ASSETS, classicTemplateDir } from './files.ts';
import type { RenderSpec } from './types.ts';

export function inputHashes(spec: RenderSpec) {
  const files = new Set([spec.classic.projectCss, spec.classic.designDoc, spec.classic.cover.image,
    ...spec.shots.map(s => s.file), ...spec.audio.voices.map(v => v.file), spec.audio.music.file]);
  return Object.fromEntries([...files].sort().map(file => [file, sha256(projectFile(spec.project.root, file))]));
}
export function templateHashes() {
  return { id: 'classic', version: '1',
    builders: Object.fromEntries(['templates/classic-v1.ts', 'templates/classic-callouts-v1.ts', 'python-format.ts'].map(file =>
      [file, sha256(fileURLToPath(new URL(file, import.meta.url)))])),
    assets: Object.fromEntries(Object.keys(CLASSIC_ASSETS).map(file => [file, sha256(path.join(classicTemplateDir(), file))])) };
}
export function writeNewJson(file: string, data: unknown) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
}
