import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { dataRoot } from '../data-root.ts';
import { PackagingError, resolvePackagingDir, resolvePackagingTemplateDir } from './packaging-runtime.ts';
import { isPackagingChromeLog } from './packaging-runtime-files.ts';
import { resolvePackagingStickerAssets } from './packaging-sticker-assets.ts';
import { safeFontFilename, userFontDir } from './packaging-font.ts';
import { assertSupportedPackagingConfigLayoutVersions, type FinalEditPackagingConfig } from './packaging-vars.ts';
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

async function hashFile(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function addFile(files: FileMap, relative: string, absolute: string): void {
  if (!fs.existsSync(absolute)) throw new PackagingError('layout_resource_missing', `自动布局资源缺失：${relative}`, 409);
  files.set(relative.replaceAll(path.sep, '/'), absolute);
}

async function addDirectory(files: FileMap, relativeRoot: string, absoluteRoot: string, skipFile?: (relative: string) => boolean): Promise<void> {
  if (!fs.existsSync(absoluteRoot)) return;
  const visit = async (dir: string): Promise<void> => {
    for (const entry of (await fs.promises.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      const relative = `${relativeRoot}/${path.relative(absoluteRoot, absolute).replaceAll(path.sep, '/')}`;
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && !skipFile?.(relative)) addFile(files, relative, absolute);
    }
  };
  await visit(absoluteRoot);
}

async function manifestFiles(files: FileMap): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [relative, absolute] of [...files.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    result[relative] = await hashFile(absolute);
  }
  return result;
}

async function copySnapshot(source: string, destination: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  // 硬链接共享 inode，原地更新部署资源会悄悄改掉历史任务的冻结文件。
  await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
}

