// 两套方案共用的内容。图和项目名是真的，数字和任务是示例。
const A = {
  s1:'img://w1600/scene-s1', s2:'img://w1600/scene-s2', s3:'img://w1600/scene-s3', s4:'img://w1600/scene-s4',
  real:'img://w1600/real-w16', real1:'img://w640/shot01-real', real2:'img://w640/shot02-real',
  n1:'img://w640/shot01-new', n2:'img://w640/shot02-new', n3:'img://w640/shot08-new', n4:'img://w640/shot06-new',
  g564:'img://w640/g564-product', rq:'img://w640/scene-2', ps:'img://w640/cover-gray-1', qf:'img://w640/cover-brown-2',
  lh98:'img://w640/scene-1', xq:'img://w640/input-2', pc:'img://w640/scene-3', ps118:'img://w640/cover-black-1',
  g564c:'img://w640/g564-final-cover', psc:'img://w640/cover-black-2',
  f1:'img://w640/film-3.0', f2:'img://w640/film-8.6', f3:'img://w640/film-cover',
  c0:'img://w640/clip-0', c1:'img://w640/clip-1', c2:'img://w640/clip-2', c3:'img://w640/clip-3', c4:'img://w640/clip-4', c5:'img://w640/clip-5', c6:'img://w640/clip-6',
  film:'vid://case-film',
};

const NAV = {
  member: [
    { g:'创作', items:[['home','工作台','grid'],['projects','我的项目','folder'],['canvas','创作画布','sparkle']] },
    { g:'进度', items:[['mytasks','我的任务','logs',5],['downloads','下载与交付','download'],['errors','出错的任务','alert',1]] },
    { g:'账目', items:[['usage','我的用量','table']] },
  ],
  admin: [
    { g:'总览', items:[['overview','运行总览','grid']] },
    { g:'生产', items:[['aprojects','项目空间','folder'],['canvas','创作画布','sparkle'],['tasks','全员任务','logs',18],['downloads','下载与交付','download'],['errors','出错的任务','alert',3]] },
    { g:'资源', items:[['pools','模型与名额','cpu'],['settings','供应商配置','settings'],['resources','公共资源','image']] },
    { g:'团队', items:[['users','成员与账号','users'],['ausage','团队用量','table']] },
    { g:'系统', items:[['ops','版本与备份','monitor']] },
  ],
};
const PLACEHOLDER = {
  canvas:['创作画布','按创作主题组织画布，多组图片与视频任务并行推进。'], downloads:['下载与交付','查看这台电脑的成片下载状态。'],
  usage:['我的用量','本月额度、模型花费和调用记录。'], aprojects:['项目空间','全员的项目。'], settings:['供应商配置','图片、脚本、视频、配音模型的密钥和地址。'],
  resources:['公共资源','提示词模板、标题、LUT、配乐和脚本知识。'], users:['成员与账号','工号、角色、月度额度和个人并发。'], ausage:['团队用量','全团队的费用和调用记录。'],
  ops:['版本与备份','备份、还原和服务器升级。'], recycle:['回收站','删除的项目和素材，可以恢复。'], account:['修改密码','输入当前密码，设置至少 6 位的新密码。'],
  step2:['分镜生成','整理原始分镜并批量生成。'], step3:['脚本生成','卖点、人群和口播脚本。'], step4:['视频生成','选择分镜组创建视频任务。'],
};

const STEPS = [['scene','场景图','新场景图生成'],['step2','分镜','分镜生成'],['step3','脚本','脚本生成'],['step4','视频','视频生成'],['mix','混剪','智能混剪']];

