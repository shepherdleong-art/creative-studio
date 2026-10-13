// 端到端视频包装管线（创意工作台 0.5.2 · Phase 1）
// 用法（应用根目录）：
//   node-runtime\node.exe packaging\package-video.mjs <rough_cut.mp4> [vars.json] [输出.mp4] [模板目录]
// 示例：
//   node-runtime\node.exe packaging\package-video.mjs storage\final-edits\jobs\<id>\final.mp4
//
// 流程：ffprobe 探针 → 复制模板并注入真实规格(宽/高/fps/时长) → HyperFrames 渲染透明层
//       → ffmpeg(libvpx 解码 alpha) 叠加 → 成片
// 全部使用应用内置组件，零网络依赖。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, "..");

const require = createRequire(import.meta.url);
require('./win-hide-spawn.cjs');
const { spawnSync } = require('node:child_process');
const FFMPEG = process.env.CREATIVE_STUDIO_FFMPEG || require('ffmpeg-static');
const FFPROBE = process.env.CREATIVE_STUDIO_FFPROBE || require('ffprobe-static').path;
const CHROME = process.env.HYPERFRAMES_BROWSER_PATH || path.join(__dirname, "runtime/chrome-headless-shell", process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell');
const CLI = path.join(__dirname, "node_modules/hyperframes/bin/hyperframes.mjs");
for (const file of [FFMPEG, FFPROBE, CHROME, CLI]) {
  if (!file || !fs.existsSync(file)) throw new Error(`包装运行组件缺失：${file}，请重新安装包装运行时`);
}

const roughCut = process.argv[2];
if (!roughCut) {
  console.error("用法: node packaging\\package-video.mjs <rough_cut.mp4> [vars.json] [输出.mp4] [模板目录]");
  process.exit(1);
}
const roughAbs = path.resolve(roughCut);
// 参数：[2]=rough_cut [3]=vars.json [4]=输出.mp4 [5]=模板目录
const tplAbs = process.argv[5]
  ? path.resolve(process.argv[5])
  : path.join(__dirname, "templates/overlay-basic");
const varsAbs = process.argv[3]
  ? path.resolve(process.argv[3])
  : path.join(tplAbs, "vars.json");
const outputAbs = process.argv[4]
  ? path.resolve(process.argv[4])
  : path.join(__dirname, "renders", `${path.basename(roughAbs, ".mp4")}-packaged.mp4`);

const run = (cmd, args, opts = {}) => {
  const { retries = 0, retryOn, ...spawnOptions } = opts;
  // §8 ⑥：windowsHide 防止包装渲染阶段弹出 CMD 窗口
  for (let attempt = 0; ; attempt++) {
    const r = spawnSync(cmd, args, { encoding: "utf-8", windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: 16 * 1024 * 1024, ...spawnOptions });
    if (r.status === 0) return r.stdout;
    const diagnostic = `${r.error?.code || ''}\n${r.stderr || r.stdout || ''}`;
    if (attempt < retries && retryOn?.test(diagnostic)) {
      console.log('媒体探针暂时超时，重新校验一次…');
      continue;
    }
    throw new Error(`命令失败: ${path.basename(cmd)}\n${diagnostic}`);
  }
};

// 1) 探针
console.log(`[1/4] 探针: ${roughAbs}`);
const probeJson = run(FFPROBE, [
  "-v", "error", "-select_streams", "v:0",
  "-show_entries", "stream=width,height,r_frame_rate,duration",
  "-of", "json", roughAbs,
], { timeout: 15_000, retries: 1, retryOn: /ETIMEDOUT/ });
const st = JSON.parse(probeJson).streams[0];
const [fpsNum, fpsDen] = st.r_frame_rate.split("/").map(Number);
const spec = {
  width: st.width,
  height: st.height,
  fps: Math.round(fpsNum / fpsDen),
  duration: Number(st.duration).toFixed(3),
};
console.log(`      规格: ${spec.width}x${spec.height} @${spec.fps}fps, ${spec.duration}s`);

// 2) 复制模板（整个模板目录，含 gsap/字体等资产）+ 注入真实规格
// 注：本机 node-runtime v22.22.3 的 fs.cpSync 在 Windows 中文长路径下会原生崩溃
//（0xC0000005，2026-09-01 实测），故用手写递归复制（readdir+mkdir+copyFile 均验证可用）。
const copyDir = (src, dst) => {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
};
const workDir = path.join(process.env.CREATIVE_STUDIO_PACKAGING_WORK_ROOT || path.join(process.env.CREATIVE_STUDIO_DATA_ROOT || APP_ROOT, 'storage/packaging/renders'), `_work_${randomUUID()}`);
fs.mkdirSync(workDir, { recursive: true });
try {
copyDir(tplAbs, workDir);
// 共享字体目录（模板 @font-face 引用 fonts/...，单源分发，避免每个模板重复携带）
const sharedFonts = path.join(__dirname, "fonts");
if (fs.existsSync(sharedFonts)) copyDir(sharedFonts, path.join(workDir, "fonts"));
// §10 ②：三槽字体注入（内容寻址）——vars 提供 titleFontFile/subtitleFontFile/pointFontFile（纯文件名）
// 时按别名 UserTitle/UserSubtitle/UserPoint 注入 @font-face；文件不存在静默跳过（模板回退原生字体）。
// 不提供任何槽 = 未选字体 → 不注入（「模板原生字体」语义），无 legacy 回退。
const FONT_FORMAT = { ".ttf": "truetype", ".otf": "opentype", ".woff2": "woff2", ".ttc": "truetype" };
const userFontDir = path.join(workDir, "fonts", "user");
if (process.env.CREATIVE_STUDIO_PACKAGING_USER_FONTS && fs.existsSync(process.env.CREATIVE_STUDIO_PACKAGING_USER_FONTS)) copyDir(process.env.CREATIVE_STUDIO_PACKAGING_USER_FONTS, userFontDir);
let userFontFace = "";
{
  let slots = [
    ["UserTitle", null],
    ["UserSubtitle", null],
    ["UserPoint", null],
  ];
  try {
    if (varsAbs && fs.existsSync(varsAbs)) {
      const varsJson = JSON.parse(fs.readFileSync(varsAbs, "utf-8"));
      slots = [
        ["UserTitle", typeof varsJson.titleFontFile === "string" ? varsJson.titleFontFile : null],
        ["UserSubtitle", typeof varsJson.subtitleFontFile === "string" ? varsJson.subtitleFontFile : null],
        ["UserPoint", typeof varsJson.pointFontFile === "string" ? varsJson.pointFontFile : null],
      ];
    }
  } catch { /* vars 不可读则不注入 */ }
  for (const [alias, file] of slots) {
    if (!file || !/^[A-Za-z0-9._-]{1,120}$/.test(file)) continue;
    const ext = path.extname(file).toLowerCase();
    if (!FONT_FORMAT[ext]) continue;
    if (!fs.existsSync(path.join(userFontDir, file))) continue;
    userFontFace += `<style>@font-face{font-family:"${alias}";src:url("fonts/user/${file}") format("${FONT_FORMAT[ext]}");font-weight:100 900;}</style>`;
  }
}
// §11 ① v2：封面帧场景主色跟随 + 同色系深浅派生（用户 2026-09-07 定稿）
// ffmpeg 抽第 0 帧 → sharp 量化 4bit 色桶 → 占比≥5% 的彩色里取「占比×饱和度」最高者为主色
// → 同色相派生深色版（L=0.26，S 0.25~0.45 防脏）+ 浅色版（L=0.88，S≤0.15，混白 50% 提亮），深浅对比天然成立
// 色相范围由模板 palette.json 声明：{"hue":"any"} 不限（A 卡片风，暖色平局优先）；缺省 warm 暖色限定（B/C/D 手账风统一）
let paletteScript = "";
try {
  const coverJpg = path.join(workDir, "_cover.jpg");
  run(FFMPEG, ["-y", "-v", "error", "-ss", "0", "-i", roughAbs, "-frames:v", "1", coverJpg]);
  const sharp = (await import("sharp")).default;
  const { data } = await sharp(coverJpg).resize(96, 96, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  const buckets = new Map(); // key -> { n, r, g, b }
  let wsum = 0;
  for (let i = 0; i < data.length; i += 3) {
    const p = i / 3, px = (p % 96) / 96, py = Math.floor(p / 96) / 96;
    // 中央主体加权（用户 2026-09-07：产品多在画面中央，中央 50%x50% 区域权重 x2.5，防大面积背景色压过产品色）
    const wgt = (px >= 0.25 && px < 0.75 && py >= 0.25 && py < 0.75) ? 2.5 : 1;
    wsum += wgt;
    const k = (data[i] >> 4) << 8 | (data[i + 1] >> 4) << 4 | (data[i + 2] >> 4);
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = { n: 0, r: 0, g: 0, b: 0 }));
    b.n += wgt; b.r += data[i] * wgt; b.g += data[i + 1] * wgt; b.b += data[i + 2] * wgt;
  }
  const total = wsum;
  const toHsl = (r, g, b) => {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    if (mx === mn) return { h: 0, s: 0, l };
    const d = mx - mn;
    const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return { h: h * 60, s, l };
  };
  const hex = (r, g, b) => "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase();
  const hslRgb = (h, s, l) => {
    h = ((h % 360) + 360) % 360;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
  };
  const colors = [...buckets.values()].map((b) => {
    const r = b.r / b.n, g = b.g / b.n, bl = b.b / b.n;
    return { share: b.n / total, r, g, b: bl, ...toHsl(r, g, bl) };
  });
  const isWarmHue = (h) => (h >= 10 && h <= 70) || h >= 320; // 棕/橙/奶油 或 粉/红
  // 模板色相模式声明（仅 A 开启 any，其余默认 warm）
  let hueMode = "warm";
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(tplAbs, "palette.json"), "utf8"));
    if (pj && pj.hue === "any") hueMode = "any";
  } catch { /* 无声明=warm */ }
  // 主色候选：彩色（sat≥0.12）且占比≥5%（占比门槛防小面积艳色喧宾夺主）
  const cands = colors.filter((c) => c.s >= 0.12 && c.share >= 0.05);
  const score = (c) => c.share * c.s;
  let theme = null;
  if (hueMode === "any") {
    const sorted = [...cands].sort((a, b) => score(b) - score(a));
    theme = sorted[0] || null;
    if (theme && !isWarmHue(theme.h)) {
      const warmAlt = sorted.find((c) => isWarmHue(c.h));
      if (warmAlt && score(warmAlt) >= score(theme) * 0.85) theme = warmAlt; // 暖色平局优先
    }
  } else {
    const warm = cands.filter((c) => isWarmHue(c.h));
    if (warm.length) theme = warm.sort((a, b) => score(b) - score(a))[0];
  }
  let inkD = "#6B4A3A", inkL = "#F5EDE0";
  if (theme) {
    // 深色版：同色相，L=0.38 中深（用户 2026-09-07：L=0.26 会丢色名——蜜桃粉变棕；0.38 保色名，粉→豆沙/米黄→焦糖/绿→松绿/蓝→牛仔蓝）
    const sD = Math.min(0.5, Math.max(0.25, theme.s));
    const [dr, dg, db] = hslRgb(theme.h, sD, 0.38);
    inkD = hex(dr, dg, db);
    // 浅色版：同色相，L=0.88，S≤0.15，再与纯白 1:1 混合提亮（向白色靠，避免显脏）
    const sL = Math.min(0.15, theme.s * 0.35);
    const [lr, lg, lb] = hslRgb(theme.h, sL, 0.88);
    inkL = hex((lr + 255) / 2, (lg + 255) / 2, (lb + 255) / 2);
  }
  paletteScript = `<script>window.__palette=${JSON.stringify({ d: inkD, l: inkL })};</script>`;
  console.log(`      吸色: 深=${inkD} 浅=${inkL}${theme ? `（主色 h=${theme.h.toFixed(0)}° s=${theme.s.toFixed(2)}，${hueMode}）` : "（无彩色场景，兜底）"}`);
} catch (e) {
  console.log(`      吸色跳过（${e.message}），模板用默认深浅色`);
}
let html = fs.readFileSync(path.join(workDir, "index.html"), "utf-8");
html = html
  .replace(/data-duration="[^"]*"/, `data-duration="${spec.duration}"`)
  .replace(/data-fps="[^"]*"/, `data-fps="${spec.fps}"`)
  .replace(/data-width="[^"]*"/, `data-width="${spec.width}"`)
  .replace(/data-height="[^"]*"/, `data-height="${spec.height}"`);