async function publishDirectory(tempDir: string, finalDir: string): Promise<void> {
  const manifestPath = path.join(finalDir, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
    return;
  }
  let lastError: unknown;
  // Windows 在并发发布或安全扫描新文件时可能短暂拒绝目录 rename；只接受完整 manifest，否则有限重试后闭门。
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await fs.promises.rename(tempDir, finalDir);
      return;
    } catch (error) {
      lastError = error;
      if (fs.existsSync(manifestPath)) {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
        return;
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}

function chromeDir(packagingDir: string): string {
  return path.join(packagingDir, 'runtime', 'chrome-headless-shell');
}

type EngineSnapshot = { key: string; engineHash: string; hyperframesVersion: string; sources: FileMap; files: Record<string, string> };
let engineCache: EngineSnapshot | null = null;
function engineIdentity(files: Record<string, string>, platform: string, arch: string): string {
  return createHash('sha256').update(JSON.stringify({ files,
    hyperframesPackage: files['node_modules/hyperframes/package.json'], platform, arch })).digest('hex');
}
async function currentEngine(packagingDir: string): Promise<EngineSnapshot> {
  const files: FileMap = new Map();
  await addDirectory(files, 'chrome-headless-shell', chromeDir(packagingDir), isPackagingChromeLog);
  await addDirectory(files, 'node_modules', path.join(packagingDir, 'node_modules'));
  const identities = [];
  for (const [relative, file] of files) {
    const stat = await fs.promises.stat(file);
    identities.push([relative, file, stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino]);
  }
  const key = JSON.stringify(identities);
  if (engineCache?.key === key) return engineCache;
  const hyperframesPackage = path.join(packagingDir, 'node_modules', 'hyperframes', 'package.json');
  const hyperframesVersion = String(JSON.parse(fs.readFileSync(hyperframesPackage, 'utf8')).version ?? '');
  const digests = await manifestFiles(files);
  const engineHash = engineIdentity(digests, process.platform, process.arch);
  engineCache = { key, engineHash, hyperframesVersion, sources: files, files: digests };
  return engineCache;
}

function engineRoot(): string {
  return path.join(dataRoot(), 'storage', 'packaging', 'layout-engines');
}

function bundleRoot(): string {
  return path.join(dataRoot(), 'storage', 'packaging', 'layout-bundles');
}

const enginesInFlight = new Map<string, Promise<{ engineHash: string; hyperframesVersion: string }>>();
async function materializeEngine(packagingDir: string): Promise<{ engineHash: string; hyperframesVersion: string }> {
  const pending = enginesInFlight.get(packagingDir);
  if (pending) return pending;
  const next = createEngineSnapshot(packagingDir);
  enginesInFlight.set(packagingDir, next);
  try { return await next; }
  finally { if (enginesInFlight.get(packagingDir) === next) enginesInFlight.delete(packagingDir); }
}

async function createEngineSnapshot(packagingDir: string): Promise<{ engineHash: string; hyperframesVersion: string }> {
  const current = await currentEngine(packagingDir);
  const finalDir = path.join(engineRoot(), current.engineHash);
  if (fs.existsSync(path.join(finalDir, 'manifest.json'))) return current;
  const manifest: EngineManifest = {
    schemaVersion: 1,
    engineHash: current.engineHash,
    hyperframesVersion: current.hyperframesVersion,
    platform: process.platform,
    arch: process.arch,
    files: current.files,
  };
  const tempDir = path.join(engineRoot(), `.tmp-${randomUUID()}`);
  await fs.promises.mkdir(tempDir, { recursive: true });
  try {
    for (const [relative, absolute] of current.sources) await copySnapshot(absolute, path.join(tempDir, relative));
    await assertHashes(tempDir, manifest.files, '冻结中的自动布局引擎');
    await fs.promises.writeFile(path.join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    await publishDirectory(tempDir, finalDir);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
  return current;
}

/** 将 v2 布局所需的模板、字体、贴纸与运行时冻结到内容寻址目录；引擎跨布局共享。 */
export async function materializePackagingLayoutBundle(input: {
  config: FinalEditPackagingConfig;
  outputWidth: number;
  outputHeight: number;
}): Promise<{ bundleDir: string; manifest: PackagingLayoutBundleManifest }> {
  const packagingDir = resolvePackagingDir();
  const engine = await materializeEngine(packagingDir);
  const templateDir = resolvePackagingTemplateDir(packagingDir, input.config.template);
  const files: FileMap = new Map();
  await addDirectory(files, `templates/${input.config.template}`, templateDir);
  await addDirectory(files, 'fonts', path.join(packagingDir, 'fonts'));
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
    files: await manifestFiles(files),
  };
  const geometryManifestHash = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  const manifest: PackagingLayoutBundleManifest = { ...identity, schemaVersion: 1, geometryManifestHash };
  const bundleDir = path.join(bundleRoot(), geometryManifestHash);
  if (fs.existsSync(path.join(bundleDir, 'manifest.json'))) {
    await assertHashes(bundleDir, manifest.files, '自动布局冻结资源');
    return { bundleDir, manifest };
  }
  const tempDir = path.join(bundleRoot(), `.tmp-${randomUUID()}`);
  await fs.promises.mkdir(tempDir, { recursive: true });
  try {
    for (const [relative, absolute] of files) await copySnapshot(absolute, path.join(tempDir, relative));
    await assertHashes(tempDir, manifest.files, '冻结中的自动布局资源');
    await fs.promises.writeFile(path.join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    await publishDirectory(tempDir, bundleDir);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
  return { bundleDir, manifest };
}

async function assertHashes(root: string, expected: Record<string, string>, label: string): Promise<void> {
  for (const [relative, sha256] of Object.entries(expected)) {
    if (!relative || relative.includes('..') || path.isAbsolute(relative)) throw new PackagingError('layout_manifest_invalid', `${label}包含非法路径`, 409);
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute) || await hashFile(absolute) !== sha256) {
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

export async function resolveVerifiedPackagingLayoutBundle(resolution: PackagingLayoutResolution): Promise<{ bundleDir: string; manifest: PackagingLayoutBundleManifest }> {
  const { bundleDir, manifest } = readPackagingLayoutBundle(resolution);
  await assertHashes(bundleDir, manifest.files, '自动布局冻结资源');
  const engineDir = path.join(engineRoot(), manifest.engineHash);
  const engineManifestPath = path.join(engineDir, 'manifest.json');
  if (!fs.existsSync(engineManifestPath)) throw new PackagingError('layout_engine_missing', '自动布局引擎已缺失，请重新完成自动布局', 409);
  const engine = JSON.parse(fs.readFileSync(engineManifestPath, 'utf8')) as EngineManifest;
  if (engine.engineHash !== manifest.engineHash || engineIdentity(engine.files, engine.platform, engine.arch) !== manifest.engineHash
    || engine.platform !== process.platform || engine.arch !== process.arch
    || engine.hyperframesVersion !== manifest.hyperframesVersion) {
    throw new PackagingError('layout_engine_mismatch', '自动布局引擎与当前任务不匹配', 409);
  }
  // 旧清单的身份仍用完整清单计算，保留已经保存的布局引用。日志可以在 Chromium 运行后变化或被清理。
  const engineFiles = Object.fromEntries(Object.entries(engine.files).filter(([relative]) => !isPackagingChromeLog(relative)));
  await assertHashes(engineDir, engineFiles, '自动布局引擎');
  return { bundleDir, manifest };
}

/** 单条、批量与发布前共用的 v2 导出门禁；v1 配置保持原路径。 */
export async function assertPackagingLayoutExportReady(
  config: {
    enabled: boolean;
    template: string;
    layoutRuntimeBundleVersion?: number;
    pointCuesLayoutVersion?: number;
    layoutResolution?: PackagingLayoutResolution;
  },
  outputWidth: number,
  outputHeight: number,
): Promise<{ bundleDir: string; manifest: PackagingLayoutBundleManifest } | null> {
  if (!config.enabled) return null;
  assertSupportedPackagingConfigLayoutVersions(config);
  if (config.layoutRuntimeBundleVersion !== 2) return null;
  const resolution = config.layoutResolution;
  if (!resolution || resolution.status !== 'resolved') {
    throw new PackagingError('packaging_layout_stale', '自动布局尚未完成，请先更新布局后再导出', 409);
  }
  if (resolution.runtimeBundleVersion !== 2 || resolution.outputWidth !== outputWidth || resolution.outputHeight !== outputHeight) {
    throw new PackagingError('layout_output_mismatch', '自动布局结果与当前输出画幅不一致，请重新完成自动布局', 409);
  }
  const verified = await resolveVerifiedPackagingLayoutBundle(resolution);
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
