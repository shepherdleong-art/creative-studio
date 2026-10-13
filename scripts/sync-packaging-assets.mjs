import fs from 'node:fs';
import path from 'node:path';

/** Copy only shipped packaging resources; never copy render scratch or uploaded fonts. */
export function syncPackagingAssets(root, standaloneDir) {
  const source = path.join(root, 'packaging');
  const target = path.join(standaloneDir, 'packaging');
  if (!path.resolve(target).startsWith(path.resolve(standaloneDir) + path.sep)) throw new Error('Unsafe packaging target');
  fs.rmSync(target, { recursive: true, force: true });
  const allowed = ['package.json', 'package-lock.json', 'package-video.mjs', 'win-hide-spawn.cjs', 'templates', 'fonts', 'node_modules', 'runtime'];
  for (const entry of allowed) {
    const from = path.join(source, entry);
    if (!fs.existsSync(from)) throw new Error(`包装运行资源缺失：${entry}，请先运行 npm run setup:packaging`);
    fs.cpSync(from, path.join(target, entry), { recursive: true, filter: file => {
      const rel = path.relative(source, file).replaceAll('\\', '/');
      return rel !== 'fonts/user' && !rel.split('/').some(part => part === '.cache' || part.startsWith('.env') || part.startsWith('config.yaml'));
    } });
  }
  for (const forbidden of ['fonts/user', 'renders', '.font-scan-cache.json']) {
    if (fs.existsSync(path.join(target, forbidden))) throw new Error(`包装负载含用户数据：${forbidden}`);
  }
}
