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

// 飞书文档 token(docx/wiki 路径)
function feishuDocToken(url) {
  return (String(url || "").match(/\/(?:docx|wiki)\/([A-Za-z0-9]+)/) || [])[1] || "";
}

// 页面上下文读取内存块数据的表达式:_clientvarMap[token] 是 JSON 字符串,原样带回。
function feishuBlockMapExpression(token) {
  return `(() => {
    try {
      const m = window.docxClientvarFetchManager;
      const map = m && m._clientvarMap;
      if (!map) return "";
      const entry = map instanceof Map ? map.get(${JSON.stringify(token)}) : map[${JSON.stringify(token)}];
      if (!entry) return "";
      return typeof entry === "string" ? entry : JSON.stringify(entry);
    } catch (_) { return ""; }
  })()`;
}

// 飞书富文本:文本存 initialAttributedTexts.text["0"](纯串,含 \n),
// 行内样式存 attribs["0"](etherpad changeset:段 (*idx)*(|line)?+len36,*idx 引用 apool.numToAttrib)。
// 实测出现的属性:author(忽略)/bold/inlineCode。
function feishuRichText(textObj) {
  const iat = textObj?.initialAttributedTexts;
  const content = iat?.text?.["0"];
  if (typeof content !== "string") return "";
  const attribStr = iat?.attribs?.["0"] || "";
  const pool = textObj?.apool?.numToAttrib || {};
  if (!attribStr) return content;
  let out = "";
  let pos = 0;
  const re = /((?:\*[0-9a-z]+)*)(?:\|[0-9a-z]+)?\+([0-9a-z]+)/g;
  let m;
  while ((m = re.exec(attribStr))) {
    const kinds = (m[1].match(/\*([0-9a-z]+)/g) || []).map((x) => pool[parseInt(x.slice(1), 36)]?.[0]);
    const len = parseInt(m[2], 36);
    let chunk = content.slice(pos, pos + len);
    pos += len;
    if (chunk) {
      if (kinds.includes("inlineCode")) chunk = "`" + chunk + "`";
      if (kinds.includes("bold")) chunk = "**" + chunk + "**";
    }
    out += chunk;
  }
  return out + content.slice(pos);
}

function feishuTableMarkdown(blocks, data) {
  const rows = data.rows_id || [];
  const cols = data.columns_id || [];
  const cellSet = data.cell_set || {};
  const cellText = (rowId, colId) => {
    const cell = cellSet[rowId + colId];
    const cellBlock = cell && blocks[cell.block_id];
    if (!cellBlock?.data?.children?.length) return "";
    return cellBlock.data.children
      .map((cid) => feishuRichText(blocks[cid]?.data?.text))
      .join(" ").replace(/\n+/g, " ").replace(/\|/g, "\\|").trim();
  };
  const lines = [];
  rows.forEach((rowId, ri) => {
    lines.push("| " + cols.map((colId) => cellText(rowId, colId)).join(" | ") + " |");
    if (ri === 0) lines.push("| " + cols.map(() => "---").join(" | ") + " |");
  });
  return lines.length ? `\n\n${lines.join("\n")}\n\n` : "";
}