if (userFontFace) html = html.replace("</head>", `${userFontFace}</head>`);
if (paletteScript) html = html.replace("</head>", `${paletteScript}</head>`);
fs.writeFileSync(path.join(workDir, "index.html"), html, "utf-8");
console.log(`[2/4] 模板规格已注入 → ${workDir}${userFontFace ? "（含用户字体）" : ""}`);

// 3) HyperFrames 渲染透明层
const overlayWebm = path.join(workDir, "overlay.webm");
console.log(`[3/4] HyperFrames 渲染透明层...`);
const t0 = Date.now();
// §9 ①：零弹窗 shim——用 node `--require <shim>` argv 直传注入 hyperframes CLI 进程
//（不经过 NODE_OPTIONS 环境变量：Windows 下 NODE_OPTIONS 对中文/空格/反斜杠路径解析不可靠，
//   实测 `--require="H:\创意…\packaging\win-hide-spawn.cjs"` 会把 \ 当转义吞掉导致 MODULE_NOT_FOUND）。
// shim patch child_process 强制 windowsHide:true，覆盖该进程树全部后代（含 puppeteer→chrome-headless-shell）。
const WIN_HIDE_SHIM = path.join(__dirname, "win-hide-spawn.cjs");
const renderArgs = ["render", workDir, "--format=webm", "--vp9-cpu-used=6", "-o", overlayWebm];
if (varsAbs && fs.existsSync(varsAbs)) renderArgs.push("--variables-file", varsAbs);
const env = {
  ...process.env,
  HYPERFRAMES_BROWSER_PATH: CHROME,
  HYPERFRAMES_FFMPEG_PATH: FFMPEG,
  HYPERFRAMES_FFPROBE_PATH: FFPROBE,
  HYPERFRAMES_NO_AUTO_INSTALL: "1",
  HYPERFRAMES_NO_TELEMETRY: "1",
};
run(process.execPath, ["--require", WIN_HIDE_SHIM, CLI, ...renderArgs], { env, cwd: __dirname, timeout: 9 * 60_000, retries: 1, retryOn: /ffprobe deadline/ });
const renderSec = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`      渲染完成 (${renderSec}s)`);

// 4) ffmpeg 叠加（libvpx 解码 alpha，原生 VP9 解码器不解析 alpha —— 关键坑）
console.log(`[4/4] ffmpeg 叠加合成...`);
run(FFMPEG, [
  "-y",
  "-i", roughAbs,
  "-c:v", "libvpx-vp9", "-i", overlayWebm,
  "-filter_complex", "[0:v][1:v]overlay=0:0:format=auto",
  "-c:v", "libx264", "-crf", "18", "-preset", "veryfast",
  "-c:a", "copy",
  "-movflags", "+faststart",
  outputAbs,
], { timeout: 9 * 60_000 });

// 包装封面合成取件（§C）：透明包装层拷贝到产物旁，供调用方抽封面帧合成包装封面 JPG
fs.copyFileSync(overlayWebm, path.join(path.dirname(outputAbs), "overlay.webm"));

// 清理工作目录（保留产物）
const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
console.log(JSON.stringify({
  ok: true,
  input: roughAbs,
  output: outputAbs,
  spec,
  renderSeconds: Number(renderSec),
  totalSeconds: Number(totalSec),
}, null, 2));
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
}
