const { localIso } = require("../../core/util");

// 飞书文档专用提取:收敛 webclip 内飞书特有处理(渲染提取 + 会话 cookie 桥接)。
// 提取仍走浏览器会话渲染(不直连接口);正文图片下载依赖会话 cookie(imageHeaders 透传)。
// doc-info-time-item 文案形如"2023年11月3日创建"/"编辑于 2023年11月3日";
// 解析为本地时区 localIso 与其他平台统一(无时刻部分取当天 00:00),解析失败保留原文兜底。
function normalizeFeishuPublishedTime(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/(\d{4})[年./-](\d{1,2})[月./-](\d{1,2})日?(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!match) return raw;
  const [, year, month, day, hour = "0", minute = "0"] = match;
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

module.exports = { extractFeishuDoc, normalizeFeishuPublishedTime };
