import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { dataRoot } from '@/lib/data-root';

export async function POST() {
  // Send response first, then exit so the client gets a clean reply
  const response = NextResponse.json({ message: '服务正在关闭...' });

  // Delay exit slightly to let the response flush
  setTimeout(() => {
    // 若当前是由一键联动脚本启动的（存在 storage/run/stack.json），
    // UI 关闭按钮连同 litellm 代理一起停止；普通安装包没有该文件，不受影响。
    try {
      const stackFile = path.join(dataRoot(), 'storage', 'run', 'stack.json');
      if (fs.existsSync(stackFile)) {
        const stack = JSON.parse(fs.readFileSync(stackFile, 'utf-8').replace(/^﻿/, '')) as { stopScript?: string };
        // 状态文件跟随 dataRoot；源码启动脚本则仍位于项目 cwd 下。
        // 两个目录都必须是精确受控目录，不能执行状态文件给出的任意路径。
        const controlledScriptsDirs = new Set([
          path.resolve(process.cwd(), 'scripts'),
          path.resolve(dataRoot(), 'scripts'),
        ]);
        const stopScript = typeof stack.stopScript === 'string' ? path.resolve(stack.stopScript) : '';
        const stopScriptName = path.basename(stopScript);
        const isControlledStopScript = controlledScriptsDirs.has(path.dirname(stopScript))
          && (stopScriptName === 'stop-stack.ps1' || stopScriptName === 'stop-litellm.sh');
        if (isControlledStopScript && fs.existsSync(stopScript)) {
          if (process.platform === 'win32' && stopScriptName === 'stop-stack.ps1') {
            spawn(
              'powershell.exe',
              ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', stopScript],
              { detached: true, stdio: 'ignore' }
            ).unref();
          } else if (process.platform !== 'win32' && stopScriptName === 'stop-litellm.sh') {
            spawn('/bin/bash', [stopScript], { detached: true, stdio: 'ignore' }).unref();
          }
        }
      }
    } catch {
      // 联动停止失败不阻塞服务退出
    }
    process.exit(0);
  }, 500);

  return response;
}