const PROJECTS = [
  { id:'lh122', code:'LH122K3-B1', full:'20261107-B店-LH122K3-B1-AI种草-PUIKIN', store:'B店', type:'AI种草', editor:'PUIKIN', date:'11-07', thumb:'s4', step:5, stepLabel:'智能混剪', detail:'第 3 版待审', st:'review', cost:'¥75.09', mine:true },
  { id:'g564', code:'G564-A', full:'20261106-K店-G564-A-新品种草-PUIKIN', store:'K店', type:'新品种草', editor:'PUIKIN', date:'11-06', thumb:'g564', step:4, stepLabel:'视频生成', detail:'8 / 12 段', st:'run', cost:'¥33.40', mine:true },
  { id:'rq5a', code:'RQ5A-A1', full:'20261105-D店-RQ5A-A1-AI种草-PUIKIN', store:'D店', type:'AI种草', editor:'PUIKIN', date:'11-05', thumb:'rq', step:2, stepLabel:'分镜生成', detail:'2 张出错', st:'bad', cost:'¥18.60', mine:true },
  { id:'ps123', code:'PS123', full:'20261105-京东-PS123-新品种草-PUIKIN', store:'京东', type:'新品种草', editor:'PUIKIN', date:'11-05', thumb:'ps', step:5, stepLabel:'智能混剪', detail:'12 条已交付', st:'ok', cost:'¥64.30', mine:true },
  { id:'qf08', code:'QF08', full:'20261104-D店-QF08-新品种草-PUIKIN', store:'D店', type:'新品种草', editor:'PUIKIN', date:'11-04', thumb:'qf', step:3, stepLabel:'脚本生成', detail:'写作中', st:'run', cost:'¥26.15', mine:true },
  { id:'lh098', code:'LH098-C2', full:'20261103-B店-LH098-C2-AI种草-PUIKIN', store:'B店', type:'AI种草', editor:'PUIKIN', date:'11-03', thumb:'lh98', step:5, stepLabel:'智能混剪', detail:'9 条已交付', st:'ok', cost:'¥51.20', mine:true },
  { id:'xq9a', code:'XQ9A', full:'20261103-K店-XQ9A-AI种草-PUIKIN', store:'K店', type:'AI种草', editor:'PUIKIN', date:'11-03', thumb:'xq', step:5, stepLabel:'智能混剪', detail:'第 1 版待审', st:'review', cost:'¥28.70', mine:true },
  { id:'pc672', code:'PC672-A', full:'20261102-京东-PC672-A-AI种草-PUIKIN', store:'京东', type:'AI种草', editor:'PUIKIN', date:'11-02', thumb:'pc', step:5, stepLabel:'智能混剪', detail:'10 条已交付', st:'ok', cost:'¥47.10', mine:true },
  { id:'ps118', code:'PS118', full:'20261101-B店-PS118-新品种草-PUIKIN', store:'B店', type:'新品种草', editor:'PUIKIN', date:'11-01', thumb:'ps118', step:5, stepLabel:'智能混剪', detail:'11 条已交付', st:'ok', cost:'¥58.90', mine:true },
];
const WAITING = [
  { img:'f3', title:'LH122K3-B1 第 3 版成片', sub:'智能混剪，10 分钟前做好，17 秒', kind:'review', label:'待审', cta:'去审片', go:'mix', isNew:true },
  { img:'g564c', title:'XQ9A 第 1 版成片', sub:'智能混剪，25 分钟前做好，15 秒', kind:'review', label:'待审', cta:'去审片', go:'mix', isNew:true },
  { img:'psc', title:'PS123 第 6 版成片', sub:'智能混剪，1 小时前做好，20 秒', kind:'review', label:'待审', cta:'去审片', go:'mix', isNew:true },
  { img:'rq', title:'RQ5A-A1 分镜', sub:'图片生成失败 2 张，其余 7 张正常', kind:'bad', label:'2 张出错', cta:'去看看', go:'errors' },
];
const LIVE = [
  { label:'G564-A 视频生成', sub:'可灵 2.5 1080p', p:66 },
  { label:'QF08 脚本生成', sub:'GPT-5-6-Luna', p:40 },
  { label:'LH098-C2 成片渲染', sub:'本地渲染', p:62 },
  { label:'G564-A 配音生成', sub:'Qwen3 TTS', p:18 },
];
const CREATE = [
  ['常规项目','场景、分镜到成片','film'],['批量生产','进入项目开展批量制作','grid'],['详情页脚本','进入项目编写产品文案','file-text'],['创作画布','连接灵感与生成流程','sparkle'],
];

