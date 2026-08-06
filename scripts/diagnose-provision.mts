import fs from 'node:fs';
import { decryptProvisioningPayload } from '../lib/provisioning/crypto.ts';

const file = process.argv[2] || 'company-profile-2026-08.provision';

async function readHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (text === '') { cleanup(); reject(new Error('已取消')); }
      else if (text === '\r' || text === '\n') { cleanup(); process.stdout.write('\n'); resolve(value); }
      else if (text === '' || text === '\b') { value = value.slice(0, -1); }
      else {
        const printable = Array.from(text).filter((c) => (c.codePointAt(0) || 0) >= 0x20 && c !== '').join('');
        if (value.length + printable.length <= 1024) value += printable;
      }
    };
    const cleanup = () => { process.stdin.off('data', onData); process.stdin.setRawMode?.(false); };
    process.stdin.on('data', onData);
  });
}

const bytes = fs.readFileSync(file);
console.log(`[1/2] 文件读取 OK（${bytes.length} 字节）`);

const password = await readHidden('导入密码（隐藏输入）：');
try {
  decryptProvisioningPayload(bytes, password);
  console.log('[2/2] 解密 + 结构校验 OK');
  console.log('结论：文件和密码都没问题。界面导入失败发生在安装目录落盘阶段（写 config.yaml / 数据库），多半是杀毒软件拦截了 H:\\Creative Studio 下的文件写入。');
} catch {
  console.log('[2/2] 解密失败：密码与文件不匹配（密码输错了，或选的不是当时生成的那份文件，或文件被修改过）。');
  console.log('提示：检查输入法全半角、末尾多空格；确认选的是 company-profile-2026-08.provision 而不是 .local.json。');
}
process.exit(0);
