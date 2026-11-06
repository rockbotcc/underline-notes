# 本地安装指南（适用于 Codex 和手动安装）

本指南面向桌面版 Chrome 和 Obsidian。Chrome 从固定的构建目录加载扩展，Obsidian 从用户指定的笔记仓库加载插件。两端通过该笔记仓库里的 Markdown 文件交换批注。

## 1. 确定安装位置

- 源码使用 https://github.com/rockbotcc/underline-notes.git 。优先复用用户已有的本地仓库，记录其绝对路径。首次安装时选择一个长期保留的工作目录。后续升级沿用同一位置，以便 Chrome 继续识别原扩展及其本地数据。
- 从用户给出的 Obsidian 仓库路径确认目标。默认配置目录为该仓库下的 `.obsidian/`。若用户设置过自定义配置目录，使用实际目录。路径缺失或有多个候选时，先完成构建，再向用户询问目标仓库。只安装 Chrome 时可跳过 Obsidian 步骤。
- 检查 `node --version`、`npm --version`。建议 Node.js 22.18 或更高版本。使用桌面版 Chrome 120+ 和 Obsidian 1.6+。

## 2. 从源码构建

首次获取源码时，在选好的父目录运行：

```sh
git clone https://github.com/rockbotcc/underline-notes.git
cd underline-notes
```

已有源码时直接进入项目根目录。需要升级且工作区干净时，运行 `git pull --ff-only`；有本地改动时保留改动，先向用户说明。构建两个插件：

```sh
npm ci
npm run build
```

核对 `dist/manifest.json` 是 Chrome 的 Manifest V3 清单，并确认其引用的脚本、图标和设置页存在。核对 `dist-obsidian/noting/` 包含 `main.js`、`manifest.json` 和 `styles.css`，其中清单的插件 ID 为 `noting`。构建失败时先排查报错，再安装新版本。

## 3. 把插件放入 Obsidian 仓库

1. 目标目录为「所选仓库 / 实际配置目录 / plugins / noting」。若已安装，先在 Obsidian 中停用插件，把现有插件目录备份到 `plugins/` 以外的本地位置，并记下备份路径。
2. 创建目标目录，把构建出的三个文件逐个复制进去。只更新这三个文件，保留已有的 `data.json`（可能包含模型凭据）和其他用户文件。备份也应留在本机。以下是 macOS/Linux 示例，在源码根目录执行；Windows 可用资源管理器或 PowerShell 完成相同的逐文件复制。

   ```sh
   # 将路径替换为已确认的笔记仓库和配置目录
   plugin_dir="/实际路径/我的笔记/.obsidian/plugins/noting"
   mkdir -p "$plugin_dir"
   cp dist-obsidian/noting/{main.js,manifest.json,styles.css} "$plugin_dir/"
   ```

3. 核对目标中的三个文件与构建产物一致。重新打开目标仓库，在「设置 → 第三方插件」中启用社区插件，再打开「划线笔记 / Underline Notes」的开关。

## 4. 加载 Chrome 扩展并连接同一仓库

1. 打开 `chrome://extensions`，开启「开发者模式」，点击「加载已解压的扩展程序」。选择源码根目录下的 `dist/`。如果是原位置升级，点击已安装扩展卡片上的「重新加载」，然后刷新已打开的网页。
2. 打开一篇普通 HTTP/HTTPS 文章，选中一句话，点击浮动工具条的颜色按钮。点击 Chrome 工具栏的扩展图标，给摘录写一条批注并保存。刷新页面后应能找回划线。
3. 需要两端同步时，进入扩展「选项」，点击「选择 Obsidian 仓库」，选中笔记仓库根目录并允许读写。点击「立即同步笔记」。默认资料目录为 `Reading/`，如曾自定义，请核对两端设置。
4. 在 Obsidian 打开 `Reading/卡片盒.md`，检查刚才的摘录和批注是否出现。同步需要 Chrome 运行且文件夹授权有效。若看不到卡片，先检查扩展设置中的连接状态和待写入项，再确认 Obsidian 打开的是同一仓库。

**给执行安装的 Codex：** 完成能够执行的构建、文件复制和核对，并提供本次实际使用的绝对路径。遇到浏览器目录授权等必须由用户操作的界面时，指出要点击的按钮和要选择的目录。分别报告文件安装、插件启用、双向连接和实际验证的状态；只有观察到测试摘录出现在 Obsidian 中，才报告端到端安装成功。