// 真实状态文案来自 lib/team-task-labels.ts
const STATUS = {
  pending:['排队中','wait'], deferred:['等待运行条件','wait'], admitted:['准备发送','run'], maybe_sent:['提交中（待确认）','warn'], accepted:['供应商已受理','run'],
  reconciling:['核查结果中','warn'], succeeded:['成功','ok'], failed:['失败','bad'], unknown:['提交结果待核查','warn'], canceled:['已取消','off'],
};
const CALL_STATE = { not_sent:'待调用，尚未发送', maybe_sent:'已发起提交，结果待确认', accepted:'供应商已受理', terminal:'执行记录已结束' };
const TASKS = [
  ['视频生成','查询生成结果','B店-LH122K3-B1-AI种草','PUIKIN','公司网关','可灵 2.5 1080p','accepted','14:32'],
  ['图片生成','生成请求','K店-G564-A-新品种草','ALAN','公司网关','七牛云 GPT Image 2 Medium','maybe_sent','14:31'],
  ['智能混剪','成片渲染','D店-RQ5A-A1-AI种草','可华','本机','本地渲染','admitted','14:30'],
  ['视频生成','查询生成结果','B店-LH122K3-B1-AI种草','PUIKIN','公司网关','Seedance 2.5','accepted','14:29'],
  ['配音生成','生成请求','京东-PS123-新品种草','强尼','配音服务','Qwen3 TTS','succeeded','14:28'],
  ['脚本与文本生成','第 2 条文案 生成','K店-G564-A-新品种草','ALAN','公司网关','GPT-5-6-Luna','pending','14:27'],
  ['视频生成','生成请求','D店-QF08-新品种草','可华','公司网关','可灵 3.0','unknown','14:26'],
  ['图片生成','下载结果','D店-RQ5A-A1-AI种草','可华','公司网关','Seedream 5.0 Pro','failed','14:24'],
  ['图片生成','生成请求','京东-PS123-新品种草','强尼','公司网关','Nano Banana Pro','succeeded','14:21'],
  ['智能混剪','素材分析','B店-LH122K3-B1-AI种草','PUIKIN','公司网关','Gemini','succeeded','14:18'],
  ['字幕对齐','生成请求','京东-PS123-新品种草','强尼','本机','本地对齐','succeeded','14:16'],
  ['视频生成','下载结果','K店-G564-A-新品种草','ALAN','公司网关','可灵 2.5 1080p','succeeded','14:12'],
  ['图片生成','查询生成结果','K店-G564-A-新品种草','ALAN','公司网关','image2-medium','succeeded','14:09'],
  ['脚本与文本生成','卖点整理','D店-QF08-新品种草','可华','公司网关','GPT-5-6-Luna','succeeded','14:05'],
  ['视频生成','查询生成结果','京东-PS123-新品种草','强尼','公司网关','Seedance 2.0 Fast','succeeded','13:58'],
  ['智能混剪','导出','京东-PS123-新品种草','强尼','本机','本地渲染','succeeded','13:52'],
  ['配音生成','生成请求','B店-LH122K3-B1-AI种草','PUIKIN','配音服务','Qwen3 TTS','succeeded','13:47'],
  ['图片生成','生成请求','D店-RQ5A-A1-AI种草','可华','公司网关','Seedream 5.0 Pro','failed','13:41'],
  ['视频生成','生成请求','B店-LH098-C2-AI种草','PUIKIN','公司网关','可灵 2.5 1080p','succeeded','13:36'],
  ['图片生成','下载结果','B店-LH098-C2-AI种草','PUIKIN','公司网关','七牛云 GPT Image 2 Medium','succeeded','13:30'],
  ['智能混剪','成片渲染','B店-LH098-C2-AI种草','PUIKIN','本机','本地渲染','succeeded','13:22'],
  ['视频生成','查询生成结果','K店-XQ9A-AI种草','PUIKIN','公司网关','可灵 3.0','deferred','13:18'],
  ['脚本与文本生成','视觉信息复核','K店-XQ9A-AI种草','PUIKIN','公司网关','GPT-5-6-Luna','succeeded','13:10'],
  ['图片生成','生成请求','京东-PC672-A-AI种草','ALAN','公司网关','Nano Banana 2','canceled','12:55'],
].map((t, i) => {
  const [mod, step, proj, actor, provider, model, status, time] = t;
  const calls = status === 'pending' || status === 'deferred'
    ? [{ state:'not_sent', time, model:null }]
    : status === 'maybe_sent' || status === 'unknown'
      ? [{ state:'maybe_sent', time, model }]
      : status === 'accepted' || status === 'admitted'
        ? [{ state:'accepted', time, model }]
        : [{ state:'accepted', time, model }, { state:'terminal', time, model }];
  return { id:`T${1000 + i}`, mod, step, proj, actor, provider, model, status, time, calls, err: status === 'failed' ? `E-${4210 + i}` : null };
});

