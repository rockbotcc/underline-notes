# 思源笔记第一版测试记录

测试日期：2026 年 11 月 12 日。

第一版已支持 Chrome 扩展向思源写入独立卡片文档、追加更新版本、离线排队、失败核对与缺失文档恢复。测试覆盖真实浏览器、模拟服务以及官方思源 3.8.10 macOS ARM64 内核。

## 真实内核验收

测试使用官方 `siyuan-3.8.10-mac-arm64.dmg` 内的 `SiYuan-Kernel`，下载后已与官方 SHA256SUMS 核对，摘要为 `4e625d3c696f76b6201fccf812ea026450db254488fc6c3b9ae80902b529660c`。

内核使用单独的临时 home、工作空间和随机端口，关闭固定 6806 代理；浏览器使用临时配置文件。没有连接或修改用户日常思源工作空间。测试结束后关闭内核并清理成功用例的临时数据。

| 场景 | 结果 |
| --- | --- |
| Chrome 扩展读取版本及笔记本，保存配置 | 通过 |
| 从真实网页侧栏创建文章笔记 | 通过 |
| 按父文档 ID 创建卡片，保留版本容器 ID 和自定义属性 | 通过 |
| 中文、加粗、列表及含斜杠的文章标题 | 通过 |
| 修改后追加版本，保留旧版和思源手动补写 | 通过 |
| 相同内容重复保存 | 通过，没有新增版本 |
| 内核实际提交后丢弃响应 | 通过，读取已存在的块标记后确认成功，没有重复版本 |
| 停止内核后保存，再启动同一测试工作空间 | 通过，恢复队列且原笔记保留 |
| 从思源删除文档后继续编辑 | 通过，暂停写入并提示处理 |
| 显式重新创建缺失文档 | 通过，创建新文档并恢复写入 |

可用以下命令重现。脚本自行创建隔离工作空间，不接受已有服务地址：

```sh
npm run build
SIYUAN_TEST_KERNEL="/Applications/SiYuan.app/Contents/Resources/kernel/SiYuan-Kernel" npm run test:siyuan-live
```

若资源目录不在内核文件的上两级，可通过 `SIYUAN_TEST_RESOURCES` 指定。成功结果写入 `test-results/siyuan-live-result.json`，设置页截图写入 `test-results/siyuan-live-settings.png`。

## 自动化与现有功能回归

| 检查 | 结果 |
| --- | --- |
| `npm run check` | TypeScript 检查通过 |
| `npm test` | 50 项单元测试通过 |
| `npm run build` | Chrome 扩展和 Obsidian 插件构建通过 |
| `npm run test:siyuan` | 模拟服务端到端与 v1、v2 数据库迁移通过 |
| `node tests/browser.mjs` | 划线、批注、文件输出、双向编辑、冲突、备份和删除回归通过 |
| `node tests/flomo.mjs` | flomo 配置、发送、去重、重试、切换目标和删除回归通过 |
| `node tests/images.mjs` | 图片采集、编辑、备份、导出回归通过 |
| `node tests/browser-ai.mjs` | AI 标签配置、过滤、失败保存和凭据隔离回归通过 |
| `npm run test:obsidian` | Obsidian 插件浏览器夹具回归通过 |

新增的模拟服务测试进一步覆盖了发送中再次编辑、切换笔记本后旧队列不改投、删除未发送草稿、无批注划线单独成卡、旧内核能力不足时拒绝保存、Token 不进入内容脚本响应和 JSON 备份。数据库迁移验证旧文章、设置与已有 flomo 发送记录保留。

发布工作流已经加入 `npm run test:siyuan`。真实内核用例需要显式提供官方内核程序，未作为普通 CI 的下载依赖。

## 使用与边界

本地源码已经构建到现有 Chrome 扩展目录。重新加载该扩展并刷新网页后，在设置中选择「思源笔记」，填写服务地址和 API Token，测试连接，选择笔记本并保存即可。

第一版是单向写入：浏览器修改追加版本，思源补写保留；浏览器删除不删除思源副本。图片只保存说明与链接，全文和阅读日志不上传。AI 标签继续使用现有 Obsidian 候选列表。

本次真实验收覆盖思源 3.8.10 的 macOS ARM64 内核。Windows、Linux、HTTPS 反向代理、其他思源版本和移动端同步尚未进行真实环境验收。自动化验证了返回的原生 Markdown 和块身份，未进行思源桌面 UI 的逐项人工操作验收。

## 思源卡片盒插件验收（2026-11-13）

已实现用户确认的「卡片流、搜索筛选和补写想法」。SDK 类型基线 1.3.0，真实应用与内核为官方思源 3.8.10（macOS ARM64）。

### 结果

- `npm run check`：通过，包含浏览器、Obsidian 和思源插件源码。
- `npm test`：55 项通过；新增 5 项覆盖最新版本聚合、搜索与父标签、块属性注入隔离、重复提交/响应丢失、重启恢复、目标不可用和草稿保存失败。
- `npm run build`：生成三个端的构建产物。
- `node scripts/package-release.mjs`：三个 ZIP、版本一致性和 ZIP 完整性验证通过。
- `SIYUAN_TEST_KERNEL=/Applications/SiYuan.app/Contents/Resources/kernel/SiYuan-Kernel npm run test:siyuan-plugin-live`：通过。使用临时目录、独立端口、独立授权及临时 Chromium，不访问用户工作空间。
- 本地安装：插件文件已复制到 `<工作空间>/data/plugins/underline-notes/`，核对入口 JS、CSS 和清单的 SHA-256 与构建产物一致。
- 桌面验收：用户明确确认信任并启用后，通过思源设置启用了插件，点击顶部卡片盒图标，实际看到独立页签和现有 1 张摘录。未在用户工作空间追加测试想法。

