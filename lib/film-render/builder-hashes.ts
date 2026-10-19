import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePackagingDir } from '../media-core/packaging-runtime.ts';
import { sha256 } from './files.ts';
import { FilmRenderError } from './errors.ts';

export const CLASSIC_BUILDERS = ['templates/classic-v1.ts', 'templates/classic-callouts-v1.ts', 'python-format.ts'] as const;
export const OVERLAY_BUILDERS = ['overlay-base.ts', 'overlay-subtitles.ts', '../media-core/packaging-render.ts', '../media-core/packaging-runtime.ts', '../media-core/packaging-vars.ts', '../media-core/cover-title-svg.ts', '../media-core/cover-domain.ts'] as const;

/** Source archives record build provenance; they are not executed at runtime. */
export function builderHashes(files: readonly string[], options: { sourceDir?: string; packagingDir?: string } = {}): Record<string, string> {
  const sourceDir = options.sourceDir ?? path.dirname(fileURLToPath(import.meta.url));
  const packagingDir = options.packagingDir ?? resolvePackagingDir();
  const archive = path.join(packagingDir, 'film-builders');
  return Object.fromEntries(files.map(file => {
    if (![...CLASSIC_BUILDERS, ...OVERLAY_BUILDERS].some(allowed => allowed === file)) {
      throw new FilmRenderError('BUILDER_UNKNOWN', '构建器不在固定清单中', 3);
    }
    const original = path.resolve(sourceDir, file);
    // A deployed runtime must describe its build, even on a developer's machine
    // where import.meta may still resolve to the original source checkout.
    if (!fs.existsSync(archive) && fs.existsSync(original)) return [file, sha256(original)];
    const key = path.posix.normalize(`lib/film-render/${file}`);
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(archive, 'manifest.json'), 'utf8'));
      const actual = sha256(path.join(archive, key));
      if (manifest.schemaVersion !== 1 || manifest.files?.[key] !== actual) {
        throw new Error('SHA256 mismatch');
      }
      return [file, actual];
    } catch (error) {
      throw new FilmRenderError('BUILDER_RESOURCE_INVALID', `随包构建器来源缺失或哈希不符: ${key}: ${String(error)}`, 3);
    }
  }));
}
