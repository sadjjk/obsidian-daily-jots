"use strict";

const { Readability } = require("@mozilla/readability");
const { parseHTML } = require("linkedom");
const { extractCommunityPost } = require("./social-media/communityclip");
const { decodeHtmlBuffer, downloadRemoteFile, readLimitedBody, safeFetch } = require("../core/network");
const { localDateParts, localIso, safeFileName, shortHash, yamlString } = require("../core/util");
const { extractRedditPost, parseRedditUrl } = require("./social-media/redditclip");
const { COMMUNITY_SERVICES, DOCUMENT_SERVICES, communityServiceForUrl, documentServiceForUrl, isLikelyPdfUrl, renderServiceForUrl } = require("./lib/web-platforms");
const { extractDingtalkDoc } = require("./cloud-docs/dingtalk-docs");
const { extractFeishuDoc, extractFeishuFile, isFeishuFileUrl } = require("./cloud-docs/feishu-docs");
const { extractTencentDoc, stripTencentChrome, tencentHostForUrl, tencentSiteNameForUrl } = require("./cloud-docs/tencent-docs");
const { extractWecomDoc } = require("./cloud-docs/wecom-docs");
const { extractWpsDoc, fetchFileInfo, wpsDocToken } = require("./cloud-docs/wps-docs");
const { extractXStatus } = require("./social-media/xclip");
const { extractBilibili, isBilibiliUrl, isBilibiliVideoUrl } = require("./social-media/biliclip");
const { extractXiaohongshu, isXiaohongshuUrl, isXhsNoteUrl } = require("./social-media/xhsclip");
const { extractZhihu, isZhihuNoteUrl, isZhihuUrl } = require("./social-media/zhihuclip");
const { extractWeibo, isWeiboArticleUrl, isWeiboSearchUrl, isWeiboStatusUrl } = require("./social-media/weiboclip");
const { extractWeixinArticle, isWeixinArticleUrl } = require("./social-media/weixinclip");
const { extractDouyin, isDouyinUrl } = require("./social-media/douyinclip");
const { sourceNameForUrl } = require("./lib/source-names");
const { classifyClipFamily, isClipFamilyEnabled, resolveClipFolder } = require("./lib/clip-rules");

const WECHAT_NOISE_SELECTORS = [
  "#js_pc_qr_code", "#js_article_bottom_bar", "#js_bottom_ad_area", "#js_sponsor_ad_area",
  ".rich_media_tool", ".rich_media_area_extra", ".weui-dialog", ".weui-mask", ".qr_code_pc",
  "[aria-label='二维码']", "[aria-label='QR code']",
];

const TRACKING_QUERY_NAMES = new Set([
  "fbclid", "gclid", "mc_cid", "mc_eid", "ref_src", "spm", "source", "igshid",
]);

const WECHAT_TRANSIENT_QUERY_NAMES = new Set([
  "chksm", "scene", "nwr_flag", "subscene", "clicktime", "enterid", "ascene", "devicetype",
  "version", "lang", "nettype", "exportkey", "pass_ticket", "wx_header", "from",
]);

function absoluteUrl(value, baseUrl) {
  if (!value) return "";
  try { return new URL(value, baseUrl).toString(); } catch (_) { return ""; }
}

function bestSrcset(value) {
  const entries = String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!entries.length) return "";
  return entries[entries.length - 1].split(/\s+/)[0];
}

function prepareDocument(document, url) {
  for (const element of document.querySelectorAll("script,style,noscript,template")) element.remove();
  let hostname = "";
  try { hostname = new URL(url).hostname.toLowerCase(); } catch (_) {}
  if (hostname === "mp.weixin.qq.com") {
    for (const selector of WECHAT_NOISE_SELECTORS) {
      for (const element of document.querySelectorAll(selector)) element.remove();
    }
  }
  for (const image of document.querySelectorAll("img")) {
    const candidate = image.getAttribute("data-src") || image.getAttribute("data-original")
      || image.getAttribute("data-lazy-src") || bestSrcset(image.getAttribute("data-srcset") || image.getAttribute("srcset"))
      || image.getAttribute("src");
    const resolved = absoluteUrl(candidate, url);
    if (resolved) image.setAttribute("src", resolved);
  }
  for (const anchor of document.querySelectorAll("a[href]")) {
    const resolved = absoluteUrl(anchor.getAttribute("href"), url);
    if (resolved) anchor.setAttribute("href", resolved);
  }
}

function escapeWebText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([`*_{}[\]()#+\-.!|~])/g, "\\$1")
    .replace(/%/g, "\\%");
}

function markdownDestination(value) {
  return String(value || "").replace(/>/g, "%3E").replace(/\s/g, (character) => encodeURIComponent(character));
}

function inlineCode(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "``";
  const runs = [...text.matchAll(/`+/g)].map((match) => match[0].length);
  const fence = "`".repeat(Math.max(1, ...runs, 0) + 1);
  const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${padding}${text}${padding}${fence}`;
}

function fencedCode(value) {
  const text = String(value || "").replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "");
  const runs = [...text.matchAll(/`{3,}/g)].map((match) => match[0].length);
  const fence = "`".repeat(Math.max(3, ...runs, 2) + 1);
  return `\n\n${fence}\n${text}\n${fence}\n\n`;
}

function directListItems(node) {
  return [...node.childNodes].filter((child) => child.nodeType === 1 && String(child.localName || "").toLowerCase() === "li");
}

function listToMarkdown(node, context = {}) {
  const depth = Math.max(0, Number(context.listDepth) || 0);
  const ordered = String(node.localName || "").toLowerCase() === "ol";
  const start = Math.max(1, Number(node.getAttribute?.("start")) || 1);
  const rows = [];
  directListItems(node).forEach((item, index) => {
    const nested = [];
    const body = [...item.childNodes].map((child) => {
      const tag = child.nodeType === 1 ? String(child.localName || "").toLowerCase() : "";
      if (tag === "ul" || tag === "ol") {
        nested.push(child);
        return "";
      }
      return nodeToMarkdown(child, { ...context, listDepth: depth });
    }).join("").replace(/\s*\n+\s*/g, " ").trim();
    const marker = ordered ? `${start + index}.` : "-";
    rows.push(`${"  ".repeat(depth)}${marker} ${body}`.trimEnd());
    for (const child of nested) {
      rows.push(nodeToMarkdown(child, { ...context, listDepth: depth + 1 }).replace(/^\n|\n$/g, ""));
    }
  });
  return `\n${rows.join("\n")}\n`;
}

function isLikelyContentImage(image) {
  const src = image.getAttribute("src") || "";
  // data URI SVG 是界面图标(面包屑/箭头等),不是文章内容图
  if (/^data:image\/svg/i.test(src)) return false;
  const width = Number(image.getAttribute("width") || 0);
  const height = Number(image.getAttribute("height") || 0);
  if (width > 0 && height > 0 && width <= 80 && height <= 80) return false;
  if (/\b(spacer|tracking[-_]?pixel|transparent\.gif)\b/i.test(src)) return false;
  const thumbnail = src.match(/\/(\d{1,3})px-[^/?]*(?:logo|icon|avatar|emoji)/i);
  if (thumbnail && Number(thumbnail[1]) <= 96) return false;
  return true;
}

