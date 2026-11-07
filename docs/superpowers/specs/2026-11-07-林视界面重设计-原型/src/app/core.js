// 状态、路由、交互。两套方案共用；长相在各自的 Views 里。
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const ic = (n, c = '') => `<svg class="i ${c}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const fmtT = s => { const m = Math.floor(s / 60), x = s - m * 60; return `${String(m).padStart(2, '0')}:${x.toFixed(2).padStart(5, '0')}`; };
const newcap = () => `<span class="newcap" title="这个能力现在产品里没有，是这次设计提议新增的">新能力</span>`;
const clone = o => JSON.parse(JSON.stringify(o));

const prefs = (() => { try { return JSON.parse(localStorage.getItem('lins-vision-review') || '{}'); } catch { return {}; } })();
const isMac = /Mac/.test(navigator.platform || navigator.userAgent);

const S = {
  screen: 'home', role: 'member', pop: null, toast: '', flags: prefs.flags !== false,
  theme: prefs.theme || 'system', chrome: prefs.chrome || (isMac ? 'mac' : 'win'), font: prefs.font || (isMac ? 'native' : 'bundled'), accent: prefs.accent || 'blue', logo: prefs.logo || 'own',
  overviewEmpty: false, paused: false, projectsQ: '', batch: prefs.batch || '1',
  login: { mode: 'login', id: '', pw: '', pw2: '', pw3: '', remember: false, show: false, err: '', info: '' },
  scene: {
    cands: [{ id:'S1', img:'s1', mark:'ok', secs:41 }, { id:'S2', img:'s2', mark:'rework', secs:38 }, { id:'S3', img:'s3', mark:'none', secs:44 }, { id:'S4', img:'s4', mark:'ok', secs:41 }],
    sel: 'S4', ref: 'S4', view: 'grid', input: 0,
    inputs: [{ name:'实拍-w16.jpg', img:'real', size:'1800×1677' }, { name:'实拍-镜头01.jpg', img:'real1', size:'1400×1305' }, { name:'实拍-镜头02.jpg', img:'real2', size:'1400×1342' }],
    cat: '沙发', room: '客厅', prompt: '保持图中沙发的一致性不变，更换其他家具和软装布置，风格参考原图，让客厅温馨舒适，全景图',
    provider: PROVIDERS[0], count: 4, conc: 10,
  },
  mix: {
    step: 2, t: 0, playing: false, sel: { type:'sub', i:2 }, tab: 'sub', ratio: '3:4', view: 'film', zoom: 1, snap: true, tool: 'select', safe: false, scroll: 0,
    clips: clone(FILM.clips), subs: clone(FILM.subs), hist: [], fut: [], used: FILM.clips.map(() => true), voice: 0, script: FILM.subs.map(s => s.text).join('，') + '。',
    sub: { font: '思源黑体', size: 56, x: .5, y: .82, width: 864, stroke: true, color: '#FFFFFF' }, pack: false, tpl: 0,
    exp: { state: 'idle', i: 0, verdict: null },
  },
  tasks: { q: '', actor: '全部', status: '全部', sel: null },
  pools: clone(POOLS_FULL), poolOpen: '公司网关账号', poolQ: '',
  live: clone(LIVE),
};
const ROLE = { home:'member', scene:'member', mix:'member', projects:'member', mytasks:'member', step2:'member', step3:'member', step4:'member', usage:'member', overview:'admin', tasks:'admin', pools:'admin', aprojects:'admin', settings:'admin', resources:'admin', users:'admin', ausage:'admin', ops:'admin' };
const CURRENT = { scene:'projects', step2:'projects', step3:'projects', step4:'projects', mix:'projects' };
const navCurrent = () => CURRENT[S.screen] || S.screen;

function savePrefs() { try { localStorage.setItem('lins-vision-review', JSON.stringify({ theme: S.theme, chrome: S.chrome, font: S.font, accent: S.accent, flags: S.flags, logo: S.logo, batch: S.batch })); } catch { /* 预览里存不了也没关系 */ } }
function applyHtml() {
  const d = document.documentElement, dark = S.theme === 'dark' || (S.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  d.dataset.theme = dark ? 'dark' : 'light'; d.dataset.chrome = S.chrome; d.dataset.font = SCHEME.compactReview ? (S.chrome === 'win' ? 'bundled' : 'native') : S.font; d.dataset.accent = SCHEME.compactReview ? 'blue' : S.accent; d.dataset.flags = S.flags ? 'on' : 'off';
  d.dataset.screen = S.screen;
}

// 成片播放器只建一个，重绘时搬回去，播放不断
let filmEl = null;
function film() {
  if (!filmEl) {
    filmEl = document.createElement('video'); filmEl.src = A.film; filmEl.playsInline = true; filmEl.preload = 'auto'; filmEl.id = 'film';
    filmEl.addEventListener('ended', () => { S.mix.playing = false; render(); });
  }
  return filmEl;
}

function render() {
  applyHtml();
  const view = Views[S.screen] || Views.placeholder;
  const tlEl = $('.tl-scroll'); if (tlEl) S.mix.scroll = tlEl.scrollLeft;
  const keep = {}; $$('[data-keep-scroll]').forEach(el => { keep[el.dataset.keepScroll] = el.scrollTop; });
  $('#app').innerHTML = view();
  $$('[data-keep-scroll]').forEach(el => { if (keep[el.dataset.keepScroll]) el.scrollTop = keep[el.dataset.keepScroll]; });
  const slot = $('#film-slot'); if (slot) slot.append(film());
  const tl = $('.tl-scroll'); if (tl) { const f = (tl.clientWidth - 26) / FILM.dur; if (Math.abs(f - (S.mix.fit || 0)) > .5) { S.mix.fit = f; return render(); } tl.scrollLeft = S.mix.scroll; }
  renderReview(); renderPop(); renderToast();
  if (Views.after) Views.after();
  syncTime();
}
function softRender() { const a = document.activeElement; if (a && /INPUT|TEXTAREA/.test(a.tagName) && a.type !== 'checkbox') { softRender.pending = true; return; } render(); }
addEventListener('focusout', () => { if (softRender.pending) { softRender.pending = false; setTimeout(render, 0); } });

function go(screen, opt = {}) {
  if (filmEl && !filmEl.paused) { filmEl.pause(); S.mix.playing = false; }
  S.screen = screen; S.pop = null; if (ROLE[screen]) S.role = ROLE[screen];
  if (screen === 'mix' && !S.mix.touched) { S.mix.touched = true; S.mix.t = S.mix.subs[S.mix.sel.i].t0 + .6; const v = film(); const set = () => { try { v.currentTime = S.mix.t; } catch { /* 还没就绪 */ } }; if (v.readyState > 0) set(); else v.addEventListener('loadedmetadata', set, { once: true }); }
  if (opt.role) S.role = opt.role;
  history.replaceState(null, '', '#' + screen);
  render();
  if (typeof onEnter === 'function') onEnter(screen);
  const m = $('[data-scroll-top]'); if (m) m.scrollTop = 0;
}
function toast(msg) { S.toast = msg; renderToast(); clearTimeout(toast.t); toast.t = setTimeout(() => { S.toast = ''; renderToast(); }, 3200); }
function renderToast() { const el = $('#toast'); el.textContent = S.toast; el.className = S.toast ? 'on' : ''; }

// 弹出菜单
const POPS = {
  'scene.cat': () => ({ items: ['沙发','床','床垫','餐桌','电视柜'], cur: S.scene.cat, pick: v => { S.scene.prompt = S.scene.prompt.split(S.scene.cat).join(v); S.scene.cat = v; } }),
  'scene.room': () => ({ items: ['客厅','卧室','书房','餐厅'], cur: S.scene.room, pick: v => { S.scene.prompt = S.scene.prompt.split(S.scene.room).join(v); S.scene.room = v; } }),
  'scene.provider': () => ({ items: PROVIDERS, cur: S.scene.provider, pick: v => { S.scene.provider = v; } }),
  'tasks.actor': () => ({ items: ['全部','PUIKIN','ALAN','可华','强尼'], cur: S.tasks.actor, pick: v => { S.tasks.actor = v; } }),
  'tasks.status': () => ({ items: ['全部', ...Object.values(STATUS).map(s => s[0])], cur: S.tasks.status, pick: v => { S.tasks.status = v; } }),
  'mix.font': () => ({ items: ['思源黑体','思源宋体','霞鹜文楷','得意黑'], cur: S.mix.sub.font, pick: v => { S.mix.sub.font = v; } }),
};
function renderPop() {
  const el = $('#pop'); const p = S.pop;
  if (!p) { el.innerHTML = ''; el.className = ''; return; }
  el.className = 'on'; let html = '';
  if (p.kind === 'menu') {
    const m = POPS[p.id](); html = `<div class="menu">${m.items.map(v => `<button class="menu-it ${v === m.cur ? 'cur' : ''}" data-act="popPick" data-v="${esc(v)}">${v === m.cur ? ic('check') : '<i class="menu-sp"></i>'}<span>${esc(v)}</span></button>`).join('')}</div>`;
  } else if (p.kind === 'user') {
    const admin = S.role === 'admin';
    html = `<div class="menu menu-user"><div class="menu-who"><b>${admin ? '系统管理员' : 'PUIKIN'}</b><small>工号 ${admin ? '0001，管理员' : '0102，创作成员'}</small></div>
      <div class="menu-theme"><span>外观</span><div class="mini-seg">${[['system','跟随系统'],['light','浅色'],['dark','深色']].map(([v, l]) => `<button class="${S.theme === v ? 'on' : ''}" data-act="setTheme" data-v="${v}">${l}</button>`).join('')}</div></div>
      <hr><button class="menu-it" data-act="go" data-v="account">${ic('key')}<span>修改密码</span></button><button class="menu-it" data-act="go" data-v="recycle">${ic('trash')}<span>回收站</span></button>
      <button class="menu-it" data-act="switchRole">${ic('users')}<span>切到${admin ? '员工' : '管理员'}视角（评审用）</span></button>
      <hr><button class="menu-it" data-act="logout">${ic('power')}<span>退出登录</span></button><p class="menu-hint">关闭窗口不会中断服务器任务</p></div>`;
  } else if (p.kind === 'log') {
    html = `<div class="menu menu-log"><h5>运行日志</h5>${LOGS.map(([t, m]) => `<p><time>${t}</time>${esc(m)}</p>`).join('')}</div>`;
  } else if (p.kind === 'info') {
    const pr = S.project || { store:'B店', model:'LH122K3', sub:'B1', type:'AI种草', editor:'PUIKIN' };
    html = `<div class="menu menu-log"><h5>项目信息</h5><dl><dt>店铺</dt><dd>${esc(pr.store)}</dd><dt>型号</dt><dd>${esc(pr.model)}</dd><dt>子型号</dt><dd>${esc(pr.sub || '无')}</dd><dt>生产类型</dt><dd>${esc(pr.type)}</dd><dt>剪辑师</dt><dd>${esc(pr.editor)}</dd><dt>输出画幅</dt><dd>3:4 1728×2304</dd></dl></div>`;
  } else if (p.kind === 'pause') {
    html = `<div class="menu menu-log menu-confirm"><h5>${S.paused ? '恢复运行？' : '暂停运行？'}</h5><p class="plain">${S.paused ? '恢复后新的生成任务开始排队执行。' : '暂停后不再开始新的付费生成；已提交任务继续收取结果。成员仍可登录、编辑和下载。'}</p><div class="menu-acts"><button class="menu-btn" data-act="popClose">取消</button><button class="menu-btn pri" data-act="togglePause">${S.paused ? '恢复运行' : '暂停运行'}</button></div></div>`;
  }
  else if (p.kind === 'confirm') {
    html = `<div class="menu menu-log menu-confirm"><h5>${p.title}</h5><div class="plain">${p.body}</div><div class="menu-acts"><button class="menu-btn" data-act="popClose">取消</button><button class="menu-btn pri" data-act="${p.okAct}">${p.okLabel}</button></div></div>`;
  }
  if (!html && typeof popHook === 'function') html = popHook(p) || '';
  el.innerHTML = html;
  const box = el.firstElementChild, r = p.rect, w = box.offsetWidth, h = box.offsetHeight;
  let x = p.alignRight ? r.right - w : r.left, y = r.bottom + 5;
  if (y + h > innerHeight - 44) y = Math.max(8, r.top - h - 5);
  x = Math.min(Math.max(8, x), innerWidth - w - 8);
  box.style.left = x + 'px'; box.style.top = y + 'px';
}
function openPop(kind, t, id) { S.pop = { kind, id, rect: t.getBoundingClientRect(), alignRight: kind !== 'menu' }; renderPop(); }

// 候选生成模拟
const GEN_POOL = ['n1','n2','n3','n4','s1','s3','s2','s4'];
let genSeq = 0;
function startGen(n, fromSel) {
  const sc = S.scene; const start = sc.cands.length;
  for (let i = 0; i < n; i++) {
    const id = 'S' + (sc.cands.length + 1); const c = { id, img: null, mark: 'none', secs: 0, running: true };
    sc.cands.push(c);
    const dur = 2600 + Math.random() * 3600 + i * 500;
    setTimeout(() => { c.running = false; c.img = GEN_POOL[genSeq++ % GEN_POOL.length]; c.secs = Math.round(dur / 100); if (S.screen === 'scene') softRender(); }, dur);
  }
  sc.sel = sc.cands[start].id;
  toast(fromSel ? `按 ${fromSel} 的参数重新生成，已加入队列` : `已提交 ${n} 张，关掉窗口也不会停`);
  render();
}
const sceneCounts = () => { const c = S.scene.cands; return { run: c.filter(x => x.running).length, ok: c.filter(x => !x.running).length, total: c.length }; };

// 混剪时间线
function pushHist() { const m = S.mix; m.hist.push(clone(m.clips)); m.fut = []; }
function seek(t) { const v = film(); t = Math.max(0, Math.min(FILM.dur - .01, t)); S.mix.t = t; try { v.currentTime = t; } catch { /* 还没加载好 */ } syncTime(); }
function pxPerSec() { return (S.mix.fit || 52) * S.mix.zoom; }
function syncTime() {
  if (S.screen !== 'mix') return;
  const m = S.mix, v = filmEl; const t = v && !v.seeking && v.readyState > 0 ? v.currentTime : m.t; m.t = t;
  const h = $('.tl-head'); if (h) h.style.transform = `translateX(${t * pxPerSec()}px)`;
  $$('[data-time]').forEach(el => { el.textContent = fmtT(t); });
  const curClip = m.clips.findIndex(c => t >= c.t0 && t < c.t1), curSub = m.subs.findIndex(c => t >= c.t0 && t < c.t1);
  $$('.tl-clip').forEach((el, i) => el.classList.toggle('cur', i === curClip));
  $$('.tl-sub').forEach((el, i) => el.classList.toggle('cur', i === curSub));
  $$('.lib-it').forEach((el, i) => el.classList.toggle('cur', i === curClip));
}
(function tick() { if (S.mix.playing) syncTime(); requestAnimationFrame(tick); })();

function waveBars(h, alpha = 1) {
  const pts = WAVE, w = FILM.dur * pxPerSec(), step = 3, n = Math.floor(w / step); let d = '';
  for (let i = 0; i < n; i++) { const a = pts[Math.floor(i / n * pts.length)] * alpha * (h / 2 - 1); d += `M${i * step} ${h / 2 - a}V${h / 2 + a}`; }
  return `<svg class="tl-wave" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path d="${d}"/></svg>`;
}
function timelineHTML() {
  const m = S.mix, pps = pxPerSec(), w = FILM.dur * pps; let ticks = '';
  const every = pps < 46 ? 2 : 1;
  for (let s = 0; s <= FILM.dur; s++) ticks += `<i class="tk ${s % every ? 'minor' : ''}" style="left:${s * pps}px">${s % every ? '' : `<em>${s}s</em>`}</i>`;
  return `<div class="tl-labels"><span class="tl-gut"></span><span class="tl-lab">字幕</span><span class="tl-lab v">视频</span><span class="tl-lab">配音</span><span class="tl-lab">配乐</span></div>
  <div class="tl-scroll"><div class="tl-canvas" style="width:${w + 40}px">
    <div class="tl-ruler" data-scrub>${ticks}</div>
    <div class="tl-row"><div class="tl-track">${m.subs.map((s, i) => `<button class="tl-sub ${m.sel.type === 'sub' && m.sel.i === i ? 'sel' : ''}" data-act="mixSel" data-type="sub" data-i="${i}" style="left:${s.t0 * pps}px;width:${(s.t1 - s.t0) * pps - 2}px" title="${esc(s.text)}">${esc(s.text)}</button>`).join('')}</div></div>
    <div class="tl-row v"><div class="tl-track">${m.clips.map((c, i) => `<button class="tl-clip ${c.cover ? 'cover' : ''} ${m.sel.type === 'clip' && m.sel.i === i ? 'sel' : ''}" data-act="mixSel" data-type="clip" data-i="${i}" style="left:${c.t0 * pps}px;width:${(c.t1 - c.t0) * pps - 2}px;background-image:url(${A[c.img]})" title="${esc(c.name)}"><span>${c.cover ? '封面' : `${(c.t1 - c.t0).toFixed(1)}s`}</span></button>`).join('')}</div></div>
    <div class="tl-row"><div class="tl-track tl-audio">${waveBars(34)}</div></div>
    <div class="tl-row"><div class="tl-track tl-audio bgm">${waveBars(24, .42)}</div></div>
    <div class="tl-head"><b></b></div>
  </div></div>`;
}

// 派生数据
const statusLabel = s => (STATUS[s] || [s])[0];
const statusKind = s => (STATUS[s] || [0, 'off'])[1];
function taskList() {
  const q = S.tasks.q.trim().toLowerCase(); let list = S.taskData;
  if (S.screen === 'mytasks') list = list.filter(t => t.actor === 'PUIKIN');
  if (S.screen === 'errors') list = list.filter(t => t.status === 'failed' || t.status === 'unknown' || t.status === 'maybe_sent');
  if (S.tasks.actor !== '全部' && S.screen === 'tasks') list = list.filter(t => t.actor === S.tasks.actor);
  if (S.tasks.status !== '全部') list = list.filter(t => statusLabel(t.status) === S.tasks.status);
  if (q) list = list.filter(t => [t.mod, t.step, t.proj, t.actor, t.model, t.id].join(' ').toLowerCase().includes(q));
  return list;
}
S.taskData = clone(TASKS);
function metrics() {
  if (S.overviewEmpty) return { run: 0, wait: 0, done: 0, check: 0 };
  const c = k => S.taskData.filter(t => k.includes(t.status)).length;
  return { run: c(['admitted', 'maybe_sent', 'accepted']) + 7, wait: c(['pending', 'deferred']) + 2, done: 86, check: c(['unknown', 'reconciling']) + 1 };
}
const poolCounts = () => ({ ready: S.pools.filter(p => p.state === 'ready').length, missing: S.pools.filter(p => p.state === 'missing').length, cred: S.pools.filter(p => p.state === 'credential').length });

// 所有点击
const acts = {
  go: t => go(t.dataset.v),
  popClose: () => { S.pop = null; renderPop(); },
  popPick: t => { POPS[S.pop.id]().pick(t.dataset.v); S.pop = null; render(); },
  sel: t => openPop('menu', t, t.dataset.v),
  userMenu: t => openPop('user', t),
  logMenu: t => openPop('log', t),
  infoMenu: t => openPop('info', t),
  setTheme: t => { S.theme = t.dataset.v; savePrefs(); const p = S.pop; render(); S.pop = p; renderPop(); },
  switchRole: () => go(S.role === 'admin' ? 'home' : 'overview'),
  logout: () => { S.login = { mode:'login', id:'', pw:'', pw2:'', pw3:'', remember:false, show:false, err:'', info:'' }; go('login'); },
  toastMsg: t => toast(t.dataset.v),
  // 登录
  loginCheck: t => { S.login[t.dataset.k] = !S.login[t.dataset.k]; render(); },
  loginSubmit: () => {
    const l = S.login; l.err = ''; l.info = '';
    if (l.mode === 'login') {
      if (!l.id.trim()) { l.err = '请输入工号'; return render(); }
      if (!l.pw) { l.err = '请输入密码或 6 位一次性密码'; return render(); }
      if (/^\d{6}$/.test(l.pw)) { l.mode = 'change'; l.pw2 = ''; l.pw3 = ''; return render(); }
      return go(l.id.trim() === '0001' ? 'overview' : 'home');
    }
    if (l.pw2.length < 6) { l.err = '新密码至少 6 位，可以使用 6 位数字'; return render(); }
    if (l.pw2 !== l.pw3) { l.err = '两次输入的新密码不一致'; return render(); }
    l.mode = 'login'; l.pw = ''; l.info = '密码已修改，请使用新密码重新登录。'; render();
  },
  // 第一步
  sceneSel: t => { S.scene.sel = t.dataset.id; render(); },
  sceneMark: t => { const c = S.scene.cands.find(x => x.id === S.scene.sel); if (!c || c.running) return; const v = t.dataset.v; c.mark = c.mark === v ? 'none' : v; render(); },
  sceneRef: () => { const c = S.scene.cands.find(x => x.id === S.scene.sel); if (!c || c.running) return; S.scene.ref = c.id; toast(`${c.id} 已设为场景参考图，第 2 步分镜会参考它`); render(); },
  sceneView: t => { S.scene.view = t.dataset.v; render(); },
  sceneInput: t => { S.scene.input = +t.dataset.i; render(); },
  sceneUpload: () => $('#file-pick').click(),
  sceneGen: () => startGen(S.scene.count),
  sceneRegen: () => { const c = S.scene.cands.find(x => x.id === S.scene.sel); startGen(1, c && c.id); },
  sceneStep: t => { const [k, d] = [t.dataset.k, +t.dataset.d]; const max = k === 'count' ? 9 : 10; S.scene[k] = Math.max(1, Math.min(max, S.scene[k] + d)); render(); },
  sceneDl: () => toast('原型里不真的下载。正式版存到客户端设置的下载目录。'),
  // 混剪
  mixStep: t => { if (filmEl) filmEl.pause(); S.mix.playing = false; S.mix.step = +t.dataset.v; render(); },
  mixPlay: () => { const v = film(), m = S.mix; if (v.paused) { if (v.currentTime >= FILM.dur - .05) v.currentTime = 0; v.play().catch(() => toast('浏览器拦下了自动播放，再点一次')); m.playing = true; } else { v.pause(); m.playing = false; } render(); },
  mixSel: t => { const m = S.mix, i = +t.dataset.i, type = t.dataset.type; m.sel = { type, i }; m.tab = type === 'clip' ? 'clip' : 'sub'; const src = type === 'clip' ? m.clips[i] : m.subs[i]; if (src && !m.playing) seek(src.t0 + .02); render(); },
  mixTab: t => { S.mix.tab = t.dataset.v; render(); },
  mixTool: t => { S.mix.tool = t.dataset.v; render(); },
  mixSnap: () => { S.mix.snap = !S.mix.snap; render(); },
  mixSafe: () => { S.mix.safe = !S.mix.safe; render(); },
  mixRatio: t => { S.mix.ratio = t.dataset.v; render(); },
  mixView: t => { S.mix.view = t.dataset.v; render(); },
  mixSplit: () => {
    const m = S.mix, t = m.t, i = m.clips.findIndex(c => t > c.t0 + .1 && t < c.t1 - .1);
    if (i < 0 || m.clips[i].cover) return toast('把播放头移到片段中间再分割');
    pushHist(); const c = m.clips[i]; m.clips.splice(i, 1, { ...c, t1: t }, { ...c, t0: t, name: c.name + ' 后半' }); m.sel = { type:'clip', i: i + 1 }; m.tab = 'clip'; render();
  },
  mixUndo: () => { const m = S.mix; if (!m.hist.length) return; m.fut.push(clone(m.clips)); m.clips = m.hist.pop(); render(); },
  mixRedo: () => { const m = S.mix; if (!m.fut.length) return; m.hist.push(clone(m.clips)); m.clips = m.fut.pop(); render(); },
  mixPack: () => { S.mix.pack = !S.mix.pack; render(); },
  mixTpl: t => { S.mix.tpl = +t.dataset.i; render(); },
  mixStroke: () => { S.mix.sub.stroke = !S.mix.sub.stroke; render(); },
  mixUsed: t => { const m = S.mix, i = +t.dataset.i; if (m.used.filter(Boolean).length === 1 && m.used[i]) return toast('至少保留一个视频才能继续'); m.used[i] = !m.used[i]; render(); },
  mixVoice: t => { S.mix.voice = +t.dataset.i; render(); },
  mixExport: () => {
    const e = S.mix.exp; e.state = 'run'; e.i = 0; e.verdict = null; render();
    const step = () => { if (e.state !== 'run') return; e.i++; if (e.i >= EXPORT_STAGES.length) { e.state = 'done'; toast('导出完成，已写回项目'); } if (S.screen === 'mix') softRender(); if (e.state === 'run') setTimeout(step, 620); };
    setTimeout(step, 620);
  },
  mixVerdict: t => { S.mix.exp.verdict = t.dataset.v; toast(t.dataset.v === 'pass' ? '这一版已通过，可以交付' : '已标记重做，回到预览调整'); if (t.dataset.v !== 'pass') { S.mix.step = 2; S.mix.exp.state = 'idle'; } render(); },
  // 控制台
  overviewRow: t => { S.tasks.sel = t.dataset.id; go('tasks'); },
  pauseAsk: t => openPop('pause', t),
  togglePause: () => { S.paused = !S.paused; S.pop = null; toast(S.paused ? '已暂停，新生成任务等待中' : '已恢复运行'); render(); },
  taskSel: t => { const id = t.dataset.id; S.tasks.sel = S.tasks.sel === id ? null : id; render(); },
  taskRetry: t => { const x = S.taskData.find(y => y.id === t.dataset.id); x.status = 'pending'; x.err = null; x.calls = [{ state:'not_sent', time:'刚刚', model:null }]; toast('已重新加入队列'); render(); },
  taskClearFilter: () => { S.tasks.q = ''; S.tasks.actor = '全部'; S.tasks.status = '全部'; render(); },
  poolOpen: t => { const k = t.dataset.k; S.poolOpen = S.poolOpen === k ? null : k; render(); },
  poolStep: t => { const p = S.pools.find(x => x.name === t.dataset.n); p.cap = Math.max(0, (+p.cap || 0) + +t.dataset.d); p.dirty = true; render(); },
  poolToggle: t => { const p = S.pools.find(x => x.name === t.dataset.n); p.on = !p.on; p.dirty = true; render(); },
  poolSave: t => { const p = S.pools.find(x => x.name === t.dataset.n); p.cap = Math.max(0, +p.cap || 0); p.dirty = false; p.state = p.state === 'credential' ? 'credential' : !p.on ? 'off' : p.cap > 0 ? 'ready' : 'missing'; toast(p.state === 'ready' ? `已保存。${p.name}同时能跑 ${p.cap} 条，正在跑的任务不受影响。` : '已保存。'); render(); },
  // 评审条
  rvScreen: t => go(t.dataset.v),
  rvSet: t => { S[t.dataset.k] = t.dataset.v; savePrefs(); render(); },
  rvFlags: () => { S.flags = !S.flags; savePrefs(); render(); },
  rvEmpty: t => { S.overviewEmpty = t.dataset.v === '1'; render(); },
};
document.addEventListener('click', e => {
  const t = e.target.closest('[data-act]');
  if (!t) { if (S.pop && !e.target.closest('#pop')) { S.pop = null; renderPop(); } return; }
  const inPop = e.target.closest('#pop');
  if (S.pop && !inPop && t.dataset.act !== 'sel' && t.dataset.act !== 'userMenu') S.pop = null;
  e.preventDefault();
  const fn = acts[t.dataset.act]; if (fn) fn(t, e);
});
document.addEventListener('input', e => {
  const t = e.target, b = t.dataset.bind;
  if (t.dataset.dirty) { const p = S.pools.find(x => x.name === t.dataset.dirty); if (p) { p.cap = t.value; if (!p.dirty) { p.dirty = true; const pos = t.value.length; render(); const again = $(`[data-dirty="${p.name}"]`); if (again) { again.focus(); again.setSelectionRange(pos, pos); } } } return; }
  if (!b) return;
  const path = b.split('.'); let o = S; while (path.length > 1) o = o[path.shift()];
  o[path[0]] = t.type === 'number' || t.type === 'range' ? +t.value : t.value;
  if (t.dataset.live) { if (b === 'mix.zoom') { const s = $('.tl-scroll'); if (s) S.mix.scroll = s.scrollLeft; } render(); const again = $(`[data-bind="${b}"]`); if (again && t.dataset.live === 'text') { again.focus(); again.setSelectionRange && again.setSelectionRange(t.value.length, t.value.length); } }
});
document.addEventListener('keydown', e => {
  const typing = /INPUT|TEXTAREA/.test(document.activeElement.tagName);
  if (e.key === 'Escape' && S.pop) { S.pop = null; renderPop(); }
  if (e.key === 'Enter' && S.screen === 'login' && typing) { e.preventDefault(); acts.loginSubmit(); return; }
  if (typing) return;
  if (typeof keyHook === 'function' && keyHook(e)) return;
  if (e.code === 'Space' && S.screen === 'mix' && S.mix.step === 2) { e.preventDefault(); acts.mixPlay(); }
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    if (S.screen === 'scene') { const c = S.scene.cands, i = c.findIndex(x => x.id === S.scene.sel), d = e.key === 'ArrowRight' ? 1 : -1; S.scene.sel = c[(i + d + c.length) % c.length].id; render(); return; }
    const list = SCREENS.map(s => s[0]); const i = list.indexOf(S.screen); if (i < 0) return;
    go(list[(i + (e.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length]);
  }
});
// 拖播放头
let scrubbing = false;
function scrubAt(x) { const c = $('.tl-canvas'); if (!c) return; seek((x - c.getBoundingClientRect().left) / pxPerSec()); }
document.addEventListener('mousedown', e => { if (e.target.closest('[data-scrub]')) { scrubbing = true; scrubAt(e.clientX); e.preventDefault(); } });
document.addEventListener('mousemove', e => { if (scrubbing) scrubAt(e.clientX); });
document.addEventListener('mouseup', () => { scrubbing = false; });
addEventListener('resize', () => { if (Views.after) Views.after(); if (S.pop) { S.pop = null; renderPop(); } });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (S.theme === 'system') render(); });

// 真能选本机图片
document.addEventListener('change', e => {
  if (e.target.id !== 'file-pick') return;
  const f = e.target.files[0]; if (!f) return;
  const key = 'up' + Date.now(); A[key] = URL.createObjectURL(f);
  S.scene.inputs.push({ name: f.name, img: key, size: `${Math.round(f.size / 1024)} KB` }); S.scene.input = S.scene.inputs.length - 1; render();
});

// 生产进度慢慢走，不重绘
setInterval(() => {
  S.live.forEach((l, i) => { l.p = l.p >= 99 ? 12 : l.p + (i % 2 ? 1 : 2); });
  $$('[data-live-bar]').forEach(el => { const l = S.live[+el.dataset.liveBar]; if (l) el.style.width = l.p + '%'; });
  $$('[data-live-num]').forEach(el => { const l = S.live[+el.dataset.liveNum]; if (l) el.textContent = l.p + '%'; });
}, 1600);

// 评审条：不属于设计本身
function renderReview() {
  const seg = (k, opts) => `<div class="rv-seg">${opts.map(([v, l]) => `<button class="${S[k] === v ? 'on' : ''}" data-act="rvSet" data-k="${k}" data-v="${v}">${l}</button>`).join('')}</div>`;
  const other = SCHEME.other ? `<a class="rv-link" href="${SCHEME.other.file}#${S.screen}">切到${SCHEME.other.name}</a>` : '';
  const controls = SCHEME.compactReview
    ? `${seg('batch', [['1','第一批'],['2','加新能力']])}${seg('theme', [['system','系统'],['light','浅'],['dark','深']])}${seg('chrome', [['mac','Mac 样子'],['win','Windows 样子']])}`
    : `${seg('theme', [['system','系统'],['light','浅'],['dark','深']])}
    ${seg('chrome', [['mac','Mac 窗口'],['win','Windows 窗口']])}
    ${SCHEME.hasNativeFont ? seg('font', [['native','Mac 字体'],['bundled','Windows 字体']]) : ''}
    ${SCHEME.hasAccent ? seg('accent', [['blue','蓝'],['green','绿'],['graphite','灰']]) : ''}
    ${SCHEME.hasLogoSwitch ? seg('logo', [['own','L 标志'],['leaf','叶子标志']]) : ''}
    <button class="rv-flag ${S.flags ? 'on' : ''}" data-act="rvFlags">标新能力</button>`;
  $('#review').innerHTML = `<b class="rv-name">${SCHEME.name}</b>
    <div class="rv-tabs">${SCREENS.map(([v, l], i) => `<button class="${S.screen === v ? 'on' : ''}" data-act="rvScreen" data-v="${v}">${i + 1} ${l}</button>`).join('')}</div>
    <span class="rv-sp"></span>
    ${S.screen === 'overview' ? `<div class="rv-seg"><button class="${S.overviewEmpty ? '' : 'on'}" data-act="rvEmpty" data-v="0">有数据</button><button class="${S.overviewEmpty ? 'on' : ''}" data-act="rvEmpty" data-v="1">全是 0</button></div>` : ''}
    ${controls}
    ${other}`;
}

function boot() {
  for (const k of Object.keys(A)) {
    const d = A[k]; if (!d.startsWith('data:')) continue;
    const [h, b] = d.split(','); const bin = atob(b); const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    A[k] = URL.createObjectURL(new Blob([u], { type: h.match(/data:(.*?);/)[1] }));
  }
  const h = location.hash.slice(1); const known = [...SCREENS.map(s => s[0]), ...Object.keys(PLACEHOLDER), 'projects', 'mytasks', 'errors'];
  const start = known.includes(h) ? h : 'home'; if (ROLE[start]) S.role = ROLE[start];
  go(start);
}
window.__S = S; window.__go = go;
