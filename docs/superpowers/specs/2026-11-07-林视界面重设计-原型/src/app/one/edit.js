// 剪辑共用的控件：字幕样式、片段、包装、音频、封面，以及「鼠标停在小图上看大图」。
// 单条混剪和批量生产的检查成片共用这一套，功能对齐正式产品的 mixcut 右栏。
const getP = p => p.split('.').reduce((o, k) => o[k], S);
const setP = (p, v) => { const ks = p.split('.'), last = ks.pop(); ks.reduce((o, k) => o[k], S)[last] = v; };
const FMT = { i:v => Math.round(v), f1:v => (+v).toFixed(1), f2:v => (+v).toFixed(2), x:v => `${(+v).toFixed(2)}×`, rx:v => `${(+v).toFixed(1)}x`, s:v => `${(+v).toFixed(1)} 秒`, db:v => `${Math.round(v)} dB`, deg:v => `${Math.round(v)}°`, px:v => `${Math.round(v)}` };
// 滑杆拖动时只更新数字和预览，松手才整页重绘，拖动不会断
const rng = (label, p, min, max, step, fmt = 'i') => `<div class="rng"><span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}" data-bind="${p}" data-rng="${fmt}" value="${getP(p)}"><em>${FMT[fmt](getP(p))}</em></div>`;
const COLORS = ['#FFFFFF', '#FFE45C', '#FF5C7A', '#1D1D1F'];
const colorRow = (label, p) => { const v = getP(p); return `<div class="fr"><span>${label}</span><span class="sws">${COLORS.map(c => `<button class="sw ${v.toUpperCase() === c ? 'on' : ''}" style="--c:${c}" data-act="setv" data-k="${p}" data-v="${c}" aria-label="${c}"></button>`).join('')}<label class="sw sw-pick ${COLORS.includes(v.toUpperCase()) ? '' : 'on'}" style="--c:${v}" title="其他颜色"><input type="color" data-bind="${p}" data-rng="color" value="${v}"></label></span></div>`; };
const swRow = (label, p, sub = '') => `<div class="fr"><span>${label}${sub ? `<small class="fr-sub">${sub}</small>` : ''}</span><button class="switch ${getP(p) ? 'on' : ''}" data-act="tog" data-k="${p}" aria-label="${label}"></button></div>`;
const segRow = (label, p, opts) => `<div class="fr"><span>${label}</span><div class="seg sm">${opts.map(([v, l]) => `<button class="${getP(p) === v ? 'on' : ''}" data-act="setv" data-k="${p}" data-v="${v}">${l}</button>`).join('')}</div></div>`;
const card = (icon, title, body, extra = '') => `<section class="rc"><h5>${ic(icon)}<span>${title}</span>${extra}</h5>${body}</section>`;

// ---------- 字体 ----------
const FONTS = ['思源黑体','思源宋体','微软雅黑','等线','黑体','宋体','楷体','霞鹜文楷','得意黑','站酷快乐体','阿里巴巴普惠体'];
// 写进 style 属性，所以字体名只能用单引号
const FONT_CSS = { '思源黑体':"NSans,'PingFang SC',sans-serif", '思源宋体':"'Songti SC','Source Han Serif SC',serif", '宋体':"'Songti SC',SimSun,serif", '楷体':"'Kaiti SC',KaiTi,serif", '霞鹜文楷':"'Kaiti SC',KaiTi,serif", '黑体':"'Heiti SC',SimHei,sans-serif" };
const fontCss = f => FONT_CSS[f] || "NSans,'PingFang SC',sans-serif";
S.fonts = { recent:['思源黑体','得意黑'], fav:['思源黑体'] };
const fontBtn = (p, none = '') => { const v = getP(p); return `<button class="pop" data-act="fontPick" data-k="${p}" data-none="${none ? 1 : ''}"><span style="font-family:${fontCss(v || '思源黑体')}">${esc(v || none)}</span>${ic('chevron-down')}</button>`; };
// core.js 渲染弹出层时，遇到不认识的种类来这里取
function popHook(p) {
  if (p.kind !== 'font') return '';
  const q = (p.q || '').trim(), cur = getP(p.k), list = q ? FONTS.filter(f => f.includes(q)) : FONTS;
  const row = f => `<div class="fp-row ${f === cur ? 'cur' : ''}"><button class="fp-name" data-act="fontSet" data-v="${f}" style="font-family:${fontCss(f)}">${f === cur ? ic('check') : '<i class="menu-sp"></i>'}${f}</button><button class="fp-star ${S.fonts.fav.includes(f) ? 'on' : ''}" data-act="fontFav" data-v="${f}" title="${S.fonts.fav.includes(f) ? '取消收藏' : '收藏'}">${S.fonts.fav.includes(f) ? '★' : '☆'}</button></div>`;
  return `<div class="menu menu-font"><input class="fp-q" data-fpq placeholder="搜索字体名称…" value="${esc(q)}" aria-label="搜索字体名称">
    ${p.none ? `<button class="menu-it" data-act="fontSet" data-v="">${!cur ? ic('check') : '<i class="menu-sp"></i>'}模板原生字体</button>` : ''}
    ${q ? (list.length ? list.map(row).join('') : '<p class="fp-empty">无匹配字体</p>') : `<div class="fp-sec">收藏</div>${S.fonts.fav.length ? S.fonts.fav.map(row).join('') : '<p class="fp-empty">暂无收藏，点击字体右侧 ☆ 收藏</p>'}
    <div class="fp-sec">最近使用</div>${S.fonts.recent.map(row).join('')}
    <div class="fp-sec"><span>系统</span><button data-act="fontScan">刷新</button></div>${FONTS.map(row).join('')}`}</div>`;
}

