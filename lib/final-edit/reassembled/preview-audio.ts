import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { dataRoot } from '../../data-root.ts';
import { stitchNarration } from '../../film-render/audio.ts';
import { readPcmWav, encodePcmWav } from '../../film-render/wav.ts';
import { filmBinding } from './store.ts';
import { projectFile } from '../../film-render/files.ts';
import type { RenderSpec } from '../../film-render/types.ts';

/** Immutable voice inputs are assembled once; the shared player supplies the intro. */
export function filmPreviewAudio(db: Database.Database, groupId: string, music = false): string | null {
  const binding = filmBinding(db, groupId);
  if (!binding) return null;
  const spec = JSON.parse(binding.specJson) as RenderSpec;
  const storageRoot = path.join(dataRoot(), 'storage');
  if (music) return path.relative(storageRoot, projectFile(spec.project.root, spec.audio.music.file));
  const key = createHash('sha256').update(binding.specJson).digest('hex');
  const directory = path.join(storageRoot, 'final-edits', 'film-preview-audio', binding.id);
  const output = path.join(directory, `${key}.wav`);
  if (!fs.existsSync(output)) {
    fs.mkdirSync(directory, { recursive: true });
    const temporary = path.join(directory, `${randomUUID()}.wav`);
    try {
      stitchNarration(spec, temporary);
      const wav = readPcmWav(temporary);
      fs.writeFileSync(output, encodePcmWav(wav.pcm.subarray(20 * 2000 * 2)), { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  return path.relative(storageRoot, output);
}
