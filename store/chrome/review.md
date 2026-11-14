# Chrome 上架检查报告

检查日期：2026-11-14。对象：当前工作区 Chrome 扩展 0.5.1 候选包。此次未提交商店；新版政策及上架材料随本次提交发布到 GitHub main。

## 结论

已修复检查中发现的默认阅读采集、模型明文远程传输和过期商店说明问题，准备好候选 ZIP、截图、权限说明、隐私声明建议和审核步骤。技术检查通过，正式提交前需确认公开隐私政策为新版，并完成开发者账号的付款/验证及后台声明。Google 的最终审核结论不能由本地检查保证。

当前仓库仍使用 0.5.1，本包包含本次商店准备修复，不能与已有 0.5.1 GitHub release ZIP 混用。首次上架可以使用此版本；如果商店已存在同版本，则需统一递增版本并重建上传包。

## 核查结果

| 项目 | 结果与依据 |
| --- | --- |
| Manifest V3 | 通过；模块 service worker；最低 Chrome 120；ZIP 根目录包含 manifest |
| 单一用途 | 网页阅读笔记；保存、回顾、同步与已有标签整理围绕同一用途；材料已补全可选集成 |
| 权限 | 仅 unlimitedStorage、alarms 和 HTTP/HTTPS 主机访问；无 tabs/history/cookies/debugger 权限申请；广泛站点访问用于任意页面划线恢复、原图与自选 API。仍可能被要求补充说明 |
| 远程代码 | 源码及打包 JS 检索未发现 eval、new Function、importScripts 或远程脚本加载；依赖随包提供，模型结果仅解析为标签数据 |
| 隐私/知情选择 | 新安装阅读记录默认关闭，需切换并保存；首次安装打开有隐私说明的设置页；AI 默认关闭；flomo/思源配置前有发送范围说明 |
| 传输 | flomo HTTPS；思源和模型仅 HTTPS 或本机回环 HTTP。新增模型接口限制及回归测试。原图下载可能使用原站 HTTP 并附带浏览器允许的站点凭据，隐私政策已披露；不向任意图片站发送 API Key |
| 凭据 | 密码输入框；本机 IndexedDB 保存；备份和网页消息隔离有测试覆盖。没有应用层静态加密，政策如实披露，依赖设备/浏览器配置文件访问保护 |
| 删除与备份 | 本地删除、旧备份防复活有测试；同步墓碑保留标识/URL/标题，政策已注明；第三方和已导出文件副本需单独删除 |
| 内容与隐私安全 | 页面消息校验当前 tab URL、配置操作限制扩展页；无痕禁用；排除站点有测试；未发现开发者遥测或广告上传路径 |
| 商店素材 | 3 张真实当前 UI 截图均 1280×800，128px PNG 图标、440×280 宣传图；已逐张视觉检查 |
| 包内容 | 只含运行文件、图标、许可证；不含源码映射、测试资料、API 凭据或开发 profile；ZIP 完整性检查通过 |
| 公开政策 | GitHub 地址可匿名访问；新版政策随本次提交更新，提交商店前核对日期为 2026-11-14 |

## 验证

- `npm run check`：通过。
- `npm test`：66 项通过，0 失败；包括新增远程 HTTP 拒绝、本机 HTTP 允许的回归。
- `npm run build`：通过。
- `npm run test:e2e`：通过，覆盖核心操作、未开启阅读不产生会话、主动开启后产生会话、本地双向修改/冲突、备份、重启、排除与删除。
- `npm run test:browser-ai`、`npm run test:flomo`、`npm run test:images`、`npm run test:siyuan`：通过。第三方接口使用项目测试服务，未以真实付费账号或远程服务实测；思源含 v1/v2 → v3 数据库迁移。
- `node scripts/store-screenshots.mjs`：用临时 profile 与原创样例生成三张真实截图；运行后清理 profile。
- `node scripts/package-release.mjs`：版本一致性与 ZIP 校验通过。
- `git diff --check`：通过。

## 上架前仍需完成

1. 核对 GitHub main 的 PRIVACY.md 与本目录副本一致，包含新安装默认关闭阅读记录、HTTPS 及限定用途说明。
2. 使用本人开发者账号完成注册付款、邮箱/两步验证及后台要求的身份信息；本次未访问开发者后台。
3. 按 listing.md 填写素材、权限与数据用途声明，核对联系邮箱、分发地区和商店实际字段。可选第三方集成若被要求测试账号，需提供隔离测试账号。
4. 上传本目录中的扩展 ZIP；最终批准与审核周期由 Google 决定。

## 官方依据

- [发布流程](https://developer.chrome.com/docs/webstore/publish)
- [隐私字段与权限说明](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- [用户数据 FAQ：本地数据披露、显著说明、限定用途与本机通信](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
- [Manifest V3 代码要求](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)
- [图标与截图规格](https://developer.chrome.com/docs/webstore/images)
- [开发者政策](https://developer.chrome.com/docs/webstore/program-policies/policies)
