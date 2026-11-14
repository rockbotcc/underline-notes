# Chrome 上架检查报告 · 0.5.2

检查日期：2026-11-14。对象：`store/chrome/underline-notes-chrome-0.5.2.zip`。本次更新本地提交材料与安装包，未上传或提交 Chrome Web Store。

## 安装包来源与一致性

- 来源：[GitHub 0.5.2 Release](https://github.com/rockbotcc/underline-notes/releases/tag/0.5.2) 的 `underline-notes-chrome.zip`，仅在本目录增加版本后缀；没有重新压缩或修改包内文件。
- 发布源码：`35150e26f24199cc189420b5441cccfe635d8926`，包含安全修复提交 `6f5d23497cd16481aae673e077f94d4e4fde945b`。
- [发布 CI](https://github.com/rockbotcc/underline-notes/actions/runs/43538575141) 全部通过后生成正式产物。
- SHA-256：`0e8851028a77328bf3fc8250ab277320454e9828cf641eedc239bbca9144d1bc`，与 Release 的 `SHA256SUMS.txt` 一致。
- ZIP 根目录 `manifest.json` 的版本为 `0.5.2`；ZIP 完整性通过；不包含源码映射、测试目录或开发浏览器配置。
- 商店目录已移除旧的 0.5.1 候选 ZIP，避免误上传。当前安装包与 GitHub 发布包一致，不再存在同版本候选包与 Release 内容不同的问题。

## 本次安全修复

1. **网页笔记隔离**：使用封闭 Shadow DOM，阻止网页通过公开 DOM 接口读取当前页笔记；拒绝脚本合成的点击、双击、输入和键盘事件。真实用户操作、Ctrl/Command+Enter 保存及草稿保护保留。
2. **模型传输限制**：Chrome 端继续要求远程模型接口使用 HTTPS，仅本机回环 HTTP 例外。配套 Obsidian 插件 0.5.2 补齐了同一限制，阻止向远程 HTTP 接口明文发送密钥和笔记；Obsidian 插件不包含在本 Chrome ZIP 中，需独立升级。

不增加扩展权限、数据类别或发送用途，不改变已有笔记数据格式。

## 核查结果

| 项目 | 结果与依据 |
| --- | --- |
| Manifest V3 | 模块 service worker；最低 Chrome 120；ZIP 根目录包含 manifest |
| 单一用途 | 网页阅读笔记；保存、回顾、同步与已有标签整理围绕同一用途 |
| 权限 | unlimitedStorage、alarms 和 HTTP/HTTPS 主机访问；未申请 tabs/history/cookies/debugger 权限；用途见 listing.md |
| 隐私与选择 | 新安装阅读记录默认关闭，需主动保存设置；AI 默认关闭；可选同步配置前说明发送范围 |
| 传输 | flomo HTTPS；思源和模型为 HTTPS 或本机回环 HTTP。原图可能使用原站 HTTP，并附带浏览器允许的站点凭据，隐私政策已披露 |
| 凭据 | 密码输入框；仅在本机数据库保存；备份及网页消息隔离有测试覆盖；不宣称提供应用层静态加密 |
| 内容与隐私安全 | 封闭笔记界面、可信事件校验、页面消息对应当前 tab URL、配置操作限制扩展页；无痕禁用；排除站点有测试 |
| 删除与备份 | 删除联动、冲突保护、旧备份防复活有测试；同步删除记录及外部副本的保留规则见隐私政策 |
| 商店素材 | 从本次 Release ZIP 运行的真实扩展重新生成三张 1280×800 截图，使用原创示例与临时 profile；128px 图标与包内图标一致，宣传图为 440×280 |
| 隐私政策 | 本目录 PRIVACY.md 与仓库根目录副本一致；日期为 2026-11-14；本次无新增数据用途 |

## 验证

发布 CI 已通过类型检查、68 项单元测试、构建、安全回归、完整浏览器功能测试、图片、自动标签、flomo、思源及数据库迁移测试，并完成版本一致性、ZIP 校验及打包。

本次对**下载的正式 Chrome ZIP**额外执行：

- 对照 Release 校验文件验证 SHA-256；检查 ZIP 完整性和 manifest 版本。
- 核对打包代码包含封闭 Shadow DOM 与 `isTrusted` 事件防护。
- `npm run test:security`：验证网页无法读取私人笔记或执行原始 DOM 篡改攻击；伪造编辑、保存、删除及快捷键被阻止，真实 Ctrl/Command+Enter 可用。
- `npm run test:e2e`：验证划线、批注、真实点击与快捷键、草稿保护、本地双向同步、冲突恢复、备份、重启、排除及删除。
- `node scripts/store-screenshots.mjs`：从该包生成三张实际界面截图，并检查截图内容和尺寸。
- 在仓库根目录执行 `shasum -a 256 -c store/chrome/SHA256SUMS.txt` 和 `git diff --check`。

第三方集成回归使用项目测试服务；本次未以真实付费账号或真实 Obsidian／思源客户端进行人工验收。

## 商店提交

安装包、文案、截图和权限／隐私填写说明见本目录 `listing.md`。提交时核对商店后台的当前版本、账号状态、联系邮箱与地区，上传 `underline-notes-chrome-0.5.2.zip`。本次未访问开发者后台，未执行账号付款、后台声明或提交审核；最终审核结果由 Google 决定。

## 参考链接

- [发布流程](https://developer.chrome.com/docs/webstore/publish)
- [隐私字段与权限说明](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- [用户数据 FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
- [Manifest V3 代码要求](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)
- [图标与截图规格](https://developer.chrome.com/docs/webstore/images)
- [开发者政策](https://developer.chrome.com/docs/webstore/program-policies/policies)
