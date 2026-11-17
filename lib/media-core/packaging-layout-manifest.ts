import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { dataRoot } from '../data-root.ts';
import { PackagingError, resolvePackagingDir, resolvePackagingTemplateDir } from './packaging-runtime.ts';
import { resolvePackagingStickerAssets } from './packaging-sticker-assets.ts';
import { safeFontFilename, userFontDir } from './packaging-font.ts';
import type { FinalEditPackagingConfig } from './packaging-vars.ts';
import type { PackagingLayoutResolution } from './packaging-auto-layout.ts';

type FileMap = Map<string, string>;

export interface PackagingLayoutBundleManifest {
  schemaVersion: 1;
  geometryManifestHash: string;
  runtimeBundleVersion: number;
  template: string;
  outputWidth: number;
  outputHeight: number;
  engineHash: string;
  hyperframesVersion: string;
  files: Record<string, string>;
}

interface EngineManifest {
  schemaVersion: 1;
  engineHash: string;
  hyperframesVersion: string;
  platform: string;
  arch: string;
  files: Record<string, string>;
}

function hashFile(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function addFile(files: FileMap, relative: string, absolute: string): void {
  if (!fs.existsSync(absolute)) throw new PackagingError('layout_resource_missing', `自动布局资源缺失：${relative}`, 409);
  files.set(relative.replaceAll(path.sep, '/'), absolute);
}

function addDirectory(files: FileMap, relativeRoot: string, absoluteRoot: string): void {
  if (!fs.existsSync(absoluteRoot)) return;
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      const relative = `${relativeRoot}/${path.relative(absoluteRoot, absolute)}`;
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) addFile(files, relative, absolute);
    }
  };
  visit(absoluteRoot);
}

function manifestFiles(files: FileMap): Record<string, string> {
  return Object.fromEntries([...files.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([relative, absolute]) => [relative, hashFile(absolute)]));
}

function copySnapshot(source: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  // 硬链接共享 inode，原地更新部署资源会悄悄改掉历史任务的冻结文件。
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
}

function publishDirectory(tempDir: string, finalDir: string): void {
  const manifestPath = path.join(finalDir, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    return;
  }
  const wait = new Int32Array(new SharedArrayBuffer(4));
  let lastError: unknown;
  // Windows 在并发发布或安全扫描新文件时可能短暂拒绝目录 rename；只接受完整 manifest，否则有限重试后闭门。
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      fs.renameSync(tempDir, finalDir);
      return;
    } catch (error) {
      lastError = error;
      if (fs.existsSync(manifestPath)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
        return;
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
      Atomics.wait(wait, 0, 0, 50);
    }
  }
  throw lastError;
}

function chromeDir(packagingDir: string): string {
  return path.join(packagingDir, 'runtime', 'chrome-headless-shell');
}

let engineCache: { key: string; engineHash: string; hyperframesVersion: string } | null = null;
function currentEngine(packagingDir: string): { engineHash: string; hyperframesVersion: string } {
  const files: FileMap = new Map();
  addDirectory(files, 'chrome-headless-shell', chromeDir(packagingDir));
  addDirectory(files, 'node_modules', path.join(packagingDir, 'node_modules'));
  const key = JSON.stringify([...files].map(([relative, file]) => {
    const stat = fs.statSync(file);
    return [relative, file, stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino];
  }));
  if (engineCache?.key === key) return engineCache;
  const hyperframesPackage = path.join(packagingDir, 'node_modules', 'hyperframes', 'package.json');
  const hyperframesVersion = String(JSON.parse(fs.readFileSync(hyperframesPackage, 'utf8')).version ?? '');
  const engineHash = createHash('sha256').update(JSON.stringify({
    files: manifestFiles(files),
    hyperframesPackage: hashFile(hyperframesPackage),
    platform: process.platform,
    arch: process.arch,
  })).digest('hex');
  engineCache = { key, engineHash, hyperframesVersion };
  return engineCache;
}

function engineRoot(): string {
  return path.join(dataRoot(), 'storage', 'packaging', 'layout-engines');
}

function bundleRoot(): string {
  return path.join(dataRoot(), 'storage', 'packaging', 'layout-bundles');
}

