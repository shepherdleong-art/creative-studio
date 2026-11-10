import os from 'node:os';
import path from 'node:path';
import { dataRoot } from '../data-root.ts';

/** Shared fonts survive release updates and do not depend on a Windows login account. */
export function sharedSystemFontRoots(): string[] {
  const shared = path.join(dataRoot(), 'storage', 'fonts');
  if (process.platform === 'darwin') return [shared, '/System/Library/Fonts', '/Library/Fonts', path.join(os.homedir(), 'Library', 'Fonts')];
  if (process.platform === 'win32') return [
    shared,
    path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts'),
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'Windows', 'Fonts'),
  ];
  return [shared, '/usr/share/fonts', '/usr/local/share/fonts', path.join(os.homedir(), '.local', 'share', 'fonts')];
}
