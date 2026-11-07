// 方案一补的 4 屏：新建项目、分镜生成、脚本生成、视频生成。
// 图、视频、详情页和第 1 条脚本来自真实案例 LH122K3；数字和方案 2、3 的文案是示例。
const pad2 = n => String(n).padStart(2, '0');
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

// 构建时按字面替换成内嵌文件，所以这里不能用模板字符串拼路径
Object.assign(A, {
  r1:'img://w900/shot01-real', p1:'img://w900/shot01-new', vv1:'vid://v01',
  r2:'img://w900/shot02-real', p2:'img://w900/shot02-new', vv2:'vid://v02',
  r3:'img://w900/shot03-real', p3:'img://w900/shot03-new', vv3:'vid://v03',
  r4:'img://w900/shot04-real', p4:'img://w900/shot04-new', vv4:'vid://v04',
  r5:'img://w900/shot05-real', p5:'img://w900/shot05-new', vv5:'vid://v05',
  r6:'img://w900/shot06-real', p6:'img://w900/shot06-new', vv6:'vid://v06',
  r7:'img://w900/shot07-real', p7:'img://w900/shot07-new', vv7:'vid://v07',
  r8:'img://w900/shot08-real', p8:'img://w900/shot08-new', vv8:'vid://v08',
  r9:'img://w900/shot09-real', p9:'img://w900/shot09-new', vv9:'vid://v09',
  ev1:'img://w640/ev-1', ev2:'img://w640/ev-2', ev3:'img://w640/ev-3', ev4:'img://w640/ev-4', ev5:'img://w640/ev-5', ev6:'img://w640/ev-6', ev7:'img://w640/ev-7', dp:'img://w640/dp-top',
});

SCREENS.splice(0, SCREENS.length, ['brand','品牌'],['login','登录'],['home','工作台'],['new','新建'],['scene','场景图'],['step2','分镜'],['step3','脚本'],['step4','视频'],['mix','混剪'],['overview','总览'],['tasks','任务'],['pools','名额']);
ROLE.new = 'member'; CURRENT.new = 'home';

const SAMPLE_PROJECT = { code:'LH122K3-B1', type:'AI种草', store:'B店', model:'LH122K3', sub:'B1', editor:'PUIKIN', full:'20261107-B店-LH122K3-B1-AI种草-PUIKIN' };
const SCENE_SAMPLE = clone(S.scene);
S.project = { ...SAMPLE_PROJECT };
S.fresh = false; // 刚新建、还没有任何素材的项目

function restoreSample() {
  S.fresh = false; S.scene = clone(SCENE_SAMPLE); S.sb = clone(SB_SAMPLE); S.sc = clone(SC_SAMPLE);
  S.vid.group = 'g1'; S.vid.shot = 0; S.vid.data = {}; S.vid.free = []; seedVid(); vidKicked = false;
}
function useSample() { restoreSample(); render(); }
const emptyStep = (title, note, main = '') => `<div class="ph-pg"><b>${title}</b><span>${note}</span><div class="ph-acts">${main}<button class="btn" data-act="useSample">用示例数据继续看</button></div></div>`;

// 通用弹窗。和 Mac 的表单一样，只能按取消或 Esc 关，避免手滑丢掉填了一半的内容。
const sheet = (title, sub, body, foot, cls = '') => `<div class="scrim"><form class="sheet ${cls}" onsubmit="return false"><header class="sh-h"><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</header><div class="sh-b" data-keep-scroll="sheet">${body}</div><footer class="sh-f">${foot}</footer></form></div>`;
const stepper = (val, act, k, extra = '') => `<span class="stp">${val}<div><button data-act="${act}" data-k="${k}" data-d="-1" ${extra}>−</button><button data-act="${act}" data-k="${k}" data-d="1" ${extra}>+</button></div></span>`;
function ask(t, title, body, okAct, okLabel) { S.pop = { kind:'confirm', title, body, okAct, okLabel, rect:t.getBoundingClientRect(), alignRight:true }; renderPop(); }

// ---------- 新建项目 ----------
const IMG_RATIOS = ['3:4','9:16','1:1','4:3','16:9'];
// 超时、并发和图片预处理由服务器统一管理，这里不让员工设
S.np = { store:'', model:'', sub:'', type:'', editor:'PUIKIN', provider:PROVIDERS[0], ratio:'3:4', res:'2K', err:'' };
const npMissing = () => { const n = S.np; return !n.store ? '请选择店铺' : !n.model.trim() ? '请输入型号' : !n.type ? '请选择生产类型' : !n.editor.trim() ? '请输入剪辑师' : ''; };
const npName = () => { const n = S.np; return npMissing() ? '' : ['20261107', n.store, n.model.trim(), n.sub.trim(), n.type, n.editor.trim()].filter(Boolean).join('-'); };
function npSync() {
  const el = $('#np-name'); if (!el) return;
  const name = npName(); el.textContent = name || '填写完生产身份后自动生成'; el.classList.toggle('wait', !name);
  const b = $('[data-act=npCreate]'); if (b) b.classList.toggle('dim', !name);
  const e = $('#np-err'); if (e && S.np.err && !npMissing()) { S.np.err = ''; e.textContent = ''; }
}

// ---------- 分镜生成 ----------
const SB_TEMPLATE = '图1是待编辑分镜图，是本次修改的主要对象。图2是场景参考图。参考图2，修改图1，保持图中沙发和模特的一致性不变，更换客厅的其他家具和软装布置，构图和机位景别严格参考图1。';
const SB_STATES = ['草稿','生成中','已完成','审核中','已通过','待生成视频'];
const SB_MAX = 20;
const sbItem = k => ({ id:`r${k}`, img:`r${k}`, name:`实拍-镜头${pad2(k)}.jpg`, k });
const sbShot = (n, k, o = {}) => ({ n, k, src:`r${k}`, file:`实拍-镜头${pad2(k)}.jpg`, vers:[{ img:`p${k}`, secs:30 + (k * 7) % 22 }], ver:0, mark:'ok', prompt:SB_TEMPLATE, running:false, err:'', ...o });
S.sb = {
  group:'g1', shot:0, view:'cmp', sheet:false, seq:0, provider:PROVIDERS[1], lib:range(1, 9).map(sbItem),
  form:{ name:'', picks:[], tpl:SB_TEMPLATE },
  groups:[
    { id:'g1', name:'客厅场景分镜 1-9', state:'已完成', ref:'s4', refId:'S4', shots:range(1, 9).map(k => sbShot(k, k, k === 7 ? { mark:'rework' } : {})) },
    { id:'g2', name:'客厅细节分镜 1-4', state:'生成中', ref:'s4', refId:'S4', shots:[sbShot(1, 3), sbShot(2, 4), sbShot(3, 5, { vers:[], running:true, mark:'none' }), sbShot(4, 8, { vers:[], running:true, mark:'none', willFail:true })] },
  ],
};
// 前两张留一次历史版本：真实产品保留每次重做的历史候选
S.sb.groups[0].shots[0].vers.unshift({ img:'s1', secs:41 }); S.sb.groups[0].shots[0].ver = 1;
S.sb.groups[0].shots[1].vers.unshift({ img:'s2', secs:38 }); S.sb.groups[0].shots[1].ver = 1;
const sbGroup = () => S.sb.groups.find(g => g.id === S.sb.group) || S.sb.groups[0];
const sbCur = () => { const g = sbGroup(); return g.shots[S.sb.shot] || g.shots[0]; };
const sbCounts = g => ({ total:g.shots.length, gen:g.shots.filter(s => s.vers.length).length, ok:g.shots.filter(s => s.vers.length && s.mark === 'ok').length, run:g.shots.filter(s => s.running).length, bad:g.shots.filter(s => s.err).length });
function sbFinish(g, shot, delay) {
  shot.timer = setTimeout(() => {
    shot.running = false; shot.timer = null;
    if (shot.willFail) { shot.willFail = false; shot.err = '供应商超时，没有扣费'; }
    else { shot.err = ''; shot.vers.push({ img:`p${shot.k}`, secs:Math.round(delay / 100) }); shot.ver = shot.vers.length - 1; }
    if (!g.shots.some(s => s.running) && g.state === '生成中') { g.state = '已完成'; if (S.screen === 'step2') toast(`${g.name} 生成完成`); }
    if (S.screen === 'step2') softRender();
  }, delay);
}
function sbKick(g) { g.shots.forEach((s, i) => { if (s.running && !s.timer) sbFinish(g, s, 5200 + i * 1700); }); }

