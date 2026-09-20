const crypto = require("node:crypto");

const { localIso } = require("../../core/util");

// 飞书文档专用提取:收敛 webclip 内飞书特有处理(渲染提取 + 会话 cookie 桥接)。
// 提取仍走浏览器会话渲染(不直连接口);正文图片下载依赖会话 cookie(imageHeaders 透传)。
// doc-info-time-item 文案形如"2023年11月3日创建"/"编辑于 2023年11月3日";
// 解析为本地时区 localIso 与其他平台统一(无时刻部分取当天 00:00),解析失败保留原文兜底。
function normalizeFeishuPublishedTime(value) {
  const raw = String(value || "").trim();
  const full = raw.match(/(\d{4})[年./-](\d{1,2})[月./-](\d{1,2})日?(?:\s+(\d{1,2}):(\d{2}))?/);
  // 飞书对当年日期省略年份("5月19日修改"),按当前年补齐;往年才显示完整年份
  const short = full ? null : raw.match(/(\d{1,2})月(\d{1,2})日(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!full && !short) return raw;
  const [year, month, day, hour = "0", minute = "0"] = full
    ? full.slice(1)
    : [String(new Date().getFullYear()), ...short.slice(1)];
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  return Number.isNaN(date.getTime()) ? raw : localIso(date);
}

async function extractFeishuDoc(url, { webSessionManager, collectSessionCookies, captureTimeoutMs } = {}) {
  const rendered = await webSessionManager.extract(url, "feishu", { captureTimeoutMs });
  const publishedTime = typeof rendered.publishedTime === "string"
    ? normalizeFeishuPublishedTime(rendered.publishedTime)
    : rendered.publishedTime;
  const normalized = publishedTime ? { ...rendered, publishedTime } : rendered;
  const cookie = collectSessionCookies ? await collectSessionCookies("feishu", "https://my.feishu.cn/") : "";
  return cookie ? { ...normalized, imageHeaders: { cookie } } : normalized;
}

// 飞书云盘文件页(/file/{token}):非文档,不做正文提取,按附件下载。
function isFeishuFileUrl(url) {
  return /^https?:\/\/[^/]*feishu\.cn\/file\/[A-Za-z0-9]+/.test(String(url || ""));
}

// 下载流请求头:x-csrftoken 即 cookie 里的 _csrf_token(实测一致),其余为 web 端固定应用标识。
function feishuFileDownloadHeaders(cookie) {
  const csrf = (String(cookie || "").match(/(?:^|;\s*)_csrf_token=([^;]+)/) || [])[1] || "";
  return {
    accept: "application/json, text/plain, */*",
    origin: "https://my.feishu.cn",
    referer: "https://my.feishu.cn/",
    "x-command": "stream.download.preview",
    ...(csrf ? { "x-csrftoken": csrf } : {}),
    "x-lgw-app-id": "1161",
    "x-lgw-os-type": "3",
    "x-lgw-terminal-type": "2",
    "x-lsc-bizid": "2",
    "x-lsc-terminal": "web",
    "x-lsc-version": "1",
    "x-request-id": crypto.randomBytes(24).toString("base64").replace(/[+/=]/g, "").slice(0, 31),
  };
}

// 先按无 version 直试(飞书对最新版本可能放行);被拒时抛错提示,待元信息接口补 version。
async function extractFeishuFile(url, { collectSessionCookies } = {}) {
  const token = (String(url || "").match(/\/file\/([A-Za-z0-9]+)/) || [])[1];
  if (!token) throw new Error("无法从链接解析飞书文件 token");
  const cookie = collectSessionCookies ? await collectSessionCookies("feishu", "https://my.feishu.cn/") : "";
  if (!cookie) {
    const error = new Error("飞书文件下载需要登录会话:先在浏览器会话中登录飞书后重试");
    error.code = "DOCUMENT_LOGIN_REQUIRED";
    throw error;
  }
  const streamUrl = `https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/preview/${token}?mount_point=explorer&preview_type=16`;
  return { streamUrl, headers: { ...feishuFileDownloadHeaders(cookie), cookie }, fallbackName: token };
}

module.exports = { extractFeishuDoc, normalizeFeishuPublishedTime, isFeishuFileUrl, extractFeishuFile };
