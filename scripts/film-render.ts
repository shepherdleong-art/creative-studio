import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.CREATIVE_STUDIO_DATA_ROOT ||= repo;
process.env.CREATIVE_STUDIO_PACKAGING_DIR ||= path.join(repo, 'packaging');
const { FilmRenderError } = await import('../lib/film-render/errors.ts');
const { parseRenderSpec, serializeRenderSpec } = await import('../lib/film-render/spec.ts');
const { identifier } = await import('../lib/film-render/validation.ts');
let currentStage = 'input';
const controller = new AbortController();
for (const name of ['SIGINT', 'SIGTERM'] as const) process.once(name, () => controller.abort());

try {
  const { values, positionals: p } = parseArgs({ allowPositionals: true, options: {
    'base-name': { type: 'string' }, out: { type: 'string' }, spec: { type: 'string' },
    'run-id': { type: 'string' }, 'progress-json': { type: 'boolean' }, ssim: { type: 'string' }, sheet: { type: 'string' },
    'music-in': { type: 'string' }, 'cover-frame': { type: 'string' }, 'reference-html': { type: 'string' }, help: { type: 'boolean' },
  } });
  const need = (v: string | undefined, name: string) => { if (!v) throw new FilmRenderError('ARGUMENT_MISSING', `缺少参数 ${name}`); return v; };
  const inputFile = (file: string | undefined, name: string) => {
    const resolved = path.resolve(need(file, name));
    if (!fs.statSync(resolved, { throwIfNoEntry: false })?.isFile()) throw new FilmRenderError('INPUT_MISSING', `输入文件不存在: ${resolved}`);
    return resolved;
  };
  const readSpec = (file: string | undefined) => parseRenderSpec(fs.readFileSync(inputFile(file, 'spec'), 'utf8'));
  const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  let result: unknown;
  if (values.help || !p[0]) {
    console.log('film-render.ts doctor | templates | spec <project> <variant> [--music-in seconds] [--cover-frame frame] [--out file] | render <spec> [--run-id id] [--progress-json] | verify <video> --spec file | compare <new> <old> --spec file [--ssim 0.98] [--reference-html file] | gate <project> <variant>');
  } else if (p[0] === 'doctor') {
    result = await (await import('../lib/film-render/runtime-info.ts')).doctor();
  } else if (p[0] === 'templates') {
    const { classicTemplateDir, verifyClassicAssets } = await import('../lib/film-render/files.ts');
    const { PACKAGING_TEMPLATE_IDS } = await import('../lib/media-core/packaging-vars.ts');
    const { resolvePackagingDir, resolvePackagingTemplateDir } = await import('../lib/media-core/packaging-runtime.ts');
    verifyClassicAssets(); result = [JSON.parse(fs.readFileSync(path.join(classicTemplateDir(), 'template.json'), 'utf8')),
      ...PACKAGING_TEMPLATE_IDS.map((id, index) => {
        fs.accessSync(path.join(resolvePackagingTemplateDir(resolvePackagingDir(), id), 'index.html'));
        return { id, version: '1', code: 'ABCD'[index], staticCover: true, introFrames: 20, fonts: 'template-default' };
      })];
  } else if (p[0] === 'spec') {
    const spec = (await import('../lib/film-render/from-project.ts')).renderSpecFromProject(path.resolve(need(p[1], 'project')), need(p[2], 'variant'),
      { baseName: values['base-name'], musicInSec: values['music-in'] === undefined ? undefined : Number(values['music-in']), coverFrame: values['cover-frame'] === undefined ? undefined : Number(values['cover-frame']),
        onAdjustment: change => console.error(JSON.stringify({ stage: 'spec', adjustment: change })) });
    const text = serializeRenderSpec(spec);
    if (values.out) { fs.writeFileSync(path.resolve(values.out), text, { flag: 'wx' }); result = { ok: true, spec: path.resolve(values.out) }; }
    else process.stdout.write(text);
  } else if (p[0] === 'gate') {
    result = (await import('../lib/film-render/gate.ts')).gateOpening(path.resolve(need(p[1], 'project')), need(p[2], 'variant'));
  } else if (p[0] === 'render') {
    const spec = readSpec(p[1]);
    const id = values['run-id'] ?? `${stamp()}-${createHash('sha256').update(serializeRenderSpec(spec)).digest('hex').slice(0, 8)}`;
    identifier(id, 'run-id');
    result = await (await import('../lib/film-render/render.ts')).renderFilm({ spec,
      runDir: path.join(spec.project.root, 'variants', spec.project.variant, 'renders', id), signal: controller.signal,
      onStage: event => { currentStage = event.stage; if (values['progress-json']) console.log(JSON.stringify(event)); } });
  } else if (p[0] === 'verify' || p[0] === 'compare') {
    const spec = readSpec(values.spec);
    currentStage = p[0];
    const video = inputFile(p[1], 'video');
    const workDir = path.join(spec.project.root, 'variants', spec.project.variant, 'renders', `${p[0]}-${stamp()}-${process.pid}`);
    if (p[0] === 'verify') {
      const cover = video.replace(/\.mp4$/i, '-封面.jpg');
      result = await (await import('../lib/film-render/verify.ts')).verifyFilm({ spec, video, cover, workDir, signal: controller.signal });
    } else {
      result = await (await import('../lib/film-render/compare.ts')).compareFilms({ spec, video, reference: inputFile(p[2], 'reference'),
        workDir, threshold: values.ssim === undefined ? undefined : Number(values.ssim), referenceHtml: values['reference-html'] && path.resolve(values['reference-html']),
        sheet: values.sheet && path.resolve(values.sheet), signal: controller.signal });
    }
    if (!(result as { ok: boolean }).ok) process.exitCode = 4;
  } else throw new FilmRenderError('COMMAND_UNKNOWN', `未知命令 ${p[0]}`);
  if (result !== undefined) console.log(JSON.stringify(result));
} catch (error) {
  const code = error instanceof FilmRenderError ? error.code : (error instanceof Error && 'code' in error ? String(error.code) : 'COMMAND_FAILED');
  console.log(JSON.stringify({ ok: false, stage: currentStage, code, message: error instanceof Error ? error.message : String(error) }));
  process.exitCode = error instanceof FilmRenderError ? error.exitCode : /^(ERR_PARSE_ARGS|ENOENT|EEXIST|ENOTDIR)/.test(code) ? 2 : 4;
}