// ---------- 脚本生成 ----------
const SC_STAGES = ['准备任务','视觉读取','卖点提炼','卖点检查','卖点组织','资产固化','资产复用','购买理由','创意规划','文案生成','完成检查'];
const SC_REUSE = 6;
const SC_MODELS = ['GPT-5-6-Luna-Standard','GPT-5-6-Luna-Fast'];
const SC_POINTS = [
  { t:'约 6.5 厘米实心实木粗腿', d:'大粗腿，有力支撑不在话下。', ev:'ev1', page:'详情页第 8 屏' },
  { t:'约 4.5 厘米立水支撑', d:'足料用材承重强，随意蹦都很稳。', ev:'ev2', page:'详情页第 5 屏' },
  { t:'约 2.6 厘米厚料大板直拼', d:'扎实可见，经久耐用。', ev:'ev3', page:'详情页第 6 屏' },
  { t:'北美 FAS 级橡木框架', d:'木质坚硬。', ev:'ev4', page:'详情页第 9 屏' },
  { t:'臻选头层牛皮', d:'久坐不易觉闷。', ev:'ev5', page:'详情页第 12 屏' },
  { t:'鹅毛、海绵、公仔棉靠包', d:'调试配比，柔软有支撑，久用依旧饱满。', ev:'ev6', page:'详情页第 21 屏' },
  { t:'约 60 厘米宽适座深', d:'不同坐姿都能满足。', ev:'ev7', page:'详情页第 24 屏' },
];
// 阶段说明来自 components/script-studio/ScriptStudioPanel.tsx
const SC_COPY = ['检查图片数量、目标时长和创作要求，随后开始读取详情页。','合适尺寸的裁切图直接读取，长详情页自动分段处理。','识别商品名称、结构与规格文案；相同意思会合并，没有图片证据的表达不会当作事实。','检查信息完整性与来源位置，排除促销内容。有疑问时可展开来源图手动核对。','把相关结构、参数和使用意义组织成完整卖点，保留各项事实与适用条件。','把本次识别结果固定为产品资产，之后再生成一版或一组都直接复用、不再重新看图。','直接读取已保存的卖点与证据，减少等待，也避免同一详情页每次识别结果不一致。','在证据之上把事实归并成购买理由与推荐短句，未确认前只作展示，脚本仍使用原始事实。','结合时长、人群与创作要求，把每条脚本分配到不同的切入角度。','为每个方案匹配不同表达结构，并把选择结果与理由展示出来。','检查口播时长预算和方案之间的差异，通过后才能进入人工选择。'];
// 模板内容来自本机模板库的真实条目；匹配原因的写法照 lib/script-studio/viral-templates.ts
const SC_TEMPLATES = [
  { id:'t1', name:'中古风客厅C位！舒适颜值双在线的大黑熊实木皮沙发', title:'中古风客厅C位！舒适颜值双在线的大黑熊实木皮沙发', cat:'沙发', sub:'真皮沙发', struct:'钩子>痛点>卖点>逼单', why:['同类目：沙发','命中卖点关键词：FAS、北美、头层牛皮、橡木、大板直拼'],
    ref:'中古风客厅的C位，还得是这张舒适与颜值并存的大黑熊沙发！中厚头层牛皮光泽莹润，亮度适中有质感。FAS级北美橡木大板直拼，流畅木纹透出高级感，既美观又兼顾了稳固性，怎么造都是满满安全感。蓬松饱满的大软包，让客厅多了几分慵懒，宅家时间更放松。黑茶色沉稳大气，在不同风格的家里都是吸睛的存在。把大黑熊搬回家，打造专属你的复古小家~' },
  { id:'t2', name:'待客撑场面首选高质感黑胡桃木真皮实木沙发', title:'待客撑场面首选高质感黑胡桃木真皮实木沙发', cat:'沙发', sub:'实木沙发', struct:'钩子>痛点>卖点>逼单', why:['同类目：沙发','子类目相关：实木沙发','命中卖点关键词：FAS、北美、框架'],
    ref:'家里待客想撑场面，这款沙发太给面了。北美FAS级黑胡桃木框架，搭配进口真皮，高级感藏在细节里，大坐深宽敞随便躺，颜值舒服双在线。' },
  { id:'t3', name:'换一张沙发就把家变成电影场景', title:'换一张实木牛皮沙发 轻松拥有电影感复古居家', cat:'沙发', sub:'实木沙发', struct:'钩子>痛点>卖点>逼单', fallback:true, why:['同类目：沙发','子类目相关：实木沙发','命中卖点关键词：实木、牛皮、框架、支撑'],
    ref:'我妈说你把房子搞成这样是要拍电影吗？其实我只是换了张沙发，再简单加了一些小饰品。造型很有慵懒感，胡桃木色非常高级耐看，和我家的色系搭配出有电影感的复古风，从每一面看都有实木自带的光泽。在这样的沙发上看看书，玩会手机，整个人都会更放松。全实木框架和加粗支撑腿，站满成年人都没事，想要搭配不出错，还得是它在C位啊。' },
  { id:'t4', name:'小户型必入 实木+牛皮神仙组合好坐又实用的舒适沙发', title:'小户型必入神仙沙发 实木+牛皮组合好坐又实用', cat:'沙发', sub:'', struct:'钩子>痛点>卖点>逼单', fallback:true, why:['同类目：沙发','命中卖点关键词：实木、牛皮、框架、靠包'],
    ref:'这张沙发纯实木框架，独立牛皮软包都可拆卸晾晒，分段加高靠包，头颈腰都有支撑，宽大座面随意舒展身体，三重填充又软又弹，真的好坐又好看！' },
  { id:'t5', name:'我家的本命全实木沙发 小户型也能轻松搭出治愈感', title:'我家的本命全实木沙发 小户型也能轻松搭出治愈感', cat:'沙发', sub:'实木沙发', struct:'钩子>痛点>卖点>逼单', why:['同类目：沙发','子类目相关：实木沙发','命中卖点关键词：实木、框架'],
    ref:'终于等到了适合我家的本命沙发，全实木框架，简约好看还耐用，让家变美也是随手的事情，就算客厅不大，选它也够美了。' },
  { id:'t6', name:'天猫热销榜TOP1电动沙发 舒适体验值得入手', title:'天猫热销榜TOP1电动沙发 舒适体验值得入手', cat:'沙发', sub:'电动沙发', struct:'钩子>痛点>卖点>逼单', why:['同类目：沙发','命中卖点关键词：头层牛皮'],
    ref:'天猫热销榜第一的电动沙发来了，大角度调节，舒服，一键电动躺倒下，舒服，温润头层牛皮，舒服，软弹座包，舒服，排名第一的电动沙发果然值得买。' },
  { id:'t7', name:'林氏家居复合支撑椰棕床垫 软硬均衡适配全年龄段', title:'林氏家居复合支撑椰棕床垫 软硬均衡适配全年龄段', cat:'床垫', sub:'椰棕床垫', struct:'钩子>痛点>卖点>逼单', other:true, why:['命中卖点关键词：支撑'],
    ref:'林氏家居家用床垫，以进口椰棕丝为核心材质，打造贴合人体的睡感，兼具柔弹缓冲分压性能，承托身体各个部位，入睡更放松。科学硬感支撑结构，兼顾承托力与舒适度，老少都能安心使用，放心入手不踩雷。' },
];
const SC_TPL_MAX = 6;
const scTpl = id => SC_TEMPLATES.find(x => x.id === id);
const scTplTotal = () => S.sc.tplPicks.reduce((a, x) => a + x.n, 0);
const SC_FRAMES = ['直接解决','原因诊断','两难解决'];
const SC_END = '想了解这款，点击下方链接看看吧。';
const SC_PLANS = [
  { name:'粗腿稳支撑', kind:'功能种草', title:'林氏可可系列', sub:'粗腿稳支撑', uses:[0,1,2,6], tpl:'痛点解决型', frame:0, who:'天天在家坐躺的家庭', pain:'怕沙发坐久了不稳、塌陷', why:'切入点是一个明确的担心，用参数逐条作答最省时间。',
    text:`天天坐躺，沙发支撑不能只看外观。约6.5厘米实心实木粗腿，配约4.5厘米立水支撑，约2.6厘米厚料大板直拼，约60厘米座深，坐姿更舒展。${SC_END}`,
    alt:`沙发天天坐，支撑要看真材料。约6.5厘米实心粗腿，约4.5厘米立水，约60厘米座深，坐久也舒展。${SC_END}` },
  { name:'窝进沙发的周末', kind:'场景种草', title:'林氏可可系列', sub:'窝进沙发的周末', uses:[4,5,6], tpl:'场景代入型', frame:2, who:'周末宅家的年轻人', pain:'想窝着放松，又怕沙发坐着闷', why:'先给画面再给依据，适合靠舒适感打动的人。',
    text:`周末不想出门，就窝在沙发上。头层牛皮，鹅毛混充靠包，坐下就不想起来。约60厘米座深，盘腿、半躺都放得下。${SC_END}`,
    alt:`下班回到家，最想窝的就是这张沙发。头层牛皮，鹅毛混充靠包，约60厘米座深，盘腿半躺都放得下。${SC_END}` },
  { name:'材料拆开讲', kind:'工艺讲解', title:'林氏可可系列', sub:'材料拆开讲', uses:[3,0,5], tpl:'工艺讲解型', frame:1, who:'买实木家具前会先做功课的人', pain:'分不清实木沙发用料好坏', why:'对方已经在比较用料，直接拆开材料讲最可信。',
    text:`买实木沙发，先看三处。框架是北美 FAS 级橡木，腿是约6.5厘米实心粗腿，靠包是鹅毛混充。坐得久也放心。${SC_END}`,
    alt:`选实木沙发，先看用料。北美 FAS 级橡木框架，约6.5厘米实心粗腿，鹅毛混充靠包。用料看得见，坐着才放心。${SC_END}` },
];
const SC_EXTRA = { name:'坐得舒展', kind:'场景种草', title:'林氏可可系列', sub:'坐得舒展', uses:[6,4], tpl:'场景代入型', frame:0, who:'上班久坐的人', pain:'下班只想彻底放松', why:'先说下班后的状态，再落到座深和皮料。',
  text:`坐了一天班，回到家只想好好舒展一下。约60厘米座深，盘腿半躺都够用，头层牛皮久坐不易觉闷。${SC_END}`, alt:`坐了一天，回到家就想躺平。约60厘米座深，盘腿半躺都够用，头层牛皮久坐不易觉闷。${SC_END}` };
const scPlan = p => ({ ...p, vers:[{ v:1, label:'AI 初稿', text:p.text }], cur:0 });
S.sc = {
  page:2, plan:0, source:'upload', folder:'', mode:'multi', model:SC_MODELS[0], target:15, count:3, ask:'', stage:SC_STAGES.length, open:null, libOpen:false, libReady:true, newFiles:false, tplOpen:null, tplQ:'', tplWide:false,
  files:[['dp','详情页-01.jpg'],['ev2','详情页-05.jpg'],['ev3','详情页-06.jpg'],['ev1','详情页-08.jpg'],['ev4','详情页-09.jpg'],['ev5','详情页-12.jpg'],['ev6','详情页-21.jpg'],['ev7','详情页-24.jpg']],
  points:SC_POINTS.map(() => true), plans:SC_PLANS.map(scPlan),
  tplPicks:[],
};
// 真实口径：lib/script-duration-policy.ts。只数字母和数字，每秒 4.2 字，片头 20 帧不算口播。
const scCount = s => Array.from(s).filter(c => /[\p{L}\p{N}]/u.test(c)).length;
const scBudget = target => { const nar = target - 20 / 24; return { min:Math.ceil(nar * .9 * 4.2), max:Math.floor(nar * 4.2) }; };
function scEst(text) {
  const n = scCount(text), b = scBudget(S.sc.target), sec = n / 4.2;
  return { n, sec, kind:n > b.max ? 'warn' : n < b.min ? 'warn' : 'ok', label:n > b.max ? '偏长' : n < b.min ? '偏短' : '在预算内' };
}
const scCurPlan = () => S.sc.plans[S.sc.plan] || S.sc.plans[0];
const scText = p => p.vers[p.cur].text;
function scMetrics(p) {
  const e = scEst(scText(p)), v = p.vers[p.cur];
  return `<div><b>${S.sc.target} 秒</b>目标时长</div><div title="时长按字数估算，每秒约 4.2 字"><b>${e.sec.toFixed(1)} 秒</b>预计口播<span class="tag ${e.kind}">${e.label}</span></div><div><b>${e.n} 字</b>不算标点</div><div><b>V${v.v}</b>${esc(v.label)}</div>`;
}
const scVersions = p => p.vers.map((v, i) => `<div class="fr"><span>V${v.v} ${esc(v.label)}</span>${i === p.cur ? '<small class="now">当前版本</small>' : `<button class="link" data-act="scVer" data-i="${i}">切换到此版</button>`}</div>`).join('');
function scRun(from, then) {
  const c = S.sc; c.page = 1; c.stage = from; render();
  const tick = () => { if (c.stage >= SC_STAGES.length) return; c.stage++; if (S.screen === 'step3') softRender(); if (c.stage >= SC_STAGES.length) { if (then) then(); return; } setTimeout(tick, 420); };
  setTimeout(tick, 420);
}

