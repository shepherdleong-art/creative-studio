import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Callout, ClassicComposition, Shot, Subtitle } from '../lib/film-render/types.ts';
import { parsePythonJson, pyFixed, pyFloat, pyJson, pyNumber, roundEven } from '../lib/film-render/python-format.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.CREATIVE_STUDIO_PACKAGING_DIR = path.join(repo, 'packaging');
const { buildClassic, classicDocuments } = await import('../lib/film-render/templates/classic-v1.ts');
const { verifyClassicAssets } = await import('../lib/film-render/files.ts');
const fixtures = path.join(repo, 'scripts/fixtures/film-render/classic-v1');

for (const row of JSON.parse(fs.readFileSync(path.join(fixtures, 'numbers.json'), 'utf8'))) {
  assert.equal(pyFloat(row.value), row.repr);
  assert.equal(pyFixed(row.value, 6), row.fixed);
  assert.equal(roundEven(row.value), row.rounded);
}
assert.equal(pyFixed(.0078125, 6), '0.007812');
assert.equal(pyJson(parsePythonJson('{"x": 430.0, "y": "你好😀"}')), '{"x": 430.0, "y": "\\u4f60\\u597d\\ud83d\\ude00"}');
verifyClassicAssets();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-classic-'));
try {
  for (const name of ['legacy', 'static', 'tracking', 'fractional', 'float-coordinates']) {
    const dir = path.join(fixtures, name);
    const timeline = parsePythonJson(fs.readFileSync(path.join(dir, 'timeline.json'), 'utf8')) as {
      width: 1080; height: 1440; fps: 24; introFrames: 20; frames: number; duration: number;
      shots: Shot[]; subtitles: Subtitle[]; callouts?: Callout[]; title: [string, string];
      endtitle: [string, string]; tag: string; theme: string;
    };
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'packaging.json'), 'utf8'));
    const spec: ClassicComposition = {
      project: { root, variant: '01', baseName: 'fixture' },
      canvas: { width: 1080, height: 1440, fps: 24, introFrames: 20, frames: timeline.frames },
      shots: timeline.shots, subtitles: timeline.subtitles,
      classic: {
        projectCss: 'style.css', designDoc: 'DESIGN.md', theme: timeline.theme,
        durationText: pyNumber(timeline.duration, timeline, 'duration'),
        cover: { image: 'cover.png', title: timeline.title, tag: timeline.tag,
          note: config.variants['01'].coverNote, brand: config.brand, model: config.model, productName: config.productName },
        labels: config.variants['01'].labels, callouts: timeline.callouts ?? [], outro: { title: timeline.endtitle },
      },
    };
    const css = fs.readFileSync(path.join(dir, 'style.css'), 'utf8');
    const docs = classicDocuments(spec, css);
    for (const [file, content] of Object.entries(docs)) assert.equal(content, fs.readFileSync(path.join(dir, file), 'utf8'), `${name}/${file}`);
    fs.copyFileSync(path.join(dir, 'style.css'), path.join(root, 'style.css'));
    fs.copyFileSync(path.join(dir, 'DESIGN.md'), path.join(root, 'DESIGN.md'));
    fs.writeFileSync(path.join(root, 'cover.png'), 'fixture');
    const output = path.join(root, name);
    buildClassic(spec, output);
    for (const file of Object.keys(docs)) assert.deepEqual(fs.readFileSync(path.join(output, file)), fs.readFileSync(path.join(dir, file)));
    assert.throws(() => buildClassic(spec, output), /已存在/);
    assert.throws(() => buildClassic(spec, path.join(root, '..', 'outside')), /越出工程/);
    console.log(`classic/1 ${name}: HTML, meta and config match Python byte-for-byte`);
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log('film-render classic tests passed');
