# 今日随手记 Daily Jots

> 在你发现内容的地方，把它写进你的 Obsidian —— 聊天即日记，链接即笔记，全程本地。

![License](https://img.shields.io/badge/License-AGPL--3.0--only-blue)
![Obsidian](https://img.shields.io/badge/Obsidian-1.11.4%2B-7C3AED)
![Fork](https://img.shields.io/badge/fork%20of-omnichannel--diary-00B8A9)

**今日随手记**是一个 Obsidian 插件：把微信、Telegram、飞书等 9 个聊天渠道里随手发出的消息、链接和附件，自动整理成 Vault 里的本地 Markdown。没有 AI 中转，没有云端暂存，笔记只留在你的硬盘上。

## 为什么需要它

| 你的现状 | 今日随手记 |
| --- | --- |
| 好内容截图收藏，图片散落相册 | 正文、图片、视频、附件自动落成一篇结构化笔记 |
| 收藏夹是黑洞，存了再也不看 | 落进 Vault 的 Markdown 可搜索、可双链、进图谱 |
| 链接失效、平台风控、内容消失 | 发给 bot 的那一刻就完成本地化，之后链接死活与你无关 |
| 工具越多越记不住 | 不用换 App：在聊天窗口丢一个链接，笔记自己长出来 |

## 它是怎么工作的

1. **连接渠道** —— 扫码或填入 Token，把聊天账号接入插件
2. **随手投喂** —— 在聊天窗口发消息、丢链接、传文件：纯文本追加进当天日记，链接被读出正文，附件原样落盘
3. **长在 Vault 里** —— 每条记录都是带 frontmatter 的 Markdown，媒体本地化进附件目录

## 站在前人的肩膀上

本项目 fork 自 [AI-Scarlett/obsidian-omnichannel-diary](https://github.com/AI-Scarlett/obsidian-omnichannel-diary)。

- 9 渠道接入体系、「消息即日记」的落盘架构、本地优先原则——这些是本项目的**灵魂**，全部出自原作者的设计
- 本项目只做锦上添花：在同一个骨架上，把内容源的**深度**（更多平台、更完整的提取）与**可靠性**（真实报错、失败可见）往前推了几步
- 许可证沿用 AGPL-3.0-only，感谢原作者的开源

## 锦上添花：本项目优化内容

### 更深的社区媒体剪藏

| 平台 | 提取内容 |
| --- | --- |
| 知乎 | 无需登录 游客身份即可；回答、专栏文章与纯问题页；403 自动种风控 Cookie 重试，公开内容无需登录 |
| 小红书 | 无需登录 游客身份即可；标题、作者与视频封面，分享短链自动展开 |
| 微博 | 搜索页、单条微博、头条文章；作者/时间/转评赞/配图大纲式排版，话题与 @ 降噪，图片本地化，风控可诊断 |
| 微信公众号 | 标题、公众号名与正文；图集帖全图恢复，懒加载图片本地化 |
| Bilibili | 标题、UP 主、日期、统计、标签等结构化信息，支持 `b23.tv` 短链 |
| 更多站点 | 持续打磨中 |

### 云文档一键导出

| 平台 | 导出 |
| --- | --- |
| 腾讯文档 | 表格 → xlsx、幻灯片 → pptx，自动走服务端导出链 |
| 钉钉 | 在线表格 → xlsx 附件 |
| 企业微信文档 | 表格 → xlsx、幻灯片 → pptx |
| WPS | 文档表格 → xlsx |

### 设置补充

- 内置百余站点来源表 + 自定义规则（精确域名与 `*.` 通配符）
- 新增视频导出下载

### 可靠性工程

- **渠道稳定性** —— QQ 渠道 CORS 适配（经 Obsidian `requestUrl` 通道）、微信多回复去重等连接层修复
- **剪藏回执** —— 附带保存正文预览（默认前 200 字，可配置）与图片/视频计数
- **真实报错** —— 验证壳页、风控、Cookie 缺失报可诊断错误，不再存空笔记


## 渠道支持

| 渠道 | 连接方式 | 接收通道 | 附件 |
| --- | --- | --- | --- |
| 微信 | 官方 iLink/ClawBot 扫码授权 | HTTPS 长轮询 | AES 解密图片、文件、视频和语音 |
| 飞书 / Lark | 官方设备注册或 App ID/Secret | 官方 WebSocket SDK | 通过官方 API 下载消息资源 |
| 钉钉 | Client ID/Secret | 官方 Stream SDK | 文字及事件提供的直接下载资源 |
| 企业微信 | Bot ID/Secret | 官方机器人 WebSocket SDK | SDK 下载和 AES 解密 |
| QQ | App ID/Secret | 官方 QQ Bot Gateway SDK | 事件附件 URL |
| Slack | Socket Mode App Token 和 Bot Token | Socket Mode WebSocket | 需要鉴权的私有文件 URL |
| Telegram | BotFather Token | Bot API 长轮询 | 图片、文档、音频、语音、视频和动画 |
| Discord | Bot Token | Gateway v10 WebSocket | 消息附件 URL |
| WhatsApp | 关联设备二维码 | 内置 Baileys Node 传输层 | 图片、文档、音频、视频和贴纸 |

## 安装

1. 从 [release 分支](https://github.com/sadjjk/obsidian-daily-jots/tree/release) 下载 `main.js`、`manifest.json`、`styles.css`
2. 放入 `<Vault>/.obsidian/plugins/daily-jots/`
3. 在 Obsidian「设置 → 第三方插件」中启用「今日随手记」
4. 「设置 → 今日随手记」中添加渠道，扫码或填入凭据

要求 Obsidian 1.11.4+，桌面端使用。

## 隐私与本地优先

- **无 AI 中转** —— 消息与网页内容不经任何第三方服务加工，插件直连各平台官方接口
- **凭据只存本地** —— 渠道 Token 等仅保存在你的 Vault 配置中
- **笔记只落本地** —— 所有正文、图片、视频与文档写入你自己的 Vault，无云端暂存


## 致谢

- [AI-Scarlett/obsidian-omnichannel-diary](https://github.com/AI-Scarlett/obsidian-omnichannel-diary) —— 灵魂与骨架的来源，本项目的一切增强都建立在这份开源工作之上
