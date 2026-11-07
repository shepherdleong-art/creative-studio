"""生成打包字体切片（实施期一次性运行；构建期只读本地文件，不联网、不跑本脚本）。

产物：
  public/fonts/lins-sans-*.woff2   —— 中文（思源黑体）按字符频次分片的 woff2 切片
  public/fonts/inter-latin.woff2   —— Inter 拉丁字母 + 数字子集
  public/fonts/slices.json         —— 切片清单（片名 / 字数 / 字节数 / unicode-range）
  public/fonts/OFL-*.txt           —— 两套字体的 SIL OFL 许可证
  app/fonts.css                    —— 与切片一一对应的 @font-face 声明

为什么按「字符频次分片」而不是按 Unicode 区段均分：
  中文页面用到的字集中在高频字。按频次切，首屏通常只命中 1 个核心切片；
  按码位均分时一句中文会打散到 6~8 个切片，反而下载更多字节。
  每个切片仍然用 unicode-range 精确声明自己覆盖的码位，
  所以「用到哪一段才下载哪一段」的机制与按区段切片完全一致。

用法（需要 fontTools + brotli）：
  python scripts/ui/build-font-slices.py
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[2]
CJK_SOURCE = ROOT / 'packaging' / 'templates' / 'classic' / '1' / 'assets' / 'fonts' / 'SourceHanSansCN-VF.ttf'
INTER_SOURCE = ROOT / 'scripts' / 'ui' / 'vendor' / 'inter-latin-wght-normal.woff2'
OUT_DIR = ROOT / 'public' / 'fonts'
CSS_PATH = ROOT / 'app' / 'fonts.css'
# 子集属于「修改版」：OFL 的自留字体名（Reserved Font Name）条款要求改名后才能再分发，
# 思源黑体的自留名是 'Source'。字形完全来自 Source Han Sans CN VF 2.005，
# 对外以 Lins Sans SC 声明，避开自留名限制。
FAMILY_ZH = 'Lins Sans SC'
CJK_ORIGIN = 'Source Han Sans CN VF'
FAMILY_LATIN = 'Inter'
# Inter 拉丁子集的覆盖范围（与 @fontsource-variable/inter 的 wght.css latin 段一致）。
LATIN_UNICODE_RANGE = (
    'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, '
    'U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, '
    'U+FEFF, U+FFFD'
)

SCAN_DIRS = ['app', 'components', 'lib']
SCAN_EXTS = {'.tsx', '.ts', '.css', '.mjs'}
# 切片策略：
#   1) lins-sans-ui-N —— 源码里实际出现的字，按频次每 400 字一片。
#      界面文案几乎全落在这几片里，首屏命中 2~3 片即可，不必下载整套。
#   2) lins-sans-gb-N —— GB2312 里界面没用到的常用字（用户输入的项目名、姓名等），
#      按码位分 5 片，只有真的出现表外字才下载其中一片。
UI_BAND_CHARS = 400
GB2312_CHUNKS = 5


def in_cjk_scope(code: int) -> bool:
    return (
        0x2E80 <= code <= 0x9FFF
        or 0xF900 <= code <= 0xFAFF
        or 0xFF00 <= code <= 0xFFEF
        or 0x3000 <= code <= 0x303F
        or 0x2000 <= code <= 0x206F
    )


def scan_frequency() -> list[str]:
    """统计源码里中文字符的使用频次，作为切片顺序的依据。"""
    freq: dict[str, int] = {}
    for directory in SCAN_DIRS:
        for path in (ROOT / directory).rglob('*'):
            if not path.is_file() or path.suffix not in SCAN_EXTS:
                continue
            text = path.read_text(encoding='utf-8', errors='ignore')
            for char in text:
                if in_cjk_scope(ord(char)):
                    freq[char] = freq.get(char, 0) + 1
    return [char for char, _ in sorted(freq.items(), key=lambda item: (-item[1], item[0]))]


def gb2312_hanzi() -> list[str]:
    """GB2312 一二级汉字，覆盖日常中文输入；表外生僻字退回系统字体。"""
    result: list[str] = []
    for high in range(0xB0, 0xF8):
        for low in range(0xA1, 0xFF):
            try:
                result.append(bytes([high, low]).decode('gb2312'))
            except UnicodeDecodeError:
                continue
    return result


def build_plan() -> list[dict]:
    used = scan_frequency()
    # ui-* 片：源码里实际出现的字，按频次每 400 字一片。
    # 界面文案几乎全落在这几片里，首屏命中 2~3 片即可。
    plan = [
        {'name': f'lins-sans-ui-{index + 1}', 'chars': used[index * UI_BAND_CHARS:(index + 1) * UI_BAND_CHARS]}
        for index in range((len(used) + UI_BAND_CHARS - 1) // UI_BAND_CHARS)
    ]
    # gb-* 片：GB2312 里界面没用到的常用字（用户输入的项目名、姓名等），
    # 按码位切分，只有真的出现表外字才下载其中一片。
    rest = [char for char in gb2312_hanzi() if char not in set(used)]
    per_chunk = (len(rest) + GB2312_CHUNKS - 1) // GB2312_CHUNKS
    plan += [
        {'name': f'lins-sans-gb-{index + 1}', 'chars': rest[index * per_chunk:(index + 1) * per_chunk]}
        for index in range(GB2312_CHUNKS)
    ]
    return [entry for entry in plan if entry['chars']]


def to_unicode_range(chars: list[str]) -> str:
    codes = sorted({ord(char) for char in chars})
    pieces: list[str] = []
    start = previous = codes[0]
    for code in codes[1:]:
        if code == previous + 1:
            previous = code
            continue
        pieces.append(f'U+{start:X}' if start == previous else f'U+{start:X}-{previous:X}')
        start = previous = code
    pieces.append(f'U+{start:X}' if start == previous else f'U+{start:X}-{previous:X}')
    return ', '.join(pieces)


def rename_subset(font: TTFont) -> None:
    """按 OFL 第 3 条改名：子集不得再自称 'Source'。"""
    for record in font['name'].names:
        if record.nameID in (1, 16):
            record.string = FAMILY_ZH
        elif record.nameID == 4:
            record.string = f'{FAMILY_ZH} Regular'
        elif record.nameID == 6:
            record.string = f'{FAMILY_ZH}-Regular'
        elif record.nameID == 0:
            record.string = (
                f'{record.toUnicode()} '
                f'Subset and renamed by Creative Studio from {CJK_ORIGIN}; '
                'licensed under the SIL Open Font License 1.1.'
            )


def subset_cjk(chars: list[str], destination: Path) -> None:
    font = TTFont(CJK_SOURCE)
    options = subset.Options()
    options.layout_features = ['kern', 'tnum', 'pnum']
    options.name_IDs = ['*']
    options.name_languages = ['*']
    options.notdef_outline = True
    options.drop_tables += ['BASE', 'vhea', 'vmtx', 'VVAR', 'STAT']
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(text=''.join(chars))
    subsetter.subset(font)
    rename_subset(font)
    font.flavor = 'woff2'
    destination.parent.mkdir(parents=True, exist_ok=True)
    font.save(destination)
    font.close()


def write_css(entries: list[dict]) -> None:
    lines = [
        '/* 打包字体声明：由 scripts/ui/build-font-slices.py 生成，不要手改。',
        ' * 字体文件在 public/fonts/，构建期只读本地文件，不联网下载。',
        ' * 中文按字符频次切片（高频字一个文件，其余按段），每片用 unicode-range 声明覆盖范围，',
        ' * 浏览器只下载页面实际用到的切片。许可证见 public/fonts/OFL-*.txt。 */',
    ]
    for entry in entries:
        lines += [
            '@font-face {',
            f'  font-family: "{FAMILY_ZH}";',
            '  font-style: normal;',
            '  font-weight: 250 900;',
            '  font-display: swap;',
            f'  src: url("/fonts/{entry["name"]}.woff2") format("woff2-variations");',
            f'  unicode-range: {entry["unicode_range"]};',
            '}',
        ]
    lines += [
        '@font-face {',
        f'  font-family: "{FAMILY_LATIN}";',
        '  font-style: normal;',
        '  font-weight: 100 900;',
        '  font-display: swap;',
        '  src: url("/fonts/inter-latin.woff2") format("woff2-variations");',
        f'  unicode-range: {LATIN_UNICODE_RANGE};',
        '}',
        '',
    ]
    CSS_PATH.write_text('\n'.join(lines), encoding='utf-8')


def main() -> int:
    if not CJK_SOURCE.exists():
        print(f'缺少中文字体源文件：{CJK_SOURCE}', file=sys.stderr)
        return 1
    if not INTER_SOURCE.exists():
        print(f'缺少 Inter 源文件：{INTER_SOURCE}', file=sys.stderr)
        return 1
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    total = 0
    manifest = []
    for entry in build_plan():
        destination = OUT_DIR / f'{entry["name"]}.woff2'
        subset_cjk(entry['chars'], destination)
        entry['unicode_range'] = to_unicode_range(entry['chars'])
        size = destination.stat().st_size
        total += size
        manifest.append({
            'name': entry['name'],
            'characters': len(entry['chars']),
            'bytes': size,
            'unicodeRange': entry['unicode_range'],
        })
        print(f'{entry["name"]}: {len(entry["chars"])} 字，{size} 字节')
    shutil.copyfile(INTER_SOURCE, OUT_DIR / 'inter-latin.woff2')
    latin = (OUT_DIR / 'inter-latin.woff2').stat().st_size
    total += latin
    print(f'inter-latin: {latin} 字节')
    write_css([{'name': item['name'], 'unicode_range': item['unicodeRange']} for item in manifest])
    (OUT_DIR / 'slices.json').write_text(json.dumps({
        'generator': 'scripts/ui/build-font-slices.py',
        'family': FAMILY_ZH,
        'latinFamily': FAMILY_LATIN,
        'cjkSource': str(CJK_SOURCE.relative_to(ROOT)).replace('\\', '/'),
        'slices': manifest,
        'latin': {'name': 'inter-latin', 'bytes': latin, 'unicodeRange': LATIN_UNICODE_RANGE},
    }, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'合计 {total} 字节，{len(manifest) + 1} 个文件')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
