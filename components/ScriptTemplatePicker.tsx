'use client';

interface TemplateDef {
  id: string;
  name: string;
  slogan: string;
  example: string;
  suitable: string;
}

const TEMPLATES: TemplateDef[] = [
  {
    id: 'pain_point',
    name: '直击痛点',
    slogan: '"你是不是也…？"',
    example: '你是不是也这样——下班回家腰酸背痛，往床上一靠，靠背硬邦邦的，比上班还累...直到换了这张床。',
    suitable: '功能型卖点',
  },
  {
    id: 'scene_seeding',
    name: '场景种草',
    slogan: '打造让人向往的生活场景',
    example: '周末窝在床上，奶油色的床在柔和光线里美得像杂志。泡杯茶，打开投影，这就是独居女孩的治愈角落。',
    suitable: '颜值/氛围型',
  },
  {
    id: 'feature_showcase',
    name: '功能展示',
    slogan: '一个镜头一个核心功能',
    example: '先看靠背——高回弹海绵，用力压下去瞬间回弹。再看床架——加厚钢板，300kg承重，跳上去纹丝不动。',
    suitable: '硬核参数型',
  },
  {
    id: 'emotional',
    name: '情感共鸣',
    slogan: '先讲一个故事',
    example: '独居第三年，搬家四次。以前觉得床只是睡觉的地方，直到有了第一个真正属于自己的家...它在等你回家。',
    suitable: '生活方式型',
  },
  {
    id: 'comparison',
    name: '对比测评',
    slogan: '使用前 vs 使用后',
    example: '这是我以前的床头——硬邦邦的木靠背，靠十分钟就腰酸。换了这个之后——下班第一件事就是往床上倒。',
    suitable: '有明确对比点',
  },
  {
    id: 'unboxing',
    name: '开箱体验',
    slogan: '从拆包到使用全记录',
    example: '收到床了！一个箱子？打开看看...配件整整齐齐，不用螺丝刀，咔咔几下装好了。女生一个人，五分钟搞定。',
    suitable: '安装简单/包装精致',
  },
  {
    id: 'problem_solving',
    name: '问题解决',
    slogan: '抛出一个问题，展示解决方案',
    example: '扫地机器人每次都卡在床底下怎么办？这张床的床底留了15cm空间，机器人自由进出，床底干干净净。',
    suitable: '实用功能型',
  },
];

interface Props {
  selectedId: string;
  onSelect: (id: string, name: string) => void;
}

export default function ScriptTemplatePicker({ selectedId, onSelect }: Props) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
      {TEMPLATES.map((t) => {
        const isSelected = selectedId === t.id;
        return (
          <button
            key={t.id}
            onClick={() => onSelect(t.id, t.name)}
            className={`cursor-pointer rounded-[14px] border p-3 text-left transition-all ${
              isSelected
                ? 'border-accent bg-accent-tint/10 ring-1 ring-accent/30'
                : 'border-hairline bg-surface hover:border-hairline/80 hover:bg-surface-subtle'
            }`}
          >
            <div className="mb-1 text-sm font-semibold text-ink">{t.name}</div>
            <div className="mb-1.5 text-[0.7rem] italic text-accent">{t.slogan}</div>
            <div className="text-[0.65rem] leading-relaxed text-ink-tertiary line-clamp-2">
              {t.example}
            </div>
            <div className="mt-2 inline-flex rounded-full bg-surface-subtle px-1.5 py-px text-[0.6rem] text-ink-tertiary">
              {t.suitable}
            </div>
          </button>
        );
      })}
    </div>
  );
}