// 飞书内存块数据 → Markdown:page.children 树序遍历,与官方 docx blocks 同构。
// 未知块类型降级:有文本出文本,否则递归子块,不丢行。
function blockMapToMarkdown(clientvarRaw) {
  let inner;
  try { inner = typeof clientvarRaw === "string" ? JSON.parse(clientvarRaw) : clientvarRaw; }
  catch (_) { return ""; }
  const blocks = inner?.data?.block_map;
  if (!blocks || typeof blocks !== "object") return "";
  const rootId = Object.keys(blocks).find((id) => blocks[id]?.data?.type === "page");
  const root = rootId && blocks[rootId];
  if (!root?.data?.children?.length) return "";
  const lines = [];
  const emit = (tokenId, depth) => {
    const block = blocks[tokenId];
    if (!block?.data) return;
    const data = block.data;
    const type = String(data.type || "");
    const kids = data.children || [];
    const text = feishuRichText(data.text);
    const headingMatch = type.match(/^heading([1-9])$/);
    if (headingMatch) {
      lines.push(`\n\n${"#".repeat(Math.min(6, Number(headingMatch[1]) + 1))} ${text.trim()}\n\n`);
    } else if (type === "text") {
      if (text.trim()) lines.push(`\n\n${text.trim()}\n\n`);
    } else if (type === "bullet") {
      lines.push(`${"  ".repeat(depth)}- ${text.trim()}\n`);
    } else if (type === "ordered") {
      lines.push(`${"  ".repeat(depth)}1. ${text.trim()}\n`);
    } else if (type === "code") {
      const lang = data.language && data.language !== "Plain Text" ? String(data.language).toLowerCase() : "";
      lines.push(`\n\n\`\`\`${lang}\n${(data.text?.initialAttributedTexts?.text?.["0"] || "").replace(/\n$/, "")}\n\`\`\`\n\n`);
    } else if (type === "quote" || type === "quote_container") {
      const body = text.trim() || kids.map((k) => feishuRichText(blocks[k]?.data?.text)).join("\n").trim();
      lines.push(`\n\n${body.split("\n").map((l) => `> ${l}`).join("\n")}\n\n`);
    } else if (type === "divider") {
      lines.push("\n\n---\n\n");
    } else if (type === "image") {
      lines.push(`\n\n![](<${data.image?.token ? feishuImageUrl(data.image.token) : ""}>)\n\n`);
    } else if (type === "table") {
      lines.push(feishuTableMarkdown(blocks, data));
    } else if (type === "callout" || type === "page") {
      kids.forEach((k) => emit(k, depth));
    } else {
      // 未知类型:先出自身文本,再递归子块
      if (text.trim()) lines.push(`\n\n${text.trim()}\n\n`);
      else kids.forEach((k) => emit(k, depth));
    }
    // 列表允许嵌套子项
    if (type === "bullet" || type === "ordered") kids.forEach((k) => emit(k, depth + 1));
  };
  root.data.children.forEach((k) => emit(k, 0));
  return lines.join("").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// 飞书图片下载地址(以云盘 medias 下载端点为准),需会话 cookie。
function feishuImageUrl(token) {
  return `https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/all/${token}`;
}

async function extractFeishuDoc(url, { webSessionManager, collectSessionCookies, captureTimeoutMs } = {}) {
  const token = feishuDocToken(url);
  const rendered = await webSessionManager.extract(url, "feishu", {
    captureTimeoutMs,
    extraEvaluate: token ? feishuBlockMapExpression(token) : "",
  });
  const publishedTime = typeof rendered.publishedTime === "string"
    ? normalizeFeishuPublishedTime(rendered.publishedTime)
    : rendered.publishedTime;
  const normalized = publishedTime ? { ...rendered, publishedTime } : rendered;
  const cookie = collectSessionCookies ? await collectSessionCookies("feishu", "https://my.feishu.cn/") : "";
  const withCookie = cookie ? { ...normalized, imageHeaders: { cookie } } : normalized;
  // 内存块数据直取:成功则以结构化 Markdown 覆盖正文,失败/为空维持渲染提取(兜底)
  const blockMarkdown = rendered.extraValue ? blockMapToMarkdown(rendered.extraValue) : "";
  if (blockMarkdown.trim()) {
    return { ...withCookie, markdown: blockMarkdown, extractionMethod: "feishu-block-map" };
  }
  return { ...withCookie, extractionMethod: "feishu-dom" };
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
  // 作者:owner/creator 可能是字符串名字,也可能是嵌套对象({name/userName});纯 ID 拿不到名字时置空
  let author = "";
  const ownerNode = pickFeishuMetaValue(payload, (key, value) => /^(owner|creator|author)$/i.test(key) && value !== "" && value != null);
  if (typeof ownerNode === "string") {
    author = ownerNode.trim();
  } else if (ownerNode && typeof ownerNode === "object") {
    const ownerName = pickFeishuMetaValue(ownerNode, (key, value) =>
      /^(name|user_?name|nick_?name|nickname)$/i.test(key) && typeof value === "string" && value.trim());
    author = ownerName ? String(ownerName).trim() : "";
  }
  if (!author) {
    const hit = pickFeishuMetaValue(payload, (key, value) =>
      typeof value === "string" && /(owner_?name|creator_?name|author|user_?name|nick_?name)$/i.test(key)
      && !/(^id$|_?id$|key|token)$/i.test(key) && value.trim());
    author = hit ? String(hit).trim() : "";
  }
  return { name, version, publishedAt, author };
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
    author: meta.author,
  };
}

module.exports = { extractFeishuDoc, normalizeFeishuPublishedTime, isFeishuFileUrl, extractFeishuFile, blockMapToMarkdown, feishuRichText };