function nodeToMarkdown(node, context = {}) {
  if (!node) return "";
  if (node.nodeType === 3) return escapeWebText(String(node.nodeValue || "").replace(/\s+/g, " "));
  if (node.nodeType !== 1) return "";
  const tag = String(node.localName || "").toLowerCase();
  if (["script", "style", "noscript", "svg"].includes(tag)) return "";
  if (tag === "pre") return fencedCode(node.textContent || "");
  if (tag === "ul" || tag === "ol") return listToMarkdown(node, context);
  const content = [...node.childNodes].map((child) => nodeToMarkdown(child, context)).join("");
  const blockType = String(node.getAttribute?.("data-block-type") || "").toLowerCase();
  if (blockType === "code") {
    // 飞书代码块:容器内逐行收集,textContent 原样保留缩进与换行,不过空白压缩
    const lineNodes = [...node.querySelectorAll('[data-block-type="code_line"], .code-line')];
    let body = lineNodes.length
      ? lineNodes.map((line) => line.textContent || "").join("\n")
      : String(node.textContent || "");
    body = body.replace(/\r\n?/g, "\n");
    if (!lineNodes.length) {
      // 飞书实际渲染无行元素:工具栏文案("代码块{语言}自动换行复制")混在文本里,
      // 且行间以 U+200B 零宽字符分隔——剥文案、按零宽还原行
      body = body.replace(/代码块\u200B?[^\n]*?自动换行复制/g, "");
      body = body.split("\u200B").map((line) => line.replace(/[ \t]+$/g, "")).join("\n");
    }
    body = body.replace(/^\n+|\n+$/g, "");
    return body.trim() ? fencedCode(body) : "";
  }
  if (blockType === "code_line") return ""; // 由 code 容器统一收集,避免行内容重复
  const feishuHeading = blockType.match(/^heading([1-6])$/);
  if (feishuHeading) return `\n\n${"#".repeat(Number(feishuHeading[1]) + 1)} ${content.trim()}\n\n`;
  if (blockType === "bullet") {
    const body = content.trim().replace(/^[•·◦▪‣-]\s*/, "");
    return body ? `\n- ${body}\n` : "";
  }
  if (blockType === "ordered") {
    const body = content.trim().replace(/^\d+(?:\\[.)、]|[.)、])?\s*/, "");
    return body ? `\n1. ${body}\n` : "";
  }
  if (blockType === "quote" || blockType === "quote_container") {
    return `\n\n${content.trim().split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
  }
  if (blockType === "divider") return "\n\n---\n\n";
  if (tag === "br") return "\n";
  if (tag === "p" || tag === "div" || tag === "section" || tag === "article") return `\n\n${content.trim()}\n\n`;
  if (/^h[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag[1]) + 1)} ${content.trim()}\n\n`;
  if (tag === "strong" || tag === "b") return `**${content.trim()}**`;
  if (tag === "em" || tag === "i") return `*${content.trim()}*`;
  if (tag === "code") return inlineCode(node.textContent || "");
  if (tag === "blockquote") return `\n\n${content.trim().split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
  if (tag === "li") return content;
  if (tag === "a") {
    const href = node.getAttribute("href") || "";
    return href ? `[${content.trim() || escapeWebText(href)}](<${markdownDestination(href)}>)` : content;
  }
  if (tag === "img") {
    const src = node.getAttribute("src") || "";
    const alt = escapeWebText(node.getAttribute("alt") || "");
    return src ? `\n\n![${alt}](<${markdownDestination(src)}>)\n\n` : "";
  }
  return content;
}

function cleanMarkdown(value) {
  const output = [];
  let fenceCharacter = "";
  let fenceLength = 0;
  let previousBlank = false;
  for (const originalLine of String(value || "").replace(/\r\n?/g, "\n").split("\n")) {
    const line = fenceCharacter ? originalLine : originalLine.replace(/[ \t]+$/g, "");
    const opening = !fenceCharacter && line.match(/^\s*(`{3,}|~{3,})(?:\s|$)/);
    if (opening) {
      fenceCharacter = opening[1][0];
      fenceLength = opening[1].length;
      output.push(line);
      previousBlank = false;
      continue;
    }
    if (fenceCharacter) {
      output.push(line);
      const closing = line.match(/^\s*(`+|~+)\s*$/);
      if (closing && closing[1][0] === fenceCharacter && closing[1].length >= fenceLength) {
        fenceCharacter = "";
        fenceLength = 0;
      }
      continue;
    }
    if (!line.trim()) {
      if (!previousBlank && output.length) output.push("");
      previousBlank = true;
    } else {
      output.push(line);
      previousBlank = false;
    }
  }
  return output.join("\n").trim();
}

function normalizedText(node) {
  return String(node?.textContent || "").replace(/\s+/g, " ").trim();
}

function metaContent(document, selector) {
  return String(document.querySelector(selector)?.getAttribute("content") || "").trim();
}

function compactTitle(value, fallback = "Untitled web page") {
  const title = String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return (title || fallback).slice(0, 300);
}

function normalizedIdentityUrl(value, extraIgnored = new Set()) {
  try {
    const parsed = new URL(value);
    parsed.hash = "";
    for (const name of [...parsed.searchParams.keys()]) {
      if (/^utm_/i.test(name) || TRACKING_QUERY_NAMES.has(name.toLowerCase()) || extraIgnored.has(name.toLowerCase())) parsed.searchParams.delete(name);
    }
    const ordered = [...parsed.searchParams.entries()].sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
    parsed.search = "";
    for (const [name, item] of ordered) parsed.searchParams.append(name, item);
    return parsed.toString();
  } catch (_) {
    return String(value || "");
  }
}

function declaredWechatValue(html, name, validator) {
  const pattern = new RegExp(`(?:^|[;{}>\\n])\\s*var\\s+${name}\\s*=\\s*([^;\\n]+)`, "gim");
  for (const declaration of String(html || "").matchAll(pattern)) {
    for (const literal of declaration[1].matchAll(/(["'])(.*?)\1/g)) {
      const candidate = String(literal[2] || "").trim();
      if (validator(candidate)) return candidate;
    }
  }
  return "";
}

function validWechatBiz(value) {
  return /^[A-Za-z0-9+/_-]{4,128}={0,2}$/.test(String(value || ""));
}

function validWechatNumber(value) {
  return /^\d{1,30}$/.test(String(value || ""));
}

function wechatArticleIdentityUrl(html, sourceUrl, canonicalUrl = "") {
  const candidates = [];
  for (const value of [sourceUrl, canonicalUrl]) {
    try {
      const parsed = new URL(value);
      if (parsed.hostname.toLowerCase() === "mp.weixin.qq.com") candidates.push(parsed);
    } catch (_) {}
  }
  for (const parsed of candidates) {
    const biz = parsed.searchParams.get("__biz") || "";
    const mid = parsed.searchParams.get("mid") || "";
    const idx = parsed.searchParams.get("idx") || "";
    if (validWechatBiz(biz) && validWechatNumber(mid) && validWechatNumber(idx)) {
      const stable = new URL("https://mp.weixin.qq.com/s");
      stable.searchParams.set("__biz", biz);
      stable.searchParams.set("mid", mid);
      stable.searchParams.set("idx", idx);
      return stable.toString();
    }
  }
  const biz = declaredWechatValue(html, "biz", validWechatBiz);
  const mid = declaredWechatValue(html, "mid", validWechatNumber);
  const idx = declaredWechatValue(html, "idx", validWechatNumber);
  if (biz && mid && idx) {
    const stable = new URL("https://mp.weixin.qq.com/s");
    stable.searchParams.set("__biz", biz);
    stable.searchParams.set("mid", mid);
    stable.searchParams.set("idx", idx);
    return stable.toString();
  }
  for (const parsed of candidates) {
    const shortId = parsed.pathname.match(/^\/s\/([^/]+)\/?$/)?.[1];
    if (shortId) return `https://mp.weixin.qq.com/s/${encodeURIComponent(decodeURIComponent(shortId))}`;
  }
  return normalizedIdentityUrl(canonicalUrl || sourceUrl, WECHAT_TRANSIENT_QUERY_NAMES);
}

function publishedWechatTime(html) {
  for (const name of ["createTime", "create_time", "publish_time", "ct"]) {
    const quoted = declaredWechatValue(html, name, (candidate) => /^\d{10,13}$/.test(candidate));
    const numericPattern = new RegExp(`(?:^|[;{}>\\n])\\s*var\\s+${name}\\s*=\\s*(\\d{10,13})(?:\\D|$)`, "im");
    const value = quoted || numericPattern.exec(String(html || ""))?.[1] || "";
    if (!value) continue;
    const number = Number(value);
    const date = new Date(value.length === 13 ? number : number * 1000);
    if (!Number.isNaN(date.getTime())) return localIso(date);
  }
  return "";
}

function canonicalUrlFromDocument(document, finalUrl) {
  const raw = document.querySelector('link[rel="canonical"]')?.getAttribute("href")
    || metaContent(document, 'meta[property="og:url"]');
  return absoluteUrl(raw, finalUrl) || finalUrl;
}

const GENERIC_COMMENT_SELECTORS = [
  "[itemprop='comment']", "[data-testid*='comment' i]", ".topic-post", ".comment-item", ".feedbackItem", ".CommentItem", ".comment", ".reply", ".answer",
];

function genericCommentNodes(document) {
  for (const selector of GENERIC_COMMENT_SELECTORS) {
    let nodes = [];
    try { nodes = [...document.querySelectorAll(selector)].filter((node) => normalizedText(node).length >= 12); } catch (_) {}
    if (nodes.length) return nodes.slice(0, 300);
  }
  return [];
}

function detectCommunityPage(html, finalUrl) {
  const { document } = parseHTML(html);
  const generator = metaContent(document, 'meta[name="generator"]').toLowerCase();
  if (/discourse|forem|question2answer|flarum|nodebb|vanilla forums|xenforo/.test(generator)) return true;
  let pathname = "";
  try { pathname = new URL(finalUrl).pathname; } catch (_) {}
  if (/\/(?:t|topic|discussion|questions?)\/[^/]*\d+/i.test(pathname)) return true;
  return genericCommentNodes(document).length > 0;
}

function selectArticle(document, finalUrl) {
  const hostname = new URL(finalUrl).hostname.toLowerCase();
  const wechatContent = hostname === "mp.weixin.qq.com" ? document.querySelector("#js_content") : null;
  if (wechatContent && normalizedText(wechatContent).length >= 40) {
    const title = normalizedText(document.querySelector("#activity-name"))
      || metaContent(document, 'meta[property="og:title"]')
      || document.title
      || hostname;
    const byline = normalizedText(document.querySelector("#js_author_name"))
      || metaContent(document, 'meta[name="author"]');
    const siteName = normalizedText(document.querySelector("#js_name")) || "微信公众号";
    const plainText = normalizedText(wechatContent);
    return {
      title: compactTitle(title, hostname),
      byline,
      excerpt: metaContent(document, 'meta[property="og:description"]') || plainText.slice(0, 240),
      siteName,
      content: wechatContent.innerHTML,
      extractionMethod: "wechat-article",
    };
  }
  // Some pages (bilibili video pages with huge inline JSON and custom elements)
  // crash the Readability/linkedom internals with null references; degrade to a
  // document-body extract instead of failing the whole capture.
  let article = null;
  try { article = new Readability(document.cloneNode(true), { charThreshold: 40 }).parse(); } catch (_) { article = null; }
  return {
    title: compactTitle(article?.title || document.title, hostname),
    byline: article?.byline || "",
    excerpt: article?.excerpt || "",
    siteName: article?.siteName || hostname,
    content: article?.content || document.body?.innerHTML || "",
    extractionMethod: article?.content ? "readability" : "document-body",
  };
}

function articleFromHtml(html, finalUrl, overrides = {}) {
  const rawHtml = String(html || "");
  const { document } = parseHTML(html);
  const canonicalUrl = canonicalUrlFromDocument(document, finalUrl);
  try { prepareDocument(document, finalUrl); } catch (_) { /* keep the raw document when rewriting fails */ }
  const article = overrides.content !== undefined ? overrides : { ...selectArticle(document, finalUrl), ...overrides };
  let sourceHtml = article.content !== undefined ? article.content : document.body?.innerHTML || "";
  let commentCount = Number(article.commentCount) || 0;
  if (overrides.content === undefined) {
    let articleText = "";
    try { articleText = normalizedText(parseHTML(`<body>${sourceHtml}</body>`).document.body); } catch (_) { /* comment detection degrades */ }
    const comments = genericCommentNodes(document).filter((node) => {
      const sample = normalizedText(node).slice(0, 100);
      return sample && !articleText.includes(sample);
    });
    if (comments.length) {
      sourceHtml += `<section class="community-comments"><h2>Comments (${comments.length})</h2>${comments.map((node, index) => `<article><h3>Comment ${index + 1}</h3>${node.outerHTML}</article>`).join("")}</section>`;
      commentCount = comments.length;
      article.extractionMethod = `${article.extractionMethod || "readability"}-with-comments`;
    }
  }
  let articleDocument = document;
  try {
    articleDocument = parseHTML(`<!doctype html><html><head></head><body>${sourceHtml}</body></html>`).document;
    prepareDocument(articleDocument, finalUrl);
  } catch (_) { /* fall back to the already-parsed document */ }
  for (const image of articleDocument.querySelectorAll("img[src]")) {
    if (!isLikelyContentImage(image)) image.remove();
  }
  const images = [...articleDocument.querySelectorAll("img[src]")]
    .map((image) => image.getAttribute("src"))
    .filter((value) => /^(?:https?:|data:)/i.test(value || ""));
  const converted = cleanMarkdown(nodeToMarkdown(articleDocument.body));
  const fallbackText = cleanMarkdown(overrides.plainText || "");
  const markdown = converted.length >= Math.min(120, fallbackText.length) ? converted : fallbackText;
  const contentChars = (fallbackText || normalizedText(articleDocument.body)).length;
  const hostname = new URL(finalUrl).hostname;
  return {
    url: finalUrl,
    canonicalUrl,
    identityUrl: hostname.toLowerCase() === "mp.weixin.qq.com"
      ? wechatArticleIdentityUrl(rawHtml, finalUrl, canonicalUrl)
      : normalizedIdentityUrl(canonicalUrl || finalUrl),
    title: compactTitle(article.title || document.title, hostname),
    byline: article.byline || "",
    excerpt: article.excerpt || fallbackText.slice(0, 240),
    siteName: article.siteName || hostname,
    markdown,
    images: [...new Set(images)],
    contentChars,
    extractionMethod: article.extractionMethod || "rendered-page",
    extractionStatus: contentChars >= 120 ? "complete" : "partial",
    // 数据侧显式声明"本来就没有正文文字"(如小红书纯图笔记),收据文案据此省略"正文"
    textless: Boolean(article.textless),
    commentCount,
    publishedAt: article.publishedAt || (hostname.toLowerCase() === "mp.weixin.qq.com" ? publishedWechatTime(rawHtml) : ""),
  };
}

function deadlinePromise(promise, deadline, message) {
  const remaining = Number(deadline) - Date.now();
  if (!Number.isFinite(remaining) || remaining > 2_147_000_000) return promise;
  if (remaining <= 0) return Promise.reject(new Error(message));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), remaining);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function mapWithConcurrency(items, concurrency, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, run));
  return output;
}

