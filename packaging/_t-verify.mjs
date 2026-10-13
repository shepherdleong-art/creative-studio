// §18 标题拖拽模板级验证（2026-10-09）：stub 注入 vars/layouts + 断言脚本，chrome-headless-shell --dump-dom 回收结果。
// 用法：node packaging/_t-verify.mjs   （结束后自动清理 stub）
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'templates');
const SHELL = join(dirname(fileURLToPath(import.meta.url)), 'runtime', 'chrome-headless-shell', 'chrome-headless-shell.exe');

const TPL = {
  poster: { dir: 'overlay-poster', sub: 'subtitle' },
  journal: { dir: 'overlay-journal', sub: 'subtitle' },
  minimal: { dir: 'overlay-minimal', sub: 'subtitle' },
  variety: { dir: 'overlay-variety', sub: 'subtitleWrap' },
};

const HELPERS = `
function center(el){var root=document.getElementById('root').getBoundingClientRect();var r=el.getBoundingClientRect();
return [(r.left+r.width/2-root.left)/root.width*100,(r.top+r.height/2-root.top)/root.height*100];}
function done(R){var pre=document.createElement('pre');pre.id='assert';pre.textContent=JSON.stringify(R);document.body.appendChild(pre);}
function rec(R,n,p,d){R.push([n,!!p,String(d)]);}`;

function layoutAssert(tplId, subId) {
  return `
setTimeout(function(){var R=[];
var t=document.getElementById('title'),s=document.getElementById('${subId}');
var c=center(t);rec(R,'title.center',Math.abs(c[0]-60)<1&&Math.abs(c[1]-40)<1,c[0].toFixed(2)+','+c[1].toFixed(2));
rec(R,'title.zoom',parseFloat(t.style.zoom)===1.5,t.style.zoom);
rec(R,'title.rotate',(t.style.rotate||'')==='12deg',t.style.rotate||'(empty)');
var cs=center(s);rec(R,'sub.center',Math.abs(cs[0]-30)<1&&Math.abs(cs[1]-55)<1,cs[0].toFixed(2)+','+cs[1].toFixed(2));
rec(R,'sub.zoom',parseFloat(s.style.zoom)===0.8,s.style.zoom);
rec(R,'sub.rotate',(s.style.rotate||'')==='-8deg',s.style.rotate||'(empty)');
rec(R,'title.fs',true,getComputedStyle(t).fontSize);rec(R,'sub.fs',true,getComputedStyle(s).fontSize);
done(R);},1000);`;
}

function buildCase(tplKey, vars, assertJs) {
  const tpl = TPL[tplKey];
  const html = readFileSync(join(ROOT, tpl.dir, 'index.html'), 'utf8');
  const injectVars = `<script>window.__hyperframes={getVariables:function(){return ${JSON.stringify(vars)};}};</script>`;
  const injectAssert = `<script>${HELPERS}${assertJs}</script>`;
  const marker = '<script>\n(function () {';
  if (!html.includes(marker)) throw new Error('marker not found in ' + tplKey);
  return html.replace(marker, injectVars + marker).replace('</body>', injectAssert + '</body>');
}

function runCase(tplKey, name, vars, assertJs) {
  const tpl = TPL[tplKey];
  const stub = join(ROOT, tpl.dir, '_t-verify.html');
  writeFileSync(stub, buildCase(tplKey, vars, assertJs));
  try {
    const dom = execFileSync(SHELL, ['--dump-dom', '--virtual-time-budget=4000', pathToFileURL(stub).href], { maxBuffer: 16 * 1024 * 1024 }).toString();
    const m = dom.match(/<pre id="assert">([\s\S]*?)<\/pre>/);
    if (!m) return { name, fatal: 'no assert output' };
    return { name, rows: JSON.parse(m[1]) };
  } finally { unlinkSync(stub); }
}