// ---------- 字幕样式（对齐 FinalEditInspector 的 StyleEditor） ----------
const subStyle = () => ({ font:'思源黑体', size:56, x:.5, y:.82, scale:1, width:864, color:'#FFFFFF', align:'center', italic:false, stroke:{ on:true, color:'#1D1D1F', w:4 }, shadow:{ on:false, color:'#000000', op:.5, blur:6, dist:3, ang:45 } });
function styleCss(st, k) { // k：预览缩放倍数
  const sh = st.shadow, rad = sh.ang * Math.PI / 180, dx = Math.cos(rad) * sh.dist * k, dy = Math.sin(rad) * sh.dist * k;
  const shadow = sh.on ? `drop-shadow(${dx.toFixed(1)}px ${dy.toFixed(1)}px ${(sh.blur * k).toFixed(1)}px ${sh.color}${Math.round(sh.op * 255).toString(16).padStart(2, '0')})` : 'none';
  return `font-family:${fontCss(st.font)};font-size:${(st.size * k * st.scale).toFixed(1)}px;color:${st.color};font-style:${st.italic ? 'italic' : 'normal'};text-align:${st.align};-webkit-text-stroke:${st.stroke.on ? `${(st.stroke.w * k).toFixed(2)}px ${st.stroke.color}` : '0'};paint-order:stroke fill;filter:${shadow};width:${(st.width * k * st.scale).toFixed(0)}px;left:${(st.x * 100).toFixed(1)}%;top:${(st.y * 100).toFixed(1)}%`;
}
function stylePreview(base, img, text) {
  const st = getP(base);
  return `<div class="st-prev" data-st="${base}" style="background-image:url(${A[img]})"><span class="st-safe"></span><b style="${styleCss(st, 0.21)}">${esc(text)}</b></div>`;
}
function styleCard(base, o = {}) {
  const st = getP(base), p = k => `${base}.${k}`;
  const body = `${o.top || ''}${o.preview ? stylePreview(base, o.img || 'p4', o.text || '约6.5厘米实心实木粗腿') : ''}
    <div class="fg"><div class="fr"><span>字体</span>${fontBtn(p('font'))}</div>
      ${rng('字号', p('size'), 12, 180, 1)}${rng('X 位置', p('x'), 0, 1, .01, 'f2')}${rng('Y 位置', p('y'), 0, 1, .01, 'f2')}${rng('缩放', p('scale'), .5, 2, .01, 'f2')}${rng('单行宽度', p('width'), 200, 1800, 10)}
      ${colorRow('颜色', p('color'))}${segRow('对齐', p('align'), [['left','左'],['center','中'],['right','右']])}
      ${swRow('斜体', p('italic'))}${swRow('描边', p('stroke.on'))}
      ${st.stroke.on ? `<div class="fx">${colorRow('描边颜色', p('stroke.color'))}${rng('粗细', p('stroke.w'), 0, 16, .5, 'f1')}</div>` : ''}
      ${swRow('阴影', p('shadow.on'))}
      ${st.shadow.on ? `<div class="fx">${colorRow('阴影颜色', p('shadow.color'))}${rng('不透明度', p('shadow.op'), 0, 1, .05, 'f2')}${rng('模糊', p('shadow.blur'), 0, 40, 1)}${rng('距离', p('shadow.dist'), 0, 40, 1)}${rng('角度', p('shadow.ang'), 0, 360, 1, 'deg')}</div>` : ''}</div>`;
  return card('text', o.title || '字幕样式', body, `${o.tag || ''}<button class="rc-a" data-act="${o.resetAct || 'styleReset'}" data-k="${base}"${o.resetV ? ` data-v="${o.resetV}"` : ''}>${o.resetLabel || '恢复默认'}</button>`);
}

