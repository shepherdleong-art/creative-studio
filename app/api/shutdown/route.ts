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
    // UI 关闭按钮连同 litellm 代理与隧道一起停止；普通安装包没有该文件，不受影响。
    try {
      const stackFile = path.join(dataRoot(), 'storage', 'run', 'stack.json');
      if (fs.existsSync(stackFile)) {
        const stack = JSON.parse(fs.readFileSync(stackFile, 'utf-8').replace(/^﻿/, '')) as { stopScript?: string };
        if (stack.stopScript && fs.existsSync(stack.stopScript)) {
          spawn(
            'powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', stack.stopScript],
            { detached: true, stdio: 'ignore' }
          ).unref();
        }
      }
    } catch {
      // 联动停止失败不阻塞服务退出
    }
    process.exit(0);
  }, 500);

  return response;
}
