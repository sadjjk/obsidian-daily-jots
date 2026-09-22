// WPS 文档专用提取:登录 cookie(插件 wps 会话)+ 内部 OTL API 直取 + OTL 转 Markdown。
// 实测依据(2026-09-21,kdocs.cn/l/ck1mE4vgjirr):
// POST /api/v3/office/file/{token}/open/otl 返回 OTL JSON 全量块树(42KB 样本);
// 头 x-csrf-rand = cookie 的 csrf(32 字符);x-client-request-id 任意 uuid;x-forward-region 固定 yxy;
// body {connid 自造, args:{password:"", sync:true, startVersion:0, endVersion:0, autoSlim:true,
//   connRenderMode:0, readonly:false, modifyPassword:""}, group: 任意值}(group|front_ver 至少给一,否则 400);
// 参数矩阵:原样/去 reuse/仅 front_ver/仅 group/group 自造/无 connid 均 200;
// OTL 结构:content(根)>logic_block>block_tile>(outline-title|paragraph|heading|picture),
//   text 节点 {text, marks?:[{type,attrs}]},heading.attrs.level,emoji.attrs.emoji,picture.attrs.sourceKey;
// 图片 URL 走 POST /api/v3/office/file/{token}/attachment/shapes(请求体 {objects:[{attachment_id,max_edge,source}]},返回 {data:{sourceKey:{url}}});
// 文档元信息(作者/创建时间)走 GET /api/v3/office/file/{token}(返回 {file:{name,create_time,modify_time,creator:{name}}});
// 内存模型路线不成立(无飞书式数据全局),兜底走 ProseMirror DOM(.ProseMirror.otl-main-editor)。
const crypto = require("node:crypto");
const { localIso } = require("../../core/util");
const { readLimitedBody } = require("../../core/network");

const WPS_ORIGIN = "https://www.kdocs.cn";
const WPS_TOKEN_PATTERN = /kdocs\.cn\/(?:l|view\/l|w)\/([A-Za-z0-9]+)/i;

function wpsError(message, code) {
  const error = new Error(message);
  if (code) error.code = code;
  return error;
}

function wpsDocToken(url) {
  return (String(url || "").match(WPS_TOKEN_PATTERN) || [])[1] || "";
}

async function responseText(response, maxBytes = 8 * 1024 * 1024) {
  if (typeof response.text === "function") return response.text();
  const buffer = await readLimitedBody(response, maxBytes);
  return buffer.toString("utf8");
}

async function responseJson(response) {
  if (typeof response.json === "function") return response.json();
  return JSON.parse(await responseText(response));
}

// text 节点 marks → Markdown 包裹;覆盖实测 link 及常见 bold/italic/code/strike/underline。
function applyMarks(text, marks) {
  let out = text;
  for (const mark of marks || []) {
    const type = String(mark?.type || "").toLowerCase();
    if (type === "link" && mark.attrs?.href) out = `[${out}](<${mark.attrs.href}>)`;
    else if (type === "bold" || type === "strong") out = `**${out}**`;
    else if (type === "italic" || type === "em") out = `*${out}*`;
    else if (type === "inlinecode" || type === "code") out = "`" + out + "`";
    else if (type === "strikethrough" || type === "strike" || type === "del") out = `~~${out}~~`;
  }
  return out;
}

// 行内内容(text/emoji)→ 字符串
function inlineText(nodes) {
  return (nodes || []).map((n) => {
    if (n?.type === "text") return applyMarks(typeof n.text === "string" ? n.text : "", n.marks);
    if (n?.type === "emoji") return n.attrs?.emoji || "";
    if (Array.isArray(n?.content)) return inlineText(n.content);
    return "";
  }).join("");
}

// OTL JSON → Markdown。imageUrls: {sourceKey: url} 来自 attachment/shapes(可空)。
function otlToMarkdown(otlJson, imageUrls = {}) {
  const root = otlJson?.content;
  if (!root || typeof root !== "object") return "";
  const lines = [];
  const emitBlock = (node, depth) => {
    if (!node || typeof node !== "object") return;
    const type = String(node.type || "");
    if (type === "outline-title") {
      const t = inlineText(node.content).trim();
      if (t) lines.push(`\n\n# ${t}\n\n`);
      return;
    }
    if (type === "heading") {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 1));
      lines.push(`\n\n${"#".repeat(level + 1)} ${inlineText(node.content).trim()}\n\n`);
      return;
    }
    if (type === "paragraph") {
      const text = inlineText(node.content).trim();
      const listType = node.attrs?.listType;
      if (listType === "bullet" || listType === "unordered") {
        lines.push(`${"  ".repeat(Number(node.attrs?.listLevel) || 0)}- ${text}\n`);
      } else if (listType === "ordered" || listType === "number") {
        lines.push(`${"  ".repeat(Number(node.attrs?.listLevel) || 0)}1. ${text}\n`);
      } else if (text) {
        lines.push(`\n\n${text}\n\n`);
      }
      return;
    }
    if (type === "picture") {
      const url = node.attrs?.src || imageUrls[node.attrs?.sourceKey] || "";
      lines.push(`\n\n![${node.attrs?.caption || ""}](<${url}>)\n\n`);
      return;
    }
    // 容器(logic_block/block_tile/list/其他)递归;未知叶子出文本兜底
    if (Array.isArray(node.content)) node.content.forEach((c) => emitBlock(c, depth + 1));
    else {
      const t = inlineText([node]).trim();
      if (t) lines.push(`\n\n${t}\n\n`);
    }
  };
  emitBlock(root, 0);
  return lines.join("").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function otlTitle(otlJson) {
  const root = otlJson?.content;
  let title = "";
  const walk = (n) => {
    if (title || !n || typeof n !== "object") return;
    if (n.type === "outline-title") { title = inlineText(n.content).trim(); return; }
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  walk(root);
  return title;
}

function collectPictureKeys(otlJson) {
  const keys = [];
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (n.type === "picture" && n.attrs?.sourceKey) keys.push(n.attrs.sourceKey);
    if (Array.isArray(n.content)) n.content.forEach(walk);
  };
  walk(otlJson?.content);
  return keys;
}

