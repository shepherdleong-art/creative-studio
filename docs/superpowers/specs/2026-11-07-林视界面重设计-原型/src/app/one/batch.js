// 批量生产：在第 5 步「智能混剪」里切到「批量生产」。四步：准备素材、脚本与口播、检查成片、导出成片。
// 结构和文案对齐 components/batch-production/；示例成片用 9 段真实分镜视频按脚本拼出来，没有配音。
SCREENS.splice(SCREENS.findIndex(s => s[0] === 'mix') + 1, 0, ['batch','批量']);
ROLE.batch = 'member'; CURRENT.batch = 'projects';
const BT_FILE = { 1:'01-分镜-全景', 2:'02-分镜-侧角全景', 3:'03-分镜-扶手细节', 4:'04-分镜-坐垫下结构', 5:'05-分镜-踩踏承重', 6:'06-分镜-舒展', 7:'07-分镜-半躺', 8:'08-分镜-坐姿', 9:'09-分镜-收尾' };
const BT_SRC = { 1:5, 2:4, 3:4, 4:4, 5:4, 6:5, 7:5, 8:5, 9:5 };
const BT_OPEN = [1, 2];
const BT_SCRIPTS = [...SC_PLANS, SC_EXTRA].map((p, i) => ({ id:`s${i + 1}`, name:p.name, src:i < 3 ? '项目脚本' : '手动', target:15, text:p.text, title:p.title, sub:p.sub }));
const BT_STAGES = ['生成口播', '匹配画面语义', '自动配画面', '生成封面'];
const BT_DUR = 19; // 时间轴统一刻度（秒）
const BT_VOICES = [['温柔知性女声','自然，适合家居种草'],['活力少女音','轻快，适合新品'],['沉稳男声','讲工艺和材质'],['亲切邻家女声','日常分享']];
const BT_STATUS = { 待确认:'wait', 生产中:'run', 部分完成:'warn', 已完成:'ok', 失败:'bad' };

function btSubs(text, t0, t1) {
  const parts = text.split(/[，。！？、]/).map(s => s.trim()).filter(Boolean), total = parts.reduce((a, s) => a + s.length, 0);
  let t = t0; return parts.map(s => { const d = (t1 - t0) * s.length / total, o = { t0:t, t1:t + d, text:s }; t += d; return o; });
}
function btPoints(si, t0, nar) { const uses = (si < 3 ? SC_PLANS[si] : SC_EXTRA).uses, step = nar / uses.length; return uses.map((u, j) => ({ t0:t0 + .4 + j * step, t1:t0 + .4 + j * step + Math.min(2.2, step - .3), text:SC_POINTS[u].t.replace(/ /g, ''), x:.5, y:.66 })); }
function btMakeFilm(si, copy, seq, extra = {}) {
  const s = BT_SCRIPTS[si], cover = 20 / 24, nar = scCount(s.text) / 4.2, each = nar / seq.length;
  let t = cover;
  const clips = seq.map(k => { const c = { k, t0:t, t1:t + each, inPt:.3, srcDur:BT_SRC[k], rate:1, fz:1, fx:0, fy:0, img:`p${k}`, name:`${BT_FILE[k]}.mp4`, src:k <= 2 ? '开场素材库' : '正文素材库' }; t += each; return c; });
  return { id:`f${si + 1}${copy}`, si, copy, clips, subs:btSubs(s.text, cover, cover + nar), points:btPoints(si, cover, nar), dur:cover + nar, status:'待审核', err:'', vis:true, chk:false, exp:'未导出', cover:{ ...coverState(seq[1] || seq[0]), t1:s.title, t2:s.sub }, pk:{ on:true, tpl:0, fTitle:'', fSub:'', fPoint:'' }, style:null, bgm:{ track:BGM_LIB[si % 2], gain:-14, fi:.5, fo:1.5 }, nar:{ rate:1, gain:0 }, ...extra };
}
const btCfg = () => ({ mats:range(1, 9).map(k => ({ k, on:true, ex:false, reason:'' })), scripts:[{ id:'s1', on:true, n:2 }, { id:'s2', on:true, n:2 }, { id:'s3', on:true, n:2 }, { id:'s4', on:false, n:1 }], voice:{ prov:'Qwen3 TTS', rate:1, v:0 }, style:subStyle(), ct:{ mode:'preset' }, bgm:{ picks:[], gain:-14, fi:.5, fo:1.5 }, confirmed:false });
const btSampleFilms = () => [
  btMakeFilm(0, 'A', [1, 4, 5, 3, 6, 9], { status:'已通过', exp:'已导出' }),
  btMakeFilm(0, 'B', [2, 3, 4, 8, 5, 9]),
  btMakeFilm(1, 'A', [1, 7, 8, 6, 5], { status:'已通过', exp:'修改未导出' }),
  btMakeFilm(1, 'B', [2, 6, 7, 9, 8]),
  btMakeFilm(2, 'A', [1, 3, 4, 5, 4]),
  btMakeFilm(2, 'B', [2, 4, 3, 6, 5], { status:'失败', err:'配音失败：配音服务超时' }),
];
S.bt = {
  cur:'b1', step:2, zoom:1, pv:null, q:'', showArch:false, newName:'', sel:0, clip:null, filter:'all', t:1.3, playing:false, pool:'body', hl:null, tab:'pack', tool:'select', snap:true, hist:[], fut:[], srcK:null, trimIn:null, expFilter:'all', adv:false, an:'GPT-5-6-Luna-Standard', scriptOpen:null,
  batches:[
    { id:'b1', name:'11 月首批口播', status:'部分完成', locked:true, elapsed:'12 分 40 秒', exportTime:'3 分 05 秒', cfg:{ ...btCfg(), confirmed:true }, films:btSampleFilms() },
    { id:'b2', name:'11 月第二批', status:'待确认', locked:false, cfg:btCfg(), films:[] },
    { id:'b3', name:'10 月返场测试', status:'已完成', locked:true, archived:true, cfg:{ ...btCfg(), confirmed:true }, films:btSampleFilms().map(f => ({ ...f, status:'已通过', exp:'已导出', err:'' })) },
  ],
};
const btIdx = () => S.bt.batches.findIndex(b => b.id === S.bt.cur);
const btB = () => S.bt.batches[btIdx()];
const btBase = () => `bt.batches.${btIdx()}`;
const btFilms = () => btB().films;
const btFilm = () => btFilms()[S.bt.sel] || btFilms()[0];
const btFilmName = f => `成片 ${f.si + 1}${f.copy}`;
const btDup = f => { const n = {}; f.clips.forEach(c => { n[c.k] = (n[c.k] || 0) + 1; }); return n; };
const btTime = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
const btUsage = k => { let n = 0; const films = new Set(); btFilms().forEach(f => f.clips.forEach(c => { if (c.k === k) { n++; films.add(f.id); } })); return [n, films.size]; };

// ---------- 预览：和单条混剪共用合成预览（editor.js 的 cpUpdate） ----------
function btState() {
  const pv = S.bt.pv, f = pv ? btFilms()[pv.fi] : btFilm(); if (!f) return null;
  const tr = !pv && S.trim && S.trim.scope === 'bt' && S.bt.trimIn != null ? S.trim : null;
  return { clips:tr ? f.clips.map((c, j) => j === tr.i ? { ...c, inPt:tr.inPt } : c) : f.clips, subs:f.subs, points:f.points, style:f.styleDraft || f.style || btB().cfg.style, cover:f.cover, pk:f.pk, t:pv ? pv.t : S.bt.t, playing:pv ? pv.playing : S.bt.playing, srcK:pv ? null : S.bt.srcK };
}
function btLive() {
  if (S.screen !== 'batch' || (S.bt.step !== 2 && S.bt.pv == null)) return;
  const st = btState(); if (!st) return; cpUpdate(st);
  $$('[data-bt-time]').forEach(el => { el.textContent = btTime(st.t); });
  const fill = $('#pv-fill'); if (fill && S.bt.pv) fill.style.width = `${(st.t / btFilms()[S.bt.pv.fi].dur * 100).toFixed(2)}%`;
  const head = $('#bt-head'); if (head) head.style.left = `${(S.bt.t / BT_DUR * 100).toFixed(3)}%`;
}
let btLast = 0;
(function btTick(now) {
  const b = S.bt, pv = b.pv, dt = btLast ? (now - btLast) / 1000 : 0;
  if (S.screen === 'batch') {
    if (pv && pv.playing) { const f = btFilms()[pv.fi]; pv.t += dt; if (pv.t >= f.dur) { pv.t = f.dur - .01; pv.playing = false; render(); } btLive(); }
    else if (!pv && b.step === 2 && b.playing) { b.t += dt; const end = b.srcK ? BT_SRC[b.srcK] : btFilm().dur; if (b.t >= end) { b.t = end - .01; b.playing = false; render(); } btLive(); }
  }
  btLast = now; requestAnimationFrame(btTick);
})(0);

