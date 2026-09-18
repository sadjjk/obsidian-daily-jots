// 钉钉文档专用提取:登录 cookie(来自插件内置会话)+ document/data API 直取 + Slate 转 HTML。
// 实测依据(2026-09-18):私有文档匿名 GET /i/nodes 302,带会话 cookie 200;
// dentryKey 为 16 位 base62;响应顶层 {status,isSuccess,data},package 在 data.documentContent;
// body 为 Slate 序列化数组 [type(string), props(object), ...children],文本在叶子节点字符串元素。
const DINGTALK_ORIGIN = "https://alidocs.dingtalk.com";
const DENTRY_KEY_PATTERN = /"dentryKey"\s*:\s*"([^"]{8,64})"/i;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 Edg/132";
const { readLimitedBody } = require("./network");

// 双形态兼容:原生 fetch Response 有 text/json;safeFetch 的自定义 response 只有
// body(async iterable,IncomingMessage),webclip 体系一律用 readLimitedBody 读取。
async function responseText(response, maxBytes = 8 * 1024 * 1024) {
  if (typeof response.text === "function") return response.text();
  const buffer = await readLimitedBody(response, maxBytes);
  return buffer.toString("utf8");
}

async function responseJson(response) {
  if (typeof response.json === "function") return response.json();
  return JSON.parse(await responseText(response));
}

function dingtalkError(message, code) {
  const error = new Error(message);
  if (code) error.code = code;
  return error;
}

function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function requestHeaders(cookieHeader) {
  const headers = {
    "user-agent": UA,
    "accept": "application/json, text/plain, */*",
    "accept-language": "zh-CN,zh;q=0.9",
    "referer": `${DINGTALK_ORIGIN}/`,
    "origin": DINGTALK_ORIGIN,
  };
  if (cookieHeader) headers.cookie = cookieHeader;
  return headers;
}

async function resolveDentryKey(url, cookieHeader = "", fetchImpl = globalThis.fetch) {
  const previewKey = new URL(url).searchParams.get("dentryKey");
  if (previewKey) return previewKey;
  const response = await fetchImpl(url, { headers: requestHeaders(cookieHeader) });
  if (!response.ok) {
    throw dingtalkError(`钉钉文档页面返回 HTTP ${response.status}:${url}`, "DINGTALK_DOCS_UNREACHABLE");
  }
  const html = await responseText(response);
  const match = html.match(DENTRY_KEY_PATTERN);
  if (!match) {
    throw dingtalkError(`无法从页面提取 dentryKey(私有文档需先在「浏览器会话」面板登录钉钉):${url}`, "DINGTALK_DENTRY_KEY_NOT_FOUND");
  }
  return match[1];
}

async function fetchDocumentData(dentryKey, cookieHeader = "", fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`${DINGTALK_ORIGIN}/api/document/data`, {
    method: "POST",
    headers: {
      ...requestHeaders(cookieHeader),
      "content-type": "application/json;charset=UTF-8",
      "a-dentry-key": dentryKey,
    },
    body: JSON.stringify({ fetchBody: true }),
  });
  if (!response.ok) {
    throw dingtalkError(`钉钉 document/data 返回 HTTP ${response.status}`, "DINGTALK_DOCS_UNREACHABLE");
  }
  const payload = await responseJson(response);
  if (payload && (payload.isSuccess === false || payload.success === false)) {
    throw dingtalkError("钉钉 document/data 报告 isSuccess=false(权限不足或链接失效)", "DINGTALK_DOCS_API_ERROR");
  }
  return payload;
}