function csrfFromCookie(cookie) {
  return (String(cookie || "").match(/(?:^|;\s*)csrf=([^;]+)/) || [])[1] || "";
}

function otlRequest(token, cookie) {
  const csrf = csrfFromCookie(cookie);
  const body = {
    connid: crypto.randomBytes(16).toString("hex"),
    args: { password: "", readonly: false, modifyPassword: "", sync: true, startVersion: 0, endVersion: 0, autoSlim: true, connRenderMode: 0 },
    group: `2099${Date.now()}-000000000000`,
  };
  return {
    url: `${WPS_ORIGIN}/api/v3/office/file/${token}/open/otl`,
    init: {
      method: "POST",
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 Edg/132",
        "origin": WPS_ORIGIN,
        "content-type": "text/plain;charset=UTF-8",
        "referer": `${WPS_ORIGIN}/l/${token}`,
        ...(csrf ? { "x-csrf-rand": decodeURIComponent(csrf) } : {}),
        "x-client-request-id": crypto.randomUUID(),
        "x-forward-region": "yxy",
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    },
  };
}

async function fetchShapeUrls(token, cookie, sourceKeys, fetchImpl) {
  if (!sourceKeys?.length) return {};
  try {
    const response = await fetchImpl(`${WPS_ORIGIN}/api/v3/office/file/${token}/attachment/shapes`, {
      method: "POST",
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 Edg/132",
        origin: WPS_ORIGIN,
        accept: "application/json",
        "content-type": "application/json;charset=UTF-8",
        referer: `${WPS_ORIGIN}/l/${token}`,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({ objects: sourceKeys.map((key) => ({ attachment_id: key, max_edge: 1180, source: "" })) }),
    });
    const payload = await responseJson(response);
    const data = payload?.data || {};
    const map = {};
    for (const [key, value] of Object.entries(data)) if (value?.url) map[key] = value.url;
    return map;
  } catch (_) { return {}; }
}

// 文档元信息:GET /api/v3/office/file/{token} → {file:{name,create_time,creator:{name}}}
async function fetchFileInfo(token, cookie, fetchImpl) {
  try {
    const response = await fetchImpl(`${WPS_ORIGIN}/api/v3/office/file/${token}`, {
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 Edg/132",
        origin: WPS_ORIGIN,
        accept: "application/json",
        referer: `${WPS_ORIGIN}/l/${token}`,
        ...(cookie ? { cookie } : {}),
      },
    });
    const file = (await responseJson(response))?.file || {};
    const publishedAt = Number(file.create_time) > 0 ? localIso(new Date(Number(file.create_time) * 1000)) : "";
    return { author: file.creator?.name || "", publishedAt, title: file.name || "" };
  } catch (_) { return { author: "", publishedAt: "", title: "" }; }
}

async function extractWpsDoc(url, { collectSessionCookies, fetchImpl = globalThis.fetch } = {}) {
  const token = wpsDocToken(url);
  if (!token) throw wpsError("无法从链接解析 WPS 文档 token", "WPS_DOCS_INVALID_URL");
  const cookie = collectSessionCookies ? await collectSessionCookies("wps", `${WPS_ORIGIN}/`) : "";
  const { url: otlUrl, init } = otlRequest(token, cookie);
  const response = await fetchImpl(otlUrl, init);
  const status = Number(response.status);
  if (!(status >= 200 && status < 300)) {
    throw wpsError(`WPS open/otl 返回 HTTP ${status}(私有文档需先在「浏览器会话」面板登录 WPS)`, "WPS_DOCS_UNREACHABLE");
  }
  const otl = await responseJson(response);
  const pictureKeys = collectPictureKeys(otl);
  const [imageUrls, meta] = await Promise.all([
    pictureKeys.length ? fetchShapeUrls(token, cookie, pictureKeys, fetchImpl) : {},
    fetchFileInfo(token, cookie, fetchImpl),
  ]);
  const markdown = otlToMarkdown(otl, imageUrls);
  if (!markdown.trim()) throw wpsError("WPS OTL 数据为空", "WPS_DOCS_EMPTY");
  return {
    title: otlTitle(otl) || meta.title || token,
    markdown,
    author: meta.author,
    publishedAt: meta.publishedAt,
    extractionMethod: "wps-otl",
    images: Object.values(imageUrls),
    imageHeaders: cookie ? { cookie } : undefined,
  };
}

module.exports = { extractWpsDoc, otlToMarkdown, otlTitle, wpsDocToken, applyMarks };
