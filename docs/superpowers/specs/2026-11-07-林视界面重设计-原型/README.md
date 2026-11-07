# 林视界面重设计：原型

[功能方案](../2026-11-07-林视界面重设计-功能方案.md) 的设计依据。外观以这里为准，规则以规格为准；两者冲突时以规格为准。

| 文件 | 是什么 |
| --- | --- |
| `方案一-Mac原生.html` | 定稿，13 屏，每屏都能点。单文件，图片、视频、字体都在里面；双击用浏览器打开，断网也能看。底部黑色评审条用来切屏和切状态，不属于设计。 |
| `index.html` | 总入口：每轮改了什么、现在和定稿的同屏对比。页脚「方案三」和 design-demos 的链接指向没放进仓库的留档，点不开属正常。 |
| `direction-approved.md` | 八轮评审各展示了什么、用户原话和结论。 |
| `brand-spec.md` | 名字写法、真实素材、字体等事实。 |
| `directions.md` | 前几轮的方向卡，留档用。 |
| `落地素材/` | 要放进产品的素材，见下表。 |
| `src/` | 原型源码，用来查颜色令牌和页面结构，见下面「看源码」。 |
| `tools/checks/` | 原型的自动检查脚本和上传用的样图，见下面「在 Windows 上跑原型的检查」。 |

`落地素材/` 里有三个文件：

| 文件 | 用途 |
| --- | --- |
| `林视标志.svg` | 彩色标志，生成应用图标的源图。 |
| `林视叶子-单色.svg` | 单色叶子，颜色跟随文字色。 |
| `登录页背景.jpg` | 登录页虚化背景用的真实场景图。 |

## 看源码

- 颜色令牌：`src/app/one/one.css` 开头，浅色和深色两套。
- 部件样式：`edit.css`、`steps.css`。
- 示例数据：`src/app/data.js`。
- 各屏结构和交互：`one.js`、`steps.js`、`editor.js`、`batch.js`。

源码里的图片和视频是占位符，不能直接打开。要看效果，打开上面那个单文件。

## 在 Windows 上跑原型的检查

1. 安装 Python 3。
2. 安装 Playwright：`pip install playwright`，再运行 `python -m playwright install chromium webkit`。
3. 在本目录下运行下面的命令。加 `-X utf8` 是为了避免中文输出在 Windows 控制台报编码错误。

```
python -X utf8 tools\checks\e2e-点按清单.py 方案一-Mac原生.html one 检查结果
python -X utf8 tools\checks\画面比例.py 方案一-Mac原生.html
python -X utf8 tools\checks\按钮被切.py 方案一-Mac原生.html 1288 640 light webkit
python -X utf8 tools\checks\工具栏藏内容.py 方案一-Mac原生.html
```

- 点按清单全部通过时，最后一行是 `RESULT one FAILS: []`。
- 这些脚本只检查原型本身。正式实施时，按规格和任务要求把它们改写进仓库自己的验收程序。

## 没放进仓库的

下面这些留在出原型那台 Mac 的 `outputs/prototypes/2026-11-07-林视品牌与界面方案/`，实施用不到；要改原型，回那台电脑改：

- 重新构建原型用的素材、字体和脚本，约 35MB。
- 前两轮的方向稿。
- 方案三。
