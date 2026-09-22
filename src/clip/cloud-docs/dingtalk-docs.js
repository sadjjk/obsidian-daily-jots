// 钉钉文档专用提取:登录 cookie(来自插件内置会话)+ document/data API 直取 + Slate 转 HTML。
// 实测依据(2026-09-18):私有文档匿名 GET /i/nodes 302,带会话 cookie 200;
// dentryKey 为 16 位 base62;响应顶层 {status,isSuccess,data},package 在 data.documentContent;
// body 为 Slate 序列化数组 [type(string), props(object), ...children],文本在叶子节点字符串元素。
const DINGTALK_ORIGIN = "https://alidocs.dingtalk.com";
const DENTRY_KEY_PATTERN = /"dentryKey"\s*:\s*"([^"]{8,64})"/i;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 Edg/132";
const { readLimitedBody } = require("../../core/network");
const { localIso } = require("../../core/util");

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

// 匿名访客 cookie jar:GET i/nodes 与 POST document/data 时服务端会 set-cookie,
// 图片(resources/img)请求必须带上这些 cookie,否则返回「暂无权限访问」占位图(实测)。
// 兼容两种响应形态:原生 fetch 的 headers.getSetCookie();safeFetch 的 get("set-cookie")(join 串,按「逗号+name=」启发式拆分)。
function collectSetCookies(response) {
  const headers = response.headers;
  if (headers && typeof headers.getSetCookie === "function") {
    return headers.getSetCookie().filter(Boolean);
  }
  const value = headers && typeof headers.get === "function" ? headers.get("set-cookie") : null;
  if (!value) return [];
  return value.split(/,\s*(?=[A-Za-z_][\w.-]*=)/);
}