const DRAG_LAYOUT = (tplId) => ({ ['overlay-' + tplId]: { cover: { title: { x: 60, y: 40, scale: 1.5, rotate: 12 }, subtitle: { x: 30, y: 55, scale: 0.8, rotate: -8 } } } });
const BASE_VARS = { title: '复古藤编椅', subtitle: '把自然搬回家', point1: '手工藤编工艺', point2: '高回弹坐垫', point3: '实木框架承重强', totalSec: 6, coverSec: 0.8 };

const results = [];
// 1) 四模板：布局应用（中心/zoom/rotate）+ 记录字号供跨 run 比较
for (const k of Object.keys(TPL)) {
  results.push(runCase(k, k + ':layout', { ...BASE_VARS, layouts: DRAG_LAYOUT(k) }, layoutAssert(k, TPL[k].sub)));
}
// 2) 四模板：无布局参照（字号基准）
for (const k of Object.keys(TPL)) {
  results.push(runCase(k, k + ':ref', { ...BASE_VARS }, `
setTimeout(function(){var R=[];var t=document.getElementById('title'),s=document.getElementById('${TPL[k].sub}');
rec(R,'title.fs',true,getComputedStyle(t).fontSize);rec(R,'sub.fs',true,getComputedStyle(s).fontSize);done(R);},1000);`));
}
// 3) A 长标题+标题布局：locked → 单行不折 + 副标题不下移（top 未被内联）
const LONG = { ...BASE_VARS, title: '北美FAS级红橡木餐边柜旗舰店' };
results.push(runCase('poster', 'poster:locked-long', { ...LONG, layouts: { 'overlay-poster': { cover: { title: { x: 50, y: 30, scale: 1, rotate: 0 } } } } }, `
setTimeout(function(){var R=[];var t=document.getElementById('title'),s=document.getElementById('subtitle');
rec(R,'title.nowrap',t.style.whiteSpace==='nowrap',t.style.whiteSpace||'(empty)');
rec(R,'sub.top-untouched',s.style.top==='',s.style.top||'(empty)');
done(R);},1000);`));
// 4) A 长标题无布局：回归——折两行 + 副标题下移
results.push(runCase('poster', 'poster:auto-long', { ...LONG }, `
setTimeout(function(){var R=[];var t=document.getElementById('title'),s=document.getElementById('subtitle');
rec(R,'title.wrap',t.style.whiteSpace==='normal',t.style.whiteSpace||'(empty)');
rec(R,'sub.moved',parseFloat(s.style.top)>17,s.style.top||'(empty)');
done(R);},1000);`));
// 5) A 复位路径：运行时先 apply 布局再 apply(null) → 自动适配恢复（折行+下移回来，ul 清旗标）
results.push(runCase('poster', 'poster:reset-restores-auto', { ...LONG }, `
setTimeout(function(){
var t=document.getElementById('title');
window.__pointLayout.apply(t,{x:60,y:40,scale:1.2,rotate:5});
window.__pointLayout.apply(t,null);
setTimeout(function(){var R=[];var s=document.getElementById('subtitle');
rec(R,'ul.cleared',t.dataset.ul!=='1',t.dataset.ul||'(empty)');
rec(R,'title.wrap-restored',t.style.whiteSpace==='normal',t.style.whiteSpace||'(empty)');
rec(R,'sub.moved-restored',parseFloat(s.style.top)>17,s.style.top||'(empty)');
done(R);},400);},1000);`));
// 6) §18.5 bug#2 变尺寸重排：带布局时改画布宽度 → refit 后布局中心按新画布保持。
//    注：--dump-dom 无持续渲染帧，ResizeObserver 回调在此 harness 不会派发（RO 端到端经真浏览器验收）；
//    这里验证的是「refit 在新画布尺寸下收敛」这一核心逻辑（RO 只是它的触发器）。
results.push(runCase('poster', 'poster:resize-refit', { ...BASE_VARS, layouts: { 'overlay-poster': { cover: { title: { x: 60, y: 40, scale: 1.5, rotate: 12 } } } } }, `
setTimeout(function(){
var rootEl=document.getElementById('root');
rootEl.style.inset='auto';rootEl.style.width='640px';rootEl.style.height='900px';
setTimeout(function(){
var w0=document.getElementById('root').clientWidth;
window.__pointLayout.refit();
var R=[];var t=document.getElementById('title');
rec(R,'root.resized',w0>600&&w0<680,String(w0));
var c=center(t);rec(R,'title.center-kept',Math.abs(c[0]-60)<1&&Math.abs(c[1]-40)<1,c[0].toFixed(2)+','+c[1].toFixed(2));
rec(R,'title.zoom-kept',parseFloat(t.style.zoom)===1.5,t.style.zoom);
done(R);},600);},1000);`));