// ---------- 片段：倍速、画面、截取（对齐 VideoPlaybackRateControl、ClipFramingControl、TrimEditor） ----------
function clipCards(base, c) {
  return card('film', '视频倍速', `<div class="fg">${rng('倍速', `${base}.rate`, .25, 4, .05, 'x')}</div><p class="note">拖动调节，松手保存；后续片段位置不变。</p><button class="btn sm" data-act="setv" data-k="${base}.rate" data-v="1">恢复原速（1×）</button>`)
    + card('image', '视频画面调整', `<div class="fg">${rng('画面缩放', `${base}.fz`, .25, 3, .05, 'x')}${rng('水平位移', `${base}.fx`, -1, 1, .02, 'f2')}${rng('垂直位移', `${base}.fy`, -1, 1, .02, 'f2')}</div><button class="btn sm" data-act="clipFrameReset" data-k="${base}">重置画面</button>`);
}

// ---------- 包装（对齐 PackagingCard） ----------
const TPL_INFO = [
  { name:'f1 花字种草', desc:'彩色花字标题，卖点做成贴纸，适合种草' },
  { name:'f2 手账拼贴', desc:'纸胶带和便签，像手账一样一条条贴卖点' },
  { name:'f3 极简高级', desc:'细字标题加细线，留白多，适合高客单' },
  { name:'f4 综艺撕纸', desc:'撕纸条和大字，节奏感强，适合促销' },
];
const tplMock = (i, big) => `<div class="tm tm${i + 1} ${big ? 'big' : ''}" style="background-image:url(${A[big ? 'p3' : 'c2']})"><b>林氏可可系列</b><i>粗腿稳支撑</i><em>约6.5厘米实心粗腿</em></div>`;
function packCard(base) {
  const pk = getP(`${base}.pk`), p = k => `${base}.pk.${k}`;
  const body = `<div class="fr pk-sw"><span>${pk.on ? `已启用，${TPL_INFO[pk.tpl].name}` : '未启用：导出渲染直接发布无包装原片'}</span><button class="switch ${pk.on ? 'on' : ''}" data-act="tog" data-k="${p('on')}" aria-label="启用视频包装"></button></div>
    ${!pk.on ? '<p class="note">开启后可选择模板、字体与文案，包装层直接叠加在预览窗口并同步播放。</p>' : `
    <div class="tpls" role="radiogroup" aria-label="包装模板">${TPL_INFO.map((t, i) => `<button class="tplc ${pk.tpl === i ? 'on' : ''}" role="radio" aria-checked="${pk.tpl === i}" data-act="setv" data-k="${p('tpl')}" data-v="${i}" data-zoom-tpl="${i}" title="${t.desc}">${tplMock(i)}<span>${t.name.slice(3)}</span></button>`).join('')}</div>
    <div class="fg"><div class="fr"><span>主标题字体</span>${fontBtn(p('fTitle'), '模板原生字体')}</div><div class="fr"><span>副标题字体</span>${fontBtn(p('fSub'), '模板原生字体')}</div><div class="fr"><span>卖点字体</span>${fontBtn(p('fPoint'), '模板原生字体')}</div>
      <div class="fr fr-btns"><button class="btn sm" data-act="toastMsg" data-v="选择 .ttf、.otf 或 .woff2 字体文件（原型里不真的上传）">上传字体</button></div></div>
    <p class="note">双击预览画面中的标题、卖点文字可直接修改；留空则该元素不显示。</p>
    <div class="rc-btns"><button class="btn sm" data-act="packCover" data-k="${base}">跳到封面</button><button class="btn sm" data-act="packAsk" data-v="layout">恢复默认版式</button><button class="btn sm" data-act="packAsk" data-v="points">重新提取卖点</button><button class="btn sm" data-act="toastMsg" data-v="已恢复自动推导的文案">恢复默认文案</button></div>
    <p class="note">预览为近似效果，最终以导出渲染为准。</p>`}`;
  return card('film', '视频包装', body);
}

