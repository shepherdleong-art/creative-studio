// Build first. Optional FILM_PORTABLE_SPEC + FILM_PORTABLE_REFERENCE performs a real local render.
// The child has compiled JS and shipped runtime resources, with a separate empty data root.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { inputHashes } from '../lib/film-render/manifest.ts';
import { builderHashes, CLASSIC_BUILDERS, OVERLAY_BUILDERS } from '../lib/film-render/builder-hashes.ts';
import { parseRenderSpec } from '../lib/film-render/spec.ts';
import { projectFile } from '../lib/film-render/files.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { webpack } = createRequire(import.meta.url)('next/dist/compiled/webpack/webpack');
const shipped = path.join(repo, '.next/standalone');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'film-portable-中文 空格-'));
const app = path.join(root, 'app');
const hasRender = Boolean(process.env.FILM_PORTABLE_SPEC);
try {
  assert.ok(fs.existsSync(path.join(shipped, 'packaging/film-builders/manifest.json')), 'run npm run build first');
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, 'package.json'), '{"type":"module"}\n');
  fs.cpSync(path.join(shipped, 'packaging'), path.join(app, 'packaging'), { recursive: true });
  // Third-party dependencies are the production payload; no application source is linked.
  fs.symlinkSync(path.join(shipped, 'node_modules'), path.join(app, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const compiled = new Set();
  function compile(file) {
    const absolute = path.resolve(file);
    if (compiled.has(absolute)) return;
    compiled.add(absolute);
    const source = fs.readFileSync(absolute, 'utf8');
    const emitted = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    const imports = [...emitted.matchAll(/(?:from\s*|import\s*\(\s*)['"](\.[^'"]+)\.ts['"]/g)];
    for (const match of imports) compile(path.resolve(path.dirname(absolute), match[1] + '.ts'));
    const target = path.join(app, path.relative(repo, absolute).replace(/\.ts$/, '.js'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, emitted.replace(/((?:from\s*|import\s*\(\s*)['"]\.[^'"]+)\.ts(['"])/g, '$1.js$2'));
  }
  for (const entry of ['render', 'compare', 'runtime-info', 'manifest']) compile(path.join(repo, `lib/film-render/${entry}.ts`));
  fs.writeFileSync(path.join(app, 'entry.js'), `
export { renderFilm } from './lib/film-render/render.js';
export { compareFilms } from './lib/film-render/compare.js';
export { doctor } from './lib/film-render/runtime-info.js';
export { classicTemplateDir } from './lib/film-render/files.js';
export { builderHashes, CLASSIC_BUILDERS, OVERLAY_BUILDERS } from './lib/film-render/builder-hashes.js';
`);
  // As in Next, pure JS packages (e.g. fontkit) are bundled; native/media packages
  // resolve from the shipped node_modules. Do not mistake an unbundled import for
  // a missing production dependency.
  await new Promise((resolve, reject) => {
    const compiler = webpack({ mode: 'production', target: 'node', context: app,
      entry: './entry.js', output: { path: app, filename: 'film.cjs', library: { type: 'commonjs2' } },
      resolve: { modules: [path.join(repo, 'node_modules')] },
      externals: { sharp: 'commonjs sharp', 'ffmpeg-static': 'commonjs ffmpeg-static', 'ffprobe-static': 'commonjs ffprobe-static' },
      optimization: { minimize: false },
    });
    compiler.run((error, stats) => compiler.close(closeError => {
      if (error || closeError || stats?.hasErrors()) reject(error || closeError || new Error(stats.toString({ all: false, errors: true })));
      else resolve();
    }));
  });
  fs.rmSync(path.join(app, 'lib'), { recursive: true });
  fs.rmSync(path.join(app, 'entry.js'));
  fs.writeFileSync(path.join(root, 'expected.json'), JSON.stringify({
    classic: builderHashes(CLASSIC_BUILDERS), overlay: builderHashes(OVERLAY_BUILDERS),
  }));
  if (hasRender) {
    assert.ok(process.env.FILM_PORTABLE_REFERENCE, 'provide an existing reference film');
    const spec = parseRenderSpec(JSON.parse(fs.readFileSync(process.env.FILM_PORTABLE_SPEC, 'utf8')));
    const film = path.join(root, 'film');
    fs.mkdirSync(film);
    for (const relative of Object.keys(inputHashes(spec))) {
      assert.ok(!path.isAbsolute(relative) && !relative.split(/[\\/]/).includes('..'), 'fixture inputs must be project-relative');
      const target = path.join(film, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(projectFile(spec.project.root, relative), target);
    }
    spec.project.root = film;
    fs.writeFileSync(path.join(root, 'spec.json'), JSON.stringify(spec));
    fs.copyFileSync(process.env.FILM_PORTABLE_REFERENCE, path.join(root, 'reference.mp4'));
    const composition = spec.template.id === 'classic' ? 'hf/index.html' : 'base/composition.json';
    fs.copyFileSync(path.join(path.dirname(process.env.FILM_PORTABLE_REFERENCE), composition), path.join(root, 'reference-composition'));
  }
  fs.writeFileSync(path.join(app, 'probe.mjs'), `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import film from './film.cjs';
const { doctor, classicTemplateDir, builderHashes, CLASSIC_BUILDERS, OVERLAY_BUILDERS, renderFilm, compareFilms } = film;
const root = path.resolve('..');
assert.equal(fs.existsSync('scripts'), false);
assert.equal(fs.existsSync('lib'), false);
assert.equal(fs.existsSync(path.join(process.env.CREATIVE_STUDIO_DATA_ROOT, 'packaging')), false);
assert.equal(classicTemplateDir(), path.resolve('packaging/templates/classic/1'));
const runtime = await doctor();
const expected = JSON.parse(fs.readFileSync(path.join(root, 'expected.json'), 'utf8'));
assert.deepEqual(builderHashes(CLASSIC_BUILDERS), expected.classic);
assert.deepEqual(builderHashes(OVERLAY_BUILDERS), expected.overlay);
const evidence = { ok: true, compiledModules: true, separateDataRoot: true, runtime, render: null, comparison: null };
if (fs.existsSync(path.join(root, 'spec.json'))) {
  const spec = JSON.parse(fs.readFileSync(path.join(root, 'spec.json'), 'utf8'));
  const result = await renderFilm({ spec, runDir: path.join(spec.project.root, 'variants', spec.project.variant, 'renders/portable'), onStage: event => console.log(JSON.stringify(event)) });
  const comparison = await compareFilms({ spec, video: result.outputs.video, reference: path.join(root, 'reference.mp4'), referenceHtml: path.join(root, 'reference-composition'), workDir: path.join(spec.project.root, 'comparison'), threshold: .99 });
  assert.equal(comparison.ok, true, JSON.stringify(comparison));
  evidence.render = result; evidence.comparison = comparison;
}
const archived = 'packaging/film-builders/lib/film-render/python-format.ts';
fs.appendFileSync(archived, '\\n// changed');
assert.throws(() => builderHashes(CLASSIC_BUILDERS), /哈希不符/);
fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(evidence, null, 2));
console.log('PASS: compiled fixed renderer uses shipped resources and rejects corrupted builder provenance');
`);
  const env = { ...process.env, CREATIVE_STUDIO_DATA_ROOT: path.join(root, 'data') };
  delete env.CREATIVE_STUDIO_PACKAGING_DIR;
  delete env.CREATIVE_STUDIO_PACKAGING_NODE;
  console.log(`Evidence: ${root}`);
  const child = spawnSync(process.execPath, ['probe.mjs'], { cwd: app, env, stdio: 'inherit', timeout: 20 * 60_000 });
  assert.equal(child.status, 0, String(child.error || `signal=${child.signal}`));
  console.log(`PASS: ${compiled.size} compiled modules; ${path.join(root, 'result.json')}`);
} finally {
  if (!hasRender && process.env.FILM_KEEP_TEST_OUTPUT !== '1') fs.rmSync(root, { recursive: true, force: true });
}
