// lib/narration-providers/voice-catalog.ts
/**
 * 已知模型的音色目录：按模型名索引，命中的模型在设置表单里用勾选列表代替自由文本。
 * 只有 openai-compatible-tts 协议下的具体已知模型才查这张表——协议类型本身不能预判
 * 背后是哪个模型，详见 lib/narration-providers/config.ts 对 openai-compatible-tts
 * defaultVoices 留空的说明。
 */

export interface KnownVoice {
  /** 传给 API 的 voice 参数值，如 "Cherry" */
  id: string;
  /** 官方中文音色名，用于 checkbox 显示，如 "芊悦" */
  label: string;
  /** 官方人设描述，用于 hover tooltip */
  description: string;
}

export const KNOWN_VOICE_CATALOG: Record<string, KnownVoice[]> = {
  'qwen-tts': [
    { id: 'Cherry', label: '芊悦', description: '阳光积极、亲切自然小姐姐（女性）' },
    { id: 'Serena', label: '苏瑶', description: '温柔小姐姐（女性）' },
    { id: 'Ethan', label: '晨煦', description: '标准普通话，带部分北方口音。阳光、温暖、活力、朝气（男性）' },
    { id: 'Chelsie', label: '千雪', description: '二次元虚拟女友（女性）' },
  ],
  'qwen3-tts-flash': [
    { id: 'Cherry', label: '芊悦', description: '阳光积极、亲切自然小姐姐（女性）' },
    { id: 'Serena', label: '苏瑶', description: '温柔小姐姐（女性）' },
    { id: 'Ethan', label: '晨煦', description: '标准普通话，带部分北方口音。阳光、温暖、活力、朝气（男性）' },
    { id: 'Chelsie', label: '千雪', description: '二次元虚拟女友（女性）' },
    { id: 'Momo', label: '茉兔', description: '撒娇搞怪，逗你开心（女性）' },
    { id: 'Vivian', label: '十三', description: '拽拽的、可爱的小暴躁（女性）' },
    { id: 'Moon', label: '月白', description: '率性帅气的月白（男性）' },
    { id: 'Maia', label: '四月', description: '知性与温柔的碰撞（女性）' },
    { id: 'Kai', label: '凯', description: '耳朵的一场SPA（男性）' },
    { id: 'Nofish', label: '不吃鱼', description: '不会翘舌音的设计师（男性）' },
    { id: 'Bella', label: '萌宝', description: '喝酒不打醉拳的小萝莉（女性）' },
    { id: 'Jennifer', label: '詹妮弗', description: '品牌级、电影质感般美语女声（女性）' },
    { id: 'Ryan', label: '甜茶', description: '节奏拉满，戏感炸裂，真实与张力共舞（男性）' },
    { id: 'Katerina', label: '卡捷琳娜', description: '御姐音色，韵律回味十足（女性）' },
    { id: 'Aiden', label: '艾登', description: '精通厨艺的美语大男孩（男性）' },
    { id: 'Eldric Sage', label: '沧明子', description: '沉稳睿智的老者，沧桑如松却心明如镜（男性）' },
    { id: 'Mia', label: '乖小妹', description: '温顺如春水，乖巧如初雪（女性）' },
    { id: 'Mochi', label: '沙小弥', description: '聪明伶俐的小大人，童真未泯却早慧如禅（男性）' },
    { id: 'Bellona', label: '燕铮莺', description: '声音洪亮，吐字清晰，人物鲜活，听得人热血沸腾；金戈铁马入梦来，字正腔圆间尽显千面人声的江湖（女性）' },
    { id: 'Vincent', label: '田叔', description: '一口独特的沙哑烟嗓，一开口便道尽了千军万马与江湖豪情（男性）' },
    { id: 'Bunny', label: '萌小姬', description: '"萌属性"爆棚的小萝莉（女性）' },
    { id: 'Neil', label: '阿闻', description: '平直的基线语调，字正腔圆的咬字发音，这就是最专业的新闻主持人（男性）' },
    { id: 'Elias', label: '墨讲师', description: '既保持学科严谨性，又通过叙事技巧将复杂知识转化为可消化的认知模块（女性）' },
    { id: 'Arthur', label: '徐大爷', description: '被岁月和旱烟浸泡过的质朴嗓音，不疾不徐地摇开了满村的奇闻异事（男性）' },
    { id: 'Nini', label: '邻家妹妹', description: '糯米糍一样又软又黏的嗓音，那一声声拉长了的"哥哥"，甜得能把人的骨头都叫酥了（女性）' },
    { id: 'Seren', label: '小婉', description: '温和舒缓的声线，助你更快地进入睡眠，晚安，好梦（女性）' },
    { id: 'Pip', label: '顽屁小孩', description: '调皮捣蛋却充满童真的他来了，这是你记忆中的小新吗（男性）' },
    { id: 'Stella', label: '少女阿月', description: '平时是甜到发腻的迷糊少女音，但在喊出"代表月亮消灭你"时，瞬间充满不容置疑的爱与正义（女性）' },
    { id: 'Bodega', label: '博德加', description: '热情的西班牙大叔（男性）' },
    { id: 'Sonrisa', label: '索尼莎', description: '热情开朗的拉美大姐（女性）' },
    { id: 'Alek', label: '阿列克', description: '一开口，是战斗民族的冷，也是毛呢大衣下的暖（男性）' },
    { id: 'Dolce', label: '多尔切', description: '慵懒的意大利大叔（男性）' },
    { id: 'Sohee', label: '素熙', description: '温柔开朗，情绪丰富的韩国欧尼（女性）' },
    { id: 'Ono Anna', label: '小野杏', description: '鬼灵精怪的青梅竹马（女性）' },
    { id: 'Lenn', label: '莱恩', description: '理性是底色，叛逆藏在细节里——穿西装也听后朋克的德国青年（男性）' },
    { id: 'Emilien', label: '埃米尔安', description: '浪漫的法国大哥哥（男性）' },
    { id: 'Andre', label: '安德雷', description: '声音磁性，自然舒服、沉稳男生（男性）' },
    { id: 'Radio Gol', label: '拉迪奥·戈尔', description: '足球诗人Rádio Gol！今天我要用名字为你们解说足球（男性）' },
    { id: 'Jada', label: '上海-阿珍', description: '风风火火的沪上阿姐（女性，上海话）' },
    { id: 'Dylan', label: '北京-晓东', description: '北京胡同里长大的少年（男性，北京话）' },
    { id: 'Li', label: '南京-老李', description: '耐心的瑜伽老师（男性，南京话）' },
    { id: 'Marcus', label: '陕西-秦川', description: '面宽话短，心实声沉——老陕的味道（男性，陕西话）' },
    { id: 'Roy', label: '闽南-阿杰', description: '诙谐直爽、市井活泼的台湾哥仔形象（男性，闽南语）' },
    { id: 'Peter', label: '天津-李彼得', description: '天津相声，专业捧哏（男性，天津话）' },
    { id: 'Sunny', label: '四川-晴儿', description: '甜到你心里的川妹子（女性，四川话）' },
    { id: 'Eric', label: '四川-程川', description: '一个跳脱市井的四川成都男子（男性，四川话）' },
    { id: 'Rocky', label: '粤语-阿强', description: '幽默风趣的阿强，在线陪聊（男性，粤语）' },
    { id: 'Kiki', label: '粤语-阿清', description: '甜美的港妹闺蜜（女性，粤语）' },
  ],
};