// ---------- 下拉 ----------
Object.assign(POPS, {
  'bt.an': () => ({ items:SC_MODELS, cur:S.bt.an, pick:v => { S.bt.an = v; } }),
  'bt.voiceProv': () => ({ items:['Qwen3 TTS', '豆包语音'], cur:btB().cfg.voice.prov, pick:v => { btB().cfg.voice.prov = v; } }),
});
const popHookBase = popHook;
popHook = p => p.kind === 'batches' ? btBatchPop(p)
  : p.kind === 'btrule' ? `<div class="menu menu-log"><h5>开场素材库：自动归库与调用</h5><p class="plain">你只需要生成开场，后面直接复用。自定义生成的开场视频，生成成功后自动归入本项目的开场素材库；下一次批量生产的首镜自动从开场库分散取用，其余镜头从正文库分配。归库幂等：重试或刷新不会重复登记。新增开场只影响后续批次与显式编辑，不会重排已生成的成片。</p></div>`
  : p.kind === 'bthelp' ? `<div class="menu menu-log"><h5>快捷键说明</h5><dl class="keys"><dt>空格</dt><dd>播放、暂停</dd><dt>V</dt><dd>选择工具</dd><dt>B</dt><dd>分割工具：点击视频内部切开</dd><dt>⌘/Ctrl + B</dt><dd>在播放头分割选中片段</dd><dt>Delete</dt><dd>删除选中片段，保留空位</dd><dt>⌘/Ctrl + Z</dt><dd>撤销，加 Shift 重做</dd><dt>N</dt><dd>磁吸对齐，按住 Alt 临时关闭</dd><dt>← →</dt><dd>播放头移动 1 帧，按住 Shift 移动 10 帧</dd></dl><p class="plain">拖动片段两端修剪，遇相邻片段会停住；拖入素材可替换或插入。</p></div>`
  : p.kind === 'btdup' ? `<div class="menu menu-log"><h5>区间重复检查</h5><p class="plain">检查同一素材的多段使用（含分割）和源区间重叠。斜纹标出的片段是同一素材在这条成片里用了不止一次，建议更换画面；仍可确认和导出。</p></div>`
  : popHookBase(p);
function btBatchPop(p) {
  const q = (p.q || '').trim(), list = S.bt.batches.filter(b => (S.bt.showArch || !b.archived) && (!q || b.name.includes(q)));
  return `<div class="menu menu-batch"><input class="fp-q" data-bq placeholder="搜索批次…" value="${esc(q)}" aria-label="搜索批次">
    ${list.length ? list.map(b => `<div class="bq-row ${b.id === S.bt.cur ? 'cur' : ''}"><button class="bq-pick" data-act="btPick" data-v="${b.id}"><i class="dot ${BT_STATUS[b.status]}"></i><span><b>${esc(b.name)}</b><small>${b.status}${b.films.length ? `，${b.films.length} 条成片` : ''}${b.archived ? '，已归档' : ''}${b.locked ? '，已锁定' : ''}</small></span></button><button class="bq-a" data-act="btArch" data-v="${b.id}" title="${b.archived ? '恢复批次' : '归档批次（不删除成片与导出文件）'}">${b.archived ? '恢复' : '归档'}</button></div>`).join('') : '<p class="fp-empty">没有匹配的批次，点下面「新建批次」开始</p>'}
    <button class="lg-chk ${S.bt.showArch ? 'on' : ''}" data-act="btShowArch"><i>${ic('check')}</i>显示已归档</button>
    <div class="bq-new"><input class="in" data-bind="bt.newName" placeholder="新批次名称，例如：8 月产品口播" value="${esc(S.bt.newName)}"><button class="btn pri sm" data-act="btNew">新建批次</button></div></div>`;
}

