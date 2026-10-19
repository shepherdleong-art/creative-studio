// §9 ① 零弹窗 shim v2：预加载时 patch child_process，强制 windowsHide:true。
// 作用域：package-video.mjs 以 argv `--require` 注入 hyperframes CLI 进程（不走 NODE_OPTIONS：
// Windows 下中文/空格/反斜杠路径会被 Node 解析拆坏，v3.2 §9.6 实测 MODULE_NOT_FOUND），
// 使其内部全部后代（ffmpeg/ffprobe/puppeteer→chrome-headless-shell）不再弹 CMD 窗口。
//
// v2 新增（2026-09-18 CMD 弹窗治理，实锤见窗口枚举日志 _win-log-before*.csv）：
// 1) patch 范围从 spawn/spawnSync/execFile/execFileSync 扩到全家桶（+exec/execSync/fork）：
//    hyperframes probeNvidiaVramMb 用 execSync("nvidia-smi ...")（无 N 卡机器失败不缓存、
//    每次浏览器启动都弹一次）；@puppeteer/browsers Process.kill 用 execSync(taskkill)。
// 2) 对 chrome-headless-shell.exe 强制 detached:false：@puppeteer/browsers launch.js
//    `opts.detached ??= true`（Windows 上同样生效）→ DETACHED_PROCESS → chrome 启动时无控制台，
//    Chromium 随后自行 AllocConsole → 每个 chrome 进程（主/gpu/utility/renderer）都新建
//    **可见**控制台窗（标题=exe 路径，单次渲染 ~20 个）。windowsHide 只影响"创建控制台时"
//    的可见性，管不到事后 AllocConsole；只有让 chrome 继承本进程（已隐藏）的控制台才能根治。
//    本进程 node 以 windowsHide 启动时获得的是隐藏控制台，detached:false 后 chrome 及其
//    子进程全部继承该隐藏控制台（实测隔离实验：子进程不再新建任何控制台）。
// 说明：仅影响当前注入进程树；显式传 false 的调用方也会被提升为 true（弹窗无合规场景）。

'use strict';
if (process.platform === 'win32') {
  const childProcess = require('node:child_process');
  const fs = require('node:fs');
  const path = require('node:path');
  const { PassThrough } = require('node:stream');

  // 部分 Windows ffprobe-static 构建在嵌套匿名管道最后一次写入时挂起。
  // stdout/stderr 先写受控临时文件，退出后回放流；保留真实退出码和上层 deadline。
  // 只作用于包装进程树中的 ffprobe，不更改应用其他媒体调用或第三方依赖源码。
  const probeWithFiles = (original, args, synchronous) => {
    const optionsIndex = Array.isArray(args[1]) ? 2 : 1;
    const options = args[optionsIndex] || {};
    const root = process.env.CREATIVE_STUDIO_PACKAGING_WORK_ROOT || path.join(process.env.CREATIVE_STUDIO_DATA_ROOT || process.cwd(), 'storage', 'packaging', 'renders');
    fs.mkdirSync(root, { recursive: true });
    const dir = fs.mkdtempSync(path.join(root, '.probe-'));
    const files = [path.join(dir, 'stdout'), path.join(dir, 'stderr')];
    const handles = files.map(file => fs.openSync(file, 'w+'));
    const cleanup = () => {
      for (const fd of handles) { try { fs.closeSync(fd); } catch {} }
      fs.rmSync(dir, { recursive: true, force: true });
    };
    const read = index => {
      const size = fs.statSync(files[index]).size;
      if (size > 16 * 1024 * 1024) throw new Error('包装探针输出超过 16MB');
      return fs.readFileSync(files[index]);
    };
    args[optionsIndex] = { ...options, stdio: ['ignore', ...handles] };
    try {
      const result = original.apply(childProcess, args);
      if (synchronous) {
        try {
          const buffers = [read(0), read(1)];
          [result.stdout, result.stderr] = options.encoding && options.encoding !== 'buffer' ? buffers.map(buffer => buffer.toString(options.encoding)) : buffers;
          result.output = [null, result.stdout, result.stderr];
          return result;
        } finally { cleanup(); }
      }
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      result.stdout = stdout; result.stderr = stderr;
      result.stdio[1] = stdout; result.stdio[2] = stderr;
      result.once('exit', () => {
        try { stdout.end(read(0)); stderr.end(read(1)); }
        catch (error) { stderr.end(String(error)); }
      });
      result.once('close', () => { stdout.end(); stderr.end(); cleanup(); });
      return result;
    } catch (error) { cleanup(); throw error; }
  };

  // 判定是否为 chrome-headless-shell 启动命令（ puppeteer 浏览器进程专用）
  const isChromeHeadlessShell = (cmd) =>
    typeof cmd === 'string' && /chrome-headless-shell(\.exe)?$/i.test(cmd.trim().replace(/^"|"$/g, ''));

  // 在 options 上强制隐藏；chrome 额外摘掉 detached（见头注 2）
  const hideOptions = (options, cmd) => {
    const next = { ...options, windowsHide: true };
    if (isChromeHeadlessShell(cmd)) next.detached = false;
    return next;
  };

  // spawn/execFile/fork 形态：args[0]=cmd，其后为 ([数组参数,] options[, callback])；
  // options 参数位置兼容两种形态：数组形态 args[2] 是 options；无数组形态 args[1] 是 options。
  // exec/execSync 形态：args[0]=命令字符串，args[1] 是 options 或 callback。
  const patchArgs = (args) => {
    const cmd = args[0];
    for (let i = 1; i < args.length; i += 1) {
      const a = args[i];
      if (a && typeof a === 'object' && !Array.isArray(a)) {
        args[i] = hideOptions(a, cmd);
        return;
      }
      if (typeof a === 'function') {
        // callback 前没有 options：注入（exec(cmd, cb) / execFile(cmd, cb) 形态）
        args.splice(i, 0, hideOptions({}, cmd));
        return;
      }
    }
    // 没有任何 options：按形态补齐——spawn(cmd)/exec(cmd) 时第二参为 options，
    // spawn(cmd, [...])/execFile(cmd, [...]) 时第三参为 options，统一末尾追加即可
    //（Node 归一化逻辑对「非数组对象即 options」两种形态均兼容）。
    args.push(hideOptions({}, cmd));
  };

  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
    const original = childProcess[name];
    if (typeof original !== 'function' || original.__winHidePatched) continue;
    const wrapped = function (...args) {
      patchArgs(args);
      if ((name === 'spawn' || name === 'spawnSync') && /(?:^|[\\/])ffprobe(?:\.exe)?$/i.test(String(args[0]))) {
        return probeWithFiles(original, args, name === 'spawnSync');
      }
      return original.apply(this, args);
    };
    wrapped.__winHidePatched = true;
    childProcess[name] = wrapped;
  }
}