// ---------- 视频生成 ----------
const VID_PROVS = [
  { name:'公司可灵 2.5 1080p', short:'可灵 2.5', durs:[5, 10], multi:true },
  { name:'公司可灵 3.0', short:'可灵 3.0', durs:range(3, 15), multi:true },
  { name:'公司七牛可灵 3.0', short:'七牛可灵 3.0', durs:range(3, 15) },
  { name:'公司即梦 Seedance 2.5', short:'Seedance 2.5', durs:range(4, 30) },
  { name:'公司即梦 Seedance 2.0 1080p', short:'Seedance 2.0', durs:range(4, 15) },
  { name:'公司即梦 Seedance 2.0 Fast', short:'Seedance 2.0 Fast', durs:range(4, 15) },
  { name:'公司 MiniMax H3 2K', short:'MiniMax H3', durs:range(4, 15), ref:true },
  { name:'公司万相 Wan 3.0 1080p', short:'Wan 3.0', durs:range(2, 30), ref:true },
];
const provOf = name => VID_PROVS.find(p => p.name === name) || VID_PROVS[0];
const describeDurs = d => d.length === 2 ? d.join(' / ') + ' 秒' : `${d[0]}–${d[d.length - 1]} 秒`;
// 模板和提示词来自 lib/seed.ts
const VID_TPLS = {
  '自定义':'',
  '推进':'以当前图片为首帧，镜头推进，向主体缓慢靠近，运动平稳自然。保持产品结构、材质、比例、颜色和画面构图稳定，不要添加文字，不要让主体变形。',
  '拉远':'以当前图片为首帧，镜头拉远，缓慢退离主体，逐渐展现主体与整体环境的关系，运动匀速自然。保持产品结构、材质、比例、颜色和画面构图稳定，不要添加文字，不要让主体变形。',
  '固定镜头':'以当前图片为首帧，固定镜头，机位与镜头全程不动，光线保持恒定，仅有布料、蒸汽、微尘一类极轻微的环境微动。保持产品结构、材质、比例、颜色和构图稳定，不要添加文字。',
  '手持镜头':'以当前图片为首帧，手持镜头，画面带有轻微的呼吸感和自然晃动，不产生明显位移。保持产品结构、材质、比例、颜色和构图稳定，不要添加文字，不要让主体变形。',
  '环绕':'以当前图片为首帧，镜头环绕，绕主体走一小段侧向弧线，幅度小、速度慢、运动平稳。保持产品结构、材质、比例、颜色和构图稳定，不要添加文字。',
  '跟随':'以当前图片为首帧，跟随镜头，镜头与主体保持相对稳定的距离一路跟随移动，主体始终完整清晰地留在画面内。保持产品结构、材质、比例、颜色稳定，不要添加文字，不要产生畸变。',
  '右摇':'以当前图片为首帧，镜头右摇，机位固定不动，只让镜头原地向右转动，不做任何平移。保持产品结构、材质、比例、颜色稳定，不要添加文字，不要产生畸变。',
  '自然生长':'原本空白的场景里，家具和软装自然生长出来，像魔法一样，最终变成首帧图的样子。',
};
const VID_FILL = ['推进','固定镜头','手持镜头','右摇'];
const KLING = VID_PROVS[0].name, SEED = VID_PROVS[3].name;
// 分镜 k 的真实运镜：片子是 v0k.mp4
const VID_SEED = {
  1:{ prov:KLING, dur:5, tpl:'自然生长' }, 2:{ prov:SEED, dur:4, tpl:'右摇', empty:true }, 3:{ prov:SEED, dur:4, tpl:'推进' },
  4:{ prov:SEED, dur:4, tpl:'自定义', prompt:'一只手掀开沙发坐垫，露出下面的实木排骨架，动作自然，保持沙发结构和材质不变。' },
  5:{ prov:SEED, dur:4, tpl:'自定义', prompt:'模特赤脚踩上沙发坐垫，轻轻踏动，坐垫有自然回弹，展示承重。保持沙发结构和材质不变。' },
  6:{ prov:KLING, dur:5, tpl:'固定镜头' }, 7:{ prov:KLING, dur:5, tpl:'固定镜头' }, 8:{ prov:KLING, dur:5, tpl:'固定镜头' }, 9:{ prov:KLING, dur:5, tpl:'手持镜头' },
};
const vidResult = (o, st, extra = {}) => ({ id:++vidSeq, prov:o.prov, tpl:o.tpl, dur:o.dur, multi:!!o.multi, tail:o.tail || null, prompt:'', st, dropped:false, reason:'', ...extra });
// 右边的表单显示选中这条视频用的设置；改了再生成是新的一条，这条不变
function vidLoad(sh) { const r = sh.results[sh.res]; if (!r) return; Object.assign(sh, { prov:r.prov, tpl:r.tpl, dur:r.dur, multi:r.multi, tail:r.tail, descs:[{ prompt:r.prompt }] }); }
const vidDirty = sh => { const r = sh.results[sh.res]; return !!r && (sh.prov !== r.prov || sh.tpl !== r.tpl || sh.dur !== r.dur || !!sh.multi !== !!r.multi || sh.tail !== r.tail || sh.descs.length !== 1 || sh.descs[0].prompt !== r.prompt); };
const vidStateHTML = sh => { const r = sh.results[sh.res]; return !r ? '' : vidDirty(sh) ? '<small class="dirty">改过了，生成后多一条，这条不变</small><button data-act="vReset">还原</button>' : '<small>这条视频用的设置</small>'; };
let vidSeq = 0;
function vidShot(s) {
  const seed = VID_SEED[s.k], o = { prov:seed.prov, dur:seed.dur, tpl:seed.tpl };
  return { n:s.n, k:s.k, ...o, multi:provOf(o.prov).multi, tail:null, descs:[{ prompt:seed.empty ? '' : seed.prompt || VID_TPLS[seed.tpl] }], res:0, results:[] };
}
function vidData(id) {
  const v = S.vid, g = S.sb.groups.find(x => x.id === id);
  if (!v.data[id]) v.data[id] = g ? g.shots.map(vidShot) : [];
  return v.data[id];
}
S.vid = { group:'g1', shot:0, compare:true, playing:true, batch:false, hideDropped:false, data:{}, free:[] };
const seedVid = () => {
  const d = vidData('g1'), withPrompt = (o, st, extra = {}) => vidResult(o, st, { prompt:o.descs[0].prompt, ...extra });
  [0, 2, 3, 4, 5, 8].forEach(i => d[i].results.push(withPrompt(d[i], 'done')));
  d[4].results.unshift(vidResult({ prov:VID_PROVS[1].name, tpl:'自定义', dur:5, multi:true }, 'failed', { prompt:d[4].descs[0].prompt, err:'供应商超时，没有扣费' }));
  d[4].res = 1;
  d[2].results.push(vidResult({ prov:VID_PROVS[1].name, tpl:'手持镜头', dur:5, multi:true }, 'done', { prompt:VID_TPLS['手持镜头'], dropped:true, reason:'扶手边缘变形' }));
  d[6].results.push(withPrompt(d[6], 'running'));
  d[7].results.push(withPrompt(d[7], 'queued'));
  d.forEach(vidLoad);
};
seedVid();
const SB_SAMPLE = clone(S.sb), SC_SAMPLE = clone(S.sc);
const vidIsFree = () => S.vid.group === 'free';
const vidShots = () => vidIsFree() ? S.vid.free : vidData(S.vid.group);
const vidCur = () => vidShots()[S.vid.shot] || vidShots()[0];
const vidRes = sh => sh && sh.results[sh.res];
const vidFrame = sh => sh.img || (() => { const g = S.sb.groups.find(x => x.id === S.vid.group), s = g && g.shots.find(x => x.k === sh.k); return s && s.vers.length ? s.vers[s.ver].img : `p${sh.k}`; })();
const vidStatus = sh => {
  const live = sh.results.filter(r => !r.dropped), done = live.filter(r => r.st === 'done').length;
  if (live.some(r => r.st === 'running')) return ['run', '生成中'];
  if (live.some(r => r.st === 'queued')) return ['wait', '排队中'];
  if (done) return ['ok', `${done} 条完成`];
  if (live.some(r => r.st === 'failed')) return ['bad', '失败'];
  return ['none', '未生成'];
};
const vidCounts = () => { const r = vidShots().flatMap(s => s.results); return { wait:r.filter(x => x.st === 'queued').length, run:r.filter(x => x.st === 'running').length, ok:r.filter(x => x.st === 'done').length, bad:r.filter(x => x.st === 'failed').length }; };
function vidAdvance(sh, r, wait = 1400, gen = 5600) {
  const done = () => { r.st = 'done'; if (S.screen === 'step4') softRender(); };
  if (r.st === 'queued') { setTimeout(() => { r.st = 'running'; if (S.screen === 'step4') softRender(); setTimeout(done, gen); }, wait); }
  else if (r.st === 'running') setTimeout(done, gen);
}
let vidKicked = false;
function vidKick() { if (vidKicked) return; vidKicked = true; const d = vidData('g1'); if (!d.length) return; vidAdvance(d[6], d[6].results[0], 0, 22000); vidAdvance(d[7], d[7].results[0], 24000, 20000); }
let vidEl = null;
function mountVid() {
  const slot = $('#vid-slot');
  if (!slot) { if (vidEl && !vidEl.paused) vidEl.pause(); return; }
  if (!vidEl) { vidEl = document.createElement('video'); vidEl.id = 'vid'; vidEl.muted = true; vidEl.loop = true; vidEl.playsInline = true; vidEl.preload = 'auto'; vidEl.setAttribute('muted', ''); }
  slot.append(vidEl);
  const key = slot.dataset.src;
  if (vidEl.dataset.key !== key) { vidEl.dataset.key = key; vidEl.src = A[key]; }
  if (S.vid.playing) { if (vidEl.paused) vidEl.play().catch(() => {}); } else if (!vidEl.paused) vidEl.pause();
}
(function vidTick() { const b = $('#vid-bar'); if (b && vidEl && vidEl.duration) b.style.width = `${vidEl.currentTime / vidEl.duration * 100}%`; requestAnimationFrame(vidTick); })();