// Slate 序列化节点:[type(string), props(object), ...children];纯字符串即文本(叶子内容)。
// props 不当正文输出;未知节点兜底为递归子节点文本。
function slateNodeToHtml(node) {
  if (typeof node === "string") return escapeHtml(node);
  if (!Array.isArray(node)) return "";
  const [type, props = {}, ...children] = node;
  const inner = children.map(slateNodeToHtml).join("");
  if (type === "h1" || type === "h2" || type === "h3" || type === "h4" || type === "h5" || type === "h6") {
    return `<${type}>${inner}</${type}>`;
  }
  if (type === "heading") {
    const level = Math.min(6, Math.max(1, Number(props && props.level) || 1));
    return `<h${level}>${inner}</h${level}>`;
  }
  if (type === "p") return inner.trim() ? `<p>${inner}</p>` : "";
  if (type === "img") {
    let src = String((props && props.src) || "");
    if (!src) return "";
    // 文档内嵌图片是站内相对路径(/core/api/resources/img/<hash>),媒体文件是 down.dingtalk.com 完整 URL
    if (src.startsWith("/")) src = `${DINGTALK_ORIGIN}${src}`;
    if (!/^https?:/i.test(src)) return "";
    return `<p><img src="${escapeHtml(src)}" alt="${escapeHtml((props && props.alt) || "")}"></p>`;
  }
  if (type === "span" && props && props["data-type"] === "leaf") {
    let out = inner;
    if (props.bold) out = `<strong>${out}</strong>`;
    if (props.italic) out = `<em>${out}</em>`;
    return out;
  }
  return inner;
}

function parsePackageJson(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch (_) {
    throw dingtalkError("钉钉文档 package 内容不是合法 JSON", "DINGTALK_PACKAGE_MALFORMED");
  }
}

// payload 为 document/data 的 JSON;兼容 data.resultValue 包裹层与 checkpoint 二次内嵌(实测结构)。
function packageToHtml(payload) {
  let root = payload;
  for (const key of ["data", "resultValue"]) {
    if (root && typeof root === "object" && root[key] && typeof root[key] === "object") root = root[key];
  }
  let content = parsePackageJson(
    root && root.documentContent !== undefined ? root.documentContent
      : root && root.checkpoint ? root.checkpoint.content
      : root ? root.content : undefined,
  );
  if (content && content.checkpoint) content = parsePackageJson(content.checkpoint.content);
  const meta = (root && root.fileMetaInfo) || (content && content.fileMetaInfo) || {};
  const parts = (content && content.parts) || {};
  const main = parts.main || parts[Object.keys(parts)[0]];
  const body = main && main.data && main.data.body;
  if (!body) {
    throw dingtalkError("钉钉文档 package 中未找到 parts[main].data.body", "DINGTALK_PACKAGE_MALFORMED");
  }
  const html = slateNodeToHtml(body).replace(/\n{3,}/g, "\n\n").trim();
  return { title: String(meta.name || "钉钉文档"), html };
}

async function extractDingtalkDoc(url, { webSessionManager, fetchImpl = globalThis.fetch } = {}) {
  let hostname = "";
  try { hostname = new URL(url).hostname.toLowerCase(); } catch (_) {}
  if (!/(^|\.)alidocs\.dingtalk\.com$/.test(hostname)) {
    throw dingtalkError(`非钉钉文档链接:${url}`, "DINGTALK_DOCS_URL_MISMATCH");
  }
  let cookieHeader = "";
  if (webSessionManager && typeof webSessionManager.collectCookies === "function") {
    cookieHeader = await webSessionManager.collectCookies("dingtalk", `${DINGTALK_ORIGIN}/`);
  }
  const dentryKey = await resolveDentryKey(url, cookieHeader, fetchImpl);
  const payload = await fetchDocumentData(dentryKey, cookieHeader, fetchImpl);
  const { title, html } = packageToHtml(payload);
  // 图片下载上下文:登录 cookie + dentry key(resources/img 端点需要 dentry 上下文)
  const imageHeaders = cookieHeader ? { cookie: cookieHeader, "a-dentry-key": dentryKey } : undefined;
  return { title, html, cookieHeader, imageHeaders };
}

module.exports = { resolveDentryKey, fetchDocumentData, packageToHtml, extractDingtalkDoc };
