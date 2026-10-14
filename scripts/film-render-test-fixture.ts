import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parsePythonJson, pyJson } from '../lib/film-render/python-format.ts';
import { encodePcmWav } from '../lib/film-render/wav.ts';

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const goldenRoot = path.join(repo, 'scripts/fixtures/film-render/classic-v1');
export function fixtureProject(root: string, name = 'tracking') {
  const dir = path.join(goldenRoot, name);
  fs.mkdirSync(path.join(root, 'variants/01'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(root, 'review'), { recursive: true });
  const timeline = parsePythonJson(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8')) as Record<string, unknown>;
  timeline.voices = [{ file: 'voice.wav', trimStart: 0, trimEnd: 1, atFrame: 24 }];
  timeline.music = 'music.wav';
  fs.writeFileSync(path.join(root, 'variants/01/timeline.json'), pyJson(timeline, false));
  for (const name of ['opening.mp4', 'detail.mp4', 'outro.mp4', 'cover.png']) fs.writeFileSync(path.join(root, 'variants/01', name), 'fixture');
  fs.copyFileSync(path.join(dir, 'style.css'), path.join(root, 'tools/style.css'));
  for (const name of ['packaging.json', 'DESIGN.md']) fs.copyFileSync(path.join(dir, name), path.join(root, name));
  fs.writeFileSync(path.join(root, 'voice.wav'), encodePcmWav(Buffer.alloc(48000 * 2)));
  fs.writeFileSync(path.join(root, 'music.wav'), encodePcmWav(Buffer.alloc(48000 * 2)));
  fs.writeFileSync(path.join(root, 'review/opening-effects.json'), JSON.stringify({ variants: [{
    variant: '01', effectId: 'carton-explosion', shot: 'O01', sourceFile: 'opening.mp4', status: 'visual_approved',
    sha256: createHash('sha256').update('fixture').digest('hex'),
  }] }));
  return timeline;
}
export function treeHash(root: string): string {
  const hash = createHash('sha256');
  function visit(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      hash.update(path.relative(root, file));
      if (entry.isDirectory()) visit(file);
      else hash.update(fs.readFileSync(file));
    }
  }
  visit(root);
  return hash.digest('hex');
}