// ---------- 点击 ----------
const btSnap = () => { const f = btFilm(); S.bt.hist.push({ id:f.id, clips:clone(f.clips) }); S.bt.fut = []; };
function btReshuffle(f) { const body = range(3, 9).filter(k => btB().cfg.mats.find(m => m.k === k && !m.ex)); const n = f.clips.length - 1, pick = []; while (pick.length < n) { const k = body[Math.floor(Math.random() * body.length)]; if (!pick.includes(k) || pick.length >= body.length) pick.push(k); } const fresh = btMakeFilm(f.si, f.copy, [f.clips[0].k, ...pick]); f.clips = fresh.clips; f.status = '待审核'; f.exp = f.exp === '已导出' ? '修改未导出' : f.exp; }
Object.assign(acts, {
  btMode: t => go(t.dataset.v),
  btStep: t => { const v = +t.dataset.v, b = btB(); if (v === 2 && !b.films.length) return toast('还没有成片，先完成第 1、2 步确认并开始生产'); S.bt.step = v; S.bt.playing = false; render(); },
  btList: t => { S.pop = { kind:'batches', q:'', rect:t.getBoundingClientRect() }; renderPop(); },
  btPick: t => { S.bt.cur = t.dataset.v; S.bt.sel = 0; S.bt.clip = null; S.bt.t = 1.3; S.bt.playing = false; S.pop = null; const b = btB(); if (!b.films.length && S.bt.step > 1) S.bt.step = 0; render(); },
  btArch: t => { const b = S.bt.batches.find(x => x.id === t.dataset.v); b.archived = !b.archived; toast(b.archived ? '批次已归档，成片与导出文件完好保留。勾选「显示已归档」即可查看和恢复。' : '批次已恢复。'); renderPop(); },
  btShowArch: () => { S.bt.showArch = !S.bt.showArch; renderPop(); },
  btNew: () => { const n = S.bt.newName.trim(); if (!n) return toast('请先输入新批次名称。'); const id = `b${Date.now()}`; S.bt.batches.unshift({ id, name:n, status:'待确认', locked:false, cfg:btCfg(), films:[] }); S.bt.cur = id; S.bt.newName = ''; S.bt.step = 0; S.pop = null; toast(`批次已创建：${n}`); render(); },
  btNewVersion: () => { const b = btB(), n = `${b.name} 新版本`; const id = `b${Date.now()}`; S.bt.batches.unshift({ id, name:n, status:'待确认', locked:false, cfg:{ ...clone(b.cfg), confirmed:false }, films:[] }); S.bt.cur = id; toast('已基于当前项目输入创建新版本，原批次保持不变'); render(); },
  // 第 1 步
  btMat: t => { const b = btB(); if (b.locked) return; const m = b.cfg.mats.find(x => x.k === +t.dataset.v); m.on = !m.on; b.cfg.confirmed = false; render(); },
  btMatAll: () => { const b = btB(); if (b.locked) return; const all = b.cfg.mats.every(m => m.on); b.cfg.mats.forEach(m => { m.on = !all; }); b.cfg.confirmed = false; render(); },
  btMatEx: t => { const m = btB().cfg.mats.find(x => x.k === +t.dataset.v); m.ex = !m.ex; toast(m.ex ? '已从后续自动配画面排除该素材；旧正式成片保持不变。' : '该素材已恢复参与后续自动配画面。'); render(); },
  btAdv: () => { S.bt.adv = !S.bt.adv; render(); },
  // 第 2 步
  btScript: t => { const b = btB(); if (b.locked) return; const s = b.cfg.scripts.find(x => x.id === t.dataset.v); s.on = !s.on; b.cfg.confirmed = false; render(); },
  btScriptAll: () => { const b = btB(); if (b.locked) return; const all = b.cfg.scripts.every(s => s.on); b.cfg.scripts.forEach(s => { s.on = !all; }); b.cfg.confirmed = false; render(); },
  btScriptN: t => { const b = btB(); if (b.locked) return; const s = b.cfg.scripts.find(x => x.id === t.dataset.v); s.n = Math.max(1, Math.min(10, s.n + +t.dataset.d)); b.cfg.confirmed = false; render(); },
  btScriptOpen: t => { S.bt.scriptOpen = S.bt.scriptOpen === t.dataset.v ? null : t.dataset.v; render(); },
  btVoice: t => { const b = btB(); if (b.locked) return; b.cfg.voice.v = +t.dataset.i; render(); },
  btConfirm: () => { const b = btB(), c = b.cfg, n = c.scripts.filter(s => s.on).reduce((a, s) => a + s.n, 0); if (!c.scripts.some(s => s.on)) return toast('请至少选择一份脚本。'); if (!c.mats.some(m => m.on)) return toast('请至少选择一条已完成分析的可用素材。'); c.confirmed = true; toast(`已确认 ${n} 张成片计划`); render(); },
  btStart: () => {
    const b = btB(); if (!b.cfg.confirmed) return toast('还差一步：请先点击「确认整体输入」');
    b.status = '生产中'; b.locked = true; b.stage = 0; b.startedAt = Date.now(); toast('已开跑，自动配画面与封面生成中；整片渲染会在第 4 步导出时进行。'); render();
    const tick = () => { b.stage++; if (b.stage >= BT_STAGES.length) { b.status = '已完成'; b.elapsed = '4 分 12 秒（示例）'; const plan = b.cfg.scripts.filter(s => s.on); b.films = plan.flatMap(s => range(1, s.n).map((_, j) => btMakeFilm(+s.id.slice(1) - 1, String.fromCharCode(65 + j), [BT_OPEN[j % 2], ...[3, 4, 5, 6, 7, 8, 9].sort(() => Math.random() - .5).slice(0, 5)]))); toast('批量生产完成，去「检查成片」看看'); } if (S.screen === 'batch') softRender(); if (b.stage < BT_STAGES.length) setTimeout(tick, 1100); };
    setTimeout(tick, 1100);
  },
  btPause: () => toast('原型里不真的暂停。正式版暂停后不再开始新的生成。'),
  // 第 3 步：检查成片
  btSel: (t, e) => {
    S.bt.sel = +t.dataset.i; S.bt.clip = null; S.bt.srcK = null;
    if (e && t.classList.contains('bt-rt')) { const r = t.getBoundingClientRect(); S.bt.t = Math.max(0, Math.min(btFilm().dur - .01, (e.clientX - r.left) / r.width * BT_DUR)); }
    else if (S.bt.t > btFilm().dur) S.bt.t = 1.3;
    render();
  },
  btClip: t => { const f = +t.dataset.f, i = +t.dataset.i; S.bt.sel = f; S.bt.clip = i; S.bt.srcK = null; S.bt.tab = 'clip'; const c = btFilm().clips[i]; S.trim = { scope:'bt', i, inPt:c.inPt }; S.bt.trimIn = null; if (!S.bt.playing) S.bt.t = c.t0 + .05; render(); },
  btStyleApply: () => { const f = btFilm(); f.style = clone(f.styleDraft); btEdited(f); toast('已应用到这条成片（本片覆盖）'); render(); },
  btStyleReset: () => { const f = btFilm(); f.style = null; f.styleDraft = clone(btB().cfg.style); btEdited(f); toast('已恢复批次默认样式'); render(); },
  btGainApply: () => { btEdited(btFilm()); toast('已应用这条成片的口播音量'); render(); },
  btBgmOff: () => { const f = btFilm(); f.bgm.track = ''; render(); },
  btBgmApply: () => { btEdited(btFilm()); toast('已应用 BGM 更改'); render(); },
  btCoverEdit: t => { S.bt.sel = +t.dataset.i; const f = btFilm(); S.coverEdit = { scope:'bt', draft:clone(f.cover), name:'' }; render(); },
  btZoom: t => { S.bt.zoom = +t.value || 1; render(); },
  btFit: () => { if (S.bt.clip == null) return toast('先在时间轴点选一个片段'); S.bt.zoom = 3; render(); const el = $('.bt-c.sel'); if (el) el.scrollIntoView({ block:'nearest', inline:'center' }); },
  btShowAll: () => { btFilms().forEach(f => { f.vis = true; }); render(); },
  btRule: t => { S.pop = { kind:'btrule', rect:t.getBoundingClientRect(), alignRight:false }; renderPop(); },
  btDupInfo: t => { S.pop = { kind:'btdup', rect:t.getBoundingClientRect(), alignRight:false }; renderPop(); },
  btPv: t => { S.bt.pv = { fi:+t.dataset.i, t:0, playing:true }; btLast = 0; render(); },
  btPvPlay: () => { const pv = S.bt.pv, f = btFilms()[pv.fi]; if (!pv.playing && pv.t >= f.dur - .05) pv.t = 0; pv.playing = !pv.playing; btLast = 0; render(); },
  btPvClose: () => { S.bt.pv = null; render(); },
  btPvNav: t => { const n = btFilms().length; S.bt.pv = { fi:(S.bt.pv.fi + +t.dataset.d + n) % n, t:0, playing:true }; btLast = 0; render(); },
  btDlAll: t => { S.pop = { kind:'menu', id:'bt.dlall', rect:t.getBoundingClientRect() }; POPS['bt.dlall'] = () => ({ items:['成片和封面（打包下载）', '只要成片', '只要封面'], cur:'', pick:v => { const n = btFilms().filter(f => f.exp === '已导出' || f.exp === '修改未导出').length; if (!n) return toast('还没有导出过的成片'); toast(v === '只要封面' ? `已打包下载 ${n} 张封面（示例）` : v === '只要成片' ? `已打包下载 ${n} 条成片（示例）` : `已打包下载 ${n} 条成片和 ${n} 张封面（示例）。正式版存到客户端设置的下载目录。`); } }); renderPop(); },
  btSeek: (t, e) => { const r = t.getBoundingClientRect(), x = (e ? e.clientX : r.left) - r.left; S.bt.t = Math.max(0, Math.min(btFilm().dur - .01, x / r.width * BT_DUR)); S.bt.srcK = null; btLive(); },
  btPlay: () => { const b = S.bt; if (!b.playing && b.t >= (b.srcK ? BT_SRC[b.srcK] : btFilm().dur) - .05) b.t = 0; b.playing = !b.playing; btLast = 0; render(); },
  btEye: t => { const f = btFilms()[+t.dataset.i]; f.vis = !f.vis; render(); },
  btChk: t => { const f = btFilms()[+t.dataset.i]; f.chk = !f.chk; render(); },
  btFilter: t => { S.bt.filter = t.dataset.v; render(); },
  btAll: () => { const list = btVisible(), all = list.every(f => f.chk); list.forEach(f => { f.chk = !all; }); render(); },
  btPass: () => { const list = btFilms().filter(f => f.chk && f.status !== '失败'); if (!list.length) return toast('请先勾选要操作的成片。'); list.forEach(f => { f.status = '已通过'; f.chk = false; }); toast(`已通过 ${list.length} 条成片，可以正式导出。`); render(); },
  btRework: () => { const list = btFilms().filter(f => f.chk); if (!list.length) return toast('请先勾选要操作的成片。'); list.forEach(f => { btReshuffle(f); f.chk = false; }); toast(`已返工 ${list.length} 条成片并换一批画面，新候选需要重新审核。`); render(); },
  btUnpass: () => { const list = btFilms().filter(f => f.chk && f.status === '已通过'); list.forEach(f => { f.status = '待审核'; f.chk = false; }); toast(`已撤销 ${list.length} 条成片的审核。`); render(); },
  btConfirmOne: () => { const f = btFilm(); f.status = f.status === '已通过' ? '待审核' : '已通过'; toast(f.status === '已通过' ? `${btFilmName(f)} 已确认` : '已撤销确认'); render(); },
  btRetryVoice: t => { const f = btFilms()[+t.dataset.i]; ask(t, '重试配音？', '重试配音会清除这条成片的手动字幕覆盖，并按新口播重新生成自动字幕。', 'btRetryVoiceGo', '重试配音'); S.bt.retry = f.id; },
  btRetryVoiceGo: () => { const f = btFilms().find(x => x.id === S.bt.retry); S.pop = null; f.status = '处理中'; f.err = ''; toast('已重新排队配音，完成后渲染会自动继续。'); render(); setTimeout(() => { f.status = '待审核'; if (S.screen === 'batch') softRender(); }, 3500); },
  btRetryCover: () => toast('已重试封面（示例）'),
  btReshuffleOne: t => { const f = btFilms()[+t.dataset.i]; btReshuffle(f); toast('已为这一条建立新候选，其他成片保持不变。'); render(); },
  btTool: t => { S.bt.tool = t.dataset.v; render(); },
  btSplit: () => { const f = btFilm(), i = f.clips.findIndex(c => S.bt.t > c.t0 && S.bt.t < c.t1); if (i < 0) return toast('把播放头移到片段中间再分割'); btSplitAt(f, i, S.bt.t); },
  btDel: () => { const f = btFilm(), i = S.bt.clip; if (i == null) return toast('先在时间轴点选一个片段'); btSnap(); f.clips.splice(i, 1); S.bt.clip = null; S.trim = null; btEdited(f); toast('已删除选中片段，保留空位'); render(); },
  btUndo: () => { const h = S.bt.hist.pop(); if (!h) return; const f = btFilms().find(x => x.id === h.id); S.bt.fut.push({ id:f.id, clips:clone(f.clips) }); f.clips = h.clips; render(); },
  btRedo: () => { const h = S.bt.fut.pop(); if (!h) return; const f = btFilms().find(x => x.id === h.id); S.bt.hist.push({ id:f.id, clips:clone(f.clips) }); f.clips = h.clips; render(); },
  btSnapT: () => { S.bt.snap = !S.bt.snap; render(); },
  btPool: t => { S.bt.pool = t.dataset.v; render(); },
  btHl: t => { const k = +t.dataset.v; S.bt.hl = S.bt.hl === k ? null : k; render(); },
  btSrc: t => { S.bt.srcK = +t.dataset.v; S.bt.t = 0; S.bt.playing = true; btLast = 0; render(); },
  btSrcClose: () => { S.bt.srcK = null; S.bt.t = 1.3; S.bt.playing = false; render(); },
  btTab: t => { S.bt.tab = t.dataset.v; render(); },
  // 第 4 步
  btExpFilter: t => { S.bt.expFilter = t.dataset.v; render(); },
  btExpChk: t => { const f = btFilms()[+t.dataset.i]; f.echk = !f.echk; render(); },
  btExpAll: () => { const list = btFilms().filter(btCanExport), all = list.every(f => f.echk); list.forEach(f => { f.echk = !all; }); render(); },
  btExport: () => {
    const list = btFilms().filter(f => f.echk && btCanExport(f)); if (!list.length) return toast('请先勾选要正式导出的成片。');
    list.forEach(f => { f.exp = '渲染中'; f.echk = false; }); toast(`已开始渲染 ${list.length} 条成片，渲染完成后自动导出。`); render();
    setTimeout(() => { list.forEach(f => { f.exp = '已导出'; }); const b = btB(); if (!b.exportTime || b.exportTime === '0 秒') b.exportTime = '1 分 12 秒（示例）'; toast(`已导出 ${list.length} 条`); if (S.screen === 'batch') softRender(); }, 3200);
  },
  btOpenDir: () => toast('已请求系统打开文件夹（原型里不真的打开）'),
  btDl: () => toast('原型里不真的下载。正式版下载当前正式版视频或封面。'),
  btBack: t => { S.bt.sel = +t.dataset.i; S.bt.step = 2; S.bt.pv = null; render(); },
  btHelp: t => { S.pop = { kind:'bthelp', rect:t.getBoundingClientRect(), alignRight:true }; renderPop(); },
});
function btSplitAt(f, i, t) {
  const c = f.clips[i]; if (t - c.t0 < .5 || c.t1 - t < .5) return toast('分割后两侧视频均需至少保留 0.5 秒，请换一个分割点');
  btSnap(); f.clips.splice(i, 1, { ...c, t1:t }, { ...c, t0:t, inPt:c.inPt + (t - c.t0) * (c.rate || 1) }); S.bt.clip = i + 1; btEdited(f); render();
}
function btEdited(f) { if (f.exp === '已导出') f.exp = '修改未导出'; }
function btKey(e) {
  if (S.screen !== 'batch' || S.bt.step !== 2 || S.coverEdit || S.bt.pv != null) return false;
  const k = e.key.toLowerCase(), mod = e.metaKey || e.ctrlKey;
  if (S.trim && S.trim.scope === 'bt' && S.bt.trimIn != null) { if (k === 'escape') { acts.trimCancel(); return true; } if (k === 'enter') { acts.trimDone(); return true; } }
  if (k === ' ') { e.preventDefault(); acts.btPlay(); return true; }
  if (mod && k === 'z') { e.preventDefault(); (e.shiftKey ? acts.btRedo : acts.btUndo)(); return true; }
  if (mod && k === 'b') { e.preventDefault(); acts.btSplit(); return true; }
  if (mod) return false;
  if (k === 'v') { S.bt.tool = 'select'; render(); return true; }
  if (k === 'b') { S.bt.tool = 'split'; render(); return true; }
  if (k === 'n') { S.bt.snap = !S.bt.snap; render(); return true; }
  if (k === 'delete' || k === 'backspace') { e.preventDefault(); acts.btDel(); return true; }
  if (k === 'escape') { S.bt.clip = null; S.trim = null; render(); return true; }
  if (k === 'arrowleft' || k === 'arrowright') { e.preventDefault(); S.bt.t = Math.max(0, Math.min(btFilm().dur - .01, S.bt.t + (k === 'arrowleft' ? -1 : 1) * (e.shiftKey ? 10 : 1) / 24)); btLive(); return true; }
  return false;
}
const btVisible = () => btFilms().filter(f => S.bt.filter === 'all' || (S.bt.filter === 'todo' ? f.status !== '已通过' : f.status === '已通过'));
const btCanExport = f => f.status === '已通过' && f.exp !== '渲染中';
// 拖素材到时间轴片段上替换
document.addEventListener('dragstart', e => { const el = e.target.closest && e.target.closest('[data-drag-k]'); if (el) e.dataTransfer.setData('text/bt-k', el.dataset.dragK); });
document.addEventListener('drop', e => {
  const k = e.dataTransfer && +e.dataTransfer.getData('text/bt-k'); if (!k || S.screen !== 'batch') return;
  const clipEl = e.target.closest && e.target.closest('[data-btc]'), trk = e.target.closest && e.target.closest('[data-bt-vid]');
  if (clipEl) {
    const [fi, ci] = clipEl.dataset.btc.split(':').map(Number); S.bt.sel = fi; btSnap(); const f = btFilms()[fi], c = f.clips[ci], len = (c.t1 - c.t0) * (c.rate || 1);
    Object.assign(c, { k, img:`p${k}`, name:`${BT_FILE[k]}.mp4`, srcDur:BT_SRC[k], inPt:Math.min(c.inPt, Math.max(0, BT_SRC[k] - len)) }); btEdited(f); toast(`已用 ${BT_FILE[k]} 替换这一段`); render(); return;
  }
  if (!trk) return;
  const fi = +trk.dataset.btVid, f = btFilms()[fi], r = trk.getBoundingClientRect(), t = (e.clientX - r.left) / r.width * BT_DUR, last = f.clips.reduce((a, c) => Math.max(a, c.t1), COVER_SEC);
  const add = (t0, t1) => { S.bt.sel = fi; btSnap(); f.clips.push({ k, t0, t1, inPt:.3, srcDur:BT_SRC[k], rate:1, fz:1, fx:0, fy:0, img:`p${k}`, name:`${BT_FILE[k]}.mp4`, src:'正文素材库' }); f.clips.sort((a, b) => a.t0 - b.t0); btEdited(f); render(); };
  if (t >= last - .05) { add(last, last + Math.min(BT_SRC[k] - .3, 2.6)); toast('已追加到这条成片末尾'); return; }
  const prev = Math.max(COVER_SEC, ...f.clips.filter(c => c.t1 <= t + .001).map(c => c.t1)), next = Math.min(f.dur, ...f.clips.filter(c => c.t0 >= t - .001).map(c => c.t0));
  if (next - prev >= .5) { add(prev, Math.min(next, prev + BT_SRC[k] - .3)); toast('已插入到空位'); } else toast('这里没有空位。拖到片段上可以替换，拖到末尾可以追加。');
});
// 时间轴上的片段：拖两端修剪，拖中间移动，遇到相邻片段会停住
document.addEventListener('pointerdown', e => {
  if (e.button !== 0 || S.screen !== 'batch') return;
  const el = e.target.closest && e.target.closest('[data-btc]'); if (!el) return;
  const [fi, i] = el.dataset.btc.split(':').map(Number), f = btFilms()[fi], it = f.clips[i], trk = el.parentElement, W = trk.getBoundingClientRect().width, h = e.target.dataset.h || '';
  if (S.bt.tool === 'split') { e.preventDefault(); S.bt.sel = fi; btSplitAt(f, i, (e.clientX - trk.getBoundingClientRect().left) / W * BT_DUR); return; }
  const startX = e.clientX, o = { t0:it.t0, t1:it.t1, inPt:it.inPt }, others = f.clips.filter((x, j) => j !== i), tol = 6 / W * BT_DUR;
  const lo = Math.max(COVER_SEC, ...others.filter(x => x.t0 < it.t0).map(x => x.t1)), hi = Math.min(BT_DUR, ...others.filter(x => x.t0 >= it.t1 - .001).map(x => x.t0));
  const snap = v => { if (!S.bt.snap || window.__altDown) return v; for (const c of [S.bt.t, ...others.flatMap(x => [x.t0, x.t1])]) if (Math.abs(c - v) < tol) return c; return v; };
  let moved = false;
  const move = ev => {
    const dx = ev.clientX - startX; if (!moved && Math.abs(dx) < 3) return;
    if (!moved) { moved = true; S.bt.sel = fi; btSnap(); el.classList.add('drag'); }
    const dt = dx / W * BT_DUR;
    if (h === 'l') { it.t0 = Math.max(Math.max(lo, o.t0 - o.inPt / (it.rate || 1)), Math.min(o.t1 - .5, snap(o.t0 + dt))); it.inPt = o.inPt + (it.t0 - o.t0) * (it.rate || 1); }
    else if (h === 'r') it.t1 = Math.min(Math.min(hi, o.t0 + ((it.srcDur || BT_SRC[it.k]) - o.inPt) / (it.rate || 1)), Math.max(o.t0 + .5, snap(o.t1 + dt)));
    else { const len = o.t1 - o.t0, t0 = Math.max(lo, Math.min(hi - len, snap(o.t0 + dt))); it.t0 = t0; it.t1 = t0 + len; }
    el.style.left = `${it.t0 / BT_DUR * 100}%`; el.style.width = `${(it.t1 - it.t0) / BT_DUR * 100}%`;
  };
  const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); if (moved) { S.bt.clip = i; btEdited(f); render(); } };
  addEventListener('pointermove', move); addEventListener('pointerup', up);
});
// 素材池：鼠标在缩略图上左右滑，浏览素材画面
let scrubV = null;
document.addEventListener('mousemove', e => {
  const th = e.target.closest && e.target.closest('[data-scrub-k]');
  if (!th) { if (scrubV && scrubV.parentElement) scrubV.remove(); return; }
  const k = +th.dataset.scrubK; if (!scrubV) { scrubV = document.createElement('video'); scrubV.muted = true; scrubV.playsInline = true; scrubV.preload = 'auto'; scrubV.className = 'scrub-v'; }
  if (scrubV.parentElement !== th) th.append(scrubV);
  if (scrubV.dataset.k !== String(k)) { scrubV.dataset.k = k; scrubV.src = A[`vv${k}`]; }
  const r = th.getBoundingClientRect(), p = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  if (scrubV.readyState > 0) { try { scrubV.currentTime = p * (scrubV.duration || BT_SRC[k]); } catch { /* 还没就绪 */ } }
});
document.addEventListener('input', e => { if (e.target.dataset.bq !== undefined) { S.pop.q = e.target.value; const pos = e.target.value.length; renderPop(); const q = $('#pop [data-bq]'); if (q) { q.focus(); q.setSelectionRange(pos, pos); } } });