// ---------- 音频（对齐 BgmCard、NarrationPlaybackRateControl、NarrationGainControl） ----------
const BGM_LIB = ['Keys Of Moon - The Epic Hero.mp3', 'Sappheiros - Embrace.mp3'];
function bgmCard(base, o = {}) {
  const b = getP(base);
  return card('music', o.title || '背景音乐', `${o.top || ''}<div class="fg"><div class="fr"><span>BGM 曲目</span><button class="pop" data-act="bgmPick" data-k="${base}"><span>${esc(b.track || '无 BGM')}</span>${ic('chevron-down')}</button></div>
    <div class="fr fr-btns"><button class="btn sm" data-act="bgmPlay" data-k="${base}" ${b.track ? '' : 'disabled'}>${S.bgmPlaying === base ? '停止' : '试听'}</button><button class="btn sm" data-act="toastMsg" data-v="选择音频文件后加入音乐库并应用到音轨（原型里不真的导入）">添加音乐</button></div>
    ${rng('音量（dB）', `${base}.gain`, -40, 0, 1, 'db')}${rng('淡入（秒）', `${base}.fi`, 0, 5, .1, 's')}${rng('淡出（秒）', `${base}.fo`, 0, 5, .1, 's')}</div>${o.foot || ''}`, `<small class="rc-n">${BGM_LIB.length} 首</small>`);
}
function narCards(base, o = {}) {
  const n = getP(base);
  return (o.rate === false ? '' : card('speaker', '口播音频变速', `<div class="kv big"><span>整条口播音轨</span><b data-live-rate="${base}">${n.rate.toFixed(1)}x</b></div><p class="note">同步调整口播、字幕与成片时长</p>
      <div class="fg">${rng('倍速', `${base}.rate`, .5, 2, .1, 'rx')}</div><div class="seg sm presets">${[.8, 1, 1.2, 1.5].map(v => `<button class="${Math.abs(n.rate - v) < .01 ? 'on' : ''}" data-act="setv" data-k="${base}.rate" data-v="${v}">${v}x</button>`).join('')}</div>`))
    + card('speaker', o.gainTitle || '口播音量', `<div class="kv big"><span>${o.gainScope || '整条口播音轨'}</span><b>${Math.round(n.gain)} dB</b></div><p class="note">${o.gainNote || '只调整口播响度，不改变口播内容与成片时长'}</p>
      <div class="fg">${rng('音量', `${base}.gain`, -40, 10, 1, 'db')}</div><button class="btn sm" data-act="setv" data-k="${base}.gain" data-v="0">恢复默认</button>${o.gainFoot || ''}`);
}

