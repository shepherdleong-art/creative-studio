import styles from '@/components/mixcut/mixcut-content.module.css';

export const TEMPLATES: Array<{ id: string; name: string; desc: string }> = [
  { id: 'overlay-poster', name: 'A 花字种草', desc: '两行描边大字 + 荧光笔标记 + 杂志风标签，配色吸画面主色' },
  { id: 'overlay-journal', name: 'B 手账拼贴', desc: '牛皮纸撕纸窗 + 笔记本便签胶带，低饱和奶白配色' },
  { id: 'overlay-minimal', name: 'C 极简高级', desc: '顶部米白色块承载标题 + 圆章箭头卖点便签，安静留白' },
  { id: 'overlay-variety', name: 'D 综艺撕纸', desc: '逐字跳舞花字 + 笔刷副标 + 搜索框卖点，复古撞色' },
];

export function TemplateThumb({ template }: { template: string }) {
  if (template === 'overlay-journal') {
    return (
      <span className={`${styles.tplThumb} ${styles.tplThumbJournal}`} aria-hidden="true">
        <span className={styles.tpTape} />
        <span className={styles.tpNote} />
        <span className={`${styles.tpSticker} ${styles.tpSticker1}`} />
        <span className={`${styles.tpSticker} ${styles.tpSticker2}`} />
      </span>
    );
  }
  if (template === 'overlay-minimal') {
    return (
      <span className={`${styles.tplThumb} ${styles.tplThumbMinimal}`} aria-hidden="true">
        <span className={styles.tpThinTitle} />
        <span className={styles.tpCap} />
        <span className={styles.tpCap} />
        <span className={styles.tpCap} />
      </span>
    );
  }
  if (template === 'overlay-variety') {
    // v4 特征：逐字跳舞花字（金色双行）+ 暗红绸带副标 + 搜索框卖点（§13.4，修正 v2 撕纸条漂移）
    return (
      <span className={`${styles.tplThumb} ${styles.tplThumbVariety}`} aria-hidden="true">
        <span className={styles.tpGold} />
        <span className={styles.tpGold2} />
        <span className={styles.tpBanner} />
        <span className={`${styles.tpSearch} ${styles.tpSearch1}`} />
        <span className={`${styles.tpSearch} ${styles.tpSearch2}`} />
      </span>
    );
  }
  return (
    <span className={styles.tplThumb} aria-hidden="true">
      <span className={styles.tpHero} />
      <span className={styles.tpSub} />
      <span className={`${styles.tpPill} ${styles.tpPill1}`} />
      <span className={`${styles.tpPill} ${styles.tpPill2}`} />
      <span className={`${styles.tpPill} ${styles.tpPill3}`} />
    </span>
  );
}