/**
 * 解析模型名对应的已知音色目录：trim + 大小写不敏感精确匹配；
 * qwen3-tts-flash 的带日期版本号（如 qwen3-tts-flash-2025-11-27）归一到同一目录。
 * 未命中返回 null。
 */
export function resolveKnownVoiceCatalog(model: string): KnownVoice[] | null {
  const key = model.trim().toLowerCase();
  if (!key) return null;
  for (const [catalogKey, voices] of Object.entries(KNOWN_VOICE_CATALOG)) {
    if (catalogKey.toLowerCase() === key) return voices;
  }
  if (/^qwen3-tts-flash-\d{4}-\d{2}-\d{2}$/.test(key)) {
    return KNOWN_VOICE_CATALOG['qwen3-tts-flash'];
  }
  return null;
}

/**
 * 切换一个音色的勾选状态，返回新的逗号分隔字符串。
 * toggledId 必须是 catalog 中的音色 id（调用方从同一 catalog 渲染 checkbox，天然满足）。
 * 已知音色按 catalog 原始顺序排在前面；currentVoicesCsv 里已存在但不在 catalog 中的
 * "目录外音色" 原样保留、按其原有相对顺序追加在后，不会因为这次切换被丢弃。
 */
export function toggleVoiceSelection(currentVoicesCsv: string, catalog: KnownVoice[], toggledId: string): string {
  const current = currentVoicesCsv
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  const catalogIds = new Set(catalog.map((v) => v.id));
  const selectedKnown = new Set(current.filter((v) => catalogIds.has(v)));
  const unknown = current.filter((v) => !catalogIds.has(v));

  if (selectedKnown.has(toggledId)) {
    selectedKnown.delete(toggledId);
  } else {
    selectedKnown.add(toggledId);
  }

  const orderedKnown = catalog.filter((v) => selectedKnown.has(v.id)).map((v) => v.id);
  return [...orderedKnown, ...unknown].join(',');
}

/**
 * 仅当 mode === 'create' 且 currentVoicesCsv（trim 后）为空时，返回 catalog 前 4 个音色 id 作为默认勾选建议；
 * 其余情况（编辑模式，或音色框已有内容）一律返回 null，调用方收到 null 就什么都不做。
 */
export function resolveDefaultVoiceSelection(
  mode: 'create' | 'edit',
  catalog: KnownVoice[],
  currentVoicesCsv: string
): string[] | null {
  if (mode !== 'create') return null;
  if (currentVoicesCsv.trim() !== '') return null;
  return catalog.slice(0, 4).map((v) => v.id);
}
