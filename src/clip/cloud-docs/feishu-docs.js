const crypto = require("node:crypto");

const { localIso } = require("../../core/util");
const { readLimitedBody } = require("../../core/network");

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

// meta 接口响应结构未逐字段核对:深度优先按谓词宽匹配,取不到退回 token 兜底
function pickFeishuMetaValue(payload, match) {
  const walk = (node) => {
    if (!node || typeof node !== "object") return undefined;
    if (Array.isArray(node)) {
      for (const item of node) { const hit = walk(item); if (hit !== undefined) return hit; }
      return undefined;
    }
    for (const [key, value] of Object.entries(node)) {
      if (match(key, value)) return value;
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") { const hit = walk(value); if (hit !== undefined) return hit; }
    }
    return undefined;
  };
  return walk(payload);
}

const FEISHU_NAME_FALLBACKS = [
  /^(name|file_?name|obj_?name|doc_?name|title)$/i,
  /name$/i,
  /(name|title)/i,
];

function parseFeishuFileMeta(payload, token) {
  // 文件名:精确 → 前缀降级 → 宽匹配,排除 id/key/token/url 等陷阱字段
  let name = "";
  for (const re of FEISHU_NAME_FALLBACKS) {
    const hit = pickFeishuMetaValue(payload, (key, value) =>
      typeof value === "string" && re.test(key) && !/(id|key|token|hash|url|link|time|version)$/i.test(key)
      && value.trim() && value.trim().toLowerCase() !== token.toLowerCase());
    if (hit) { name = String(hit).trim(); break; }
  }
  name = name || token;
  // 真实流 version 是长数字雪花 ID(如 7639013533866314704);短数字是无关字段,误拼会 404
  const rawVersion = pickFeishuMetaValue(payload, (key, value) =>
    /^(version|latest_?version|obj_?version)$/i.test(key) && /^\d{10,}$/.test(String(value)));
  const version = rawVersion === undefined ? "" : String(rawVersion);
  const created = pickFeishuMetaValue(payload, (key, value) =>
    /(create_?time|created_?at|gmt_?create)$/i.test(key) && (typeof value === "number" || /^\d+$/.test(String(value))));
  let publishedAt = "";
  const value = Number(created);
  if (Number.isFinite(value) && value > 0) publishedAt = localIso(new Date(value > 1e12 ? value : value * 1000));
  return { name, version, publishedAt };
}

// 先取元信息(真实文件名/version/创建时间),下载流带上 version;元信息失败不阻塞,退回无 version + token 兜底
async function extractFeishuFile(url, { collectSessionCookies, fetchImpl } = {}) {
  const token = (String(url || "").match(/\/file\/([A-Za-z0-9]+)/) || [])[1];
  if (!token) throw new Error("无法从链接解析飞书文件 token");
  const cookie = collectSessionCookies ? await collectSessionCookies("feishu", "https://my.feishu.cn/") : "";
  if (!cookie) {
    const error = new Error("飞书文件下载需要登录会话:先在浏览器会话中登录飞书后重试");
    error.code = "DOCUMENT_LOGIN_REQUIRED";
    throw error;
  }
  let meta = { name: token, version: "", publishedAt: "" };
  try {
    const metaUrl = `https://my.feishu.cn/space/api/meta/?token=${token}&type=12&need_extra_fields=3`;
    const response = await fetchImpl(metaUrl, {
      headers: { accept: "application/json, text/plain, */*", cookie, referer: "https://my.feishu.cn/" },
    });
    // 三形态兼容:原生 Response 有 json/text;safeFetch 的自定义 response 只有 body(async iterable)
    const parseBody = async () => {
      if (typeof response.json === "function") return response.json();
      const text = typeof response.text === "function"
        ? await response.text()
        : (await readLimitedBody(response, 1024 * 1024)).toString("utf8");
      return JSON.parse(text);
    };
    meta = parseFeishuFileMeta(await parseBody(), token);
  } catch (_) { /* 元信息拿不到就按无 version + token 继续 */ }
  const version = meta.version ? `&version=${encodeURIComponent(meta.version)}` : "";
  const streamUrl = `https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/preview/${token}?mount_point=explorer&preview_type=16${version}`;
  return {
    streamUrl,
    // version 拼错时飞书返回 404;无 version 的直试已被实测验证可行,留作回退
    fallbackStreamUrl: version ? `https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/preview/${token}?mount_point=explorer&preview_type=16` : "",
    headers: { ...feishuFileDownloadHeaders(cookie), cookie },
    fallbackName: meta.name,
    publishedAt: meta.publishedAt,
  };
}

module.exports = { extractFeishuDoc, normalizeFeishuPublishedTime, isFeishuFileUrl, extractFeishuFile };