function mergeCookieJar(jar, response) {
  for (const line of collectSetCookies(response)) {
    const pair = line.split(";")[0];
    const idx = pair.indexOf("=");
    if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}

function jarHeader(jar) {
  return jar && jar.size ? [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ") : "";
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

async function resolveDentryKey(url, jar = new Map(), fetchImpl = globalThis.fetch) {
  const previewKey = new URL(url).searchParams.get("dentryKey");
  if (previewKey) return previewKey;
  const response = await fetchImpl(url, { headers: requestHeaders(jarHeader(jar)) });
  if (!response.ok) {
    throw dingtalkError(`钉钉文档页面返回 HTTP ${response.status}:${url}`, "DINGTALK_DOCS_UNREACHABLE");
  }
  mergeCookieJar(jar, response);
  const html = await responseText(response);
  const match = html.match(DENTRY_KEY_PATTERN);
  if (!match) {
    throw dingtalkError(`无法从页面提取 dentryKey(私有文档需先在「浏览器会话」面板登录钉钉):${url}`, "DINGTALK_DENTRY_KEY_NOT_FOUND");
  }
  return match[1];
}

async function fetchDocumentData(dentryKey, jar = new Map(), fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`${DINGTALK_ORIGIN}/api/document/data`, {
    method: "POST",
    headers: {
      ...requestHeaders(jarHeader(jar)),
      "content-type": "application/json;charset=UTF-8",
      "a-dentry-key": dentryKey,
    },
    body: JSON.stringify({ fetchBody: true }),
  });
  if (!response.ok) {
    throw dingtalkError(`钉钉 document/data 返回 HTTP ${response.status}`, "DINGTALK_DOCS_UNREACHABLE");
  }
  mergeCookieJar(jar, response);
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
  // 代码块(实测):["code", {}, [span text [span leaf "多行\n文本"]]],leaf 文本自带 \n;
  // 必须输出 pre/code,否则下游 markdown 转换把换行折叠成空格,代码被拍平
  if (type === "code") return `<pre><code>${inner}</code></pre>`;
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
  if (type === "a") {
    const href = String((props && props.href) || "");
    return href ? `<a href="${escapeHtml(href)}">${inner}</a>` : inner;
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
  const values = Object.values(parts);
  // 正文 part:普通文档在 parts.main;知识库(PORTAL)的 note/preview 中 main.data 只有文件元数据,
  // 正文在 UUID key 的 part(实测:ragflow 便签正文在 00000000-…0001 的 data.body)。遍历取首个带 body 的 part。
  const bodyOwner = values.find((part) => part && part.data && Array.isArray(part.data.body)) || parts.main;
  const body = bodyOwner && bodyOwner.data && bodyOwner.data.body;
  if (!body) {
    throw dingtalkError("钉钉文档 package 中未找到正文 body 节点(parts 中无 data.body)", "DINGTALK_PACKAGE_MALFORMED");
  }
  // 标题兜底:fileMetaInfo.name 缺失时,文件名在元数据 part 的 data.fileName(与正文 part 可能不同)
  const metaPart = values.find((part) => part && part.data && part.data.fileName);
  const html = slateNodeToHtml(body).replace(/\n{3,}/g, "\n\n").trim();
  // 实测 fileMetaInfo:creator.nick 为作者昵称,gmtCreate 为文档创建时间(epoch 毫秒)
  const author = String(meta.creator && meta.creator.nick || "");
  const publishedAt = meta.gmtCreate ? localIso(new Date(meta.gmtCreate)) : "";
  return {
    title: String(meta.name || (metaPart && metaPart.data && metaPart.data.fileName) || "钉钉文档"),
    html,
    author,
    publishedAt,
  };
}

// 附件型文档(uni-preview?previewAtta=1):上传的原文件(docx/xlsx/pdf 等),
// 走 /box/api/v2/file/download 拿 OSS 预签名直链,webclip 下载为附件保存。
// 实测(2026-09-22):dentryUuid + version 从 URL 参数取;downloadType=URL_PRE_SIGNATURE 返回 preSignUrls[0]。
function parseAttachmentUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch (_) { return null; }
  if (parsed.pathname !== "/uni-preview") return null;
  const params = parsed.searchParams;
  if (params.get("previewAtta") !== "1") return null;
  const dentryUuid = params.get("dentryUuid");
  const version = params.get("version") || "1";
  if (!dentryUuid) return null;
  const extension = (params.get("extension") || "").toLowerCase();
  const fileName = params.get("fileName") || "";
  const fileSize = Number(params.get("fileSize")) || 0;
  return { dentryUuid, version, extension, fileName, fileSize };
}

// 钉钉在线表格(/spreadsheetv2/):collab 服务端存储,无 HTTP 导出 API,
// 用无头 Chrome + 页面内 webpack hack 导出 xlsx(详见 headless-chrome.js)。
function parseSpreadsheetUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch (_) { return null; }
  if (!parsed.pathname.includes("/spreadsheetv2/")) return null;
  const params = parsed.searchParams;
  // dentryKey:优先查询参数,其次路径段(/spreadsheetv2/{dentryKey}/edit)
  const pathSeg = parsed.pathname.split("/spreadsheetv2/")[1] || "";
  const dentryKey = params.get("dentryKey") || pathSeg.split("/")[0] || "";
  const docId = params.get("docId") || params.get("docKey") || "";
  if (!dentryKey) return null;
  // 构造编辑器完整 URL(带必要参数,确保 collab WebSocket 建立)
  const editorUrl = `${DINGTALK_ORIGIN}/spreadsheetv2/${dentryKey}/edit?docId=${encodeURIComponent(docId)}&dentryKey=${encodeURIComponent(dentryKey)}`;
  return { dentryKey, docId, editorUrl };
}

// 钉钉在线表格:无头 Chrome 导出 xlsx,返回 { buffer, fileName }
// 延迟 require headless-chrome(任务 4 才创建该模块),避免模块加载期 MODULE_NOT_FOUND
async function headlessExport(spreadsheetUrl, cookieHeader) {
  if (!cookieHeader) {
    throw dingtalkError("钉钉在线表格导出需要登录 cookie(请先在钉钉文档登录窗口登录)", "DINGTALK_DENTRY_KEY_NOT_FOUND");
  }
  const { exportDingtalkSpreadsheet } = require("./headless-chrome");
  return await exportDingtalkSpreadsheet(spreadsheetUrl, cookieHeader);
}

async function fetchDownloadUrl(dentryUuid, version, jar, fetchImpl) {
  const apiUrl = `${DINGTALK_ORIGIN}/box/api/v2/file/download?dentryUuid=${encodeURIComponent(dentryUuid)}&version=${encodeURIComponent(version)}&supportDownloadTypes=URL_PRE_SIGNATURE,HTTP_TO_CENTER&downloadType=URL_PRE_SIGNATURE`;
  const response = await fetchImpl(apiUrl, {
    headers: requestHeaders(jarHeader(jar)),
  });
  if (!response.ok) {
    throw dingtalkError(`钉钉附件下载接口返回 HTTP ${response.status}`, "DINGTALK_DOCS_UNREACHABLE");
  }
  mergeCookieJar(jar, response);
  const payload = await responseJson(response);
  if (payload && (payload.isSuccess === false || payload.success === false)) {
    throw dingtalkError("钉钉附件下载接口返回失败(权限不足或链接失效)", "DINGTALK_DOCS_API_ERROR");
  }
  const info = payload?.data?.ossUrlPreSignatureInfo || {};
  const preSignUrls = info.preSignUrls || [];
  if (!preSignUrls.length) {
    throw dingtalkError("钉钉附件下载接口未返回预签名 URL", "DINGTALK_DOCS_API_ERROR");
  }
  const downloadUrl = preSignUrls[0];
  // 从 OSS URL 的 response-content-disposition 参数提取文件名(多层 URL encode)
  let fileName = "";
  try {
    const cdMatch = downloadUrl.match(/response-content-disposition=([^&]+)/);
    if (cdMatch) {
      let decoded = cdMatch[1];
      // OSS URL 参数通常被 encode 了 2-3 次
      for (let i = 0; i < 3; i++) decoded = decodeURIComponent(decoded);
      const fnMatch = decoded.match(/filename\*?=([^;]+)/);
      if (fnMatch) fileName = fnMatch[1].replace(/^"(.*)"$/, "$1").trim();
    }
  } catch (_) {}
  return { downloadUrl, fileName };
}

async function extractDingtalkDoc(url, { webSessionManager, fetchImpl = globalThis.fetch } = {}) {
  let hostname = "";
  try { hostname = new URL(url).hostname.toLowerCase(); } catch (_) {}
  if (!/(^|\.)alidocs\.dingtalk\.com$/.test(hostname)) {
    throw dingtalkError(`非钉钉文档链接:${url}`, "DINGTALK_DOCS_URL_MISMATCH");
  }
  // jar:登录 cookie(若有)+ 提取过程中服务端种的匿名访客 cookie;图片下载必须带后者
  const jar = new Map();
  let cookieHeader = "";
  if (webSessionManager && typeof webSessionManager.collectCookies === "function") {
    cookieHeader = await webSessionManager.collectCookies("dingtalk", `${DINGTALK_ORIGIN}/`);
  }
  if (cookieHeader) {
    for (const pair of cookieHeader.split("; ")) {
      const idx = pair.indexOf("=");
      if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }
  // 附件型文档(uni-preview?previewAtta=1):上传的原文件,走 /box/api/v2/file/download
  const attachment = parseAttachmentUrl(url);
  if (attachment) {
    const { downloadUrl, fileName: dlFileName } = await fetchDownloadUrl(attachment.dentryUuid, attachment.version, jar, fetchImpl);
    const fileName = attachment.fileName || dlFileName || `${attachment.dentryUuid}.${attachment.extension || "bin"}`;
    const error = new Error(`钉钉附件文档(${attachment.extension || "未知"}格式),已获取下载链接`);
    error.code = "DINGTALK_BINARY_DOC";
    error.downloadUrl = downloadUrl;
    error.fileName = fileName;
    error.meta = { extension: attachment.extension, fileSize: attachment.fileSize };
    throw error;
  }
  // 在线表格(/spreadsheetv2/):无头 Chrome 导出 xlsx,抛 DINGTALK_BINARY_DOC 带 buffer(复用附件落盘)
  const spreadsheet = parseSpreadsheetUrl(url);
  if (spreadsheet) {
    const { buffer, fileName } = await headlessExport(spreadsheet.editorUrl, cookieHeader || jarHeader(jar));
    const error = new Error(`钉钉在线表格(${fileName}),已导出 xlsx`);
    error.code = "DINGTALK_BINARY_DOC";
    error.buffer = buffer;
    error.fileName = fileName;
    error.meta = { extension: "xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
    throw error;
  }
  // 在线文档(/i/nodes):Slate 结构,走 document/data API 提取
  const dentryKey = await resolveDentryKey(url, jar, fetchImpl);
  const payload = await fetchDocumentData(dentryKey, jar, fetchImpl);
  const { title, html, author, publishedAt } = packageToHtml(payload);
  const mergedCookie = jarHeader(jar);
  const imageHeaders = { cookie: mergedCookie || cookieHeader, "a-dentry-key": dentryKey };
  return { title, html, author, publishedAt, cookieHeader, imageHeaders };
}

module.exports = { resolveDentryKey, fetchDocumentData, packageToHtml, extractDingtalkDoc, parseAttachmentUrl, fetchDownloadUrl, parseSpreadsheetUrl, headlessExport };
