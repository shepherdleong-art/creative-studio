/**
 * 林视标志（05 号票，团队版外壳用）。
 *
 * 矢量取自原型 `落地素材/林视标志.svg`：绿色渐变圆角方块 + 白色叶子形眼睛，叶子旋转 -45°。
 * 内联而不是引用 `public/icons/**`——那套应用图标归 03 号票，
 * 侧栏只要一个小号标志，不依赖打包产物的更新时机。
 */
export function WorkspaceBrandMark({ size = 26, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label="林视"
      className={className}
      style={{ display: 'block', flex: 'none' }}
    >
      <defs>
        <linearGradient id="lins-brand-gradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#46A97B" />
          <stop offset="1" stopColor="#1D6A4B" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="96" height="96" rx="22" fill="url(#lins-brand-gradient)" />
      <rect x="2.5" y="2.5" width="95" height="95" rx="21.5" fill="none" stroke="#FFFFFF" strokeOpacity="0.22" />
      <g transform="rotate(-45 50 50)">
        <path
          fill="#FFFFFF"
          fillRule="evenodd"
          d="M12 50C28 20 72 20 88 50 72 80 28 80 12 50zM50 39a11 11 0 100 22 11 11 0 000-22z"
        />
      </g>
    </svg>
  );
}

/** 单色叶子：颜色跟随文字色，用在顶栏品牌位等浅色场景。 */
export function WorkspaceLeafMark({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden="true"
      className={className}
      style={{ display: 'block', flex: 'none' }}
    >
      <g transform="rotate(-45 50 50)">
        <path
          fill="currentColor"
          fillRule="evenodd"
          d="M12 50C28 20 72 20 88 50 72 80 28 80 12 50zM50 39a11 11 0 100 22 11 11 0 000-22z"
        />
      </g>
    </svg>
  );
}
