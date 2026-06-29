import path from 'path';

// Resolved once at process startup so all modules share the same root.
// In production (installed): process.cwd() == app dir (server.js sets it via process.chdir).
// In dev EXE mode: CREATIVE_STUDIO_DATA_ROOT overrides cwd (which points to .next/standalone).
// In dev server (npm run dev): process.cwd() == project root, no override needed.
const _root: string = process.env.CREATIVE_STUDIO_DATA_ROOT
  || path.resolve(/*turbopackIgnore: true*/ process.cwd());

export function dataRoot(): string {
  return _root;
}
