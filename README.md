# Omnichannel Diary

> 🍴 本项目是 [AI-Scarlett/obsidian-omnichannel-diary](https://github.com/AI-Scarlett/obsidian-omnichannel-diary) 的 fork,由 [JinYu](https://github.com/sadjjk) 维护。许可证 AGPL-3.0-only,沿用上游。

Omnichannel Diary 将聊天平台中的消息、网页和附件保存到本地 Obsidian Vault,支持微信、飞书/Lark、钉钉、企业微信、QQ、Slack、Telegram、Discord 和 WhatsApp。剪藏能力覆盖文章、云文档、PDF、技术社区讨论与代码平台,详见[支持的剪藏来源](docs/supported-sources.md)。可选的远程查询(「查 关键词」→ 回复「确认 1」打包发回)见[远程查询与导出](docs/remote-search.md)。

## Fork 增强功能 (0.5.0)

- **知乎剪藏优化** —— 覆盖回答页、专栏文章与纯问题页(`/question/{id}`:标题 + 详情 + 首屏回答);遇到 `403` 时自动拉起无头 Chrome 种下 `__zse_ck` 风控 Cookie 并重试,公开问题无需登录。

- **Bilibili 视频页剪藏优化** —— 直接读取页面 `__INITIAL_STATE__`,提取标题、UP 主、日期、统计、标签等结构化信息,支持 `b23.tv` 短链;遇到验证壳页报真实错误,不再存空笔记。

- **小红书剪藏优化** —— `403/429/461` 退避后带 referer 重试;验证壳页产出可诊断的错误信息,不再误报"需要登录"。

- **剪藏回执附加预览** —— 剪藏回执附带保存正文的 markdown 预览(默认 200 字,开关与字数在「收集规则」里配置;图片不进预览,换行原样保留);固定欢迎语只在纯日记/失败回执开头出现。

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

Slack、Telegram 与 Discord 必须使用官方开发者 Token,其余支持扫码授权。

## 构建与测试

Node.js 20.18+:`npm install && npm run verify`

## 许可证

AGPL-3.0-only(沿用上游)。