// 汇总
// 7) 四模板：可编辑元素命中回归——全部 [data-point-id] computed pointer-events 不得为 none
//    （2026-10-10 journal .note pointer-events:none 致封面/正片便签选不中实锤；合成事件验收绕过命中测试测不出，
//     本断言在 --dump-dom 下查 computed style，堵死此类只能靠真鼠标发现的 bug）
const PE_VARS = { ...BASE_VARS, pointCues: [{ id: 'pe1', text: '零胶水物理固定', startSec: 1.5, endSec: 3 }], pointCuesMode: 'timed' };
for (const k of Object.keys(TPL)) {
  results.push(runCase(k, k + ':pointer-events', PE_VARS, `
setTimeout(function(){var R=[];var els=document.querySelectorAll('[data-point-id]');var bad=[];
els.forEach(function(el){var pe=getComputedStyle(el).pointerEvents;if(pe==='none')bad.push(el.getAttribute('data-point-id'));});
rec(R,'editable.count',els.length>=5,String(els.length));
rec(R,'editable.hittable',bad.length===0,bad.join(',')||'(ok)');
done(R);},1000);`));
}

// 8) 四模板：占位文字（2026-10-12 用户定稿+铁律）——主/副标题抓取失败时模板端填充「标题/副标题需修改」，
//    仅编辑态可见（CLI 渲染 visibility:hidden 不进成片），占位不写入数据层；抓取成功绝不显示占位；
//    卖点空=彻底不显示（display:none，无占位无标记）
const PLACEHOLDER_VARS = { ...BASE_VARS, subtitle: '', point2: '' };
for (const k of Object.keys(TPL)) {
  results.push(runCase(k, k + ':placeholder', PLACEHOLDER_VARS, `
setTimeout(function(){var R=[];
var g2=document.querySelector('[data-point-id="cover:point2"]');
var gs=document.getElementById('${TPL[k].sub}');
var gt=document.getElementById('title');
rec(R,'ph.sub-marked',!!(gs&&gs.getAttribute('data-placeholder')==='1'&&gs.textContent.indexOf('需修改')>=0),gs?(gs.getAttribute('data-placeholder')+'/'+gs.textContent.slice(0,12)):'missing');
rec(R,'ph.title-not-marked',!!(gt&&!gt.hasAttribute('data-placeholder')&&gt.textContent.indexOf('需修改')<0),gt?gt.textContent.slice(0,12):'missing');
rec(R,'ph.sub-hidden-render',gs?getComputedStyle(gs).visibility==='hidden':'?',gs?getComputedStyle(gs).visibility:'?');
document.documentElement.dataset.edit='1';
rec(R,'ph.sub-shown-edit',gs?getComputedStyle(gs).visibility==='visible':'?',gs?getComputedStyle(gs).visibility:'?');
rec(R,'ph.point-hidden',!!(g2&&getComputedStyle(g2).display==='none'&&!g2.hasAttribute('data-placeholder')),g2?(getComputedStyle(g2).display+'/'+g2.getAttribute('data-placeholder')):'missing');
rec(R,'ph.point-hidden-edit',g2?getComputedStyle(g2).display==='none':'?',g2?getComputedStyle(g2).display:'?');
rec(R,'ph.no-ghost-legacy',!!(g2&&gs&&!g2.hasAttribute('data-ghost')&&!gs.hasAttribute('data-ghost')),'ok');
delete document.documentElement.dataset.edit;
done(R);},1000);`));
}