// 下拉菜单
Object.assign(POPS, {
  'np.provider': () => ({ items:PROVIDERS, cur:S.np.provider, pick:v => { S.np.provider = v; } }),
  'np.ratio': () => ({ items:IMG_RATIOS, cur:S.np.ratio, pick:v => { S.np.ratio = v; } }),
  'sb.state': () => ({ items:SB_STATES, cur:sbGroup().state, pick:v => { sbGroup().state = v; } }),
  'sb.provider': () => ({ items:PROVIDERS, cur:S.sb.provider, pick:v => { S.sb.provider = v; } }),
  'sc.model': () => ({ items:SC_MODELS, cur:S.sc.model, pick:v => { S.sc.model = v; } }),
  'sc.target': () => ({ items:['15 秒','20 秒','30 秒','45 秒','60 秒'], cur:`${S.sc.target} 秒`, pick:v => { S.sc.target = parseInt(v, 10); } }),
  'vid.group': () => ({ items:[...S.sb.groups.map(g => `${g.name}（${g.shots.length} 张）`), '＋ 自由素材工位（直接传图做视频）'], cur:vidIsFree() ? '＋ 自由素材工位（直接传图做视频）' : (() => { const g = S.sb.groups.find(x => x.id === S.vid.group); return `${g.name}（${g.shots.length} 张）`; })(), pick:v => {
    const g = S.sb.groups.find(x => v.startsWith(x.name)); S.vid.group = g ? g.id : 'free'; S.vid.shot = 0; S.vid.playing = true;
  } }),
  'vid.prov': () => ({ items:VID_PROVS.map(p => p.name), cur:vidCur().prov, pick:v => vidSetProv(vidCur(), v) }),
  'vid.tpl': () => ({ items:Object.keys(VID_TPLS), cur:vidCur().tpl, pick:v => vidSetTpl(vidCur(), v) }),
  'vid.allProv': () => { const list = vidShots(), same = new Set(list.map(s => s.prov)); return { items:VID_PROVS.map(p => p.name), cur:same.size === 1 ? list[0].prov : '', pick:v => { list.forEach(s => vidSetProv(s, v)); toast(`已将供应商应用到 ${list.length} 个分镜。`); } }; },
  'vid.allDur': () => { const list = vidShots(), same = new Set(list.map(s => s.dur)); return { items:bulkDurs(list).map(d => `${d} 秒`), cur:same.size === 1 ? `${list[0].dur} 秒` : '', pick:v => { const d = parseInt(v, 10); list.forEach(s => { s.dur = d; }); toast(`已将时长 ${d} 秒应用到 ${list.length} 个分镜。`); } }; },
});
for (const i of range(0, 19)) {
  POPS[`vid.tpl.${i}`] = () => ({ items:Object.keys(VID_TPLS), cur:vidShots()[i].tpl, pick:v => vidSetTpl(vidShots()[i], v) });
}
function vidSetProv(sh, name) {
  const p = provOf(name); sh.prov = name; sh.multi = !!p.multi;
  sh.dur = p.durs.reduce((c, d) => Math.abs(d - sh.dur) < Math.abs(c - sh.dur) ? d : c, p.durs[0]);
  if (p.ref) sh.tail = null;
}
function vidSetTpl(sh, name) { sh.tpl = name; if (name !== '自定义') sh.descs[0].prompt = VID_TPLS[name]; }
function vidSubmit(sh) {
  const made = [];
  sh.descs.forEach((d, i) => { if (!d.prompt.trim()) return; const r = vidResult(sh, 'queued', { prompt:d.prompt, tpl:i === 0 ? sh.tpl : '自定义' }); sh.results.push(r); made.push(r); vidAdvance(sh, r, 1200 + made.length * 500, 5200); });
  if (made.length) { sh.res = sh.results.length - made.length; vidLoad(sh); }
  return made.length;
}
const bulkDurs = list => list.length ? provOf(list[0].prov).durs.filter(d => list.every(s => provOf(s.prov).durs.includes(d))) : [];
// 拖入和多选上传
let upSeq = 0;
function addFiles(kind, files) {
  const imgs = [...files].filter(f => /^image\//.test(f.type));
  if (!imgs.length) return toast('请拖入 PNG、JPEG 或 WebP 图片');
  const keyOf = f => { const k = `up${Date.now()}${++upSeq}`; A[k] = URL.createObjectURL(f); return k; };
  if (kind === 'sb') {
    if (!S.sb.sheet) S.sb.form = { name:'', picks:[], tpl:SB_TEMPLATE };
    imgs.forEach(f => { const id = keyOf(f); S.sb.lib.push({ id, img:id, name:f.name, k:0 }); });
    S.sb.sheet = true; toast(`已上传 ${imgs.length} 张，选好后创建分镜组`);
  } else if (kind === 'sc') {
    imgs.forEach(f => S.sc.files.push([keyOf(f), f.name])); S.sc.newFiles = true;
  } else if (kind === 'free') {
    imgs.forEach(f => S.vid.free.push({ n:S.vid.free.length + 1, k:0, img:keyOf(f), prov:KLING, dur:5, tpl:'推进', multi:true, tail:null, descs:[{ prompt:VID_TPLS['推进'] }], res:0, results:[] }));
    S.vid.shot = S.vid.free.length - 1;
  } else if (kind === 'scene') {
    imgs.forEach(f => S.scene.inputs.push({ name:f.name, img:keyOf(f), size:`${Math.round(f.size / 1024)} KB` })); S.scene.input = S.scene.inputs.length - 1;
  }
  render();
}

// 所有点击
Object.assign(acts, {
  useSample,
  openProject: () => { if (S.project.full !== SAMPLE_PROJECT.full) S.scene = clone(SCENE_SAMPLE); S.fresh = false; S.project = { ...SAMPLE_PROJECT }; go('scene'); },
  // 新建项目
  newProject: () => { S.np = { ...S.np, store:'', model:'', sub:'', type:'', err:'' }; go('new'); },
  npSet: t => { S.np[t.dataset.k] = t.dataset.v; render(); },
  npCancel: () => go('home'),
  npCreate: () => {
    const miss = npMissing(); if (miss) { S.np.err = miss; render(); return; }
    const n = S.np;
    S.project = { code:[n.model.trim(), n.sub.trim()].filter(Boolean).join('-'), type:n.type, store:n.store, model:n.model.trim(), sub:n.sub.trim(), editor:n.editor.trim(), full:npName() };
    S.fresh = true; S.scene.inputs = []; S.scene.cands = []; S.scene.input = 0; S.scene.sel = ''; S.scene.ref = '';
    S.sb.groups = []; S.sb.lib = []; S.sb.group = null; S.sb.shot = 0; S.sb.sheet = false; S.sb.view = 'cmp'; S.sb.form = { name:'', picks:[], tpl:SB_TEMPLATE };
    S.vid.group = null; S.vid.shot = 0; S.vid.free = []; S.vid.data = {};
    S.sc = { ...clone(SC_SAMPLE), page:0, plan:0, files:[], plans:[], libReady:false, newFiles:false, tplPicks:[] };
    go('scene'); toast('项目已创建。先放一张原始场景图。');
  },
  sceneGen: () => { if (!S.scene.inputs.length) return toast('先上传原始场景图，再生成'); startGen(S.scene.count); },
  // 分镜
  sbGroup: t => { S.sb.group = t.dataset.id; S.sb.shot = 0; sbKick(sbGroup()); render(); },
  sbShot: t => { S.sb.shot = +t.dataset.i; S.sb.view = 'cmp'; render(); },
  sbView: t => { S.sb.view = t.dataset.v; render(); },
  sbMark: t => { const s = sbCur(); if (!s.vers.length) return; const v = t.dataset.v; s.mark = s.mark === v ? 'none' : v; render(); },
  sbVer: t => { const s = sbCur(), n = s.vers.length; s.ver = (s.ver + +t.dataset.d + n) % n; render(); },
  sbRegen: () => { const g = sbGroup(), s = sbCur(); if (s.running) return toast('任务生成中，完成后可重做'); if (!s.prompt.trim()) return toast('请填写提示词'); s.running = true; s.err = ''; sbFinish(g, s, 4200); toast(`分镜 ${s.n} 已重新提交，旧版本保留`); render(); },
  sbGen: () => { const g = sbGroup(), todo = g.shots.filter(s => !s.vers.length && !s.running); if (!todo.length) return toast('这一组都已生成。要重做单张，用右下角的按钮。'); todo.forEach(s => { s.running = true; s.err = ''; }); g.state = '生成中'; sbKick(g); toast(`已提交 ${todo.length} 张`); render(); },
  sbZip: () => toast('原型里不真的下载。正式版打包这一组全部历史候选。'),
  sbDl: () => toast('原型里不真的下载。正式版存到客户端设置的下载目录。'),
  sbDelAsk: t => ask(t, '删除这个分镜组？', '已经做好的视频不受影响。', 'sbDel', '删除'),
  sbDel: () => {
    const sb = S.sb; S.pop = null; const name = sbGroup().name, first = () => (sb.groups[0] ? sb.groups[0].id : null);
    sb.groups = sb.groups.filter(g => g.id !== sb.group); delete S.vid.data[sb.group]; if (S.vid.group === sb.group) { S.vid.group = first(); S.vid.shot = 0; }
    sb.group = first(); sb.shot = 0; toast(`已删除 ${name}`); render();
  },
  sbNew: () => { S.sb.form = { name:'', picks:[], tpl:SB_TEMPLATE }; S.sb.sheet = true; render(); },
  sbUpload: () => $('#sb-pick').click(),
  sbPick: t => { const id = t.dataset.id, p = S.sb.form.picks, i = p.indexOf(id); if (i >= 0) p.splice(i, 1); else if (p.length < SB_MAX) p.push(id); else toast(`最多选 ${SB_MAX} 张`); render(); },
  sbAll: () => { const f = S.sb.form, lib = S.sb.lib; if (f.picks.length === Math.min(lib.length, SB_MAX)) f.picks = []; else { f.picks = lib.slice(0, SB_MAX).map(x => x.id); if (lib.length > SB_MAX) toast(`最多 ${SB_MAX} 张，已选前 ${SB_MAX} 张`); } render(); },
  sbFirst: t => { const f = S.sb.form, id = t.dataset.id; f.picks = [id, ...f.picks.filter(x => x !== id)]; render(); },
  sbLibDel: t => { const id = t.dataset.id; S.sb.lib = S.sb.lib.filter(x => x.id !== id); S.sb.form.picks = S.sb.form.picks.filter(x => x !== id); render(); },
  sheetClose: () => { S.sb.sheet = false; S.vid.batch = false; render(); },
  sbCreate: () => {
    const f = S.sb.form; if (!f.picks.length) return toast('至少选 1 张，第 1 张会用作开场');
    const ref = S.scene.cands.find(c => c.id === S.scene.ref); if (!ref) return toast('先回第 1 步，选一张场景参考图');
    const id = `n${++S.sb.seq}`, items = f.picks.map(x => S.sb.lib.find(y => y.id === x));
    const g = { id, name:f.name.trim() || `新分镜组 1-${items.length}`, state:'生成中', ref:ref.img, refId:ref.id, shots:items.map((it, i) => sbShot(i + 1, it.k || i % 9 + 1, { src:it.img, file:it.name, vers:[], running:true, mark:'none', prompt:f.tpl })) };
    S.sb.groups.push(g); S.sb.group = id; S.sb.shot = 0; S.sb.sheet = false; S.sb.view = 'cmp'; if (!vidIsFree() && !S.sb.groups.some(x => x.id === S.vid.group)) { S.vid.group = id; S.vid.shot = 0; } sbKick(g); toast(`已提交 ${g.shots.length} 张分镜`); render();
  },
  // 脚本
  scPage: t => {
    const c = S.sc, v = +t.dataset.v;
    if (v === 2 && !c.plans.length) return toast('还没有脚本方案，先分析详情页');
    if (v === 1 && !c.libReady && c.stage >= SC_STAGES.length) return toast('还没有卖点库，先分析详情页');
    c.page = v; render();
  },
  scSet: t => { S.sc[t.dataset.k] = t.dataset.v; render(); },
  scStep: t => { S.sc.count = Math.max(1, Math.min(6, S.sc.count + +t.dataset.d)); render(); },
  scAnalyze: () => {
    const c = S.sc; if (c.source === 'folder' && !c.folder.trim()) return toast('请填写裁切图文件夹路径');
    const reuse = c.libReady && !c.newFiles && c.source === 'upload';
    if (!reuse && c.source === 'upload' && !c.files.length) return toast('请先上传至少一张详情页图片');
    S.fresh = false;
    if (c.mode === 'template') {
      if (reuse) { c.page = 1; render(); return; }
      c.libReady = false; scRun(0, () => { c.libReady = true; c.newFiles = false; toast('卖点库已建好，请挑选爆文模板'); }); return;
    }
    if (!reuse) c.libReady = false;
    scRun(reuse ? SC_REUSE : 0, () => { c.libReady = true; c.newFiles = false; c.plans = SC_PLANS.slice(0, Math.min(3, c.count)).map(scPlan); c.plan = 0; c.page = 2; if (S.screen === 'step3') render(); });
  },
  scDel: t => { S.sc.files.splice(+t.dataset.i, 1); render(); },
  scAdd: () => $('#sc-pick').click(),
  scLibToggle: () => { S.sc.libOpen = !S.sc.libOpen; render(); },
  scReorg: () => toast('已保存整理后的卖点和详解。下一次生成用新版本，已有脚本保持原版本。'),
  scPoint: t => { const i = +t.dataset.i, c = S.sc; if (c.points[i] && c.points.filter(Boolean).length === 1) return toast('至少保留一条卖点'); c.points[i] = !c.points[i]; render(); },
  scOpen: t => { const i = +t.dataset.i; S.sc.open = S.sc.open === i ? null : i; render(); },
  scPlan: t => { S.sc.plan = +t.dataset.i; render(); },
  scZoom: t => { S.sc.zoom = +t.dataset.i; render(); },
  scZoomClose: () => { S.sc.zoom = null; render(); },
  scCopy: () => { const text = scText(scCurPlan()); (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(() => toast('已复制完整脚本')).catch(() => toast('已复制完整脚本（预览环境里可能没写进剪贴板）')); },
  scVer: t => { const p = scCurPlan(); p.cur = +t.dataset.i; p.editing = false; toast('已切换，该版本现在就是当前版本'); render(); },
  scAgain: () => { const p = scCurPlan(); p.vers.push({ v:p.vers.length + 1, label:'AI 再生成', text:p.alt }); p.cur = p.vers.length - 1; p.editing = false; toast('已生成新版本，自动用于后续流程'); render(); },
  scFrame: () => { const p = scCurPlan(); p.frame = (p.frame + 1) % SC_FRAMES.length; p.vers.push({ v:p.vers.length + 1, label:'AI 再生成', text:p.alt }); p.cur = p.vers.length - 1; p.editing = false; toast(`已排除当前框架和钩子，换成「${SC_FRAMES[p.frame]}」`); render(); },
  scGroup: () => { const c = S.sc; scRun(SC_REUSE, () => { if (!c.plans.some(p => p.name === SC_EXTRA.name)) c.plans.push(scPlan(SC_EXTRA)); c.plan = c.plans.length - 1; c.page = 2; if (S.screen === 'step3') render(); toast('新方案已生成，这次没有重新识图'); }); },
  scTplToggle: t => { const c = S.sc, id = t.dataset.id, i = c.tplPicks.findIndex(x => x.id === id); if (i >= 0) c.tplPicks.splice(i, 1); else if (scTplTotal() < SC_TPL_MAX) c.tplPicks.push({ id, n:1 }); else toast(`合计不超过 ${SC_TPL_MAX} 条`); render(); },
  scTplN: t => { const p = S.sc.tplPicks.find(x => x.id === t.dataset.id), d = +t.dataset.d; if (d < 0 && p.n <= 1) return; if (d > 0 && scTplTotal() >= SC_TPL_MAX) return toast(`合计不超过 ${SC_TPL_MAX} 条`); p.n += d; render(); },
  scTplFull: t => { const c = S.sc, id = t.dataset.id; c.tplOpen = c.tplOpen === id ? null : id; render(); },
  scTplWide: () => { S.sc.tplWide = !S.sc.tplWide; render(); },
  scTplClear: () => { S.sc.tplQ = ''; render(); },
  scFromTpl: () => {
    const c = S.sc; if (!c.tplPicks.length) return toast('至少勾选 1 个模板');
    const list = c.tplPicks.flatMap(p => Array(p.n).fill(p.id)), pool = [...SC_PLANS, SC_EXTRA];
    scRun(SC_REUSE, () => { c.plans = list.map((id, i) => ({ ...scPlan(pool[i % pool.length]), kind:'爆文改写', tplRef:id })); c.plan = 0; c.page = 2; if (S.screen === 'step3') render(); toast(`已按模板生成 ${list.length} 条脚本，没有重新识图`); });
  },
  // 视频
  vShot: t => { S.vid.shot = +t.dataset.i; S.vid.playing = true; const sh = vidCur(); if (sh && sh.results.length && !vidRes(sh)) sh.res = 0; render(); },
  vCompare: t => { S.vid.compare = t.dataset.v === '1'; render(); },
  vRes: t => { const sh = vidCur(); sh.res = +t.dataset.i; vidLoad(sh); S.vid.playing = true; render(); },
  vReset: () => { vidLoad(vidCur()); render(); },
  vFreeMode: () => { S.vid.group = 'free'; S.vid.shot = 0; render(); },
  vPlay: () => { const r = vidRes(vidCur()); if (!r || r.st !== 'done') return; S.vid.playing = !S.vid.playing; render(); },
  vDl: () => toast('原型里不真的下载。正式版存到客户端设置的下载目录。'),
  vDropAsk: t => { const r = vidRes(vidCur()); if (!r) return; ask(t, '剔除这条视频？', '<label class="ask-l">剔除原因（可选）<input data-bind="vid.reason" placeholder="例如：手部变形"></label>智能混剪不会再用它。之后可以恢复。', 'vDrop', '剔除'); },
  vDrop: () => { const r = vidRes(vidCur()); r.dropped = true; r.reason = (S.vid.reason || '').trim(); S.vid.reason = ''; S.pop = null; toast('已剔除，智能混剪不再使用这条'); render(); },
  vRestore: () => { const r = vidRes(vidCur()); r.dropped = false; r.reason = ''; toast('已恢复使用'); render(); },
  vRetry: () => { const sh = vidCur(), r = vidRes(sh); if (!r || r.st !== 'failed') return; r.st = 'queued'; r.err = ''; vidAdvance(sh, r); toast('已重新加入队列'); render(); },
  vHide: () => { S.vid.hideDropped = !S.vid.hideDropped; render(); },
  vStep: t => { const sh = vidCur(), d = provOf(sh.prov).durs, i = d.indexOf(sh.dur); sh.dur = d[Math.max(0, Math.min(d.length - 1, i + +t.dataset.d))]; render(); },
  vMulti: () => { const sh = vidCur(); sh.multi = !sh.multi; render(); },
  vTail: () => {
    const sh = vidCur(); if (provOf(sh.prov).ref) return;
    if (!sh.tail) { const list = vidShots(), i = list.indexOf(sh), next = list[(i + 1) % list.length]; sh.tail = vidFrame(next); if (!sh.descs[0].prompt.trim() || sh.tpl !== '自定义') { sh.tpl = '自定义'; sh.descs[0].prompt = '从首帧丝滑转场到尾帧'; } toast('示例：用下一张分镜当尾帧'); }
    render();
  },
  vTailDel: () => { vidCur().tail = null; render(); },
  vAddDesc: () => { vidCur().descs.push({ prompt:'' }); render(); },
  vDelDesc: t => { vidCur().descs.splice(+t.dataset.i, 1); render(); },
  vGen: () => {
    const sh = vidCur();
    if (vidIsFree()) return toast('原型里不真的生成。自由素材工位和分镜共用这套操作。');
    if (!sh.descs.some(d => d.prompt.trim())) return toast('请至少填写一条描述提示词');
    const n = vidSubmit(sh); S.vid.playing = true; toast(`已提交 ${n} 条视频，原来的保留，关掉窗口也不会停`); render();
  },
  vBatch: () => { S.vid.batch = true; render(); },
  vRowStep: t => { const sh = vidShots()[+t.dataset.i], d = provOf(sh.prov).durs, i = d.indexOf(sh.dur); sh.dur = d[Math.max(0, Math.min(d.length - 1, i + +t.dataset.d))]; render(); },
  vFill: () => { let filled = 0, kept = 0; vidShots().forEach((s, i) => { if (s.descs[0].prompt.trim()) { kept++; return; } const name = VID_FILL[i % VID_FILL.length]; vidSetTpl(s, name); filled++; }); toast(filled ? `已填 ${filled} 条，保留 ${kept} 条手写没动。` : '每个分镜都写好了，没有需要填的。'); render(); },
  vAll: () => {
    const list = vidShots(), todo = list.filter(s => !s.results.some(r => !r.dropped) && s.descs[0].prompt.trim()), skipped = list.filter(s => !s.results.some(r => !r.dropped) && !s.descs[0].prompt.trim()).length;
    if (!todo.length) return toast(skipped ? `没有可提交的分镜：${skipped} 个未填写。可以点「一键填充提示词」。` : '全部分镜都已有任务，未提交新任务。');
    todo.forEach(vidSubmit); S.vid.batch = false; toast(`已提交 ${todo.length} 个分镜${skipped ? `，${skipped} 个未填写` : ''}`); render();
  },
  vFreeAdd: () => $('#free-pick').click(),
});
// 脚本正文和项目表单边打字边更新，不整页重绘，光标不跳
document.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.bind && t.dataset.bind.startsWith('np.')) { npSync(); return; }
  if (t.dataset.sc === 'text') {
    const p = scCurPlan();
    if (!p.editing) { p.vers.push({ v:p.vers.length + 1, label:'手动编辑', text:t.value }); p.cur = p.vers.length - 1; p.editing = true; }
    else p.vers[p.cur].text = t.value;
    $('#sc-mets').innerHTML = scMetrics(p); $('#sc-vers').innerHTML = scVersions(p);
    const e2 = scEst(t.value), side = $(`#sc-side-${S.sc.plan}`); if (side) side.textContent = `${p.kind}，${e2.sec.toFixed(1)} 秒`;
  }
  if (t.dataset.sc === 'title') scCurPlan().title = t.value;
  if (t.dataset.sc === 'sub') { scCurPlan().sub = t.value; }
  if (t.dataset.vidp !== undefined) {
    const sh = vidCur(); sh.descs[+t.dataset.vidp].prompt = t.value;
    if (+t.dataset.vidp === 0 && sh.tpl !== '自定义' && t.value !== VID_TPLS[sh.tpl]) { sh.tpl = '自定义'; const b = $('[data-v="vid.tpl"] span'); if (b) b.textContent = '自定义'; }
    const st = $('#v-state'); if (st) st.innerHTML = vidStateHTML(sh);
  }
  if (t.dataset.bkp) {
    const [i, j] = t.dataset.bkp.split(':').map(Number), sh = vidShots()[i]; sh.descs[j].prompt = t.value;
    if (j === 0 && sh.tpl !== '自定义' && t.value !== VID_TPLS[sh.tpl]) { sh.tpl = '自定义'; const b = $(`[data-v="vid.tpl.${i}"] span`); if (b) b.textContent = '自定义'; }
    const tag = $(`#bk-tag-${i}`); if (tag) tag.innerHTML = bkTags(sh);
  }
  if (t.dataset.sbp !== undefined) sbCur().prompt = t.value;
});
document.addEventListener('change', e => {
  const kind = { 'sb-pick':'sb', 'sc-pick':'sc', 'free-pick':'free' }[e.target.id];
  if (!kind) return;
  addFiles(kind, e.target.files); e.target.value = '';
});
// 把文件拖到上传区。拖到别处也拦下来，免得浏览器直接打开文件、丢掉页面状态。
const dropZone = e => (e.target.closest ? e.target.closest('[data-drop]') : null);
document.addEventListener('dragover', e => { e.preventDefault(); const z = dropZone(e); if (z) z.classList.add('over'); });
document.addEventListener('dragleave', e => { const z = dropZone(e); if (z) z.classList.remove('over'); });
document.addEventListener('drop', e => { e.preventDefault(); const z = dropZone(e); if (!z) return; z.classList.remove('over'); addFiles(z.dataset.drop, e.dataTransfer.files); });
// 方向键和空格。core.js 在翻屏之前先问这里。
function keyHook(e) {
  if (typeof pvKey === 'function' && pvKey(e)) return true;
  if (S.sb.sheet || S.vid.batch || S.coverEdit || S.mix.pv || (S.bt && S.bt.pv != null) || S.screen === 'new') return e.key === 'ArrowLeft' || e.key === 'ArrowRight';
  if (typeof edKey === 'function' && edKey(e)) return true;
  if (typeof btKey === 'function' && btKey(e)) return true;
  const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
  if (d && S.screen === 'scene' && !S.scene.cands.length) return true;
  if (d && S.screen === 'step2') { const g = sbGroup(); if (!g) return true; const n = g.shots.length; S.sb.shot = (S.sb.shot + d + n) % n; render(); return true; }
  if (d && S.screen === 'step4' && vidShots().length) { const n = vidShots().length; S.vid.shot = (S.vid.shot + d + n) % n; S.vid.playing = true; render(); return true; }
  if (e.code === 'Space' && S.screen === 'step4') { e.preventDefault(); acts.vPlay(); return true; }
  return false;
}
// Esc 一次只关最上面一层：下拉菜单开着时只关菜单（菜单由 core.js 关），不连弹窗一起关
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' || S.pop) return;
  if (S.coverEdit) acts.coverClose();
  else if (S.sc.zoom != null) acts.scZoomClose();
  else if (S.sb.sheet || S.vid.batch) acts.sheetClose();
  else if (S.screen === 'new') acts.npCancel();
}, true);
// 切屏时的钩子：进入页面才开始模拟进度
function onEnter(screen) {
  if (S.sb.sheet || S.vid.batch || S.sc.zoom != null || S.coverEdit) { S.sb.sheet = false; S.vid.batch = false; S.sc.zoom = null; S.coverEdit = null; render(); }
  if (screen === 'step2' && sbGroup()) sbKick(sbGroup());
  if (screen === 'step4') vidKick();
}