// ---------- 页面 ----------
const afterSteps = Views.after;
Views.after = () => { afterSteps(); if (S.screen === 'batch' && (S.bt.step === 2 || S.bt.pv != null)) { cpMount(); btLive(); } zoomHide(); };
Views.batch = function () {
  if (S.fresh) return shell({ tb:projectTb(), body:emptyStep('还没有可用视频', '先在视频生成里做好视频，批量生产才有素材。', '<button class="btn pri" data-act="go" data-v="step4">去视频生成</button>') });
  const b = btB(), c = b.cfg, nFilms = c.scripts.filter(s => s.on).reduce((a, s) => a + s.n, 0), steps = [['准备素材','勾选素材，分析，调色'],['脚本与口播','份数，配音，确认锁定'],['检查成片','播放，重试，换画面'],['导出成片','正式导出，打开文件夹']];
  const sub = `<div class="subbar bt-bar"><div class="seg sm mode-seg"><button data-act="btMode" data-v="mix">单条精准混剪</button><button class="on">批量生产</button></div>
    <button class="bt-pick" data-act="btList" title="批次列表"><i class="dot ${BT_STATUS[b.status]}"></i><b>${esc(b.name)}</b><small>${b.status}${b.locked ? '，已锁定' : ''}</small>${ic('chevron-down')}</button>
    ${steps.map(([l, d], i) => `<button class="crumb ${S.bt.step === i ? 'on' : ''} ${b.films.length && i < 2 ? 'done' : ''}" data-act="btStep" data-v="${i}" title="${d}"><i>${b.films.length && i < 2 && S.bt.step !== i ? ic('check') : i + 1}</i>${l}</button>`).join('')}
    <span class="r">${b.status === '生产中' ? `<span class="spin"></span>${BT_STAGES[Math.min(b.stage, 3)]}中` : `素材 ${c.mats.filter(m => m.on).length}，脚本 ${c.scripts.filter(s => s.on).length} 份，成片 ${b.films.length || nFilms}`}<span class="tag off">画幅 3:4</span></span></div>`;
  const view = [btMaterials, btScripts, btReview, btExportView][S.bt.step]();
  return shell({ tb:projectTb(), body:`<div class="bt-wrap">${sub}${view}</div>${S.coverEdit && S.coverEdit.scope === 'bt' ? coverSheet() : ''}${S.bt.pv != null ? btPvSheet() : ''}` });
};
const btLockBanner = (title, note) => `<div class="bt-lock">${ic('key')}<div><b>${title}</b><small>${note}</small></div><button class="btn sm" data-act="btNewVersion">基于当前项目输入创建新版本</button></div>`;