真实前端测试加载完整思源 Web 应用和实际插件包，未用 SDK 桩替代宿主。覆盖：原生卡片渲染、多个关键词、父子标签、笔记本筛选、草稿保存与页面重载、原生想法追加、浏览器版本追加后保留想法、真实提交后的响应丢失去重、预览只读、打开原生文档。结果见 `test-results/siyuan-plugin-result.json`，截图见 `test-results/siyuan-plugin-cardbox.png`（均为本地测试产物，不进入 Git）。

测试中一次全新内核启动因思源自身初始化 SQLite `database is locked` 退出；重新运行独立测试环境后通过。故障注入阶段的 `net::ERR_FAILED` 为主动丢弃成功响应，预期行为；最终记录中的前端未捕获异常列表为空。

### 当前限制

未验证 Windows、Linux、Docker 和远端部署；不提供移动端卡片盒。未保存草稿以单个活跃客户端使用为基线，多窗口/多设备并发编辑同一份草稿尚不支持。普通文档和无插件标记的手写块不会自动加入卡片搜索。第一版未增加 AI 打标、图片文件上传或浏览器摘录双向修改。

## 卡片盒界面对齐验收（2026-11-13）

复用 Obsidian 卡片盒的样式源，增加思源宿主适配。布局、配色、字体、卡片宽度、标签树、日期和更多菜单已对齐；原生预览按批注、补写想法、摘录、来源展示，重复标题和生成元数据仅从视图隐藏。

验证通过：

- 类型检查、55 项单元测试、构建和发布 ZIP 完整性检查。
- 官方思源内核及真实前端回归：原有搜索/标签/笔记本筛选、草稿恢复、追加保存、浏览器更新保留补写、响应丢失去重、只读预览和打开文档。
- 新增交互验收：折叠标签、菜单方向键和 Escape、菜单关闭焦点恢复、双击补写、Esc 收起后草稿保留、Ctrl+Enter 保存。
- 样式验收：共享浅色背景、深色按钮和原生预览背景、隐藏同步元数据、窄窗口无横向溢出，并检查浅色/深色/窄窗口截图。
- 桌面安装：备份旧插件后更新 `<工作空间>/data/plugins/underline-notes/` 并重新启用；关闭旧页签再打开，已实际看到新版侧栏、卡片和用户现有摘录。未修改用户笔记内容。

旧插件已备份到工作空间插件目录之外的本机位置，草稿目录没有被覆盖。

截图与机器结果保存在 `test-results/siyuan-plugin-cardbox.png`、`siyuan-plugin-dark.png`、`siyuan-plugin-narrow.png`、`siyuan-plugin-result.json`。该轮对齐未包含随手记、每日回顾、阅读足迹和 AI 功能；随手记与每日回顾的后续验收见下节。


## 随手记与每日回顾验收（2026-11-13）

新增随手记原生文档、草稿恢复、目标笔记本记忆，以及与 Obsidian 共用算法的每日回顾。顶部输入框、记录按钮、快捷键、逐张回顾、补写及完成页沿用 Obsidian 的交互和样式。

- `npm run check`、`npm test`、`npm run build`：通过，单元测试共 61 项。覆盖随手记重复提交、持久化失败、响应丢失后重启核对、ID 冲突不覆盖、内容标记隔离及每天稳定选取最多 8 张。
- `npm run test:siyuan-plugin-live`：在官方思源 3.8.10 临时内核及真实前端中验证目标笔记本校验、草稿重载、快捷键和按钮创建原生文档、丢失成功响应后的去重、搜索后的回顾范围、上一张/下一张、回顾中补写、完成返回、空结果与当日稳定选卡。保留原有明暗主题、窄面板、搜索筛选、补写恢复和原文打开回归。
- 修复从原生文档返回卡片盒时重复打开标签页的问题；保存随手记成功后立即清空输入框，再刷新卡片列表。
- 桌面验收：备份并更新本机已安装插件，核对构建文件摘要一致；实际确认顶部随手记输入框、笔记本选择及每日回顾中的现有卡片和进度正常显示。日常笔记未加入测试内容。
- `npm run test:siyuan`、`npm run test:siyuan-live`：通过扩展模拟服务、IndexedDB v1/v2 升级及真实内核写入回归。
- `npm run test:obsidian`、`npm run test:e2e`、`npm run test:flomo`、`npm run test:images`、`npm run test:browser-ai`：通过既有功能回归。
- `node scripts/package-release.mjs`：三个安装 ZIP、版本一致性和压缩包完整性检查通过。

机器结果见 `test-results/siyuan-plugin-result.json`；新增截图为 `siyuan-plugin-quick-note.png`、`siyuan-plugin-review.png`。这些是本地验收产物，不进入 Git。所有写入及故障注入均使用隔离工作空间，不向用户日常笔记添加测试内容。

仍未验收 Windows、Linux、移动端、远端 HTTPS 部署或多设备同时编辑草稿。每日回顾不持久化完成进度，普通无标记文档不自动加入卡片盒。