function materializeEngine(packagingDir: string): { engineHash: string; hyperframesVersion: string } {
  const current = currentEngine(packagingDir);
  const finalDir = path.join(engineRoot(), current.engineHash);
  if (fs.existsSync(path.join(finalDir, 'manifest.json'))) return current;
  const files: FileMap = new Map();
  addDirectory(files, 'chrome-headless-shell', chromeDir(packagingDir));
  addDirectory(files, 'node_modules', path.join(packagingDir, 'node_modules'));
  const manifest: EngineManifest = {
    schemaVersion: 1,
    engineHash: current.engineHash,
    hyperframesVersion: current.hyperframesVersion,
    platform: process.platform,
    arch: process.arch,
    files: manifestFiles(files),
  };
  const tempDir = path.join(engineRoot(), `.tmp-${randomUUID()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  try {
    for (const [relative, absolute] of files) copySnapshot(absolute, path.join(tempDir, relative));
    assertHashes(tempDir, manifest.files, '冻结中的自动布局引擎');
    fs.writeFileSync(path.join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    publishDirectory(tempDir, finalDir);
  } finally {
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  }
  return current;
}

/** 将 v2 布局所需的模板、字体、贴纸与运行时冻结到内容寻址目录；引擎跨布局共享。 */
export function materializePackagingLayoutBundle(input: {
  config: FinalEditPackagingConfig;
  outputWidth: number;
  outputHeight: number;
}): { bundleDir: string; manifest: PackagingLayoutBundleManifest } {
  const packagingDir = resolvePackagingDir();
  const engine = materializeEngine(packagingDir);
  const templateDir = resolvePackagingTemplateDir(packagingDir, input.config.template);
  const files: FileMap = new Map();
  addDirectory(files, `templates/${input.config.template}`, templateDir);
  addDirectory(files, 'fonts', path.join(packagingDir, 'fonts'));
  addFile(files, 'stickers/runtime.js', path.join(packagingDir, 'stickers', 'runtime.js'));
  addFile(files, 'stickers/catalog.json', path.join(packagingDir, 'stickers', 'catalog.json'));
  addFile(files, 'auto-layout/runtime.js', path.join(packagingDir, 'auto-layout', 'runtime.js'));
  addFile(files, 'auto-layout/replay.js', path.join(packagingDir, 'auto-layout', 'replay.js'));
  addFile(files, 'layout-service.mjs', path.join(packagingDir, 'layout-service.mjs'));
  addFile(files, 'package-video.mjs', path.join(packagingDir, 'package-video.mjs'));
  addFile(files, 'win-hide-spawn.cjs', path.join(packagingDir, 'win-hide-spawn.cjs'));
  const stickerAssets = resolvePackagingStickerAssets({ packagingDir, template: input.config.template, stickers: input.config.stickers });
  for (const asset of Object.values(stickerAssets)) addFile(files, `stickers/${asset.file}`, path.join(packagingDir, 'stickers', asset.file));
  for (const slot of [input.config.titleFont, input.config.subtitleFont, input.config.pointFont]) {
    if (!slot) continue;
    const file = safeFontFilename(slot.file);
    if (!file) throw new PackagingError('layout_font_missing', `自动布局字体无效：${slot.family}`, 409);
    addFile(files, `user-fonts/${file}`, path.join(userFontDir(), file));
  }
  const hyperframesPackage = path.join(packagingDir, 'node_modules', 'hyperframes', 'package.json');
  const identity = {
    schemaVersion: 1,
    runtimeBundleVersion: input.config.layoutRuntimeBundleVersion ?? 2,
    template: input.config.template,
    outputWidth: input.outputWidth,
    outputHeight: input.outputHeight,
    engineHash: engine.engineHash,
    hyperframesVersion: JSON.parse(fs.readFileSync(hyperframesPackage, 'utf8')).version,
    files: manifestFiles(files),
  };
  const geometryManifestHash = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const manifest: PackagingLayoutBundleManifest = { ...identity, schemaVersion: 1, geometryManifestHash };
  const bundleDir = path.join(bundleRoot(), geometryManifestHash);
  if (fs.existsSync(path.join(bundleDir, 'manifest.json'))) {
    assertHashes(bundleDir, manifest.files, '自动布局冻结资源');
    return { bundleDir, manifest };
  }
  const tempDir = path.join(bundleRoot(), `.tmp-${randomUUID()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  try {
    for (const [relative, absolute] of files) copySnapshot(absolute, path.join(tempDir, relative));
    assertHashes(tempDir, manifest.files, '冻结中的自动布局资源');
    fs.writeFileSync(path.join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    publishDirectory(tempDir, bundleDir);
  } finally {
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  }
  return { bundleDir, manifest };
}

function assertHashes(root: string, expected: Record<string, string>, label: string): void {
  for (const [relative, sha256] of Object.entries(expected)) {
    if (!relative || relative.includes('..') || path.isAbsolute(relative)) throw new PackagingError('layout_manifest_invalid', `${label}包含非法路径`, 409);
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute) || hashFile(absolute) !== sha256) {
      throw new PackagingError('layout_resource_mismatch', `${label}已变化或缺失：${relative}，请重新完成自动布局`, 409);
    }
  }
}

export function readPackagingLayoutBundle(resolution: PackagingLayoutResolution): { bundleDir: string; manifest: PackagingLayoutBundleManifest } {
  if (!/^[a-f0-9]{64}$/.test(resolution.geometryManifestHash)) throw new PackagingError('layout_manifest_invalid', '自动布局资源标识无效', 409);
  const bundleDir = path.join(bundleRoot(), resolution.geometryManifestHash);
  const manifestPath = path.join(bundleDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new PackagingError('layout_bundle_missing', '自动布局冻结资源不存在，请重新完成自动布局', 409);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PackagingLayoutBundleManifest;
  if (manifest.schemaVersion !== 1 || manifest.geometryManifestHash !== resolution.geometryManifestHash
    || manifest.runtimeBundleVersion !== resolution.runtimeBundleVersion
    || manifest.outputWidth !== resolution.outputWidth || manifest.outputHeight !== resolution.outputHeight
    || !/^[a-f0-9]{64}$/.test(manifest.engineHash)) {
    throw new PackagingError('layout_bundle_mismatch', '自动布局资源清单与解析结果不一致，请重新完成自动布局', 409);
  }
  const { geometryManifestHash, ...identity } = manifest;
  if (createHash('sha256').update(JSON.stringify(identity)).digest('hex') !== geometryManifestHash) {
    throw new PackagingError('layout_manifest_invalid', '自动布局资源清单已变化', 409);
  }
  return { bundleDir, manifest };
}

export function resolveVerifiedPackagingLayoutBundle(resolution: PackagingLayoutResolution): { bundleDir: string; manifest: PackagingLayoutBundleManifest } {
  const { bundleDir, manifest } = readPackagingLayoutBundle(resolution);
  assertHashes(bundleDir, manifest.files, '自动布局冻结资源');
  const engineDir = path.join(engineRoot(), manifest.engineHash);
  const engineManifestPath = path.join(engineDir, 'manifest.json');
  if (!fs.existsSync(engineManifestPath)) throw new PackagingError('layout_engine_missing', '自动布局引擎已缺失，请重新完成自动布局', 409);
  const engine = JSON.parse(fs.readFileSync(engineManifestPath, 'utf8')) as EngineManifest;
  if (engine.engineHash !== manifest.engineHash || engine.platform !== process.platform || engine.arch !== process.arch
    || engine.hyperframesVersion !== manifest.hyperframesVersion) {
    throw new PackagingError('layout_engine_mismatch', '自动布局引擎与当前任务不匹配', 409);
  }
  assertHashes(engineDir, engine.files, '自动布局引擎');
  return { bundleDir, manifest };
}

/** 单条、批量与发布前共用的 v2 导出门禁；v1 配置保持原路径。 */
export function assertPackagingLayoutExportReady(
  config: {
    enabled: boolean;
    template: string;
    layoutRuntimeBundleVersion?: number;
    layoutResolution?: PackagingLayoutResolution;
  },
  outputWidth: number,
  outputHeight: number,
): { bundleDir: string; manifest: PackagingLayoutBundleManifest } | null {
  if (!config.enabled || config.layoutRuntimeBundleVersion !== 2) return null;
  const resolution = config.layoutResolution;
  if (!resolution || resolution.status !== 'resolved') {
    throw new PackagingError('packaging_layout_stale', '自动布局尚未完成，请先更新布局后再导出', 409);
  }
  if (resolution.runtimeBundleVersion !== 2 || resolution.outputWidth !== outputWidth || resolution.outputHeight !== outputHeight) {
    throw new PackagingError('layout_output_mismatch', '自动布局结果与当前输出画幅不一致，请重新完成自动布局', 409);
  }
  const verified = resolveVerifiedPackagingLayoutBundle(resolution);
  if (verified.manifest.template !== config.template) {
    throw new PackagingError('layout_template_mismatch', '自动布局结果与当前模板不一致，请重新完成自动布局', 409);
  }
  return verified;
}

export function packagingLayoutEngineExecutable(manifest: PackagingLayoutBundleManifest): string {
  return path.join(engineRoot(), manifest.engineHash, 'chrome-headless-shell', process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell');
}

export function packagingLayoutDependenciesRoot(manifest: PackagingLayoutBundleManifest): string {
  return path.join(engineRoot(), manifest.engineHash);
}
