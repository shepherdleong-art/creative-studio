// THROWAWAY standalone Next sandbox. It NEVER imports the real layout,
// instrumentation, API routes, .env.local, database or production workers.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = path.join(root, 'outputs', 'prototype-team-ui');
const copies = [
  'app/prototype/team/page.tsx',
  'app/prototype/team/TeamPrototype.tsx',
  'app/prototype/team/prototype.module.css',
  'app/prototype/team/demo-data.ts',
  'components/ui/Icon.tsx',
  'components/ui/TeamPrototypeSwitcher.tsx',
];
for (const file of copies) {
  fs.mkdirSync(path.dirname(path.join(sandbox, file)), { recursive: true });
  fs.copyFileSync(path.join(root, file), path.join(sandbox, file));
}
const globals = fs.readFileSync(path.join(root, 'app/globals.css'), 'utf8');
const tokens = globals.match(/@theme \{([\s\S]*?)\n\}/)[1];
const dark = globals.match(/html\[data-theme=["']dark["']\]\s*\{([\s\S]*?)\n\}/)?.[1] || '';
fs.writeFileSync(path.join(sandbox, 'app/globals.css'), `:root {${tokens}\n} html[data-theme="dark"] {${dark}\n} * { box-sizing:border-box } body { margin:0; font-family:var(--font-sans); }`);
fs.writeFileSync(path.join(sandbox, 'app/layout.tsx'), `import './globals.css';\nexport const metadata = { title: 'Creative Studio · 双端交互原型' };\nexport default function Layout({children}: {children: React.ReactNode}) { return <html lang="zh-CN"><body>{children}</body></html>; }\n`);
fs.writeFileSync(path.join(sandbox, 'app/page.tsx'), `import { redirect } from 'next/navigation'; export default function Page() { redirect('/prototype/team?role=client&variant=A'); }\n`);
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'creative-studio-throwaway-prototype', private: true, type: 'module' }, null, 2));
fs.writeFileSync(path.join(sandbox, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2017', lib: ['dom', 'dom.iterable', 'esnext'], strict: true, skipLibCheck: true, noEmit: true, esModuleInterop: true, module: 'esnext', moduleResolution: 'bundler', jsx: 'react-jsx', isolatedModules: true, resolveJsonModule: true, plugins: [{ name: 'next' }], paths: { '@/*': ['./*'] } }, include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/dev/types/**/*.ts'], exclude: ['node_modules'] }, null, 2));
fs.writeFileSync(path.join(sandbox, 'next.config.mjs'), `export default { outputFileTracingRoot: ${JSON.stringify(root)}, devIndicators: false };\n`);
const port = process.env.PROTOTYPE_TEAM_PORT || '3317';
console.log(`\nTHROWAWAY / MEMORY ONLY\n客户端 http://127.0.0.1:${port}/prototype/team?role=client&variant=A\n管理端 http://127.0.0.1:${port}/prototype/team?role=server&variant=A\n`);
const child = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', sandbox, '--webpack', '--hostname', '127.0.0.1', '--port', port], {
  cwd: sandbox, stdio: 'inherit', windowsHide: true,
  env: { ...process.env, CREATIVE_STUDIO_TEAM_UI_PROTOTYPE: '1', NEXT_TELEMETRY_DISABLED: '1' },
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 0; });
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