const afterBase = Views.after;
Object.assign(Views, {
  after() { afterBase(); mountVid(); },
  // ---------- 新建项目 ----------
  new() {
    const n = S.np, name = npName();
    const seg = (k, opts) => `<div class="seg sm">${opts.map(v => `<button class="${n[k] === v ? 'on' : ''}" data-act="npSet" data-k="${k}" data-v="${v}">${v}</button>`).join('')}</div>`;
    const inp = (k, ph) => `<input class="in" data-bind="np.${k}" value="${esc(n[k])}" placeholder="${ph}" autocomplete="off">`;
    const body = `<div class="np">
      <div class="np-col"><div class="h4">生产身份</div>
        <div class="fg"><div class="fr"><span>店铺<em>*</em></span>${seg('store', ['B店','D店','K店','京东'])}</div>
          <div class="fr"><span>型号<em>*</em></span>${inp('model', '例如：XQ9A 或 PC672-A')}</div>
          <div class="fr"><span>子型号</span>${inp('sub', '可选')}</div>
          <div class="fr"><span>生产类型<em>*</em></span>${seg('type', ['新品种草','AI种草'])}</div>
          <div class="fr"><span>剪辑师<em>*</em></span>${inp('editor', '例如：PUIKIN')}</div></div>
</div>
      <div class="np-col"><div class="h4">图片模型</div>
        <div class="fg"><div class="fr"><span>模型</span>${selBtn('np.provider', n.provider.replace('公司网关 ', '').replace(' Medium', ''))}</div>
          <div class="fr"><span>画面比例</span>${selBtn('np.ratio', n.ratio)}</div>
          <div class="fr"><span>清晰度</span>${seg('res', ['1K','2K'])}</div>
</div>
        <p class="note">公司网关按原生像素交付，保证比例和清晰度档位。</p>
        <div class="h4">项目名称（自动生成）</div>
        <div class="fg np-name ${name ? '' : 'wait'}" id="np-name">${name || '填写完生产身份后自动生成'}</div>
        <p class="note">按「日期-店铺-型号-子型号-生产类型-剪辑师」生成。</p></div></div>`;
    const foot = `<span class="sh-err" id="np-err">${esc(n.err)}</span><button class="btn" data-act="npCancel">取消</button><button class="btn pri ${name ? '' : 'dim'}" data-act="npCreate">创建项目</button>`;
    return Views.home() + sheet('新建项目', '', body, foot, 'wide');
  },
  // ---------- 第二步 分镜 ----------
  step2() {
    if (!S.sb.groups.length) return shell({ tb:projectTb(), body:emptyStep('还没有分镜组', '先上传原始分镜图，再按顺序选 1 到 20 张创建分镜组，配合场景参考图批量生成。', '<button class="btn pri" data-act="sbUpload">上传原始分镜图</button>') + (S.sb.sheet ? sbSheet() : '') });
    const sb = S.sb, g = sbGroup(), cur = sbCur(), c = sbCounts(g), ver = cur.vers[cur.ver], m = markText[cur.mark] || markText.none, first = cur.n === 1, noResult = cur.running || !!cur.err || !cur.vers.length;
    const groupRow = x => { const k = sbCounts(x), thumb = x.shots.find(s => s.vers.length); return `<button class="it ${x.id === g.id ? 'on' : ''}" data-act="sbGroup" data-id="${x.id}"><img src="${A[thumb ? thumb.vers[thumb.ver].img : thumb === undefined ? x.shots[0].src : x.ref]}" alt=""><div><b>${esc(x.name)}</b><small>${x.state === '生成中' ? `<i class="dot run"></i>生成中 ${k.gen}/${k.total}` : `${k.total} 张，${k.ok} 可用`}</small></div></button>`; };
    const thumb = (s, i) => `<figure class="th-c ${i === sb.shot ? 'sel' : ''}" data-act="sbShot" data-i="${i}">${s.running ? '<div class="ph"><span class="spin"></span></div>' : s.err ? '<div class="ph bad">失败</div>' : `<img src="${A[s.vers[s.ver].img]}" alt="分镜 ${s.n}">`}${s.n === 1 ? '<span class="ref-s">开场</span>' : ''}<figcaption><b>${s.n}</b>${s.running || s.err ? '' : `<i class="dot ${markText[s.mark][0]}"></i>`}</figcaption></figure>`;
    const pair = (s, i) => `<button class="pair" data-act="sbShot" data-i="${i}"><div class="pair-i"><img src="${A[s.src]}" alt="原图">${s.running ? '<div class="ph"><span class="spin"></span></div>' : s.err ? '<div class="ph bad">失败</div>' : `<img src="${A[s.vers[s.ver].img]}" alt="结果">`}</div><span><b>分镜 ${s.n}</b>${s.n === 1 ? '<em>开场</em>' : ''}<small>${s.running ? '生成中' : s.err ? '失败' : `<i class="dot ${markText[s.mark][0]}"></i>${markText[s.mark][1]}`}</small></span></button>`;
    const result = cur.running ? '<div class="ph"><span class="spin"></span>生成中</div>' : cur.err ? `<div class="ph bad-t"><b>这张没生成出来</b><span>${esc(cur.err)}，可以重新生成</span></div>` : `<img src="${A[ver.img]}" alt="分镜 ${cur.n} 结果">`;
    const verBar = cur.vers.length > 1 ? `<span class="ver"><button data-act="sbVer" data-d="-1" title="上一张结果">${ic('chevron-left')}</button>第 ${cur.ver + 1} 版（共 ${cur.vers.length} 版）<button data-act="sbVer" data-d="1" title="下一张结果">${ic('chevron-right')}</button></span>` : '<span>第 1 版</span>';
    const main = sb.view === 'grid'
      ? `<div class="pairs" data-keep-scroll="pairs">${g.shots.map(pair).join('')}</div>`
      : `<div class="cmp"><figure><div class="cmp-f"><img src="${A[cur.src]}" alt="原图"></div><figcaption><b>原图</b><span>${esc(cur.file)}</span></figcaption></figure>
        <figure class="sel"><div class="cmp-f">${result}${first ? '<span class="ref" title="这张产品全景图将用于视频开头">开场：产品全景图</span>' : ''}</div><figcaption><b>结果</b>${cur.vers.length ? verBar : '<span>还没有结果</span>'}<span>${cur.running ? '' : ver && !cur.err ? `<i class="dot ${m[0]}"></i>${m[1]}` : ''}</span></figcaption></figure></div>
        <div class="strip">${g.shots.map(thumb).join('')}</div>
        <div class="acts inline"><button class="${cur.mark === 'ok' && !noResult ? 'on' : ''}" data-act="sbMark" data-v="ok" ${noResult ? 'disabled' : ''}>${ic('check')}可用</button><button class="${cur.mark === 'rework' && !noResult ? 'on' : ''}" data-act="sbMark" data-v="rework" ${noResult ? 'disabled' : ''}>待返工</button><button class="${cur.mark === 'drop' && !noResult ? 'on' : ''}" data-act="sbMark" data-v="drop" ${noResult ? 'disabled' : ''}>废弃</button><hr><button data-act="sbRegen" ${cur.running ? 'disabled' : ''}>${ic('retry')}重新生成</button><button data-act="sbDl" ${noResult ? 'disabled' : ''}>${ic('download')}下载</button></div>`;
    const body = `<div class="sc"><section class="src"><h4>分镜组<button data-act="sbNew" title="新建分镜组">${ic('plus')}</button></h4>
        <div class="src-list" data-keep-scroll="sbg">${sb.groups.map(groupRow).join('')}</div>
        <div class="src-ref"><img src="${A[g.ref]}" alt=""><div><b>参考场景</b><small>${esc(g.refId)}，第 1 步选定</small></div></div>
        <button class="drop" data-act="sbUpload" data-drop="sb">上传原始分镜图<small>拖入或点击，可多选。已传 ${sb.lib.length} 张</small></button>
        <button class="drop solid" data-act="sbNew">新建分镜组</button></section>
      <section class="cand"><header><b>${esc(g.name)}</b><small>${sb.view === 'grid' ? `${c.total} 张，${c.gen} 已生成，${c.ok} 可用` : `分镜 ${cur.n}，${c.total} 张里 ${c.ok} 张可用`}</small><div class="seg sm"><button class="${sb.view === 'cmp' ? 'on' : ''}" data-act="sbView" data-v="cmp">对照原图</button><button class="${sb.view === 'grid' ? 'on' : ''}" data-act="sbView" data-v="grid">全部</button></div></header>${main}</section>
      <aside class="insp" data-keep-scroll="insp2"><div class="h4">这一组</div>
        <div class="fg"><div class="fr"><span>状态</span>${selBtn('sb.state', g.state)}</div><div class="fr fr-btns"><button class="btn" data-act="sbZip">${ic('download')}下载 ZIP</button><button class="btn" data-act="sbGen">生成分镜</button><button class="btn" data-act="sbDelAsk">删除</button></div></div>
        <div class="h4">分镜 ${cur.n}</div>
        <div class="fg"><div class="ctx"><figure><img src="${A[cur.src]}" alt=""><figcaption>图1 底图</figcaption></figure><figure><img src="${A[g.ref]}" alt=""><figcaption>图2 ${esc(g.refId)} 参考</figcaption></figure></div>
          <div class="fr"><span>模型</span>${selBtn('sb.provider', sb.provider.replace('公司网关 ', '').replace(' Medium', ''))}</div></div>
        <div class="h4">重做提示词</div>
        <div class="fg"><textarea class="ta" rows="5" data-sbp>${esc(cur.prompt)}</textarea></div>
        <p class="note">重新生成后旧版本保留，可以切回去。</p>
        <div style="flex:1"></div><button class="go" data-act="sbRegen">${cur.running ? '生成中…' : '重新生成这一张'}</button></aside></div>
      ${sb.sheet ? sbSheet(g) : ''}`;
    return shell({ tb:projectTb(), body, status:`<span><i class="dot ${c.run ? 'run' : ''}"></i><b>${c.run ? '生成中' : '队列空闲'}</b></span><span>等待 0</span><span>活跃 ${c.run}</span><span class="ok">成功 ${c.gen}</span><span>失败 ${c.bad}</span><span class="r">本项目已用 ¥75.09（示例）</span>` });
  },
  // ---------- 第三步 脚本 ----------
  step3() {
    const c = S.sc, names = ['提供素材', c.mode === 'template' ? '挑选爆文模板' : 'AI 分析与生成', '选择脚本方案'];
    const running = c.stage < SC_STAGES.length;
    const sub = `<div class="subbar">${names.map((l, i) => `<button class="crumb ${c.page === i ? 'on' : ''} ${i < c.page ? 'done' : ''}" data-act="scPage" data-v="${i}"><i>${i < c.page ? ic('check') : i + 1}</i>${l}</button>`).join('')}<span class="r">${c.page === 2 ? `<small>每个方案的当前版本自动用于后续流程，不用再确认</small><button class="btn pri" data-act="go" data-v="step4">下一步：视频生成</button>` : running ? '<span class="spin"></span>可以离开这里，生成过程会继续' : ''}</span></div>`;
    return shell({ tb:projectTb(), body:`<div style="height:100%;display:flex;flex-direction:column">${sub}${[sc1, sc2, sc3][c.page]()}</div>` });
  },
  // ---------- 第四步 视频 ----------
  step4() {
    if (!vidIsFree() && !S.sb.groups.length) return shell({ tb:projectTb(), body:emptyStep('还没有分镜组', '可以在分镜生成里创建，也可以用自由素材工位直接传图做视频。', '<button class="btn pri" data-act="go" data-v="step2">去分镜生成</button><button class="btn" data-act="vFreeMode">用自由素材工位</button>') });
    if (!vidIsFree() && !S.sb.groups.some(x => x.id === S.vid.group)) { S.vid.group = S.sb.groups[0].id; S.vid.shot = 0; }
    const v = S.vid, list = vidShots(), free = vidIsFree(), cur = vidCur();
    const g = free ? null : S.sb.groups.find(x => x.id === v.group);
    const c = vidCounts();
    const row = (s, i) => { const st = vidStatus(s); return `<button class="it ${i === v.shot ? 'on' : ''}" data-act="vShot" data-i="${i}"><img src="${A[vidFrame(s)]}" alt=""><div><b>${free ? `图 ${s.n}` : `分镜 ${s.n}`}</b><small><i class="dot ${st[0]}"></i>${st[1]}</small></div></button>`; };
    const left = `<section class="src"><h4>选择分镜组</h4><button class="grp-sel" data-act="sel" data-v="vid.group"><span>${free ? '自由素材工位' : esc(g.name)}</span>${ic('chevron-down')}</button>
      <div class="src-list" data-keep-scroll="vl">${list.map(row).join('')}${free ? `<button class="drop" data-act="vFreeAdd" data-drop="free">添加图片<small>点击或拖入，可多选</small></button>` : ''}</div>
      ${free ? '' : `<button class="drop solid" data-act="vBatch">批量检查 ${list.length} 个分镜</button>`}</section>`;
    if (!cur) return shell({ tb:projectTb(), body:`<div class="sc">${left}<section class="cand"><div class="ph-pg"><b>等待拖入首帧图片</b><span>自由素材工位不走分镜，直接传图做视频。</span><button class="btn pri" data-act="vFreeAdd">添加图片</button></div></section><aside class="insp"><p class="note">添加首帧图后开始生成。</p></aside></div>` });
    const r = vidRes(cur), prov = provOf(cur.prov), frameImg = vidFrame(cur);
    const visible = cur.results.map((x, i) => [x, i]).filter(([x]) => !(v.hideDropped && x.dropped));
    const stage = !r ? `<div class="ph"><b>这个分镜还没生成视频</b><span>右边写好运镜描述，点生成</span></div>`
      : r.st === 'queued' ? '<div class="ph"><span class="spin"></span>排队中</div>'
      : r.st === 'running' ? '<div class="ph"><span class="spin"></span>生成中，通常要几分钟</div>'
      : r.st === 'failed' ? `<div class="ph bad-t"><b>这条没生成出来</b><span>${esc(r.err || '')}，可以重试</span></div>`
      : `<div id="vid-slot" data-src="vv${cur.k}" data-act="vPlay"></div><div class="vid-prog"><i id="vid-bar"></i></div>${r.dropped ? `<span class="ref dropped">已剔除${r.reason ? `：${esc(r.reason)}` : ''}</span>` : ''}${v.playing ? '' : `<span class="vid-big">${ic('play')}</span>`}`;
    const panes = v.compare
      ? `<div class="cmp"><figure><div class="cmp-f"><img src="${A[frameImg]}" alt="首帧"></div><figcaption><b>首帧</b><span>${free ? '上传的图片' : `分镜 ${cur.n} 当前结果`}</span></figcaption></figure><figure class="sel"><div class="cmp-f">${stage}</div><figcaption><b>视频</b><span>${r ? esc(`${provOf(r.prov).short}，${r.tpl}，${r.dur} 秒`) : '还没有'}</span></figcaption></figure></div>`
      : `<div class="cmp one"><figure class="sel"><div class="cmp-f">${stage}</div><figcaption><b>视频</b><span>${r ? esc(`${provOf(r.prov).short}，${r.tpl}，${r.dur} 秒`) : '还没有'}</span></figcaption></figure></div>`;
    const resCard = ([x, i]) => `<button class="res ${i === cur.res ? 'sel' : ''} ${x.dropped ? 'off' : ''}" data-act="vRes" data-i="${i}"><img src="${A[frameImg]}" alt=""><span><b><i class="dot ${x.dropped ? 'none' : { done:'ok', running:'run', queued:'wait', failed:'bad' }[x.st]}"></i>${x.dropped ? '已剔除' : { done:'完成', running:'生成中', queued:'排队中', failed:'失败' }[x.st]}</b><small>${esc(provOf(x.prov).short)}</small><small>${esc(x.tpl)}，${x.dur} 秒</small></span></button>`;
    const droppedN = cur.results.filter(x => x.dropped).length;
    const caps = r ? `<div class="acts inline">${r.st === 'done' ? `<button data-act="vPlay">${ic(v.playing ? 'pause' : 'play')}${v.playing ? '暂停' : '播放'}</button><button data-act="vDl">${ic('download')}下载</button><hr>${r.dropped ? '<button data-act="vRestore">恢复使用</button>' : '<button data-act="vDropAsk">剔除</button>'}` : r.st === 'failed' ? `<button data-act="vRetry">${ic('retry')}重试</button>` : '<button disabled class="muted">生成完成后可以播放和下载</button>'}</div>` : '';
    const body = `<div class="sc">${left}
      <section class="cand"><header><b>${free ? `图 ${cur.n}` : `分镜 ${cur.n}`}</b><small>${cur.results.length ? `${cur.results.length} 条结果` : '还没有结果'}</small>${droppedN ? `<button class="link" data-act="vHide">${v.hideDropped ? '显示已剔除' : '隐藏已剔除'}</button>` : ''}<div class="seg sm"><button class="${v.compare ? 'on' : ''}" data-act="vCompare" data-v="1">对照首帧</button><button class="${v.compare ? '' : 'on'}" data-act="vCompare" data-v="0">只看视频</button></div></header>
        ${panes}
        ${visible.length ? `<div class="strip res-strip">${visible.map(resCard).join('')}</div>` : ''}
        ${caps}</section>
      <aside class="insp" data-keep-scroll="insp4">${cur.descs.map((d, i) => `<div class="h4"><span>描述 ${i + 1}</span>${i ? `<button data-act="vDelDesc" data-i="${i}">删除</button>` : `<span id="v-state">${vidStateHTML(cur)}</span>`}</div>
          ${i === 0 ? `<div class="fg"><div class="ctx">${prov.ref ? `<figure><img src="${A[frameImg]}" alt=""><figcaption>全能参考，当前分镜图</figcaption></figure><figure class="tail no"><div class="tail-ph">这个模型用全能参考，不需要尾帧</div></figure>` : `<figure><img src="${A[frameImg]}" alt=""><figcaption>首帧</figcaption></figure>${cur.tail ? `<figure class="tail"><img src="${A[cur.tail]}" alt=""><figcaption>已添加尾帧 <button class="link" data-act="vTailDel">移除</button></figcaption></figure>` : `<figure class="tail"><button class="tail-ph" data-act="vTail">${ic('plus')}添加尾帧图<small>可选，点击或拖入</small></button></figure>`}`}</div>
            <div class="fr"><span>供应商</span>${selBtn('vid.prov', cur.prov.replace(/^公司\s?/, ''))}</div>
            <div class="fr"><span>模板</span>${selBtn('vid.tpl', cur.tpl)}</div>
            <div class="fr"><span>时长<small class="fr-sub">${describeDurs(prov.durs)}</small></span>${stepper(`${cur.dur} 秒`, 'vStep', 'dur')}</div>
            ${prov.multi ? `<div class="fr"><span title="可灵自动拆分多镜头">智能分镜<small class="fr-sub">可灵自动拆分多镜头</small></span><button class="switch ${cur.multi ? 'on' : ''}" data-act="vMulti" aria-label="智能分镜"></button></div>` : ''}</div>` : ''}
          ${i === 0 ? '<div class="h4">运镜描述（提示词）</div>' : ''}<div class="fg"><textarea class="ta" rows="${i ? 2 : 5}" data-vidp="${i}" placeholder="写清楚镜头怎么动，或者上面选一个模板">${esc(d.prompt)}</textarea></div>`).join('')}
        <button class="adv" data-act="vAddDesc">${ic('plus')}添加描述</button>
        <div style="flex:1"></div><button class="go" data-act="vGen">生成 ${cur.descs.length} 条视频</button></aside></div>
      ${v.batch ? vidSheet(list) : ''}`;
    return shell({ tb:projectTb(), body, status:`<span><i class="dot ${c.run ? 'run' : ''}"></i><b>${c.run ? '生成中' : '队列空闲'}</b></span><span>等待 ${c.wait}</span><span>活跃 ${c.run}</span><span class="ok">成功 ${c.ok}</span><span>失败 ${c.bad}</span><span class="r">本项目已用 ¥75.09（示例）</span>` });
  },
});