// ---------- 封面（对齐 CoverEditorDrawer） ----------
const coverState = (clip = 1) => ({ clip, time:.4, zoom:1, x:0, y:0, titleOn:true, t1:'林氏可可系列', t2:'粗腿稳支撑', fit:true, font:'思源黑体', which:'t1', st:{ t1:{ color:'#FFE45C', size:112, italic:false, stroke:true, sc:'#1D1D1F', sw:8 }, t2:{ color:'#FFFFFF', size:78, italic:false, stroke:true, sc:'#1D1D1F', sw:6 } }, custom:false });
const COVER_PRESETS = [{ name:'清爽蓝白', t1:{ color:'#FFFFFF', sc:'#0071E3' }, t2:{ color:'#0071E3', sc:'#FFFFFF' } }];
S.coverPresets = [{ name:'林氏黄字', t1:{ color:'#FFE45C', sc:'#1D1D1F' }, t2:{ color:'#FFFFFF', sc:'#1D1D1F' } }];
function coverEntry(scope, cv, clipsN) {
  return card('image', '视频封面设置', `<button class="cv-entry" data-act="coverOpen" data-v="${scope}"><span class="cv-th" style="background-image:url(${A[`p${cv.clip}`]})"></span><span><b>点击精调</b><small>${cv.custom ? '已自定义' : '默认封面'}，3:4，片段 #${cv.clip}${clipsN ? `（共 ${clipsN} 段）` : ''}</small></span>${ic('chevron-right')}</button>`);
}
function coverCanvas(cv) {
  const t = k => { const s = cv.st[k]; return `color:${s.color};font-size:${(s.size * .28).toFixed(1)}px;font-style:${s.italic ? 'italic' : 'normal'};-webkit-text-stroke:${s.stroke ? `${(s.sw * .28).toFixed(1)}px ${s.sc}` : '0'};paint-order:stroke fill;font-family:${fontCss(cv.font)}`; };
  return `<div class="cv-canvas"><img src="${A[`p${cv.clip}`]}" alt="" style="transform:translate(${cv.x * 30}%,${cv.y * 30}%) scale(${cv.zoom})"><span class="st-safe"></span>${cv.titleOn ? `<b class="cv-t1" style="${t('t1')}">${esc(cv.t1)}</b><b class="cv-t2" style="${t('t2')}">${esc(cv.t2)}</b>` : ''}</div>`;
}
function coverSheet() {
  const e = S.coverEdit, cv = e.draft, s = cv.st[cv.which], b = 'coverEdit.draft', w = `${b}.st.${cv.which}`;
  const body = `<div class="cv-grid">${coverCanvas(cv)}<div class="cv-side">
    <p class="note">直接拖动主标题或副标题定位；画面缩放与位置用下面的滑杆。虚线框为四边 4% 导出安全区。</p>
    <div class="fg"><div class="fr"><span>来源片段</span><div class="seg sm">${[1, 4, 5, 3, 6, 9].map(k => `<button class="${cv.clip === k ? 'on' : ''}" data-act="setv" data-k="${b}.clip" data-v="${k}">#${k}</button>`).join('')}</div></div>${rng('截帧时间', `${b}.time`, 0, 4, .05, 's')}</div>
    <div class="h4">画面</div><div class="fg">${rng('缩放', `${b}.zoom`, 1, 2.5, .05, 'x')}${rng('水平', `${b}.x`, -1, 1, .02, 'f2')}${rng('垂直', `${b}.y`, -1, 1, .02, 'f2')}</div>
    <div class="fg">${swRow('启用封面标题', `${b}.titleOn`)}</div>
    ${cv.titleOn ? `<div class="fg"><div class="fr"><span>共享字体</span>${fontBtn(`${b}.font`)}</div><div class="fr"><span>主标题</span><input class="in" data-bind="${b}.t1" data-live="text" value="${esc(cv.t1)}"></div><div class="fr"><span>副标题</span><input class="in" data-bind="${b}.t2" data-live="text" value="${esc(cv.t2)}"></div>${swRow('适配单行', `${b}.fit`)}</div>
    <div class="h4"><span>标题文字</span><div class="seg sm"><button class="${cv.which === 't1' ? 'on' : ''}" data-act="setv" data-k="${b}.which" data-v="t1">主</button><button class="${cv.which === 't2' ? 'on' : ''}" data-act="setv" data-k="${b}.which" data-v="t2">副</button></div></div>
    <div class="fg">${colorRow('颜色', `${w}.color`)}${rng('字号', `${w}.size`, 24, 200, 1)}${swRow('斜体', `${w}.italic`)}${swRow('描边', `${w}.stroke`)}${s.stroke ? `${colorRow('描边色', `${w}.sc`)}${rng('粗细', `${w}.sw`, 0, 16, .5, 'f1')}` : ''}</div>
    <div class="h4">内置样式</div><div class="rc-btns">${COVER_PRESETS.map(p => `<button class="btn sm" data-act="coverPreset" data-v="${p.name}">${p.name}</button>`).join('')}</div>
    <div class="h4">自定义预设</div><div class="rc-btns">${S.coverPresets.map((p, i) => `<span class="chip">${esc(p.name)}<button data-act="coverPreset" data-v="${esc(p.name)}">应用</button><button data-act="coverPresetDel" data-i="${i}" aria-label="删除预设 ${esc(p.name)}">删除</button></span>`).join('')}</div>
    <div class="fg"><div class="fr"><span>预设名称</span><input class="in" data-bind="coverEdit.name" value="${esc(e.name || '')}" placeholder="输入名称"></div><div class="fr fr-btns"><button class="btn sm" data-act="coverPresetSave">保存</button></div></div>` : ''}</div></div>`;
  return sheet('精调封面', '真实视频帧。修改在点「应用封面」后才保存。', body, '<span class="sh-err"></span><button class="btn" data-act="coverClose">取消</button><button class="btn pri" data-act="coverApply">应用封面</button>', 'wider cv-sheet');
}

// ---------- 鼠标停在小图上看大图（对齐 HoverZoomImage：跟着鼠标，贴窗口边缘自动让位） ----------
const ZOOM_SEL = '.it img,.src-ref img,.th-c img,.ctx img,.pk img,.res img,.bk img,.dps img,.pt-h img,.ev img,.ctx-one img,.pair-i img,.mat img,.bm img,.ed-it img,.bt-cv img,[data-zoom-tpl]';
let zoomTimer = null;
function zoomCaption(el) { if (el.alt) return el.alt; const host = el.closest('[title],.it,.res,.bk,.bp,.bm,.lib-it'); const b = host && host.querySelector('b'); return (host && host.getAttribute('title')) || (b && b.textContent) || ''; }
function zoomShow(el, x, y) {
  let box = $('#zoom-pop'); if (!box) { box = document.createElement('div'); box.id = 'zoom-pop'; document.body.append(box); }
  const tpl = el.dataset.zoomTpl;
  box.innerHTML = tpl != null ? `${tplMock(+tpl, true)}<small>${TPL_INFO[+tpl].name}：${TPL_INFO[+tpl].desc}</small>` : `<img src="${el.currentSrc || el.src}" alt=""><small>${esc(zoomCaption(el))}</small>`;
  box.classList.add('on'); zoomPos(x, y);
}
function zoomPos(x, y) {
  const box = $('#zoom-pop'); if (!box || !box.classList.contains('on')) return;
  const w = box.offsetWidth, h = box.offsetHeight, g = 14;
  let L = x + g, T = y + g; if (L + w > innerWidth - 8) L = x - g - w; if (L < 8) L = 8; if (T + h > innerHeight - 8) T = Math.max(8, innerHeight - 8 - h);
  box.style.left = `${L}px`; box.style.top = `${T}px`;
}
function zoomHide() { clearTimeout(zoomTimer); const box = $('#zoom-pop'); if (box) box.classList.remove('on'); }
document.addEventListener('mouseover', e => { const el = e.target.closest && e.target.closest(ZOOM_SEL); if (!el) return; clearTimeout(zoomTimer); const x = e.clientX, y = e.clientY; zoomTimer = setTimeout(() => zoomShow(el, x, y), 90); });
document.addEventListener('mousemove', e => zoomPos(e.clientX, e.clientY));
document.addEventListener('mouseout', e => { const el = e.target.closest && e.target.closest(ZOOM_SEL); if (el && !el.contains(e.relatedTarget)) zoomHide(); });
document.addEventListener('mousedown', zoomHide); addEventListener('wheel', zoomHide, { passive:true });

// ---------- 单条混剪的右栏：字幕、片段、包装、音频、封面 ----------
Object.assign(S.mix, { st:subStyle(), pk:{ on:false, tpl:0, fTitle:'', fSub:'', fPoint:'' }, bgm:{ track:BGM_LIB[0], gain:-14, fi:.5, fo:1.5 }, nar:{ rate:1, gain:0 }, cover:coverState(1) });
S.mix.clips.forEach((c, i) => Object.assign(c, { rate:1, fz:1, fx:0, fy:0, inPt:i ? .3 : 0, srcDur:(c.t1 - c.t0) + (i ? 1.6 : 0) }));
// ---------- 点击 ----------
const STYLE_RESET = { 'mix.st':subStyle };
Object.assign(acts, {
  tog: t => { setP(t.dataset.k, !getP(t.dataset.k)); render(); },
  setv: t => { const v = t.dataset.v, n = Number(v); setP(t.dataset.k, v !== '' && !Number.isNaN(n) && !/^#/.test(v) ? n : v); render(); },
  styleReset: t => { setP(t.dataset.k, subStyle()); toast('字幕样式已恢复默认'); render(); },
  clipFrameReset: t => { const b = t.dataset.k; setP(`${b}.fz`, 1); setP(`${b}.fx`, 0); setP(`${b}.fy`, 0); render(); },
  fontPick: t => { S.pop = { kind:'font', k:t.dataset.k, none:!!t.dataset.none, q:'', rect:t.getBoundingClientRect(), alignRight:true }; renderPop(); const q = $('#pop [data-fpq]'); if (q) q.focus(); },
  fontSet: t => { const k = S.pop.k, v = t.dataset.v; setP(k, v); if (v) S.fonts.recent = [v, ...S.fonts.recent.filter(f => f !== v)].slice(0, 4); S.pop = null; render(); },
  fontFav: t => { const v = t.dataset.v, f = S.fonts.fav; S.fonts.fav = f.includes(v) ? f.filter(x => x !== v) : [...f, v]; renderPop(); },
  fontScan: () => toast('已重新扫描系统字体（示例）'),
  mixPack: () => { S.mix.pk.on = !S.mix.pk.on; render(); },
  mixTpl: t => { S.mix.pk.tpl = +t.dataset.i; render(); },
  packCover: () => { if (S.screen === 'mix') { seek(.4); if (filmEl) filmEl.pause(); S.mix.playing = false; } else { S.bt.t = .4; S.bt.playing = false; } toast('已跳到封面段中点并暂停'); render(); },
  packAsk: t => ask(t, t.dataset.v === 'layout' ? '恢复默认版式？' : '按当前口播重新提取卖点？', t.dataset.v === 'layout' ? '这个模板下手动调整的卖点位置与缩放会被清除，其他模板不受影响。' : '会清空手动修改的卖点与正片卖点布局，封面布局保留。', 'packDone', t.dataset.v === 'layout' ? '恢复' : '重新提取'),
  packDone: () => { S.pop = null; toast('已完成（示例）'); render(); },
  bgmPick: t => { const k = t.dataset.k; S.pop = { kind:'menu', id:`bgm:${k}`, rect:t.getBoundingClientRect() }; POPS[`bgm:${k}`] = () => ({ items:['无 BGM', ...BGM_LIB], cur:getP(k).track || '无 BGM', pick:v => { getP(k).track = v === '无 BGM' ? '' : v; } }); renderPop(); },
  bgmPlay: t => { S.bgmPlaying = S.bgmPlaying === t.dataset.k ? null : t.dataset.k; if (S.bgmPlaying) toast('原型里没有声音，正式版这里试听曲目'); render(); },
  coverOpen: t => { const scope = t.dataset.v, cv = scope === 'mix' ? S.mix.cover : btFilm().cover; S.coverEdit = { scope, draft:clone(cv), name:'' }; render(); },
  coverClose: () => { S.coverEdit = null; render(); },
  coverApply: () => { const e = S.coverEdit, cv = { ...e.draft, custom:true }; if (e.scope === 'mix') S.mix.cover = cv; else btFilm().cover = cv; S.coverEdit = null; toast('封面已应用，导出时生效'); render(); },
  coverPreset: t => { const p = [...COVER_PRESETS, ...S.coverPresets].find(x => x.name === t.dataset.v), d = S.coverEdit.draft; Object.assign(d.st.t1, p.t1); Object.assign(d.st.t2, p.t2); toast(`已在本地应用预设「${p.name}」，点击应用封面后才会保存`); render(); },
  coverPresetSave: () => { const e = S.coverEdit, n = (e.name || '').trim(); if (!n) return toast('请先输入预设名称'); S.coverPresets.push({ name:n, t1:{ color:e.draft.st.t1.color, sc:e.draft.st.t1.sc }, t2:{ color:e.draft.st.t2.color, sc:e.draft.st.t2.sc } }); e.name = ''; toast(`已保存预设「${n}」`); render(); },
  coverPresetDel: t => { S.coverPresets.splice(+t.dataset.i, 1); render(); },
});
// 滑杆和取色：拖动时局部更新，松手整页重绘
document.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.fpq !== undefined) { S.pop.q = t.value; const pos = t.value.length; renderPop(); const q = $('#pop [data-fpq]'); if (q) { q.focus(); q.setSelectionRange(pos, pos); } return; }
  const f = t.dataset.rng; if (!f) return;
  if (f === 'color') { const sw = t.closest('.sw-pick'); if (sw) sw.style.setProperty('--c', t.value); }
  else { const em = t.nextElementSibling; if (em) em.textContent = FMT[f](t.value); }
  liveStyle();
});
document.addEventListener('change', e => { if (e.target.dataset.rng) render(); });
function liveStyle() {
  $$('.st-prev').forEach(el => { const b = el.querySelector('b'), st = getP(el.dataset.st); if (b) b.setAttribute('style', styleCss(st, .21)); });
  if (typeof edLive === 'function') edLive();
  if (typeof btLive === 'function') btLive();
  if (S.coverEdit) { const c = $('.cv-canvas'); if (c) c.outerHTML = coverCanvas(S.coverEdit.draft); }
}
