# Omnichannel Diary

> 🍴 本项目是 [AI-Scarlett/obsidian-omnichannel-diary](https://github.com/AI-Scarlett/obsidian-omnichannel-diary) 的 fork

Omnichannel Diary 将聊天平台中的消息、网页和附件保存到本地 Obsidian Vault,支持微信、飞书/Lark、钉钉、企业微信、QQ、Slack、Telegram、Discord 和 WhatsApp。

## Fork 增强功能

### 0.5.2

- **微博视频与元信息提取** —— 适配新版官媒视频帖（视频卡在 `url_objects[].object.object`、无 `page_info` 的结构），从直链收集视频并本地化；同视频多清晰度只保留一个（480p 优先，不再重复下载 720p 副本）；正文无原位链接的视频在末尾追加引用段；`published_at` 从 `created_at` 填充（此前视频帖为空）。
- **微信图集帖全图恢复** —— 公众号图集帖（正文自述「N 张图」）此前只抓到封面，图集数据在 `picture_page_info_list` 由 JS 渲染；现按主图判据（对象开头 `cdn_url` 且带 `width` 元数据）提取全部图片，剔除同图不同 CDN 变体的嵌套副本（避免图集数量翻倍），图片拼进正文走本地化管线。
- **剪藏回执视频计数** —— 保存网页视频开关打开时，回执按图片同模式报告保存视频数（「已提取正文、N 张图片、M 个视频并保存」），不展示文件路径；视频失败并入统一失败列表。
- **QQ 渠道连接修复** —— Obsidian 渲染进程原生 `fetch` 跨域被 CORS 拦截（`app://obsidian.md` → QQ 端点无 ACAO 头），导致 token/gateway 请求全灭、报「Network error」；改经 Obsidian `requestUrl`（Electron net 通道，无 CORS）做 fetch 适配器，渠道存活期覆盖 SDK 与预检；连接错误透传 SDK 日志与 cause 链，凭据错误与网络错误可区分。
- **微信渠道多回复修复** —— 一条入站消息触发的多条回复（查询 ack + 结果、导出 ack + 文件 + 回执）此前共用 `client_id`，被微信 ilink 静默去重丢第二条；改为每条回复独立 `client_id`，查询结果与导出回执不再丢失。
- **知乎/豆瓣无链接视频追加引用** —— 正文不含视频源 URL 时（知乎渲染探测、豆瓣兜底），下载成功后在末尾追加 `- [视频-NN](本地路径)` 引用段，文件不再成为孤儿。

### 0.5.1

- **来源名称标注** —— 内置百余站点来源表 + 自定义规则(精确域名与 `*.` 通配符),剪藏文件名与 frontmatter `platform` 字段自动标注来源(如 `2026-09-17-抖音-标题-hash.md`);设置面板「社区媒体来源」可视化配置与悬停提示。
- **抖音剪藏** —— 支持分享短链(自动展开并种访客 Cookie),提取标题、作者与视频封面。
- **钉钉在线表格剪藏** —— 表格链接自动经浏览器管理会话导出为 xlsx 附件落盘,文件名取自表格名(此前为无意义 hash);正文笔记按行呈现附件信息。
- **腾讯文档表格/幻灯导出** —— `docs.qq.com` 表格与幻灯片链接走导出链(opendoc 换取服务端文档 ID → 发起导出 → 轮询进度 → COS 直链下载),表格存 xlsx、幻灯存 pptx 附件;文件名取响应头 UTF-8 文件名,frontmatter 自动带作者与创建时间。
- **企微文档表格/幻灯导出** —— `doc.weixin.qq.com` 表格与幻灯片同样导出为 xlsx/pptx 附件;与腾讯文档协议同源但细节不同(docId 直接取 URL、`wedoc_xsrf` 鉴权、轮询带 timestamp),独立会话(`wecomdoc`)与错误码。

### 0.5.0

- **知乎剪藏优化** —— 覆盖回答页、专栏文章与纯问题页(`/question/{id}`:标题 + 详情 + 首屏回答);遇到 `403` 时自动拉起无头 Chrome 种下 `__zse_ck` 风控 Cookie 并重试,公开问题无需登录。

- **Bilibili 视频页剪藏优化** —— 直接读取页面 `__INITIAL_STATE__`,提取标题、UP 主、日期、统计、标签等结构化信息,支持 `b23.tv` 短链;遇到验证壳页报真实错误,不再存空笔记。

- **小红书剪藏优化** —— `403/429/461` 退避后带 referer 重试;验证壳页产出可诊断的错误信息,不再误报"需要登录"。

- **剪藏回执附加预览** —— 剪藏回执附带保存正文的 markdown 预览(默认 200 字,开关与字数在「收集规则」里配置;图片不进预览,换行原样保留,预览前带「预览如下,仅展示前 N 字」说明行);固定欢迎语只在纯日记/失败回执开头出现。

- **微博剪藏** —— 支持搜索页、单条微博与头条文章;无头 Chrome 自动种访客 Cookie 后走官方 JSON 接口提取,笔记按大纲式排版(作者 / 时间 / 转评赞 / 配图 / 转发),话题与 @ 链接降噪为纯文本,配图自动本地化;风控(432)与 Cookie 缺失报真实错误。

- **微信公众号文章剪藏** —— 提取标题、公众号名与正文;懒加载图片自动提升并下载到本地;微信降级渲染时从页面内嵌数据兜底提取,真正风控验证页报真实错误。

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


## 构建与测试

Node.js 20.18+:`npm install && npm run verify`

## 许可证

AGPL-3.0-only。