function btMaterials() {
  const b = btB(), c = b.cfg, on = c.mats.filter(m => m.on).length, lock = b.locked;
  const mat = m => `<div class="bm ${m.on ? 'on' : ''} ${m.ex ? 'ex' : ''}" ${lock ? '' : `data-act="btMat" data-v="${m.k}"`} title="${BT_FILE[m.k]}"><img src="${A[`p${m.k}`]}" alt="${BT_FILE[m.k]}">${lock ? '' : `<i class="bm-ck">${ic('check')}</i>`}<span class="bm-d">${BT_SRC[m.k]} 秒</span>
    <div class="bm-b"><b>${BT_FILE[m.k]}.mp4</b><small><i class="dot ok"></i>已分析${BT_OPEN.includes(m.k) ? '，开场素材' : ''}</small>${lock ? `<button class="link" data-act="btMatEx" data-v="${m.k}">${m.ex ? '恢复参与分配' : '从后续分配排除'}</button>` : ''}</div></div>`;
  return `<div class="bt-page bt-2col"><section class="bt-main" data-keep-scroll="btm">
      ${lock ? btLockBanner('已锁定的批次设置', '以下素材、分析版本与调色来自锁定快照，不随项目当前内容变化。') : ''}
      <div class="bt-head"><div><b>素材区</b><small>当前在线 9 条，可用（已分析）9 条，0 条待分析</small></div>${lock ? '' : `<button class="btn sm" data-act="btMatAll">${on === c.mats.length ? '取消全选' : '一键全选'}</button>`}<span class="bt-cnt">已选 ${on} / 可用 9</span></div>
      <div class="bms">${c.mats.map(mat).join('')}</div></section>
    <aside class="insp" data-keep-scroll="bti1">
      ${card('sparkle', '内容分析', `<div class="fg"><div class="fr"><span>分析模型</span>${selBtn('bt.an', S.bt.an)}</div></div><p class="note">调用视觉模型识别真实画面；文件名已写明内容时，可以提取文件名描述，跳过画面识别。</p><div class="rc-btns"><button class="btn sm" data-act="toastMsg" data-v="在线素材都已有内容分析。">AI 画面分析（0）</button><button class="btn sm" data-act="toastMsg" data-v="没有待提取的素材，全程本地处理，不调用 AI。">提取文件名描述（0）</button></div>`)}
      ${card('folder', '导入素材', `<div class="rc-btns col"><button class="btn sm" data-act="toastMsg" data-v="选择视频后只登记位置，不复制原文件（原型里不真的选）">从本机选择原片（不复制）</button><button class="btn sm" data-act="toastMsg" data-v="选择文件夹后登记里面的视频（原型里不真的选）">选择原片文件夹</button><button class="btn sm" data-act="toastMsg" data-v="选择自定义视频素材（原型里不真的导入）">自定义导入素材</button></div>`)}
      <section class="rc"><button class="rc-fold" data-act="btAdv">${ic(S.bt.adv ? 'chevron-down' : 'chevron-right')}<span>画质与调色（进阶）</span></button>${S.bt.adv ? `<p class="note">调色滤镜与低清预览片；默认用不到，卡顿或需要调色时再打开。</p>
        <div class="h4">调色滤镜（LUT）</div><p class="note">尚未导入任何调色滤镜。</p><div class="rc-btns"><button class="btn sm" data-act="toastMsg" data-v="选择 .cube 文件（原型里不真的导入）">导入 .cube LUT</button></div>
        <div class="h4">低清预览片</div><div class="rc-btns col"><button class="btn sm" data-act="toastMsg" data-v="已为选中素材请求低清预览片（示例）">为选中素材生成低清预览片</button><button class="btn sm" data-act="toastMsg" data-v="已为当前批次全部素材请求低清预览片（示例）">为当前批次全部素材生成低清预览片</button></div>
        <div class="h4">预览片缓存清理</div><p class="note">当前项目占用 9 个文件。清理不影响原片、分析结果、批次快照和正式成片。</p><div class="rc-btns"><button class="btn sm" data-act="toastMsg" data-v="已清理当前项目预览片（示例）">清理当前项目预览片</button></div>` : ''}</section>
      <div style="flex:1"></div><button class="go" data-act="btStep" data-v="1">下一步：脚本与口播</button></aside></div>`;
}