// 真实结构来自 /api/team/pools：同一上游账号的模型共用一个名额池
const POOLS_FULL = [
  { key:'media-upstream:a8da36b55d81c3021f58f6cc1616e173', name:'公司网关账号', kind:'图片和视频', models:['Nano Banana 2','Nano Banana Pro','Seedream 5.0 Pro','image2-medium','七牛云 GPT Image 2 Medium','MiniMax H3 2K','七牛可灵 3.0','万相 Wan 3.0','Seedance 2.0 Fast','Seedance 2.0','Seedance 2.5','可灵 2.5 1080p','可灵 3.0'], cap:20, held:12, accepted:9, maybe:1, notSent:2, on:true, state:'ready', members:[['PUIKIN',6,2,6],['ALAN',3,0,3],['可华',2,1,1],['强尼',1,0,1]] },
  { key:'llm:remote', name:'脚本模型', kind:'脚本', models:['脚本 / LLM'], cap:12, held:1, accepted:1, maybe:0, notSent:0, on:true, state:'ready', members:[['ALAN',1,0,1]] },
  { key:'media-upstream:96a296d224f285c67bee93c30f8a3091', name:'可灵官方账号', kind:'视频', models:['可灵 2.5'], cap:0, held:0, accepted:0, maybe:0, notSent:0, on:true, state:'missing', members:[] },
  { key:'tts:remote', name:'配音与字幕', kind:'配音', models:['TTS / 字幕对齐'], cap:0, held:0, accepted:0, maybe:0, notSent:0, on:true, state:'missing', members:[] },
  { key:'', name:'即梦官方账号', kind:'视频', models:['即梦 2.0（Seedance 2.0）'], cap:0, held:0, accepted:0, maybe:0, notSent:0, on:true, state:'credential', members:[] },
];
const POOL_STATE = { ready:'可以用', missing:'还没设名额', credential:'缺密钥', off:'已停用' };
const SETUP = [
  { label:'公司模型代理', state:'未就绪', note:'服务器上还没启动。启动后员工才能用公司模型。', cta:'查看启动步骤', go:'ops' },
  { label:'参考图中转', state:'已配置', note:'腾讯云 COS 已连上。', ok:true },
  { label:'模型名额', state:'还没设', note:'给每个账号填一个数字，就是它同时能跑几条。', cta:'去设置', go:'pools' },
];

// 真实案例成片：切点和字幕读自 case-film.mp4
const FILM = {
  dur:17.292, fps:24,
  clips:[
    { t0:0, t1:.833, img:'c0', name:'封面', src:'20 帧片头', cover:true },
    { t0:.833, t1:3.583, img:'c1', name:'01-分镜-LH122K3-全景', src:'可灵 2.5 1080p' },
    { t0:3.583, t1:6.333, img:'c2', name:'04-分镜-LH122K3-实木粗腿', src:'Seedance 2.5' },
    { t0:6.333, t1:8.958, img:'c3', name:'05-分镜-LH122K3-立水支撑', src:'Seedance 2.5' },
    { t0:8.958, t1:11.208, img:'c4', name:'03-分镜-LH122K3-大板直拼', src:'Seedance 2.5' },
    { t0:11.208, t1:14.625, img:'c5', name:'06-分镜-LH122K3-座深', src:'可灵 2.5 1080p' },
    { t0:14.625, t1:17.292, img:'c6', name:'09-分镜-LH122K3-收尾', src:'可灵 2.5 1080p' },
  ],
  subs:[
    { t0:.833, t1:1.75, text:'天天坐躺' }, { t0:1.75, t1:3.583, text:'沙发支撑不能只看外观' }, { t0:3.583, t1:6, text:'约6.5厘米实心实木粗腿' },
    { t0:6, t1:8.958, text:'配约4.5厘米立水支撑' }, { t0:8.958, t1:11, text:'约2.6厘米厚料大板直拼' }, { t0:11, t1:12.9, text:'约60厘米座深' },
    { t0:12.9, t1:14.9, text:'坐姿更舒展' }, { t0:14.9, t1:15.9, text:'想了解这款' }, { t0:15.9, t1:17.292, text:'点击下方链接看看吧' },
  ],
};
const VOICES = [['温柔知性女声','自然，适合家居种草'],['活力少女音','轻快，适合新品'],['沉稳男声','讲工艺和材质'],['亲切邻家女声','日常分享']];
const TEMPLATES = ['f1 花字种草','f2 手账拼贴','f3 极简高级','f4 综艺撕纸'];
const CREATE_STAGES = ['文案拆分与素材分析','逐句口播生成','记录真实口播时长','节拍检测与场景匹配','预热可预览草稿'];
const EXPORT_STAGES = ['正在检查','正在准备镜头','正在合成画面','正在合成声音','正在合成视频','正在生成封面','正在检查成片','正在保存交付记录'];
const LOGS = [['14:32:08','G564-A 视频生成 第 8/12 段，供应商已受理'],['14:31:58','七牛云 GPT Image 2 提交中，结果待确认'],['14:31:40','Qwen3 TTS 口播完成，用时 18 秒'],['14:30:12','S4 设为场景参考图'],['14:29:36','候选 S1 至 S4 生成完成，用时 41 秒']];
const SCREENS = [['brand','品牌'],['login','登录'],['home','工作台'],['scene','选场景图'],['mix','智能混剪'],['overview','运行总览'],['tasks','全员任务'],['pools','模型与名额']];
const TAGLINE = '出片交给 AI，眼光留给你。';
const SUBTITLE = 'AI 产品图与短视频创作工作台';
const PROVIDERS = ['公司网关 七牛云 GPT Image 2 Medium','公司网关 image2-medium','公司 Seedream 5.0 Pro','公司 Nano Banana Pro','公司 Nano Banana 2'];
