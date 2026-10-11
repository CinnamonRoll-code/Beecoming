# 第三方授权全文

这里放的是**必须随游戏一起分发**的授权文本（做法照搬拆家鹦鹉项目）。

| 文件 | 管什么 | 义务从哪来 |
|---|---|---|
| `LXGW-WenKai-OFL.txt` | 字体霞鹜文楷（游戏里用的是裁过字、改过名的子集 `assets/fonts/LXGWWenKai-Subset.ttf`，家族名 "Beecoming Subset"） | OFL 1.1 第 1、2 条：每份拷贝都要附版权行和授权全文 |
| `Godot-Engine-MIT.txt` | 引擎 | MIT：版权声明和授权全文要随所有拷贝分发 |

## ⚠ 打包时要带上这个目录

导出预设只收 Godot 认得的资源，**这些 .txt 不会进包**。导出后：

```bash
cp -r LICENSES build/web/
cp -r LICENSES build/windows/
```

## 字体为什么改名

霞鹜文楷的保留字体名是「霞鹜 / 霞鶩 / 落霞孤鹜 / 落霞孤鶩 / LXGW」，OFL 第 3 条规定改动版不得使用保留名。裁字就是改动版，所以 `tools/subset_font.py` 把子集改名为 "Beecoming Subset"，并补回授权说明。字体授权全文直接取自 github.com/lxgw/LxgwWenKai 的 `OFL.txt`（作者在标准 OFL 前加了一段保留字体名的附加许可，抄通用模板会漏掉）。

## 新加中文文案以后

重跑 `python tools/subset_font.py`，否则新字在网页版会变成方块（桌面版会退回系统雅黑）。完整字体 `tools/font_src/LXGWWenKai-Regular.ttf` 不进仓库，从拆家鹦鹉项目或上游仓库拿。