let fail = 0;
// 9) fit 基准还原（2026-10-10 G077 标题 0.19px 实锤：无基准迭代缩减 × fonts.ready 前 fallback 测量 = 跨加载复利衰减）：
//    人为把字号压到 1px（模拟上次异常收缩残留）后 refit——带 dataset.baseFs 基准还原的实现会从基准重新收敛（恢复），
//    无基准实现从 1px 继续量（不触界不再缩）永远卡 1px。journal 主/副标题（fitToCanvas）+ poster 副标题 + 三模板卖点标签
results.push(runCase('journal', 'journal:fit-restore', { ...BASE_VARS }, `
setTimeout(function(){
var t=document.getElementById('title');t.style.fontSize='1px';
window.__pointLayout.refit();
var R=[];var a1=parseFloat(getComputedStyle(t).fontSize);
rec(R,'title.restored',a1>10,a1+'px');
var s=document.getElementById('subtitle');s.style.fontSize='1px';
window.__pointLayout.refit();
var a2=parseFloat(getComputedStyle(s).fontSize);
rec(R,'subtitle.restored',a2>10,a2+'px');
done(R);},1000);`));
results.push(runCase('poster', 'poster:fit-restore-sub', { ...BASE_VARS }, `
setTimeout(function(){
var s=document.getElementById('subtitle');s.style.fontSize='1px';
window.__pointLayout.refit();
var R=[];var a=parseFloat(getComputedStyle(s).fontSize);
rec(R,'subtitle.restored',a>10,a+'px');
done(R);},1000);`));
for (const k of ['poster', 'minimal', 'variety']) {
  results.push(runCase(k, k + ':fit-restore-tag', { ...BASE_VARS }, `
setTimeout(function(){
var tag=document.querySelector('[data-point-id="cover:point1"]');
var txt=tag&&tag.querySelector('.ptxt');
if(txt) txt.style.fontSize='1px';
window.__pointLayout.refit();
var R=[];var a=txt?parseFloat(getComputedStyle(txt).fontSize):0;
rec(R,'tag.restored',a>10,a+'px');
done(R);},1000);`));
}


const fsMap = {};
for (const r of results) {
  if (r.fatal) { console.log(`✗ ${r.name}: ${r.fatal}`); fail++; continue; }
  for (const [n, pass, detail] of r.rows) {
    if (n.endsWith('.fs')) { fsMap[r.name + ':' + n] = detail; continue; }
    console.log(`${pass ? '✓' : '✗'} ${r.name} ${n} ${pass ? '' : '→ ' + detail}`);
    if (!pass) fail++;
  }
}
// 字号跨 run 比较：有布局（scale 1.5）不得触发 fit 反缩（zoom-fight 表现为字号显著变小）。
// poster 主标题例外：locked 停用右边界（紧）→ 仅画幅保护（松），字号合法变大，故只要求「不更小」。
for (const k of Object.keys(TPL)) {
  for (const who of ['title', 'sub']) {
    const a = parseFloat(fsMap[`${k}:layout:${who}.fs`]), b = parseFloat(fsMap[`${k}:ref:${who}.fs`]);
    const ok = k === 'poster' && who === 'title'
      ? a && b && a >= b * 0.97
      : a && b && Math.abs(a - b) / b < 0.03;
    console.log(`${ok ? '✓' : '✗'} ${k} ${who}.fontSize-no-zoom-fight ${ok ? '' : '→ layout=' + a + ' ref=' + b}`);
    if (!ok) fail++;
  }
}
console.log(fail === 0 ? '\n全部断言通过' : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