function sbSheet() {
  const f = S.sb.form, n = f.picks.length, lib = S.sb.lib, sc = S.scene.cands.find(c => c.id === S.scene.ref), allOn = lib.length > 0 && n === Math.min(lib.length, SB_MAX);
  const tile = x => { const i = f.picks.indexOf(x.id); return `<div class="pk ${i >= 0 ? 'on' : ''}" role="button" tabindex="0" data-act="sbPick" data-id="${x.id}" title="${esc(x.name)}"><img src="${A[x.img]}" alt="${esc(x.name)}">${i >= 0 ? `<i>${i + 1}</i>` : ''}${i === 0 ? '<span>开场图</span>' : i > 0 ? `<button class="pk-first" data-act="sbFirst" data-id="${x.id}">设为开场</button>` : ''}<button class="pk-del" data-act="sbLibDel" data-id="${x.id}" title="删除此图片" aria-label="删除">✕</button></div>`; };
  const body = `<div class="fg"><div class="fr"><span>分镜组名称</span><input class="in wide" data-bind="sb.form.name" value="${esc(f.name)}" placeholder="例如：卧室场景分镜 1-6" autocomplete="off"></div></div>
    <div class="h4"><span>选择分镜图<span class="h4-sub">已选 ${n} / ${SB_MAX} 张，点击顺序就是分镜顺序</span></span>${lib.length ? `<button class="btn sm" data-act="sbAll">${allOn ? '取消全选' : '全选'}</button>` : ''}</div>
    <div class="pks" data-keep-scroll="pks"><button class="pk-add" data-act="sbUpload" data-drop="sb">${ic('plus')}上传分镜图<small>拖入或点击</small></button>${lib.map(tile).join('')}</div>
    <p class="note">${lib.length ? '第 1 张将用于视频开头，请先选产品全景图。全选后想换开场，把鼠标放到那张图上点「设为开场」。' : '还没有原始分镜图。上传后会在这里显示缩略图，可以一次选多张。'}</p>
    <div class="np-2"><div class="np-col"><div class="h4">场景参考图</div><div class="fg ctx-one">${sc ? `<img src="${A[sc.img]}" alt=""><div><b>${esc(sc.id)}</b><small>在第 1 步选定</small></div>` : `<div class="ph"></div><div><b>还没选</b><small>回第 1 步设一张，才能创建</small></div>`}</div></div>
    <div class="np-col"><div class="h4">分镜生成模板</div><div class="fg"><textarea class="ta" rows="3" data-bind="sb.form.tpl">${esc(f.tpl)}</textarea></div></div></div>`;
  return sheet('新建分镜组', '', body, `<span class="sh-err"></span><button class="btn" data-act="sheetClose">取消</button><button class="btn pri ${n ? '' : 'dim'}" data-act="sbCreate">创建分镜组${n ? `（${n}）` : ''}</button>`, 'wide');
}

