import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectFile, sha256, CLASSIC_ASSETS, classicTemplateDir } from './files.ts';
import { isClassicSpec, type RenderSpec } from './types.ts';
import { resolvePackagingDir, resolvePackagingTemplateDir } from '../media-core/packaging-runtime.ts';
import { SUBTITLE_FONT_ASSET } from './overlay-subtitles.ts';

export function inputHashes(spec: RenderSpec) {
  const files = new Set([...(isClassicSpec(spec) ? [spec.classic.projectCss, spec.classic.designDoc, spec.classic.cover.image] : [spec.cover.image]),
    ...spec.shots.map(s => s.file), ...spec.audio.voices.map(v => v.file), spec.audio.music.file]);
  return Object.fromEntries([...files].sort().map(file => [file, sha256(projectFile(spec.project.root, file))]));
}
export function templateHashes(spec?: RenderSpec) {
  if (spec && !isClassicSpec(spec)) {
    const dir = resolvePackagingDir();
    const assets: Record<string, string> = {};
    const collect = (folder: string) => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) collect(file);
        else if (entry.isFile()) assets[path.relative(dir, file).replace(/\\/g, '/')] = sha256(file);
      }
    };
    collect(resolvePackagingTemplateDir(dir, spec.template.id));
    collect(path.join(dir, 'fonts'));
    assets[`templates/classic/1/${SUBTITLE_FONT_ASSET}`] = sha256(path.join(classicTemplateDir(), SUBTITLE_FONT_ASSET));
    for (const file of ['package-video.mjs', 'palette.js']) {
      if (fs.existsSync(path.join(dir, file))) assets[file] = sha256(path.join(dir, file));
    }
    return { ...spec.template, builders: Object.fromEntries(['overlay-base.ts', 'overlay-subtitles.ts', '../media-core/packaging-render.ts', '../media-core/packaging-runtime.ts', '../media-core/packaging-vars.ts', '../media-core/cover-title-svg.ts', '../media-core/cover-domain.ts'].map(file =>
      [file, sha256(fileURLToPath(new URL(file, import.meta.url)))])), assets };
  }
  return { id: 'classic', version: '1',
    builders: Object.fromEntries(['templates/classic-v1.ts', 'templates/classic-callouts-v1.ts', 'python-format.ts'].map(file =>
      [file, sha256(fileURLToPath(new URL(file, import.meta.url)))])),
    assets: Object.fromEntries(Object.keys(CLASSIC_ASSETS).map(file => [file, sha256(path.join(classicTemplateDir(), file))])) };
}
export function writeNewJson(file: string, data: unknown) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' });
}