class WebClipper {
  constructor(writer, settings, options = {}) {
    this.writer = writer;
    this.settings = settings;
    this.sessionManager = options.sessionManager;
    this.download = options.download || downloadRemoteFile;
    this.fetch = options.fetch || safeFetch;
  }

  collectSessionCookies(service, warmupUrl) {
    if (!this.sessionManager || typeof this.sessionManager.collectCookies !== "function") return Promise.resolve("");
    // 每个服务的硬门槛 cookie 不同:知乎是短时效 __zse_ck(403 唯一关键),
    // 微博是访客票据 SUB(432 唯一关键),微信无硬门槛(cookie 全带上即可,
    // cooldown 风控靠游客会话缓解)。requiredCookie 只指向短时效票,
    // 常驻长时效 cookie(d_c0/SUBP)作判据会让刷新永不发生。
    const required = service === "weibo" ? "SUB" : service === "zhihu" ? "__zse_ck" : undefined;
    const fallback = service === "weibo" || service === "weixin" ? undefined : "https://www.zhihu.com/explore";
    return this.sessionManager.collectCookies(service, warmupUrl, {
      requiredCookie: required,
      fallbackUrl: fallback,
    }).catch(() => "");
  }

  async extract(url) {
    const xStatus = await extractXStatus(url);
    if (xStatus) return xStatus;
    let xiaohongshuError;
    if (isXiaohongshuUrl(url)) {
      try {
        const data = await extractXiaohongshu(url, this.fetch);
        if (data) {
          const article = articleFromHtml(data.contentHtml, data.url || url, {
            title: data.title,
            byline: data.byline,
            excerpt: data.excerpt,
            siteName: data.siteName,
            content: data.contentHtml,
            plainText: data.plainText,
            extractionMethod: data.extractionMethod,
          });
          return {
            ...article,
            canonicalUrl: data.canonicalUrl,
            identityUrl: data.identityUrl,
            images: data.images,
            publishedAt: data.publishedAt,
            extractionStatus: data.extractionStatus,
          };
        }
      } catch (error) { xiaohongshuError = error; }
      // 小红书笔记页不需要登录:HTTP 提取失败时抛真实原因,
      // 不再回退到隔离浏览器会话(未登录只报中文登录引导)。
      if (isXhsNoteUrl(url) && xiaohongshuError) throw xiaohongshuError;
    }
    let zhihuError;
    if (isZhihuUrl(url)) {
      try {
        const data = await extractZhihu(url, this.fetch, (target) => this.collectSessionCookies("zhihu", target));
        if (data) {
          const article = articleFromHtml(data.contentHtml, data.url || url, {
            title: data.title,
            byline: data.byline,
            excerpt: data.excerpt,
            siteName: data.siteName,
            content: data.contentHtml,
            plainText: data.plainText,
            extractionMethod: data.extractionMethod,
          });
          return {
            ...article,
            canonicalUrl: data.canonicalUrl,
            identityUrl: data.identityUrl,
            images: data.images,
            publishedAt: data.publishedAt,
            extractionStatus: data.extractionStatus,
          };
        }
      } catch (error) { zhihuError = error; }
      // 知乎失败时保留浏览器会话回退(登录用户的隔离会话仍有价值)。
    }
    let weixinError;
    if (isWeixinArticleUrl(url)) {
      try {
        const data = await extractWeixinArticle(url, this.fetch, (target) => this.collectSessionCookies("weixin", target));
        if (data) {
          const article = articleFromHtml(data.contentHtml, data.url || url, {
            title: data.title,
            byline: data.byline,
            excerpt: data.title,
            siteName: data.siteName,
            content: data.contentHtml,
            extractionMethod: data.extractionMethod,
          });
          return {
            ...article,
            canonicalUrl: data.canonicalUrl,
            identityUrl: data.identityUrl,
            images: data.images,
            extractionStatus: data.extractionStatus,
          };
        }
      } catch (error) {
        // 微信失败没有 HTML 回退价值(冷却页/结构变化),直接抛真实原因。
        weixinError = error;
        throw weixinError;
      }
    }
    if (isWeiboSearchUrl(url) || isWeiboStatusUrl(url) || isWeiboArticleUrl(url)) {
      try {
        const data = await extractWeibo(url, this.fetch, (target) => this.collectSessionCookies("weibo", target));
        if (data) {
          const article = articleFromHtml(data.contentHtml, data.url || url, {
            title: data.title,
            byline: data.byline,
            excerpt: data.title,
            siteName: data.siteName,
            content: data.contentHtml,
            extractionMethod: data.extractionMethod,
          });
          return {
            ...article,
            canonicalUrl: data.canonicalUrl,
            identityUrl: data.identityUrl,
            images: data.images,
            extractionStatus: data.extractionStatus,
          };
        }
      } catch (error) {
        // 微博搜索页没有可用的 HTML 回退(页面壳是游客墙),失败即抛真实原因。
        weiboError = error;
        throw weiboError;
      }
    }
    if (isDouyinUrl(url)) {
      try {
        const data = await extractDouyin(url, this.fetch);
        if (data) {
          const article = articleFromHtml(data.contentHtml, data.url || url, {
            title: data.title,
            byline: data.byline,
            excerpt: data.title,
            siteName: data.siteName,
            content: data.contentHtml,
            extractionMethod: data.extractionMethod,
          });
          return {
            ...article,
            canonicalUrl: data.canonicalUrl,
            identityUrl: data.identityUrl,
            images: data.images,
            extractionStatus: data.extractionStatus,
          };
        }
      } catch (error) {
        // 抖音无票请求是降级壳,没有 HTML 回退价值,失败即抛真实原因。
        throw error;
      }
    }
    let bilibiliError;
    if (isBilibiliUrl(url)) {
      try {
        const data = await extractBilibili(url, this.fetch);
        if (data) return data;
      } catch (error) { bilibiliError = error; }
      // 风控壳页重试后仍失败:抛真实原因,避免把空壳存成笔记。
      if (bilibiliError && isBilibiliVideoUrl(url)) throw bilibiliError;
    }
    let communityError;
    if (parseRedditUrl(url)) {
      try {
        const reddit = await extractRedditPost(url);
        if (reddit) return reddit;
      } catch (error) { communityError = error; }
    } else {
      try {
        const data = await extractCommunityPost(url);
        if (data) {
          const article = articleFromHtml(data.contentHtml, data.url || url, {
            title: data.title,
            byline: data.byline,
            excerpt: data.excerpt,
            siteName: data.siteName,
            content: data.contentHtml,
            extractionMethod: data.extractionMethod,
          });
          return { ...article, commentCount: data.commentCount || 0, extractionStatus: data.extractionStatus || article.extractionStatus };
        }
      } catch (error) { communityError = error; }
    }
    if (isFeishuFileUrl(url)) {
      // 飞书云盘文件:元信息拿真实文件名/version/创建时间,带会话头下载原文件,交给 binaryFiles 附件机制落盘
      const file = await extractFeishuFile(url, {
        collectSessionCookies: this.collectSessionCookies.bind(this),
        fetchImpl: async (target, init) => {
          const result = await this.fetch(target, init);
          return result && result.response !== undefined ? result.response : result;
        },
      });
      const downloadOnce = (streamUrl, fallbackName) => this.download(streamUrl, {
        headers: file.headers,
        accept: "application/json, text/plain, */*",
        maxBytes: Math.max(1, Number(this.settings.capture.maxFileMb) || 20) * 1024 * 1024,
        timeoutMs: 60_000,
        requestAttempts: 1,
        fileName: fallbackName,
      });
      let downloaded;
      try {
        downloaded = await downloadOnce(file.streamUrl, file.fallbackName);
      } catch (error) {
        // version 不被接受(404)时回退无 version 直试(实测可行)
        if (!file.fallbackStreamUrl || !/404/.test(error?.message || "")) throw error;
        downloaded = await downloadOnce(file.fallbackStreamUrl, url.match(/\/file\/([A-Za-z0-9]+)/)[1]);
      }
      const rawName = downloaded.fileName || "";
      // downloadRemoteFile 在 mime 推断失败时会补 .bin;meta 拿到的真实文件名(带扩展)优先
      const fileName = file.fallbackName.includes(".") ? file.fallbackName : (rawName || file.fallbackName);
      return {
        url,
        canonicalUrl: url,
        identityUrl: url,
        title: fileName,
        byline: file.author || "",
        excerpt: "飞书云盘文件,已作为附件保存",
        siteName: "飞书文档",
        markdown: "",
        images: [],
        contentChars: 0,
        extractionMethod: "feishu-file-attachment",
        extractionStatus: "complete",
        publishedAt: file.publishedAt || "",
        binaryFiles: [{ buffer: downloaded.buffer, fileName, mimeType: downloaded.mimeType }],
      };
    }
    if (tencentHostForUrl(url)) {
      // 腾讯文档/企微文档:优先 opendoc 接口拿全量正文(文本/格式/图片 URL,会话 cookie);
      // 新版 melo 内核把正文画在 canvas 上,渲染提取拿不到文本,接口路线是唯一文本来源。
      // 入口按 host 分流:企微文档走独立会话(wecomdoc profile,cookie 与腾讯文档互不共享)
      try {
        const extractor = tencentHostForUrl(url) === "doc.weixin.qq.com" ? extractWecomDoc : extractTencentDoc;
        const doc = await extractor(url, {
          collectSessionCookies: this.collectSessionCookies.bind(this),
          fetchImpl: async (target, init) => {
            const result = await this.fetch(target, init);
            return result && result.response !== undefined ? result.response : result;
          },
        });
        if (doc.markdown && doc.markdown.trim().length > 60) {
          return {
            url,
            canonicalUrl: url,
            identityUrl: url,
            title: doc.title || "云文档",
            byline: doc.author || "",
            excerpt: doc.markdown.replace(/\s+/g, " ").slice(0, 200),
            siteName: tencentSiteNameForUrl(url),
            markdown: doc.markdown,
            images: doc.images || [],
            // 图片 CDN 直连可能要求会话;cookie 从腾讯会话带来,downloadWebImages 下载时自动携带
            ...(doc.imageHeaders ? { imageHeaders: doc.imageHeaders } : {}),
            contentChars: doc.markdown.length,
            extractionMethod: "tencent-opendoc",
            extractionStatus: "complete",
            publishedAt: doc.publishedAt || "",
          };
        }
      } catch (_) {
        // 接口拿不到(无会话/结构变化/非文档页)一律回落渲染提取,不中断剪藏
      }
    }
    // WPS 登录跳转页(account.kdocs.cn/passport/singlesign?cb=真实文档URL):
    // 说明当前未登录 WPS,从 cb 提取真实链接,引导用户去「浏览器会话」面板登录,而非把登录页当正文剪藏
    if (/account\.kdocs\.cn\/passport\/singlesign/.test(url)) {
      let realUrl = "";
      try { realUrl = new URL(url).searchParams.get("cb") || ""; } catch (_) {}
      const error = new Error(
        `WPS文档页面需要登录:请先在「浏览器会话」面板打开「WPS文档」登录窗口完成登录,再重新剪藏${realUrl ? `(原始文档链接:${realUrl})` : ""}`,
      );
      error.code = "DOCUMENT_LOGIN_REQUIRED";
      throw error;
    }
    if (documentServiceForUrl(url) === "wps") {
      // WPS:优先 open/{suffix} 接口拿结构化正文(会话 cookie + office_type 选端点),失败回落 ProseMirror 渲染
      try {
        const doc = await extractWpsDoc(url, {
          collectSessionCookies: this.collectSessionCookies.bind(this),
          fetchImpl: async (target, init) => {
            const result = await this.fetch(target, init);
            return result && result.response !== undefined ? result.response : result;
          },
        });
        if (doc.markdown && doc.markdown.trim().length > 60) {
          return {
            url,
            canonicalUrl: url,
            identityUrl: url,
            title: doc.title || "WPS文档",
            byline: doc.author || "",
            excerpt: doc.markdown.replace(/\s+/g, " ").slice(0, 200),
            siteName: DOCUMENT_SERVICES.wps?.name || "WPS文档",
            markdown: doc.markdown,
            images: doc.images || [],
            // 图片 CDN(shapes 返回的 url)下载可能要求会话,cookie 从 wps 会话带来
            ...(doc.imageHeaders ? { imageHeaders: doc.imageHeaders } : {}),
            contentChars: doc.markdown.length,
            extractionMethod: doc.extractionMethod || "wps-otl",
            extractionStatus: "complete",
            publishedAt: doc.publishedAt || "",
          };
        }
      } catch (wpsError) {
        // 二进制文档(et/wps/wpp/pdf 等)API 直取拿到 download_url → 下载为附件保存(参考飞书附件逻辑)
        if (wpsError?.code === "WPS_DOCS_BINARY" && wpsError.downloadUrl) {
          const maxBytes = Math.max(1, Number(this.settings.capture.maxFileMb) || 20) * 1024 * 1024;
          const downloaded = await this.download(wpsError.downloadUrl, {
            headers: {},
            maxBytes,
            timeoutMs: 60_000,
            requestAttempts: 1,
            fileName: wpsError.fileName,
          });
          const fileName = wpsError.fileName || downloaded.fileName || `${wpsDocToken(url)}.bin`;
          return {
            url,
            canonicalUrl: url,
            identityUrl: url,
            title: fileName,
            byline: wpsError.meta?.author || "",
            excerpt: `WPS 文档(${(wpsError.fileName || "").split(".").pop() || wpsError.meta?.officeType || "未知"}格式),已作为附件保存`,
            siteName: DOCUMENT_SERVICES.wps?.name || "WPS文档",
            markdown: "",
            images: [],
            contentChars: 0,
            extractionMethod: "wps-file-attachment",
            extractionStatus: "complete",
            publishedAt: wpsError.meta?.publishedAt || "",
            binaryFiles: [{ buffer: downloaded.buffer, fileName, mimeType: downloaded.mimeType }],
          };
        }
        // 接口拿不到(无会话/结构变化/非文档页)一律回落渲染提取,不中断剪藏
      }
    }
    if (documentServiceForUrl(url) === "dingtalk") {
      try {
        const dingtalk = await extractDingtalkDoc(url, {
          webSessionManager: this.sessionManager,
          // this.fetch(默认 safeFetch)返回 { response, finalUrl } 包装;解包出 response,
          // 既保留 SSRF/重定向防护,也让测试注入的 mock fetch 生效。
          fetchImpl: async (target, init) => {
            const result = await this.fetch(target, init);
            return result && result.response !== undefined ? result.response : result;
          },
        });
        const article = articleFromHtml(dingtalk.html, url, {
          title: dingtalk.title,
          siteName: DOCUMENT_SERVICES.dingtalk?.name || "钉钉文档",
          content: dingtalk.html,
          extractionMethod: "dingtalk-api",
          byline: dingtalk.author,
          publishedAt: dingtalk.publishedAt,
        });
        article.canonicalUrl = url;
        // 钉钉图片(站内 /core/api/resources/img 与 down.dingtalk.com)下载需要登录态
        if (dingtalk.imageHeaders) article.imageHeaders = dingtalk.imageHeaders;
        return article;
      } catch (dingtalkError) {
        console.error("[dingtalk] extractDingtalkDoc failed:", dingtalkError?.code || "NO_CODE", dingtalkError?.message);
        // 附件型文档(docx/xlsx/pdf 等):/box/api/v2/file/download 拿 OSS 预签名直链 → 下载为附件保存
        // 钉钉二进制文档:在线表格(buffer 已导出 xlsx)或附件型(downloadUrl OSS 直链)
        if (dingtalkError?.code === "DINGTALK_BINARY_DOC" && (dingtalkError.buffer || dingtalkError.downloadUrl)) {
          let buffer, fileName, mimeType, extractionMethod;
          if (dingtalkError.buffer) {
            // 在线表格:无头 Chrome 已导出 xlsx buffer,直接落盘(跳过 this.download)
            buffer = dingtalkError.buffer;
            fileName = dingtalkError.fileName || "dingtalk-spreadsheet.xlsx";
            mimeType = dingtalkError.meta?.mimeType || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
            extractionMethod = "dingtalk-spreadsheet-export";
          } else {
            // 附件型文档:OSS 预签名直链下载原文件
            const maxBytes = Math.max(1, Number(this.settings.capture.maxFileMb) || 20) * 1024 * 1024;
            const downloaded = await this.download(dingtalkError.downloadUrl, {
              headers: {},
              maxBytes,
              timeoutMs: 60_000,
              requestAttempts: 1,
              fileName: dingtalkError.fileName,
            });
            buffer = downloaded.buffer;
            fileName = dingtalkError.fileName || downloaded.fileName || "dingtalk-attachment.bin";
            mimeType = downloaded.mimeType;
            extractionMethod = "dingtalk-file-attachment";
          }
          const ext = (fileName.split(".").pop() || dingtalkError.meta?.extension || "").toLowerCase();
          return {
            url,
            canonicalUrl: url,
            identityUrl: url,
            title: fileName,
            byline: dingtalkError.meta?.author || "",
            excerpt: `钉钉文档(${ext || "未知"}格式),已作为附件保存`,
            siteName: DOCUMENT_SERVICES.dingtalk?.name || "钉钉文档",
            markdown: "",
            images: [],
            contentChars: 0,
            extractionMethod,
            extractionStatus: "complete",
            publishedAt: dingtalkError.meta?.publishedAt || "",
            binaryFiles: [{ buffer, fileName, mimeType }],
          };
        }
        // 登录/权限类错误(DENTRY_KEY_NOT_FOUND/API_ERROR/URL_MISMATCH)继续抛出,提示用户登录;
        // 其余结构变化类错误回落渲染提取,不中断剪藏
        if (dingtalkError?.code === "DINGTALK_DENTRY_KEY_NOT_FOUND" ||
            dingtalkError?.code === "DINGTALK_DOCS_API_ERROR" ||
            dingtalkError?.code === "DINGTALK_DOCS_URL_MISMATCH") {
          throw dingtalkError;
        }
      }
    }
    const renderService = this.settings.capture.renderDynamicPages !== false ? renderServiceForUrl(url) : null;
    let renderError;
    if (renderService && this.sessionManager) {
      try {
        const captureTimeoutMs = Math.max(30_000, Math.min(60_000,
          (Math.max(10, Number(this.settings.capture.webClipBudgetSeconds) || 75) * 1000) - 12_000));
        // 飞书:渲染提取 + 会话 cookie 桥接收敛到专用提取器;其余平台仍走通用渲染
        const rendered = renderService === "feishu"
          ? await extractFeishuDoc(url, {
              webSessionManager: this.sessionManager,
              collectSessionCookies: this.collectSessionCookies.bind(this),
              captureTimeoutMs,
            })
          : await this.sessionManager.extract(url, renderService, { captureTimeoutMs });
        const article = articleFromHtml(rendered.html, rendered.url, {
          title: rendered.title,
          byline: rendered.author,
          excerpt: rendered.description,
          siteName: COMMUNITY_SERVICES[renderService]?.name || DOCUMENT_SERVICES[renderService]?.name || new URL(rendered.url).hostname,
          content: rendered.html,
          plainText: rendered.text,
          publishedAt: rendered.publishedTime,
          extractionMethod: documentServiceForUrl(rendered.url) ? `${renderService}-rendered-document` : `${renderService}-rendered-community-comments`,
        });
        // 飞书内存块直取:extractFeishuDoc 已产结构化 markdown(比虚拟滚动 DOM 完整),
        // 直接采用并标注,不受渲染 DOM 正文长短(可能触发 partial)影响
        if (rendered.extractionMethod === "feishu-block-map" && rendered.markdown && rendered.markdown.trim()) {
          article.markdown = rendered.markdown;
          article.extractionMethod = "feishu-block-map";
          article.extractionStatus = "complete";
          article.contentChars = rendered.markdown.length;
          if (rendered.imageHeaders) article.imageHeaders = rendered.imageHeaders;
          return { ...article, commentCount: Number(rendered.commentCount) || 0 };
        }
        if (article.extractionStatus === "complete") {
          // 旧版文档被管理员升级为新智能文档:渲染页只有升级横幅,提示去剪新链接而不是产噪音笔记
          if (tencentHostForUrl(url) && /文档已不再使用|升级为新的智能文档/.test(rendered.text || "")) {
            throw new Error("该云文档已升级为新的智能文档:请打开原链接,前往新文档后剪藏新链接");
          }
          if (["tencent", "wecomdoc"].includes(renderService)) article.markdown = stripTencentChrome(article.markdown);
          // 飞书正文图片是 internal-api-drive-stream 内部流,下载需登录 cookie(实测匿名失败):
          // cookie 桥接在 extractFeishuDoc 内完成,imageHeaders 仅在拿到会话 cookie 时存在
          if (rendered.imageHeaders) article.imageHeaders = rendered.imageHeaders;
          // WPS 渲染兜底(OTL 直取失败时):file 接口若可用则补 author/publishedAt
          if (renderService === "wps") {
            const wpsToken = (rendered.url.match(/kdocs\.cn\/(?:l|view\/l|w)\/([A-Za-z0-9]+)/i) || [])[1] || "";
            if (wpsToken) {
              const cookie = this.collectSessionCookies ? await this.collectSessionCookies("wps", "https://www.kdocs.cn/") : "";
              const meta = await fetchFileInfo(wpsToken, cookie, async (target, init) => {
                const result = await this.fetch(target, init);
                return result && result.response !== undefined ? result.response : result;
              }).catch(() => ({}));
              if (meta.author) article.byline = meta.author;
              if (meta.publishedAt) article.publishedAt = meta.publishedAt;
              if (!article.title || article.title === wpsToken) article.title = meta.title || article.title;
            }
          }
          return { ...article, commentCount: Number(rendered.commentCount) || 0 };
        }
        if (tencentHostForUrl(url) || documentServiceForUrl(url) === "wps") {
          // 腾讯/企微/WPS 文档渲染拿不到正文(登录墙/私有文档):不回落 HTTP 空壳,
          // 像钉钉/飞书一样明确提示用户先登录浏览器会话
          const serviceName = DOCUMENT_SERVICES[documentServiceForUrl(url)]?.name || "腾讯文档";
          const error = new Error(`${serviceName}页面需要登录:请先在「浏览器会话」面板打开「${serviceName}」登录窗口完成登录,再重新剪藏`);
          error.code = "DOCUMENT_LOGIN_REQUIRED";
          throw error;
        }
        renderError = new Error(`${COMMUNITY_SERVICES[renderService]?.name || renderService} rendered content was too short to save safely`);
      } catch (error) {
        if (["DOCUMENT_LOGIN_REQUIRED", "DOCUMENT_CAPTURE_INCOMPLETE"].includes(error?.code)) throw error;
        renderError = error;
      }
    }
    if (parseRedditUrl(url) && communityError) throw renderError || communityError;
    const { response, finalUrl } = await safeFetch(url, { accept: "text/html,application/xhtml+xml,application/pdf", timeoutMs: 30_000 });
    if (!response.ok) {
      // 知乎对无 cookie 的裸 HTTP 一律 403:报出可操作的真实原因,而不是裸的 "Page returned HTTP 403"。
      if (isZhihuNoteUrl(url) && response.status === 403) {
        throw new Error(`Zhihu returned HTTP 403 (risk-controlled); retry later${zhihuError ? `, HTTP extraction also failed: ${zhihuError.message}` : ""}`);
      }
      throw new Error(`Page returned HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/pdf") || (isLikelyPdfUrl(finalUrl) && !contentType.includes("html"))) {
      throw new Error("PDF 链接不再自动提取正文：聊天里的 PDF 附件会正常保存，直链 PDF 可手动下载");
    }
    if (!contentType.includes("html") && !contentType.includes("xml")) throw new Error(`Unsupported page type: ${contentType || "unknown"}`);
    // WPS 未登录:safeFetch 跟随 302 到 account.kdocs.cn/passport/singlesign 登录跳转页。
    // 原始 www.kdocs.cn/l/{token} 文档需要登录态,从 cb 参数提取真实链接引导用户登录,而非存登录页空壳。
    if (/account\.kdocs\.cn\/passport\/singlesign/.test(finalUrl)) {
      let realUrl = "";
      try { realUrl = new URL(finalUrl).searchParams.get("cb") || ""; } catch (_) {}
      const error = new Error(
        `WPS文档页面需要登录:请先在「浏览器会话」面板打开「WPS文档」登录窗口完成登录,再重新剪藏${realUrl ? `(原始文档链接:${realUrl})` : ""}`,
      );
      error.code = "DOCUMENT_LOGIN_REQUIRED";
      throw error;
    }
    const html = decodeHtmlBuffer(await readLimitedBody(response, 5 * 1024 * 1024), contentType);
    if (!renderService && this.settings.capture.renderDynamicPages !== false && this.sessionManager && detectCommunityPage(html, finalUrl)) {
      try {
        const rendered = await this.sessionManager.extract(finalUrl, "community-generic", {
        });
        const renderedArticle = articleFromHtml(rendered.html, rendered.url, {
          title: rendered.title,
          byline: rendered.author,
          excerpt: rendered.description,
          siteName: new URL(rendered.url).hostname,
          content: rendered.html,
          plainText: rendered.text,
          extractionMethod: "generic-rendered-community-comments",
        });
        if (renderedArticle.extractionStatus === "complete") return { ...renderedArticle, commentCount: Number(rendered.commentCount) || 0 };
      } catch (error) {
        renderError = renderError || error;
      }
    }
    const article = articleFromHtml(html, finalUrl);
    if ((renderError || communityError || xiaohongshuError) && article.extractionStatus === "partial") {
      article.renderWarning = renderError?.message || communityError?.message || xiaohongshuError?.message || String(renderError || communityError || xiaohongshuError);
    }
    return article;
  }

  async save(url, source = {}) {
    const budgetMs = Math.max(10, Number(this.settings.capture.webClipBudgetSeconds) || 75) * 1000;
    const deadline = Number(source.deadline) || Date.now() + budgetMs;
    const article = await deadlinePromise(this.extract(url), deadline, "Web clipping exceeded its time budget");
    const family = classifyClipFamily(url, article, this.settings);
    if (!isClipFamilyEnabled(this.settings, family)) {
      throw new Error("该剪藏类型已关闭");
    }
    return this.saveArticle(article, source, { deadline, family });
  }

  async saveArticle(article, source = {}, options = {}) {
    const date = localDateParts(source.timestamp || new Date());
    const sourceLabel = sourceNameForUrl(article.url, this.settings)
      || DOCUMENT_SERVICES[documentServiceForUrl(article.url)]?.name
      || "普通网页";
    const labelForPath = safeFileName(sourceLabel, "web");
    const title = compactTitle(article.title, new URL(article.url).hostname);
    const stem = safeFileName(title, new URL(article.url).hostname);
    const identityUrl = article.identityUrl || article.canonicalUrl || normalizedIdentityUrl(article.url);
    const suffix = `-${shortHash(identityUrl)}.md`;
    const family = options.family || classifyClipFamily(article.url, article, this.settings);
    const clipFolder = resolveClipFolder(this.settings, family);
    const existingPath = typeof this.writer.findTextBySuffix === "function"
      ? this.writer.findTextBySuffix(clipFolder, suffix)
      : "";
    // 同链接重剪:一律写入今天路径,旧文件与旧本地图在写入成功后清理(系统回收站,可反悔)
    const notePath = `${clipFolder}/${date.day}/${date.day}-${labelForPath}-${stem}${suffix}`;
    const reused = Boolean(existingPath) && existingPath !== notePath;
    let markdown = article.markdown || article.excerpt || article.url;
    const failures = [];
    const skippedImages = [];
    const fileFailures = [];
    let savedImages = 0;
    let savedFiles = 0;
    const savedFilePaths = [];
    const assetFolder = `${this.settings.storage.attachmentFolder}/Web/${date.day}/${date.day}-${labelForPath}-${stem}-${shortHash(identityUrl)}`;
    for (const [index, file] of (article.binaryFiles || []).entries()) {
      try {
        const localPath = await this.writer.saveBinary(assetFolder, file.fileName || `source-${index + 1}`, file.buffer, file.mimeType);
        markdown = `[${file.label || file.fileName || "Source file"}](${encodeURI(localPath)})\n\n${markdown}`;
        savedFiles += 1;
        savedFilePaths.push(localPath.replace(/\.md$/i, ""));
      } catch (error) {
        fileFailures.push(`${file.fileName || `source-${index + 1}`}: ${error?.message || error}`);
      }
    }
    if (this.settings.capture.downloadWebImages) {
      const maxImages = Math.max(1, Number(this.settings.capture.maxWebImages) || 30);
      const allImages = [...new Set(article.images || [])];
      const selectedImages = allImages.slice(0, maxImages);
      const maxTotalBytes = Math.max(1, Number(this.settings.capture.maxWebImageTotalMb) || 50) * 1024 * 1024;
      const deadline = Number(options.deadline) || Date.now() + (Math.max(10, Number(this.settings.capture.webClipBudgetSeconds) || 75) * 1000);
      let reservedBytes = 0;
      for (const imageUrl of allImages.slice(maxImages)) skippedImages.push(imageUrl);
      const localized = await mapWithConcurrency(selectedImages, 4, async (imageUrl, index) => {
        try {
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error("skipped because the article time budget was exhausted");
          const downloaded = await this.download(imageUrl, {
            referrer: article.url,
            ...(article.imageHeaders ? { headers: article.imageHeaders } : {}),
            maxBytes: Math.min((Number(this.settings.capture.maxFileMb) || 20) * 1024 * 1024, maxTotalBytes),
            timeoutMs: Math.min(10_000, remaining),
            requestAttempts: 2,
            shouldRetry: (error) => error?.code === "ECONNRESET",
            httpAttempts: 1,
            fileName: `${stem}-img-${String(index + 1).padStart(2, "0")}`,
          });
          if (!downloaded.mimeType.startsWith("image/")) throw new Error(`not an image (${downloaded.mimeType})`);
          if (reservedBytes + downloaded.buffer.length > maxTotalBytes) throw new Error(`skipped because the article image budget is ${this.settings.capture.maxWebImageTotalMb || 50} MB`);
          reservedBytes += downloaded.buffer.length;
          try {
            const localPath = await this.writer.saveBinary(assetFolder, downloaded.fileName, downloaded.buffer, downloaded.mimeType);
            return { imageUrl, localPath };
          } catch (error) {
            reservedBytes -= downloaded.buffer.length;
            throw error;
          }
        } catch (error) {
          return { imageUrl, error: error?.message || String(error) };
        }
      });
      for (const result of localized) {
        if (result.localPath) {
          markdown = markdown.split(result.imageUrl).join(encodeURI(result.localPath));
          savedImages += 1;
        } else failures.push(`${result.imageUrl}: ${result.error}`);
      }
    }
    const frontmatter = [
      "---",
      `title: ${yamlString(title)}`,
      `source: ${yamlString(article.url)}`,
      `canonical: ${yamlString(article.canonicalUrl || article.url)}`,
      `identity: ${yamlString(identityUrl)}`,
      `site: ${yamlString(article.siteName)}`,
      `author: ${yamlString(article.byline)}`,
      `published_at: ${yamlString(article.publishedAt || "")}`,
      `platform: ${yamlString(sourceLabel)}`,
      `clipped_at: ${yamlString(date.iso)}`,
      `channel: ${yamlString(source.channel || "manual")}`,
      `extraction_method: ${yamlString(article.extractionMethod || "unknown")}`,
      "---",
      "",
    ].join("\n");
    const warningParts = [];
    if (skippedImages.length) warningParts.push(`${skippedImages.length} 张图片超出单篇上限,已保留远程地址`);
    if (failures.length) warningParts.push(`${failures.length} 张图片未能本地保存,正文中保留远程地址`);
    if (fileFailures.length) warningParts.push(`${fileFailures.length} 个原文件未能本地保存`);
    const report = warningParts.length ? `\n\n> [!warning] ${warningParts.join("；")}。` : "";
    const content = `${frontmatter}# ${escapeWebText(title)}\n\n${markdown}${report}\n`;
    if (typeof this.writer.upsertText === "function") await this.writer.upsertText(notePath, content);
    else await this.writer.createText(notePath, content);
    // 新文件写成功后清理旧剪藏:旧文件挪到今天路径,旧正文里引用的本地图/附件一并入回收站
    if (reused && existingPath && typeof this.writer.trashFile === "function") {
      try {
        const previousMarkdown = typeof this.writer.readText === "function" ? await this.writer.readText(existingPath) : "";
        for (const linkMatch of String(previousMarkdown || "").matchAll(/\]\(([^)\s]+)\)/g)) {
          let localPath;
          try { localPath = decodeURI(linkMatch[1] || ""); } catch (_) { localPath = linkMatch[1] || ""; }
          if (localPath && localPath.startsWith(this.settings.storage.attachmentFolder)) {
            await this.writer.trashFile(localPath).catch(() => {});
          }
        }
        await this.writer.trashFile(existingPath).catch(() => {});
      } catch (_) { /* 清理失败静默:旧文件保留,下次重剪再试 */ }
    }
    return { notePath, article: { ...article, title, identityUrl }, sourceLabel, reused, savedImages, savedFiles, savedFilePaths, imageFailures: failures, imageSkipped: skippedImages, fileFailures };
  }
}

module.exports = {
  WebClipper, absoluteUrl, articleFromHtml, bestSrcset, canonicalUrlFromDocument, cleanMarkdown, compactTitle,
  declaredWechatValue, detectCommunityPage, escapeWebText, genericCommentNodes, isLikelyContentImage,
  mapWithConcurrency, nodeToMarkdown, normalizedIdentityUrl, normalizedText, prepareDocument, publishedWechatTime,
  selectArticle, wechatArticleIdentityUrl,
};