function btScripts() {
  const b = btB(), c = b.cfg, lock = b.locked, base = `${btBase()}.cfg`, sel = c.scripts.filter(s => s.on), n = sel.reduce((a, s) => a + s.n, 0);
  const row = s => { const sc = BT_SCRIPTS.find(x => x.id === s.id), sec = scCount(sc.text) / 4.2, open = S.bt.scriptOpen === s.id; return `<div class="bs ${s.on ? 'on' : ''}"><button class="bs-ck" ${lock ? 'disabled' : ''} data-act="btScript" data-v="${s.id}" aria-label="选择脚本 ${esc(sc.name)}">${ic('check')}</button>
      <div class="bs-b"><b>${esc(sc.name)}<span class="tag off">${sc.src}</span></b><small>${sec.toFixed(1)} 秒，已配置配音</small>${open ? `<p class="bs-t">${esc(sc.text)}</p>` : ''}<button class="link" data-act="btScriptOpen" data-v="${s.id}">${open ? '收起' : '展开'}</button></div>
      <div class="bs-n"><small>生成份数</small><span class="stp">${s.n} 份<div><button data-act="btScriptN" data-v="${s.id}" data-d="-1" ${lock ? 'disabled' : ''}>−</button><button data-act="btScriptN" data-v="${s.id}" data-d="1" ${lock ? 'disabled' : ''}>+</button></div></span></div></div>`; };
  const voice = card('speaker', '配音', `<div class="fg"><div class="fr"><span>配音服务商</span>${selBtn('bt.voiceProv', c.voice.prov)}</div><div class="kv"><span>密钥</span><span style="color:var(--ok)">已配置</span></div>${rng('语速', `${base}.voice.rate`, .5, 2, .1, 'rx')}</div><p class="note">0.5x 慢速，1.0x 正常，2.0x 快速</p>
    <div class="h4">精选音色<span class="h4-sub">点击选中，可单独试听</span></div><div class="fg">${BT_VOICES.map(([nm, d], i) => `<div class="voice ${c.voice.v === i ? 'on' : ''}" data-act="btVoice" data-i="${i}"><i></i><div>${nm}<small>${d}</small></div><button class="link" data-act="toastMsg" data-v="原型里没有声音，正式版这里试听音色">试听</button></div>`).join('')}</div>`, '<button class="rc-a" data-act="toastMsg" data-v="已应用到全部脚本">应用到全部脚本</button>');
  const title = card('image', '封面标题', `${segRow('模式', `${base}.ct.mode`, [['none','无标题'],['preset','使用预设'],['custom','自定义']])}<p class="note">标题文字来自各脚本的封面标题。确认整体输入后随版本冻结，改样式会形成批次新版本。</p>
    ${c.ct.mode === 'none' ? '' : `<div class="bt-ct"><img src="${A.p1}" alt=""><b>${esc(BT_SCRIPTS[0].title)}</b><i>${esc(BT_SCRIPTS[0].sub)}</i></div>`}`);
  const bgm = card('speaker', '背景音乐', `<div class="kv"><span>曲库 ${BGM_LIB.length} 首</span><button class="link" data-act="toastMsg" data-v="曲库重新扫描完成，共 2 首。">重新扫描</button></div><p class="note">${c.bgm.picks.length ? `已指定 ${c.bgm.picks.length} 首，成片只在这几首之间轮流使用。` : `曲库 ${BGM_LIB.length} 首，${n} 条成片将自动分配。`}</p>
    <div class="fg">${BGM_LIB.map(t => `<div class="fr"><span class="ell">${esc(t)}</span><button class="switch ${c.bgm.picks.includes(t) ? 'on' : ''}" data-act="btBgmPick" data-v="${esc(t)}" aria-label="手动指定 ${esc(t)}"></button></div>`).join('')}${rng('音量', `${base}.bgm.gain`, -40, 0, 1, 'db')}${rng('淡入', `${base}.bgm.fi`, 0, 5, .1, 's')}${rng('淡出', `${base}.bgm.fo`, 0, 5, .1, 's')}</div>`);
  const progress = b.status === '生产中' ? `<div class="bt-prog"><b>批量生产进度</b><div class="bt-stages">${BT_STAGES.map((s, i) => `<span class="${i < b.stage ? 'done' : i === b.stage ? 'now' : ''}">${i < b.stage ? ic('check') : i === b.stage ? '<i class="spin"></i>' : ''}${s}</span>`).join('')}</div><small>刷新页面不丢失进度</small><div class="rc-btns"><button class="btn sm" data-act="btPause">暂停批次</button><button class="btn sm" data-act="btPause">停止批次</button></div></div>` : '';
  return `<div class="bt-page bt-2col wide-r"><section class="bt-main" data-keep-scroll="bts">
      ${lock ? btLockBanner('已锁定的脚本与口播', '以下正文、标题、份数与配音设置来自锁定快照，不随项目当前内容变化。') : ''}
      <div class="bt-head"><div><b>脚本与口播</b><small>每份脚本各出 N 条成片，共用同一条配音，只有画面不同。时长来自脚本自身设定。</small></div></div>
      <div class="bt-tools">${lock ? '' : `<button class="btn sm" data-act="btScriptAll">${c.scripts.every(s => s.on) ? '取消全选' : '全选脚本'}</button><button class="btn sm" data-act="toastMsg" data-v="可以上传 TXT、Markdown 或粘贴文案（原型里不真的导入）">＋ 导入自定义脚本</button>`}<span class="bt-cnt">已选 ${sel.length} 份，目标成片 ${n} 条</span></div>
      <div class="bss">${c.scripts.map(row).join('')}</div>
      <div class="bt-go">${progress}<div class="bt-sum"><b>输出设置与开始</b><small>确认信息：${sel.length} 份脚本 × 各自份数 = ${n} 条成片，9 条在线素材，画幅 3:4。点击开始后设置即锁定，后续改项目内容不影响本批次。</small></div>
        ${lock ? `<span class="tag ${b.status === '生产中' ? 'run' : 'ok'}">${b.status === '生产中' ? '生产中' : '已开始，设置已锁定'}</span>` : `<button class="btn ${c.confirmed ? '' : 'pri'}" data-act="btConfirm">${c.confirmed ? '已确认整体输入' : '确认整体输入'}</button><button class="btn pri ${c.confirmed ? '' : 'dim'}" data-act="btStart">开始批量生产</button>`}</div></section>
    <aside class="insp" data-keep-scroll="bti2">${voice}${styleCard(`${base}.style`, { title:'字幕样式（整批基准）', img:'p5', preview:true, top:'<p class="note">默认字幕来自口播对齐；在检查成片里编辑字幕时才会产生单条覆盖。</p>' })}${title}${bgm}</aside></div>`;
}

