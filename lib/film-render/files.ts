import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolvePackagingDir } from '../media-core/packaging-runtime.ts';
import { FilmRenderError, requireInput } from './errors.ts';

export function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function isInside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function projectFile(root: string, name: string): string {
  requireInput(typeof name === 'string' && name.length > 0 && !name.includes('\0'), 'INVALID_PATH', '输入文件路径不能为空');
  // Do not reinterpret a foreign-platform absolute path as a relative filename.
  requireInput(!(path.win32.isAbsolute(name) && !path.isAbsolute(name)), 'PATH_OUTSIDE_PROJECT', `路径不属于当前工程平台: ${name}`);
  const base = fs.realpathSync(root);
  const target = path.resolve(base, name);
  requireInput(isInside(base, target) || isInside(path.resolve(root), target), 'PATH_OUTSIDE_PROJECT', `路径越出工程: ${name}`);
  requireInput(fs.existsSync(target), 'INPUT_MISSING', `输入文件不存在: ${name}`);
  const real = fs.realpathSync(target);
  requireInput(isInside(base, real), 'PATH_OUTSIDE_PROJECT', `符号链接越出工程: ${name}`);
  requireInput(fs.statSync(real).isFile(), 'INPUT_NOT_FILE', `输入不是普通文件: ${name}`);
  return real;
}

export function classicTemplateDir(): string {
  return path.join(resolvePackagingDir(), 'templates/classic/1');
}

export const CLASSIC_ASSETS = {
  'assets/fonts/SourceHanSansCN-VF.ttf': '25a01e41b5cc99893eb35a6cd2cc7611841dc19eb03cbaf7f0c1de8210f2ba0b',
  'assets/scripts/gsap.min.js': 'c174bfce53a729418d57a8ad8625e7247c793a22fef8e2851e3cfa3de9cd8280',
} as const;

export function verifyClassicAssets(directory = classicTemplateDir()): void {
  const manifestPath = path.join(directory, 'template.json');
  if (!fs.existsSync(manifestPath)) throw new FilmRenderError('TEMPLATE_MISSING', `缺少模板: ${manifestPath}`, 3);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.id !== 'classic' || manifest.version !== '1' ||
      JSON.stringify(manifest.assets) !== JSON.stringify(CLASSIC_ASSETS)) {
    throw new FilmRenderError('TEMPLATE_IDENTITY', 'classic/1 模板身份或资源清单与冻结版本不符', 3);
  }
  for (const [name, expected] of Object.entries(CLASSIC_ASSETS)) {
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) throw new FilmRenderError('ASSET_MISSING', `缺少模板资源: ${file}`, 3);
    if (sha256(file) !== expected) throw new FilmRenderError('ASSET_HASH_MISMATCH', `模板资源 SHA256 不符: ${file}`, 3);
  }
}

/** Reserve exclusively; never allow an existing directory or a symlink out of the project. */
export function createOutputDirectory(root: string, output: string): string {
  const base = fs.realpathSync(root);
  let target = path.resolve(output);
  let ancestor = path.dirname(target);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const real = fs.realpathSync(ancestor);
  requireInput(real === base || isInside(base, real), 'PATH_OUTSIDE_PROJECT', '输出目录经符号链接越出工程');
  target = path.resolve(real, path.relative(ancestor, target));
  requireInput(isInside(base, target), 'PATH_OUTSIDE_PROJECT', `输出目录越出工程: ${output}`);
  requireInput(!fs.existsSync(target), 'OUTPUT_EXISTS', `输出目录已存在: ${target}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(target); // No recursive flag: a concurrent reservation must fail.
  return target;
}