// 脚本第 1 页：提供素材
function sc1() {
  const c = S.sc, b = scBudget(c.target);
  return `<div class="sc sc-two"><section class="cand"><header><b>提供素材</b><small>一次放入一张或多张同一商品的详情页</small><div class="seg sm"><button class="${c.source === 'upload' ? 'on' : ''}" data-act="scSet" data-k="source" data-v="upload">上传详情页图片</button><button class="${c.source === 'folder' ? 'on' : ''}" data-act="scSet" data-k="source" data-v="folder">裁切图文件夹</button></div></header>
      ${c.source === 'upload' ? (c.files.length || c.libReady ? `<div class="dps" data-keep-scroll="dps" data-drop="sc">${c.files.map(([k, n], i) => `<figure><img src="${A[k]}" alt="${esc(n)}"><figcaption>${esc(n)}</figcaption><button data-act="scDel" data-i="${i}" title="删除此图片" aria-label="删除">✕</button></figure>`).join('')}<button class="drop dp-add" data-act="scAdd">${ic('plus')}继续添加<small>PNG、JPEG、WebP，长图自动分段</small></button></div>`
        : `<div class="ph-pg" data-drop="sc"><b>还没有详情页</b><span>放入同一商品的详情页图片，AI 提取卖点后写脚本。卖点只提取一次，以后直接复用。</span><div class="ph-acts"><button class="btn pri" data-act="scAdd">上传详情页图片</button><button class="btn" data-act="useSample">用示例数据继续看</button></div></div>`)
        : `<div class="fold"><div class="fg"><div class="fr"><span>文件夹路径</span><input class="in wide" data-bind="sc.folder" value="${esc(c.folder)}" placeholder="例如 Q:\\产品资料库\\某产品\\裁切图" autocomplete="off"></div></div><p class="note">粘贴本机或网络盘文件夹路径。按文件名顺序读取这个文件夹的 JPG、PNG、WebP，最多 200 张，不含子文件夹。请确保属于同一商品。</p></div>`}
      ${c.libReady ? '<p class="note cand-note">当前项目已有可复用卖点库，没传新素材也可以直接生成。</p>' : ''}</section>
    <aside class="insp" data-keep-scroll="insp3a"><div class="h4">脚本模型</div><div class="fg"><div class="fr"><span>模型</span>${selBtn('sc.model', c.model)}</div></div><p class="note">识图、卖点整理和写脚本都用它。需要公司内网。</p>
      <div class="h4">生产模式</div><div class="fg"><div class="fr seg-fr"><div class="seg sm"><button class="${c.mode === 'multi' ? 'on' : ''}" data-act="scSet" data-k="mode" data-v="multi">多方向生成</button><button class="${c.mode === 'template' ? 'on' : ''}" data-act="scSet" data-k="mode" data-v="template">爆文模板改写</button></div></div></div>
      <p class="note">${c.mode === 'multi' ? '先筛选有依据的内容机会，再写脚本。机会不足时少产，不凑数量。' : '先提取卖点建库，再挑爆文模板，按参考文风改写成一条本家脚本。'}</p>
      <div class="fg"><div class="fr"><span>目标时长</span>${selBtn('sc.target', `${c.target} 秒`)}</div>${c.mode === 'multi' ? `<div class="fr"><span>生成数量<small class="fr-sub">每条用不同切入角度</small></span><span class="stp">${c.count} 条<div><button data-act="scStep" data-d="-1">−</button><button data-act="scStep" data-d="1">+</button></div></span></div>` : ''}</div>
      <p class="note">写作估算约 ${b.max} 字一条，不代表实际配音时长。</p>
      <div class="h4">创作要求（可选）</div><div class="fg"><textarea class="ta" rows="3" data-bind="sc.ask" placeholder="例如：面向 25-35 岁女性，风格自然可信，避免夸张功效">${esc(c.ask)}</textarea></div>
      <p class="note">卖点首次提取后固定保存。以后再写脚本直接复用，不重复识图。</p><div style="flex:1"></div>
      <button class="go" data-act="scAnalyze">${c.mode === 'template' ? (c.libReady && !c.newFiles ? '下一步：挑选爆文模板' : '分析图片，提取卖点') : '分析并生成脚本'}</button></aside></div>`;
}
// 产品卖点库：默认收起、默认全选，点开才能选择或排除
function scLibBar() {
  const c = S.sc, on = c.points.filter(Boolean).length, off = SC_POINTS.length - on;
  const point = (p, i) => { const keep = c.points[i], open = c.open === i; return `<div class="pt ${keep ? '' : 'off'}"><button class="pt-h" data-act="scOpen" data-i="${i}"><img src="${A[p.ev]}" alt=""><span><b>${p.t}</b><small>${p.d}</small></span>${ic(open ? 'chevron-down' : 'chevron-right')}</button><button class="switch ${keep ? 'on' : ''}" data-act="scPoint" data-i="${i}" aria-label="保留这条卖点"></button>${open ? `<figure class="pt-ev"><img src="${A[p.ev]}" alt="${p.page}"><figcaption>来源：${p.page}。数字、材质类已通过二次证据检查。</figcaption></figure>` : ''}</div>`; };
  return `<section class="fg lib-bar"><header><span class="lib-ok">${ic('check')}</span><div><b>产品卖点库</b><small>${on} 个有效卖点${off ? `，排除 ${off} 个` : '，默认全选'}，V1，已保存，可无限复用</small></div>${c.libOpen ? '<button class="btn" data-act="scReorg">重新整理卖点</button>' : ''}<button class="btn" data-act="scLibToggle" aria-expanded="${c.libOpen}">${c.libOpen ? '收起卖点' : '展开卖点'}</button></header>
    ${c.libOpen ? `<p class="note lib-note">开关决定这条卖点进不进脚本。点一条看详情页原图。</p><div class="pts">${SC_POINTS.map(point).join('')}</div>` : ''}</section>`;
}
// 脚本第 2 页（爆文模板改写）：模板内容摊开看
function scTemplates() {
  const c = S.sc, q = c.tplQ.trim().toLowerCase(), total = scTplTotal(), k = c.tplPicks.length;
  const list = q ? SC_TEMPLATES.filter(t => [t.name, t.title, t.ref, t.cat, t.sub].join(' ').toLowerCase().includes(q)) : SC_TEMPLATES.filter(t => c.tplWide || !t.other);
  const card = t => {
    const pick = c.tplPicks.some(x => x.id === t.id), full = c.tplOpen === t.id, locked = !pick && total >= SC_TPL_MAX;
    return `<article class="tp ${pick ? 'on' : ''} ${locked ? 'off' : ''}" data-act="scTplToggle" data-id="${t.id}"><i class="tp-ck">${ic('check')}</i><div class="tp-b">
      <header><b>${esc(t.name)}</b><span class="tp-cat">${esc(t.cat)}${t.sub ? ` / ${esc(t.sub)}` : ''}</span></header>
      ${t.title !== t.name ? `<small class="tp-title">标题：${esc(t.title)}</small>` : ''}
      <p class="tp-ref ${full ? 'full' : ''}">${esc(t.ref)}</p>
      ${t.ref.length > 100 ? `<button class="link" data-act="scTplFull" data-id="${t.id}">${full ? '收起参考文案' : '查看参考全文'}</button>` : ''}
      <small class="tp-meta">结构：${esc(t.struct)}${t.fallback ? '（表格没给，用默认结构）' : ''}</small>
      <div class="tp-why">${t.why.map(w => `<span>${esc(w)}</span>`).join('')}</div></div></article>`;
  };
  const row = (p, i) => { const t = scTpl(p.id); return `<div class="tp-row"><b><em>${i + 1}.</em>${esc(t.name)}</b><span class="stp">${p.n} 条<div><button data-act="scTplN" data-id="${p.id}" data-d="-1">−</button><button data-act="scTplN" data-id="${p.id}" data-d="1">+</button></div></span><button class="link quiet" data-act="scTplToggle" data-id="${p.id}">移除</button></div>`; };
  return `<div class="sc sc-tp"><section class="tp-m" data-keep-scroll="tpm">${scLibBar()}
      <div class="tp-head"><b>挑选爆文模板</b><small>卖点库已就绪。勾选 1 到 ${SC_TPL_MAX} 个模板，每个模板可以生成 1 条或多条，合计不超过 ${SC_TPL_MAX} 条。</small></div>
      <div class="tp-tools"><label class="search">${ic('search')}<input data-bind="sc.tplQ" data-live="text" value="${esc(c.tplQ)}" placeholder="搜索模板名称、标题、参考文案、类目"></label><button class="lg-chk tp-wide ${c.tplWide ? 'on' : ''}" data-act="scTplWide"><i>${ic('check')}</i>类目不足时扩大搜索</button></div>
      <div class="h4 tp-label">${q ? `<span>搜索结果（${list.length}）</span><button data-act="scTplClear">返回推荐</button>` : '<span>推荐模板<span class="h4-sub">按卖点库本地匹配，原因如实展示</span></span>'}</div>
      ${list.length ? `<div class="tps">${list.map(card).join('')}</div>` : '<p class="note">没有匹配的可用模板。</p>'}</section>
    <aside class="insp" data-keep-scroll="tpi"><div class="h4">已选 ${k} 个模板，共 ${total} / ${SC_TPL_MAX} 条</div>
      ${k ? `<div class="fg">${c.tplPicks.map(row).join('')}</div><p class="note">按这个顺序生成。同一模板多条会生成不同变体。</p>` : '<p class="note">还没选。点左边的模板勾选。</p>'}
      <div style="flex:1"></div><button class="btn back" data-act="scPage" data-v="0">返回素材</button>
      <button class="go ${k ? '' : 'dim'}" data-act="scFromTpl">${k ? `按 ${k} 个模板生成脚本（共 ${total} 条）` : '先勾选模板'}</button></aside></div>`;
}
// 脚本第 2 页：AI 分析与生成
function sc2() {
  const c = S.sc, n = SC_STAGES.length, done = c.stage >= n;
  if (done && c.mode === 'template') return scTemplates();
  const showLib = c.libReady || (c.stage > 5 && !done) || (done && c.stage === n);
  const stages = `<div class="h4">${done ? '处理完成' : `第 ${c.stage + 1} 步，共 ${n} 步`}</div><div class="fg">${SC_STAGES.map((s, i) => `<div class="stg ${i > c.stage ? 'wait' : ''}">${i < c.stage ? ic('check') : i === c.stage ? '<span class="spin"></span>' : '<i class="o"></i>'}${s}</div>`).join('')}</div>`;
  const now = done
    ? `<div class="stage-card"><b>${c.plans.length ? '本组脚本已生成' : '卖点提取完成'}</b><p>${c.plans.length ? `共 ${c.plans.length} 个方案，时长和事实检查都做过了。` : '卖点库已保存，后续生成直接复用。'}</p>${c.plans.length ? '<button class="btn pri" data-act="scPage" data-v="2">查看脚本方案</button>' : ''}</div>`
    : `<div class="stage-card"><small>阶段 ${c.stage + 1}</small><b>${SC_STAGES[c.stage]}</b><p>${SC_COPY[c.stage]}</p><p class="note-s">你可以离开这里，生成过程会继续。长详情页首次提取通常要几分钟。</p></div>`;
  return `<div class="sc2"><aside class="insp" data-keep-scroll="insp3b">${stages}</aside><section class="sc2-m" data-keep-scroll="sc2m">${now}${showLib ? scLibBar() : ''}</section></div>`;
}
// 脚本第 3 页：选择脚本方案
function sc3() {
  const c = S.sc, p = scCurPlan(), tr = p.tplRef && scTpl(p.tplRef);
  const plan = (x, i) => { const e = scEst(scText(x)); return `<button class="it plan ${i === c.plan ? 'on' : ''}" data-act="scPlan" data-i="${i}"><div><b>方案 ${i + 1} ${esc(x.name)}</b><small id="sc-side-${i}">${x.kind}，${e.sec.toFixed(1)} 秒</small></div></button>`; };
  const ev = i => { const x = SC_POINTS[i]; return `<button class="ev" data-act="scZoom" data-i="${i}" title="看详情页原图"><img src="${A[x.ev]}" alt="${x.page}"><span><b>${x.t}</b><small>${x.page}</small></span></button>`; };
  return `<div class="sc sc3"><section class="src"><h4>脚本方案</h4><div class="src-list" data-keep-scroll="scl">${c.plans.map(plan).join('')}</div>
      <p class="note">${c.plans.some(x => x.tplRef) ? '脚本文案是示例，正式版按所选模板改写。' : '方案 1 是真实成片用的脚本，其余是示例文案。'}</p>
      <div class="sc-again"><div class="fr"><span>条数</span>${`<span class="stp">${c.count}<div><button data-act="scStep" data-d="-1">−</button><button data-act="scStep" data-d="1">+</button></div></span>`}</div><div class="fr"><span>时长</span>${selBtn('sc.target', `${c.target} 秒`)}</div></div>
      <button class="drop solid" data-act="scGroup">再生成一组</button><p class="note">只复用卖点库，不重新识图。</p></section>
    <section class="sc-c"><div class="fg sc-cover"><label><span>封面主标题</span><input data-sc="title" value="${esc(p.title)}"></label><label><span>封面副标题</span><input data-sc="sub" value="${esc(p.sub)}"></label></div>
      <div class="mets sc-mets" id="sc-mets">${scMetrics(p)}</div>
      <div class="fg sc-text"><header><b>完整配音稿</b><small>时长按字数估算，成片以实际配音为准</small><span class="tag ok">结尾检查通过</span><span class="tag ok">语义审核通过</span></header><textarea data-sc="text" aria-label="完整配音稿">${esc(scText(p))}</textarea></div>
      <div class="acts inline"><button data-act="scCopy">复制</button><hr><button data-act="scFrame">换一个框架或钩子</button><button data-act="scAgain">${ic('retry')}再生成一版</button></div>
      <div class="h4"><span>用到的卖点<span class="h4-sub">点开看详情页原图，确认没写错</span></span></div>
      <div class="evs">${p.uses.map(ev).join('')}</div></section>
    <aside class="insp" data-keep-scroll="insp3c"><div class="h4">切入角度</div><div class="fg"><div class="kv"><span>人群与场景</span><span>${esc(p.who)}</span></div><div class="kv"><span>核心问题</span><span>${esc(p.pain)}</span></div></div>
      ${tr ? `<div class="h4">爆文模板</div><div class="fg"><p class="fg-t">${esc(tr.name)}</p><div class="kv"><span>结构</span><span>${esc(tr.struct)}</span></div><p class="fg-p tp-full">${esc(tr.ref)}</p></div>`
        : `<div class="h4">模板</div><div class="fg"><div class="kv"><span>${esc(p.tpl)}</span><span>${SC_FRAMES[p.frame]}，${c.target} 秒</span></div><p class="fg-p">${esc(p.why)}</p></div>`}
      <div class="h4">版本历史</div><div class="fg" id="sc-vers">${scVersions(p)}</div></aside></div>${c.zoom != null ? scZoomView() : ''}`;
}
// 视频第四步：批量检查。统一供应商和秒数，逐条改提示词。
function bkTags(s) {
  const p = provOf(s.prov), prompt = s.descs[0].prompt.trim(), transition = !!s.tail && prompt === '从首帧丝滑转场到尾帧';
  return [p.ref ? '<span class="tag run">全能参考</span>' : '', !p.ref && s.tail ? '<span class="tag run">带尾帧</span>' : '', transition ? '<span class="tag off">转场提示词</span>' : '', !prompt ? '<span class="tag warn">未填写</span>' : '', prompt && !transition && s.tpl === '自定义' ? '<span class="tag off">手写已锁定</span>' : ''].join('');
}
function vidSheet(list) {
  const provs = new Set(list.map(s => s.prov)), durs = new Set(list.map(s => s.dur));
  const row = (s, i) => {
    const st = vidStatus(s), p = provOf(s.prov);
    return `<div class="bk"><img src="${A[vidFrame(s)]}" alt=""><div class="bk-n"><b>分镜 ${s.n}</b><small><i class="dot ${st[0]}"></i>${st[1]}</small></div>
      <button class="pop" data-act="sel" data-v="vid.tpl.${i}"><span>${esc(s.tpl)}</span>${ic('chevron-down')}</button>
      <div class="bk-ps">${s.descs.map((d, j) => `<textarea class="bk-p" rows="3" data-bkp="${i}:${j}" placeholder="运镜描述（提示词）">${esc(d.prompt)}</textarea>`).join('')}</div>
      <div class="bk-d"><span class="stp">${s.dur} 秒<div><button data-act="vRowStep" data-i="${i}" data-d="-1">−</button><button data-act="vRowStep" data-i="${i}" data-d="1">+</button></div></span><small>${esc(p.short)}</small></div>
      <span class="bk-tags" id="bk-tag-${i}">${bkTags(s)}</span></div>`;
  };
  const bar = `<div class="bk-bar"><span class="bk-c"><label>统一供应商</label><button class="pop" data-act="sel" data-v="vid.allProv"><span>${provs.size > 1 ? '多个供应商' : esc(provOf(list[0].prov).short)}</span>${ic('chevron-down')}</button></span>
    <span class="bk-c"><label>统一秒数</label><button class="pop" data-act="sel" data-v="vid.allDur"><span>${durs.size > 1 ? '每条不同' : `${list[0].dur} 秒`}</span>${ic('chevron-down')}</button></span>
    <small class="bk-hint">只列出这些模型都支持的秒数</small><button class="btn" data-act="vFill">一键填充提示词</button></div>`;
  const body = `${bar}<div class="fg bk-t"><div class="bk bk-h"><span></span><span>分镜</span><span>模板</span><span>运镜描述（提示词）</span><span>时长和模型</span><span>运镜状态</span></div>${list.map(row).join('')}</div>`;
  return sheet(`批量检查 ${list.length} 个分镜`, '逐条扫一遍提示词、模板和时长。首尾帧回到单个分镜编辑，全能参考直接用对应分镜图。', body,
    '<span class="sh-err"></span><button class="btn" data-act="sheetClose">关闭</button><button class="btn pri" data-act="vAll">全部生成</button>', 'wider');
}
function scZoomView() {
  const x = SC_POINTS[S.sc.zoom];
  return `<div class="scrim" data-act="scZoomClose"><div class="zoomer"><img src="${A[x.ev]}" alt="${x.page}"><div><b>${x.t}</b><p>${x.d}</p><small>${x.page}。数字、材质类卖点已通过二次证据检查。</small><button class="btn" data-act="scZoomClose">关闭</button></div></div></div>`;
}
