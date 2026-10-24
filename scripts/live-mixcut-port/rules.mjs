// 搬家用的机械替换规则，copy-and-rename.mjs 和 port-tests.mjs 共用。
// 顺序有意义：先处理带斜杠的长写法，再处理短写法。
export const REPLACEMENTS = [
  // 同时覆盖 '@/lib/batch-production/x' 和 '../../../lib/batch-production/x' 两种写法。
  [/\blib\/batch-production\//g, 'lib/live-mixcut/'],
  [/\bcomponents\/batch-production\//g, 'components/live-mixcut/'],
  [/\/api\/batch-production\b/g, '/api/live-mixcut'],
  [/CREATIVE_STUDIO_FORMULA_MIXCUT/g, 'CREATIVE_STUDIO_LIVE_MIXCUT_ENABLE'],
  // 存储目录：全部收进 storage/live-mixcut/ 下，避免和批量共用目录或被批量的清理逻辑误删。
  [/storage\/batch-media/g, 'storage/live-mixcut/media'],
  [/'batch-media'/g, "'live-mixcut/media'"],
  [/storage\/batch-renders/g, 'storage/live-mixcut/renders'],
  [/'batch-renders'/g, "'live-mixcut/renders'"],
  [/'storage', 'cache', 'proxies'/g, "'storage', 'live-mixcut', 'cache', 'proxies'"],
  [/path\.join\('projects', ([A-Za-z.]+), '成片'\)/g, "path.join('live-mixcut', 'exports', $1, '成片')"],
  [/\.batch-media-import-/g, '.live-mixcut-import-'],
  [/batch-formula\//g, 'live-mixcut/'],
  [/'batch-formula'/g, "'live-mixcut'"],
  [/'batch-production'/g, "'live-mixcut'"],
  [/'batch-scheduler'/g, "'live-mixcut-scheduler'"],
  // 表名、触发器、索引（含 idx_batch_x）、错误码：所有 batch_ → live_mixcut_（batch_formula_x → live_mixcut_formula_x，不会撞名）。
  [/batch_/g, 'live_mixcut_'],
  [/\bidx_formula_/g, 'idx_live_mixcut_formula_'],
];

export function applyReplacements(text, onReplace = () => {}) {
  for (const [pattern, replacement] of REPLACEMENTS) {
    text = text.replace(pattern, (...match) => {
      onReplace();
      return replacement.replace(/\$(\d)/g, (_, n) => match[Number(n)]);
    });
  }
  return text;
}
