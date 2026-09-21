import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { validatePresets } from './import-motion-template-presets.mjs';

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
export function exportPresets(sourceRoot, outputRoot) {
  const source = new Database(path.join(path.resolve(sourceRoot), 'data/workbench.db'), { readonly: true, fileMustExist: true });
  let templates;
  try {
    templates = source.prepare(`SELECT id, name, COALESCE(description, '') AS description, prompt, inRandomPool
      FROM video_prompt_templates WHERE isBuiltin = 0 ORDER BY createdAt, id`).all();
  } finally { source.close(); }
  const bundle = { schemaVersion: 1, kind: 'creative-studio-motion-templates', templates };
  validatePresets(bundle);
  const files = new Map([
    ['motion-template-presets.json', Buffer.from(JSON.stringify(bundle, null, 2) + '\n')],
    ['scripts/import-motion-template-presets.mjs', fs.readFileSync(path.join(scriptRoot, 'import-motion-template-presets.mjs'))],
    ['导入自定义运镜模板.cmd', fs.readFileSync(path.join(scriptRoot, '../installer/windows/导入自定义运镜模板.cmd'))],
    ['自定义运镜模板说明.txt', Buffer.from([
      '自定义运镜模板补充包（适用创意工作台 0.6.2 Windows 免安装版）',
      '',
      `本包包含 ${templates.length} 条：${templates.map(row => row.name).join('、')}。`,
      '1. 退出工作台。将补充包全部内容解压到工作台目录，与 start-windows.cmd 放在同一层。',
      '2. 双击「导入自定义运镜模板.cmd」，完成后重新打开工作台，在「设置 → 运镜模板」查看。',
      '首次使用全新目录：请先启动工作台一次，再退出并导入。需要迁移旧版数据时，应先完成迁移再导入。',
      '',
      '只新增缺少的自定义模板，保留原有项目、供应商设置、同名模板及随机池选择。',
      '重复导入不重复添加；同名或已修改的模板会提示跳过，请查看命令窗口的结果。',
      '每次导入前自动备份到 data/backups/motion-template-import。',
      '模板保留作者的随机池设置；如未参与一键随机填充，可在设置中按需加入。',
      '本包只含自定义运镜模板，不含作者数据库、密钥、项目及脚本知识库。',
      '',
    ].join('\r\n'))],
  ]);
  for (const name of files.keys()) {
    if (fs.existsSync(path.join(outputRoot, name))) throw new Error(`目标文件已存在，拒绝覆盖：${name}`);
  }
  for (const [name, content] of files) {
    const destination = path.join(outputRoot, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content, { flag: 'wx' });
  }
  return { count: templates.length, files: [...files.keys()] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const argument = key => {
      const index = process.argv.indexOf(key);
      if (index < 0 || !process.argv[index + 1]) throw new Error(`缺少 ${key}`);
      return path.resolve(process.argv[index + 1]);
    };
    const result = exportPresets(argument('--source-root'), argument('--output'));
    console.log(`已导出 ${result.count} 条自定义运镜模板；未复制数据库或供应商设置。`);
  } catch (error) {
    console.error(`导出失败：${error.message}`);
    process.exitCode = 1;
  }
}