function btReview() {
  const b = btB(), films = btFilms(), f = btFilm(), list = btVisible(), cnt = { all:films.length, todo:films.filter(x => x.status !== '已通过').length, ok:films.filter(x => x.status === '已通过').length };
  const dupAll = films.reduce((a, x) => a + Object.values(btDup(x)).filter(v => v > 1).length, 0);
  const pool = (S.bt.pool === 'open' ? BT_OPEN : range(3, 9)).map(k => { const [n, fs] = btUsage(k), m = b.cfg.mats.find(x => x.k === k); return `<div class="bp ${S.bt.hl === k ? 'hl' : ''} ${m.ex ? 'ex' : ''}" draggable="true" data-drag-k="${k}" title="${BT_FILE[k]}：鼠标在缩略图上左右滑看画面，拖到片段上替换"><span class="bp-th" data-scrub-k="${k}"><img src="${A[`p${k}`]}" alt="${BT_FILE[k]}" draggable="false"></span><div><b>${BT_FILE[k]}</b><small>已用 ${n} 次，${fs} 条成片</small><span><button class="link" data-act="btSrc" data-v="${k}">预览</button><button class="link" data-act="btHl" data-v="${k}">${S.bt.hl === k ? '取消高亮' : '高亮定位'}</button></span></div></div>`; }).join('');
  const fb = `${btBase()}.films.${S.bt.sel}`, ci = S.bt.clip, cl = ci != null ? f.clips[ci] : null;
  const curSub = f.subs.find(x => S.bt.t >= x.t0 && S.bt.t < x.t1) || f.subs[0], si = f.subs.indexOf(curSub);
  if (!f.styleDraft) f.styleDraft = clone(f.style || b.cfg.style);
  const tabs = [['pack','包装'],['sub','字幕'],['clip','画面'],['cover','封面'],['audio','配音BGM']];
  let ins = '';
  if (S.bt.tab === 'pack') ins = packCard(fb);
  if (S.bt.tab === 'sub') ins = card('text', '当前字幕文字', `<div class="fg"><textarea class="ta" rows="2" data-bind="${fb}.subs.${si}.text" data-live="text">${esc(curSub.text)}</textarea></div><p class="note">改字幕文字不改口播音频。</p><button class="btn sm" data-act="toastMsg" data-v="已恢复自动字幕（示例）">恢复自动字幕</button>`)
    + styleCard(`${fb}.styleDraft`, { tag:f.style ? '<span class="tag run">本片覆盖</span>' : '<span class="tag off">批次默认</span>', resetAct:'btStyleReset', resetLabel:'恢复批次默认' })
    + '<div class="rc-btns"><button class="btn sm pri" data-act="btStyleApply">应用字幕样式</button></div>';
  if (S.bt.tab === 'clip') ins = cl ? clipCards(`${fb}.clips.${ci}`, cl) + edTrimHTML(cl, ci + 1, S.trim && S.trim.scope === 'bt' && S.trim.i === ci ? S.trim.inPt : cl.inPt, true) : '<p class="note pad">请在时间轴点击一个视频片段来调节它的倍速与画面构图。</p>';
  if (S.bt.tab === 'cover') ins = coverEntry('bt', f.cover, f.clips.length) + `<p class="note">封面截帧 ${f.cover.time.toFixed(1)} 秒，来自片段 #${f.cover.clip}。也可以点时间轴左侧的封面缩略图精调。</p>`;
  if (S.bt.tab === 'audio') ins = narCards(`${fb}.nar`, { rate:false, gainTitle:'成片口播音量', gainScope:'这条成片的口播', gainNote:'只调整当前成片的口播响度，不改变音频内容与时长。', gainFoot:'<div class="rc-btns"><button class="btn sm pri" data-act="btGainApply">应用音量</button></div>' })
    + bgmCard(`${fb}.bgm`, { title:'成片背景音乐', top:'<p class="note">每条成片可单独覆盖。</p>', foot:'<div class="rc-btns"><button class="btn sm" data-act="btBgmOff">关闭 BGM</button><button class="btn sm pri" data-act="btBgmApply">应用 BGM 更改</button></div>' });
  const pct = (a, z) => `left:${(a / BT_DUR * 100).toFixed(3)}%;width:${((z - a) / BT_DUR * 100).toFixed(3)}%`;
  const row = x => {
    const fi = films.indexOf(x), on = fi === S.bt.sel, stc = { 已通过:'ok', 待审核:'wait', 处理中:'run', 失败:'bad' }[x.status], dup = btDup(x);
    const clips = x.clips.map((c, i) => `<button class="bt-c ${on && S.bt.clip === i ? 'sel' : ''} ${S.bt.hl === c.k ? 'hl' : ''} ${dup[c.k] > 1 ? 'dup' : ''}" data-act="btClip" data-f="${fi}" data-i="${i}" data-btc="${fi}:${i}" style="${pct(c.t0, c.t1)};background-image:url(${A[c.img]})" title="${esc(c.name)}：拖两端修剪，拖中间移动">${dup[c.k] > 1 ? '<em>重复</em>' : ''}<i class="h l" data-h="l"></i><i class="h r" data-h="r"></i></button>`).join('');
    return `<div class="bt-row ${on ? 'on' : ''} ${x.vis ? '' : 'hid'}"><div class="bt-rh"><button class="bt-eye" data-act="btEye" data-i="${fi}" title="${x.vis ? '隐藏此成片' : '显示此成片'}">${x.vis ? '◉' : '○'}</button><button class="bs-ck sm ${x.chk ? 'on' : ''}" data-act="btChk" data-i="${fi}" aria-label="勾选用于统一导出/审核">${ic('check')}</button>
        <button class="bt-cv" data-act="btCoverEdit" data-i="${fi}" title="点击精调封面"><img src="${A[`p${x.cover.clip}`]}" alt="${btFilmName(x)} 封面"></button>
        <button class="bt-rn" data-act="btSel" data-i="${fi}"><b>${btFilmName(x)}</b><small>${esc(BT_SCRIPTS[x.si].name)}</small></button><div class="bt-rs"><span class="tag ${stc}">${x.status === '待审核' ? '待检查' : x.status === '已通过' ? '已确认' : x.status}</span>
        ${x.status === '失败' ? `<button class="link" data-act="btRetryVoice" data-i="${fi}">重试配音</button>` : `<button class="link quiet" data-act="btReshuffleOne" data-i="${fi}" title="换一批画面">换画面</button>`}</div></div>
      <div class="bt-rt" data-act="btSel" data-i="${fi}">${x.err ? `<div class="bt-err">${esc(x.err)}</div>` : ''}
        <div class="bt-trk sub">${x.subs.map(s => `<span style="${pct(s.t0, s.t1)}">${esc(s.text)}</span>`).join('')}</div>
        <div class="bt-trk pt">${(x.points || []).map(p => `<span style="${pct(p.t0, p.t1)}">${esc(p.text)}</span>`).join('')}</div>
        <div class="bt-trk vid" data-bt-vid="${fi}"><span class="bt-cov" style="${pct(0, 20 / 24)};background-image:url(${A[`p${x.cover.clip}`]})"></span>${clips}</div>
        <div class="bt-trk nar"><span style="${pct(20 / 24, x.dur)}">口播 TTS${x.nar.gain ? `，${x.nar.gain} dB` : ''}</span></div>
        <div class="bt-trk bgm">${x.bgm.track ? `<span style="${pct(0, x.dur)}">♫ ${esc(x.bgm.track)}</span>` : '<em>未选择背景音乐，点右侧「配音BGM」设置</em>'}</div></div></div>`;
  };
  const ticks = range(0, BT_DUR).map(s => `<i style="left:${s / BT_DUR * 100}%">${s % 2 ? '' : `${s}s`}</i>`).join('');
  const preview = S.bt.srcK
    ? `<div class="bt-ph"><span>素材预览：${BT_FILE[S.bt.srcK]}</span><button class="link" data-act="btSrcClose">返回成片 ×</button></div>`
    : `<div class="bt-ph"><span><b>${btFilmName(f)}</b>${esc(BT_SCRIPTS[f.si].name)}</span><button class="btn sm ${f.status === '已通过' ? '' : 'pri'}" data-act="btConfirmOne">${f.status === '已通过' ? '✓ 已确认，点击撤销' : '确认这条'}</button></div>`;
  return `<div class="bt-rev"><section class="bt-pool"><h4>素材池<small>本项目</small><button class="link" data-act="btRule" title="自动取用规则">取用规则</button><button class="link" data-act="toastMsg" data-v="选择视频导入到当前分类（原型里不真的导入）">添加素材</button></h4>
      <div class="seg sm"><button class="${S.bt.pool === 'open' ? 'on' : ''}" data-act="btPool" data-v="open">开场素材库 ${BT_OPEN.length}</button><button class="${S.bt.pool === 'body' ? 'on' : ''}" data-act="btPool" data-v="body">正文素材库 7</button></div>
      <p class="note">${S.bt.pool === 'open' ? '生成后自动归库，新批次首镜分散取用。' : '拖到片段上替换，拖到空位插入，拖到末尾追加。鼠标在缩略图上左右滑可以浏览画面。'}</p><div class="bps" data-keep-scroll="btp">${pool}</div></section>
    <section class="bt-mon">${preview}<div class="bt-stage">${cpFrameHTML({ cover:f.cover })}</div>
      <div class="transport"><button class="play" data-act="btPlay" title="空格">${ic(S.bt.playing ? 'pause' : 'play')}</button><span><span data-bt-time>${btTime(S.bt.t)}</span> <small>/ ${btTime(S.bt.srcK ? BT_SRC[S.bt.srcK] : f.dur)}</small></span><span class="r"><small>共用播放头，空格键播放或暂停。原型预览没有声音。</small></span></div></section>
    <aside class="ins bt-ins" data-keep-scroll="bti3"><div class="bt-ih"><b>成片属性</b><small>${btFilmName(f)}，修改只作用于当前成片</small></div><div class="seg sm ins-tabs">${tabs.map(([v, l]) => `<button class="${S.bt.tab === v ? 'on' : ''}" data-act="btTab" data-v="${v}">${l}</button>`).join('')}</div>${ins}</aside>
    <section class="bt-tl"><div class="tl-tools"><b class="bt-tlt">统一时间轴</b><div class="seg sm"><button class="${S.bt.filter === 'all' ? 'on' : ''}" data-act="btFilter" data-v="all">全部 ${cnt.all}</button><button class="${S.bt.filter === 'todo' ? 'on' : ''}" data-act="btFilter" data-v="todo">待检查 ${cnt.todo}</button><button class="${S.bt.filter === 'ok' ? 'on' : ''}" data-act="btFilter" data-v="ok">已确认 ${cnt.ok}</button></div>
        ${dupAll ? `<button class="tag warn" data-act="btDupInfo" title="检查同一素材的多段使用和源区间重叠">区间重复 ${dupAll}</button>` : '<span class="tag ok">无区间重复</span>'}<small class="bt-tlh">统一播放头，独立成片</small>
        <span class="r"><button class="btn" data-act="btShowAll" title="恢复所有成片的眼睛可见性">显示全部轨道</button><label class="ed-zoom"><span>缩放</span><input type="range" min="1" max="4" step=".5" value="${S.bt.zoom}" data-bt-zoom aria-label="时间轴缩放"></label><button class="btn" data-act="btHelp" title="快捷键说明">?</button></span></div>
      <div class="tl-tools sub"><button class="btn ${S.bt.tool === 'select' ? 'on' : ''}" data-act="btTool" data-v="select" title="选择 (V)">选择</button><button class="btn ${S.bt.tool === 'split' ? 'on' : ''}" data-act="btTool" data-v="split" title="分割工具 (B)：点击视频内部切开">${ic('scissors')}分割</button><button class="btn" data-act="btSplit" title="在播放头分割选中片段 (⌘/Ctrl+B)">分割当前</button><button class="btn" data-act="btDel" title="删除选中片段，保留空位 (Delete)">删除</button><button class="btn" data-act="btFit" title="放大时间轴并定位选中片段，便于修剪短片段">放大片段</button><button class="btn" data-act="btUndo" ${S.bt.hist.length ? '' : 'disabled'} title="撤销 (⌘Z)">撤销</button><button class="btn" data-act="btRedo" ${S.bt.fut.length ? '' : 'disabled'} title="重做 (⌘⇧Z)">重做</button><button class="btn ${S.bt.snap ? 'on' : ''}" data-act="btSnapT" title="磁吸对齐 (N)，按住 Alt 临时关闭">磁吸</button>
        <span class="r"><button class="btn" data-act="btAll">全选</button><button class="btn" data-act="btPass">通过已选</button><button class="btn" data-act="btRework">返工</button><button class="btn" data-act="btUnpass">撤销审核</button></span></div>
      <div class="bt-tlb" data-keep-scroll="btl"><div class="bt-tli" style="--z:${S.bt.zoom}"><div class="bt-row bt-ruler"><div class="bt-rh"><small>拖两端修剪，拖中间移动</small></div><div class="bt-rt bt-ticks" data-act="btSeek">${ticks}</div></div>${list.length ? list.map(row).join('') : '<p class="note pad">这个筛选下暂时没有成片。</p>'}<div class="bt-headline"><i id="bt-head" style="left:${S.bt.t / BT_DUR * 100}%"></i></div></div></div></section></div>`;
}

