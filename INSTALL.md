# 本地安装指南（适用于 Codex 和手动安装）

默认安装 Chrome 扩展，把摘录保存为本地 Markdown 文件。用户希望用卡片回顾时，再为同一文件夹安装 Obsidian 插件。

## 从哪一步开始

- **首次安装 Chrome**：从第 1 步开始。默认使用普通文件夹；用户同时要求用 Obsidian 回顾时，完成第 3 步后继续安装插件。
- **Chrome 已能保存摘录，现在要加装 Obsidian**：直接从下文「用 Obsidian 打开已有笔记」开始。沿用 Chrome 已授权的目录和已有摘录，不必重新加载扩展、选择文件夹或制作测试卡片。

用户选择 flomo 时，加载 Chrome 扩展后，在「笔记写入位置」选择 flomo，填写用户自己的 API URL 并保存。无需选择本地笔记文件夹，也无需安装 Obsidian。API URL 可在 [flomo API 设置](https://flomoapp.com/mine?source=incoming_webhook)获取；应由用户在扩展设置中填写。后续保存一条笔记并在 flomo 核对即可。具体追加、重试和多设备边界见 [写入 flomo](README.md#写入-flomo)。

## 1. 确定安装位置

- 使用项目官方的[最新正式 Release](https://github.com/rockbotcc/underline-notes/releases/latest)。新装 Chrome 扩展时选择长期保留的位置，例如 macOS 上的 `~/Library/Application Support/Underline Notes/chrome/`；升级时沿用 Chrome 已加载的目录（包括以前用源码安装的 `dist/`），以保留扩展身份和本地数据。
- 用户已说明存放位置时，按其选择执行。只要求保存到本地时，默认使用系统文稿目录下的「划线笔记」。目录不存在就创建，已有同名空目录就复用。如果同名目录已有内容且用途不明，让用户选择复用或另选位置。用户也可直接指定已有文件夹或 Obsidian 笔记库。笔记目录与源码、构建目录分开。普通文件夹模式跳过 Obsidian 检测与插件安装。
- 使用桌面版 Chrome 120+。只有选择卡片视图时才需要 Obsidian 1.6+。使用发布包可跳过 Node.js、Git 和源码构建。

### 可选：用户选择已有 Obsidian 笔记库时

读取 Obsidian 的本机登记文件 `obsidian.json`。macOS 通常位于 `~/Library/Application Support/obsidian/`，Windows 位于 `%APPDATA%\obsidian\`，Linux 位于 `${XDG_CONFIG_HOME:-~/.config}/obsidian/`。读取 `vaults` 中各项的 `path`，保留当前仍存在的目录并去重。识别笔记库只需检查目录，无需读取笔记正文。

- **找到一个**：告诉用户识别出的笔记库名称，直接继续安装。
- **找到多个**：列出编号和文件夹名称，让用户回复编号或名称即可。同名时附上一级父目录以便区分。等待选择期间可以先下载发布包。
- **没有找到**：可以直接使用普通文件夹。用户希望使用 Obsidian 时，请用户在 Obsidian 中打开平时写笔记的库，再重新读取登记文件。第一次使用 Obsidian 的用户可以先在欢迎页点击「创建新仓库」，起一个容易识别的名字，再告诉 Codex「建好了」。如果仍无法识别，使用系统文件夹选择器，请用户点选存放笔记的文件夹。

记住所选目录和名称。使用默认配置目录 `.obsidian/`；若该目录缺失或用户设置了自定义配置目录，先在 Obsidian 中核对实际配置目录，再复制文件。后面引导 Chrome 授权时，用用户刚选的笔记库名称提示，例如「点击『选择笔记文件夹』，选择『读书笔记』这个文件夹，然后允许写入」。

## 2. 下载并核对发布包

1. Codex 默认下载 [Chrome 扩展 ZIP](https://github.com/rockbotcc/underline-notes/releases/latest/download/underline-notes-chrome.zip)。用户选用卡片视图时，再下载 [Obsidian 插件 ZIP](https://github.com/rockbotcc/underline-notes/releases/latest/download/underline-notes-obsidian.zip)。GitHub 自动附带的 Source code 是开发用源码。若直链暂时不可用，到 Release 页的 Assets 栏查找以上两个同名 ZIP；无法获取时说明原因，仅在用户明确选择源码安装时构建。
2. 记录所选 Release 的版本；如发布资产提供 SHA-256，先比对下载文件的摘要。分别解压到临时目录。Chrome 包的根目录应有 Manifest V3 的 `manifest.json`、脚本、设置页及 `icons/`。把这些内容放入第 1 步确定的固定扩展目录。升级时先备份原安装文件，在原位置更新并点击「重新加载」，保留原来的 Chrome 扩展条目。
3. Obsidian 包解压后的 `noting/` 应包含 `main.js`、`manifest.json`、`styles.css`，清单的插件 ID 为 `noting`。按下方可选步骤安装。

## 3. 加载 Chrome 扩展并验证本地保存

1. 打开 `chrome://extensions`，开启「开发者模式」，点击「加载已解压的扩展程序」，选择固定扩展目录中直接包含 `manifest.json` 的那一层。升级后刷新已打开的网页。
2. 先进入扩展「选项」，点击「选择笔记文件夹」，选择第 1 步确定的笔记目录并允许读写。看到「文件夹已连接」后再做摘录。在 macOS 文件选择窗口可按 `⌘⇧G`，粘贴目录的绝对路径，回车后核对文件夹名称，再点「选择」。
3. 打开或刷新一篇普通 HTTP/HTTPS 网页，选中一句话，点击浮动工具条的颜色。点击 Chrome 工具栏上的扩展图标，为这条摘录添加批注并保存。刷新网页，确认划线仍在。回到扩展选项点击「立即同步笔记」，在笔记目录的 `Reading/Cards/` 下打开刚生成的 Markdown，核对摘录和批注。后续验证 Obsidian 时沿用这一条。

### 安装完成后，主动询问是否使用 Obsidian

确认摘录和批注已写入本地后，告诉用户实际保存位置。如果用户还没有明确选择，请主动询问一次，并等用户回答：

> 要用 Obsidian 的卡片盒回顾刚保存的摘录吗？可以选「安装 Obsidian 和划线笔记插件」「我已有 Obsidian，只装插件」或「只用 Chrome」。

- 选择安装两者时，先检查本机是否已有兼容的 Obsidian。已有则直接使用，需要安装或升级时从 [Obsidian 官方下载页](https://obsidian.md/download) 获取桌面版，再按下节安装插件。
- 选择只装插件时，沿用现有 Obsidian 和 Chrome 已授权的笔记文件夹，继续下节。
- 选择只用 Chrome 时，到这里完成安装。用户此前已明确选择的，直接按其选择执行。

## 用 Obsidian 打开已有笔记

1. **确认笔记目录和版本。** 使用 Chrome 已授权、直接包含 `Reading/` 的文件夹。优先沿用刚才安装时记录的绝对路径；如果路径不明且有同名文件夹，请用户点选。按第 2 步下载并核对与 Chrome 扩展同版本 Release 中的 `underline-notes-obsidian.zip`。
2. **先在 Obsidian 打开这个文件夹。** 若已登记为仓库，直接切换到它。首次使用时，在欢迎页选择「打开本地仓库」（Open folder as vault）；已经打开其他仓库时，点击仓库名 →「管理仓库」（Manage vaults…）→「Open folder as vault」旁的「Open」。选中上述笔记目录，在新窗口核对仓库名称。只有完成这一步后，Chrome 里的「用 Obsidian 打开」链接才能定位仓库。若看到 `Vault not found`，关闭提示，按本步打开文件夹。
3. **安装插件文件。** 默认位置是仓库下的 `.obsidian/plugins/noting/`。如果使用自定义配置目录，以 Obsidian「第三方插件 → 打开插件文件夹」显示的位置为准。若已安装，先在 Obsidian 中停用插件，把现有插件目录备份到 `plugins/` 以外的本地位置，并记下备份路径。
   创建目标目录，把解压所得 `noting/` 中的三个文件逐个复制进去。只更新这三个文件，保留已有的 `data.json`（可能包含模型凭据）和其他用户文件。备份也应留在本机。

4. **启用插件。** 核对复制的三个文件与发布包一致。在目标仓库进入「设置 → 第三方插件」（Community plugins）。若处于限制模式，点击「退出限制模式」（Exit Restricted mode）。点击已安装插件列表旁的「刷新插件」（Reload plugins），再启用「划线笔记 / Underline Notes」。若列表仍未出现插件，核对配置目录及文件层级后重新打开仓库。

5. **验证卡片盒。** 在 Obsidian 打开 `Reading/卡片盒.md`，检查刚才的摘录和批注是否出现。同步需要 Chrome 运行且文件夹授权有效。若看不到卡片，先检查扩展设置中的连接状态和待写入项，再确认 Obsidian 打开的是同一仓库。

**给执行安装的 Codex：** 完成能够执行的下载、解压、文件复制和核对，并提供本次实际使用的绝对路径。遇到浏览器目录授权等必须由用户操作的界面时，指出要点击的按钮和要选择的目录。按用户选的模式报告结果。普通文件夹模式以看到正确的 Markdown 笔记为准；选择卡片模式时，再验证同一条摘录出现在 Obsidian 卡片盒中。
