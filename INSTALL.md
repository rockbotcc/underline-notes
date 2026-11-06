# 本地安装指南（适用于 Codex 和手动安装）

默认安装 Chrome 扩展，把摘录保存为本地 Markdown 文件。用户希望用卡片回顾时，再为同一文件夹安装 Obsidian 插件。

## 1. 确定安装位置

- 使用项目官方的[最新正式 Release](https://github.com/rockbotcc/underline-notes/releases/latest)。新装 Chrome 扩展时选择长期保留的位置；升级时沿用 Chrome 已加载的目录（包括以前用源码安装的 `dist/`），以保留扩展身份和本地数据。
- 用户已说明存放位置时，按其选择执行。否则提供「新建划线笔记文件夹」「选择已有文件夹」「使用已有 Obsidian 笔记库」三个选项，用户回复名称即可。前两种可通过系统文件夹选择窗口完成，例如在「文稿」中新建「划线笔记」。笔记目录与源码、构建目录分开。普通文件夹模式跳过 Obsidian 检测与插件安装。
- 使用桌面版 Chrome 120+。只有选择卡片视图时才需要 Obsidian 1.6+。使用发布包可跳过 Node.js、Git 和源码构建。

### 可选：用户选择已有 Obsidian 笔记库时

读取 Obsidian 的本机登记文件 `obsidian.json`。macOS 通常位于 `~/Library/Application Support/obsidian/`，Windows 位于 `%APPDATA%\obsidian\`，Linux 位于 `${XDG_CONFIG_HOME:-~/.config}/obsidian/`。读取 `vaults` 中各项的 `path`，保留当前仍存在的目录并去重。识别笔记库只需检查目录，无需读取笔记正文。

- **找到一个**：告诉用户识别出的笔记库名称，直接继续安装。
- **找到多个**：列出编号和文件夹名称，让用户回复编号或名称即可。同名时附上一级父目录以便区分。等待选择期间可以先下载发布包。
- **没有找到**：可以直接使用普通文件夹。用户希望使用 Obsidian 时，请用户在 Obsidian 中打开平时写笔记的库，再重新读取登记文件。第一次使用 Obsidian 的用户可以先在欢迎页点击「创建新仓库」，起一个容易识别的名字，再告诉 Codex「建好了」。如果仍无法识别，使用系统文件夹选择器，请用户点选存放笔记的文件夹。

记住所选目录和名称。使用默认配置目录 `.obsidian/`；若该目录缺失或用户设置了自定义配置目录，先在 Obsidian 中核对实际配置目录，再复制文件。后面引导 Chrome 授权时，用用户刚选的笔记库名称提示，例如「点击『选择笔记文件夹』，选择『读书笔记』这个文件夹，然后允许写入」。

## 2. 下载并核对发布包

1. Codex 默认下载 [Chrome 扩展 ZIP](https://github.com/rockbotcc/underline-notes/releases/latest/download/underline-notes-chrome.zip)。用户选用卡片视图时，再下载 [Obsidian 插件 ZIP](https://github.com/rockbotcc/underline-notes/releases/latest/download/underline-notes-obsidian.zip)。GitHub 自动附带的 Source code 是开发用源码。若直链暂时不可用，到 Release 页的 Assets 栏查找以上两个同名 ZIP；无法获取时说明原因，仅在用户明确选择源码安装时构建。
2. 分别解压到临时目录。Chrome 包的根目录应有 Manifest V3 的 `manifest.json`、脚本、设置页及 `icons/`。把这些内容放入第 1 步确定的固定扩展目录。升级时先备份原安装文件，在原位置更新并点击「重新加载」，保留原来的 Chrome 扩展条目。
3. Obsidian 包解压后的 `noting/` 应包含 `main.js`、`manifest.json`、`styles.css`，清单的插件 ID 为 `noting`。按下方可选步骤安装。

## 3. 加载 Chrome 扩展并验证本地保存

1. 打开 `chrome://extensions`，开启「开发者模式」，点击「加载已解压的扩展程序」，选择固定扩展目录中直接包含 `manifest.json` 的那一层。升级后刷新已打开的网页。
2. 打开一篇普通 HTTP/HTTPS 文章，选中一句话，点击浮动工具条的颜色按钮。点击 Chrome 工具栏的扩展图标，给摘录写一条批注并保存。刷新页面后应能找回划线。
3. 进入扩展「选项」，点击「选择笔记文件夹」，新建或点选第 1 步确定的文件夹并允许读写，点击「立即同步笔记」。打开该文件夹内 `Reading/Cards/` 下对应的 Markdown 文件，核对刚保存的摘录与批注。看到两者即可确认本地保存成功。

## 可选：用 Obsidian 打开已有笔记

现在或以后需要卡片视图时，在 Obsidian 中选择「打开本地仓库」（Open folder as vault），打开 Chrome 已授权的那个文件夹，即包含 `Reading/` 的父目录。已有摘录可以原地使用。

1. 目标目录为「所选仓库 / 实际配置目录 / plugins / noting」。若已安装，先在 Obsidian 中停用插件，把现有插件目录备份到 `plugins/` 以外的本地位置，并记下备份路径。
2. 创建目标目录，把解压所得 `noting/` 中的三个文件逐个复制进去。只更新这三个文件，保留已有的 `data.json`（可能包含模型凭据）和其他用户文件。备份也应留在本机。

3. 核对目标中的三个文件与解压出的文件一致。重新打开目标仓库，在「设置 → 第三方插件」中启用社区插件，再打开「划线笔记 / Underline Notes」的开关。

4. 在 Obsidian 打开 `Reading/卡片盒.md`，检查刚才的摘录和批注是否出现。同步需要 Chrome 运行且文件夹授权有效。若看不到卡片，先检查扩展设置中的连接状态和待写入项，再确认 Obsidian 打开的是同一仓库。

**给执行安装的 Codex：** 完成能够执行的下载、解压、文件复制和核对，并提供本次实际使用的绝对路径。遇到浏览器目录授权等必须由用户操作的界面时，指出要点击的按钮和要选择的目录。按用户选的模式报告结果。普通文件夹模式以看到正确的 Markdown 笔记为准；选择卡片模式时，再验证同一条摘录出现在 Obsidian 卡片盒中。