function btExportView() {
  const films = btFilms(), b = btB(), can = films.filter(btCanExport), sel = films.filter(f => f.echk && btCanExport(f)).length, F = S.bt.expFilter, done = films.filter(f => f.exp === '已导出' || f.exp === '修改未导出').length;
  const tagOf = f => f.exp === '渲染中' ? ['run', '正在渲染成片'] : f.status !== '已通过' ? ['wait', '待审核'] : f.exp === '已导出' ? ['ok', '已导出'] : f.exp === '修改未导出' ? ['warn', '修改未导出'] : ['off', '尚未导出'];
  const show = films.filter(f => F === 'all' || (F === 'can' ? btCanExport(f) : F === 'run' ? f.exp === '渲染中' : F === 'need' ? f.status !== '已通过' || f.exp === '修改未导出' : f.exp === '渲染失败'));
  const fcard = f => { const fi = films.indexOf(f), tg = tagOf(f), ok = btCanExport(f); return `<div class="bfc ${f.echk ? 'on' : ''}"><div class="bfc-i" data-act="btPv" data-i="${fi}" title="点击预览成片"><img src="${A[`p${f.cover.clip}`]}" alt="${btFilmName(f)} 封面"><b>${esc(f.cover.t1)}</b><i>${esc(f.cover.t2)}</i><span class="bfc-play">${ic('play')}</span>${ok ? `<button class="bs-ck sm ${f.echk ? 'on' : ''}" data-act="btExpChk" data-i="${fi}" aria-label="选择成片 ${btFilmName(f)}">${ic('check')}</button>` : ''}</div>
      <div class="bfc-b"><b>${btFilmName(f)}<span class="tag ${tg[0]}">${tg[1]}</span></b><small>${esc(BT_SCRIPTS[f.si].name)}，${f.dur.toFixed(1)} 秒</small><small class="mono">LH122K3-s${f.si + 1}-k${f.clips[0].k}-f${f.pk.tpl + 1}.mp4</small>
      ${f.exp === '修改未导出' ? '<p class="note">当前修改尚未导出：正在播放的是上一版正式成片，重新导出后同一卡片原位替换。</p>' : ''}${f.status !== '已通过' ? '<p class="note">先到检查成片通过审核后再来导出。</p>' : ''}
      <div class="rc-btns">${f.exp === '已导出' || f.exp === '修改未导出' ? '<button class="btn sm" data-act="btDl">下载视频</button><button class="btn sm" data-act="btDl">下载封面</button>' : ''}${f.status !== '已通过' ? `<button class="btn sm" data-act="btBack" data-i="${fi}">回检查成片修改</button>` : ''}</div></div></div>`; };
  return `<div class="bt-page"><section class="bt-main full" data-keep-scroll="bte">
    <div class="bt-head"><div><b>导出成片</b><small>正式成片在点「导出」时才渲染。修改后重新导出，同一张卡片原位替换成新成片。点卡片可以预览。</small></div><button class="btn sm ${done ? '' : 'dim'}" data-act="btDlAll">${ic('download')}一键下载全部${ic('chevron-down')}</button><button class="btn sm" data-act="btExpAll">${can.length && can.every(f => f.echk) ? '取消全选' : `全选可导出（${can.length}）`}</button><button class="btn pri sm ${sel ? '' : 'dim'}" data-act="btExport">正式导出选中项（${sel}）</button></div>
    <div class="bt-tools"><div class="seg sm">${[['all','全部'],['can','可导出'],['run','处理中'],['need','需处理'],['fail','渲染失败']].map(([v, l]) => `<button class="${F === v ? 'on' : ''}" data-act="btExpFilter" data-v="${v}">${l}</button>`).join('')}</div><span class="bt-cnt">已导出到成品文件夹 D:\\林视成片\\LH122K3</span><button class="btn sm" data-act="btOpenDir">打开文件夹</button><span class="bt-cnt">导出用时 ${b.exportTime || '0 秒'}，仅统计实际导出时间</span></div>
    ${films.some(f => f.status !== '已通过') ? `<p class="tip">${films.filter(f => f.status !== '已通过').length} 条成片尚未审核：到「检查成片」勾选后点「通过」，审核通过后才能导出。</p>` : ''}
    <div class="bfcs">${show.length ? show.map(fcard).join('') : '<p class="note">这个筛选下暂时没有成片。</p>'}</div></section></div>`;
}
function btPvSheet() {
  const pv = S.bt.pv, films = btFilms(), f = films[pv.fi], n = films.length, done = f.exp === '已导出' || f.exp === '修改未导出';
  const body = `<div class="pv-wrap"><div class="pv-left">${cpFrameHTML({ cover:f.cover, cls:'pv' })}
      <div class="pv-bar" data-pv-seek="bt" title="点击或拖动，跳到这个时间"><i id="pv-fill" style="width:${(pv.t / f.dur * 100).toFixed(2)}%"></i></div>
      <div class="transport"><button class="play" data-act="btPvPlay" title="空格">${ic(pv.playing ? 'pause' : 'play')}</button><span><span data-bt-time>${btTime(pv.t)}</span> <small>/ ${btTime(f.dur)}</small></span><span class="r"><button class="btn sm" data-act="btPvNav" data-d="-1" ${n > 1 ? '' : 'disabled'} title="上一条（←）">${ic('chevron-left')}上一条</button><button class="btn sm" data-act="btPvNav" data-d="1" ${n > 1 ? '' : 'disabled'} title="下一条（→）">下一条${ic('chevron-right')}</button></span></div></div>
    <div class="pv-side"><div class="fg"><div class="kv"><span>脚本</span><span>${esc(BT_SCRIPTS[f.si].name)}</span></div><div class="kv"><span>时长</span><span>${f.dur.toFixed(1)} 秒</span></div><div class="kv"><span>画幅</span><span>3:4</span></div><div class="kv"><span>状态</span><span>${f.exp}</span></div><div class="kv"><span>文件名</span><span class="mono">LH122K3-s${f.si + 1}-k${f.clips[0].k}-f${f.pk.tpl + 1}.mp4</span></div></div>
      ${done ? '' : '<p class="tip">这条还没导出，播放的是检查成片里的合成预览。导出后这里播放正式成片文件。</p>'}<p class="note">原型里没有声音：示例成片是用真实分镜视频按脚本拼的。空格播放或暂停，左右键换上一条、下一条。</p></div></div>`;
  return sheet(`${btFilmName(f)} 预览`, `第 ${pv.fi + 1} 条，共 ${n} 条`, body, `${done ? '<button class="btn" data-act="btDl">下载视频</button><button class="btn" data-act="btDl">下载封面</button>' : ''}<button class="btn" data-act="btBack" data-i="${pv.fi}">回检查成片修改</button><span class="sh-err"></span><button class="btn pri" data-act="btPvClose">关闭</button>`, 'pv-sheet');
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !S.pop && S.bt.pv != null) acts.btPvClose(); }, true);
Object.assign(acts, { btBgmPick: t => { const c = btB().cfg, v = t.dataset.v; c.bgm.picks = c.bgm.picks.includes(v) ? c.bgm.picks.filter(x => x !== v) : [...c.bgm.picks, v]; render(); } });

// 时间轴缩放：拖动时只改宽度，松手重绘
document.addEventListener('input', e => { if (e.target.dataset.btZoom !== undefined) { S.bt.zoom = +e.target.value; const el = $('.bt-tli'); if (el) el.style.setProperty('--z', S.bt.zoom); } });
document.addEventListener('change', e => { if (e.target.dataset.btZoom !== undefined) render(); });
