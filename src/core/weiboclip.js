"use strict";

// 微博搜索/话题页(m.weibo.cn/search?containerid=…)是 JS 渲染 + 游客墙:
// 页面壳对无 cookie 的请求一律返回 "Sina Visitor System",正文在
// /api/container/getIndex 的 JSON 里。实测(2026-09):接口唯一硬性要求是
// Cookie 里的 SUB(访客票据,无头会话可自动种出);SUBP/_T_WM/XSRF-TOKEN/
// referer/x-xsrf-token 等全部非必须,缺 SUB 时任何请求头都拿不到数据(432)。

const { readLimitedBody } = require("./network");

const WEIBO_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";

function hostMatches(value, hosts) {
  try {
    const host = new URL(String(value)).hostname.toLowerCase();
    return hosts.some((h) => host === h || host.endsWith(`.${h}`));
  } catch (_) { return false; }
}

function isWeiboUrl(value) {
  return hostMatches(value, ["weibo.com", "weibo.cn"]);
}

function isWeiboSearchUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!hostMatches(url, ["weibo.com", "weibo.cn"])) return false;
    return /\/search\/?$/i.test(url.pathname) && Boolean(url.searchParams.get("containerid"));
  } catch (_) { return false; }
}

function weiboStatusId(value) {
  try {
    const url = new URL(String(value || ""));
    if (!hostMatches(url, ["weibo.com", "weibo.cn"])) return "";
    return /\/status\/(\d+)/i.exec(url.pathname)?.[1] || "";
  } catch (_) { return ""; }
}

function isWeiboStatusUrl(value) {
  return Boolean(weiboStatusId(value));
}

function searchContainerId(value) {
  try {
    return new URL(String(value || "")).searchParams.get("containerid") || "";
  } catch (_) { return ""; }
}

function searchTopicTitle(containerid) {
  const decoded = decodeURIComponent(String(containerid || ""));
  const q = /(?:^|&)q=([^&]+)/.exec(decoded)?.[1] || "";
  const topic = q ? decodeURIComponent(q).replace(/#/g, "").trim() : "";
  return topic ? `#${topic}# 微博搜索` : "微博搜索";
}

function formatWeiboTime(value) {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return String(value || "");
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function collectMblogs(data) {
  const mblogs = [];
  for (const card of (data?.cards || [])) {
    if (card.mblog) mblogs.push(card.mblog);
    for (const group of (card.card_group || [])) if (group.mblog) mblogs.push(group.mblog);
  }
  return mblogs;
}

// mblog.text 是 HTML:话题/用户是 <a>,表情与图标藏在 <span class="url-icon">。
// 图标不是内容,剥掉;链接文字保留,交给通用管线转 markdown。
// 链接降噪(存档笔记里这些跳转链接都是噪声):
// - 话题搜索链接(#X#)与 @用户链接 → 纯文字;
// - "全文"链接 → 剥出正文,由 meta 行的干净"原文"链接替代;
// - 视频占位卡片(timeline_card)→ 剥掉,meta 行给一个"视频"链接;
// - 其余链接一律降级为纯文字。
function cleanWeiboText(mblog) {
  let videoUrl = mblog?.page_info?.type === "video" ? String(mblog.page_info?.page_url || "") : "";
  let statusUrl = mblog?.id ? `https://m.weibo.cn/status/${mblog.id}` : "";
  let html = String(mblog?.text || "")
    .replace(/<span class="url-icon">[\s\S]*?<\/span>/g, "")
    .replace(/(<br\s*\/?>\s*){3,}/gi, "<br><br>");
  if (mblog?.page_info?.type === "video") {
    html = html.replace(/<a [^>]*href="[^"]*(?:video\.weibo\.com|weibo\.com\/tv\/show)[^"]*"[^>]*>[\s\S]*?<\/a>/gi, "");
  }
  html = html.replace(/<a ([^>]*)>([\s\S]*?)<\/a>/gi, (match, attrs, inner) => {
    const href = /href="([^"]*)"/.exec(attrs)?.[1] || "";
    const text = String(inner).replace(/<[^>]+>/g, "").trim();
    if (/timeline_card_small_video|微博视频/.test(href + text)) {
      videoUrl = videoUrl || (href.startsWith("//") ? `https:${href}` : href);
      return "";
    }
    if (/(?:m\.weibo\.cn\/search|s\.weibo\.com\/weibo\?q=)/.test(href)) return text; // 话题
    if (/(?:m\.weibo\.cn\/n\/|weibo\.com\/n\/)/.test(href) || text.startsWith("@")) return text; // @用户
    if (/\/status\/\d+/.test(href) && /^全文/.test(text)) return ""; // 全文 → meta 行"原文"
    if (/^全文/.test(text)) return "";
    return text;
  });
  return { html: html.trim(), videoUrl: videoUrl || null, statusUrl };
}

function mblogPicsHtml(mblog) {
  const pics = Array.isArray(mblog?.pics) ? mblog.pics : [];
  const urls = pics.map((pic) => pic?.large?.url || pic?.url).filter(Boolean).slice(0, 9);
  if (!urls.length) return "";
  return `<p class="weibo-item-pics">${urls.map((src) => `<img src="${src}" alt="配图" />`).join("")}</p>`;
}

function mblogMetaHtml(mblog, statusUrl, videoUrl) {
  const stats = [];
  if (Number(mblog?.reposts_count) > 0) stats.push(`转发 ${mblog.reposts_count}`);
  if (Number(mblog?.comments_count) > 0) stats.push(`评论 ${mblog.comments_count}`);
  if (Number(mblog?.attitudes_count) > 0) stats.push(`赞 ${mblog.attitudes_count}`);
  const parts = [formatWeiboTime(mblog?.created_at), ...stats];
  if (statusUrl) parts.push(`<a href="${statusUrl}">原文</a>`);
  if (videoUrl) parts.push(`<a href="${videoUrl}">视频</a>`);
  return `<p class="weibo-item-meta">${parts.join(" · ")}</p>`;
}

function mblogRetweetHtml(mblog) {
  const rt = mblog?.retweeted_status;
  if (!rt) return "";
  const text = cleanWeiboText(rt).html;
  if (!text) return "";
  const author = String(rt.user?.screen_name || "微博用户");
  return `<blockquote class="weibo-item-retweet">@${author}:${text}</blockquote>`;
}

function mblogItemHtml(mblog) {
  const { html: text, videoUrl, statusUrl } = cleanWeiboText(mblog);
  const pics = mblogPicsHtml(mblog);
  const retweet = mblogRetweetHtml(mblog);
  const author = String(mblog?.user?.screen_name || "微博用户");
  return `<section class="weibo-item"><h3 class="weibo-item-author">${author}</h3>${mblogMetaHtml(mblog, statusUrl, videoUrl)}${text ? `<div class="weibo-item-text">${text}</div>` : ""}${retweet}${pics}</section>`;
}

function weiboSearchHtml(topicTitle, mblogs) {
  const items = mblogs.map((mblog) => mblogItemHtml(mblog)).join("\n");
  return `<article class="weibo-search"><p class="weibo-search-meta">${topicTitle} · 微博搜索 · 首屏 ${mblogs.length} 条</p>\n${items}\n</article>`;
}

async function extractWeiboStatus(url, fetchImpl = globalThis.fetch, cookieGetter = null) {
  const id = weiboStatusId(url);
  if (!id) return null;

  const cookie = cookieGetter ? await cookieGetter("https://m.weibo.cn") : "";
  const sub = /(?:^|;\s*)SUB=([^;]+)/.exec(String(cookie || ""));
  if (!sub) {
    throw new Error("Weibo status needs its visitor cookie (SUB); open the weibo isolated session in plugin settings once, or retry to let headless warmup plant it");
  }

  const api = `https://m.weibo.cn/api/statuses/show?id=${id}`;
  // safeFetch 的 response 是自定义对象(headers.get + async-iterable body),
  // 没有标准 .json();全项目统一用 readLimitedBody 读体。
  const { response } = await fetchImpl(api, {
    accept: "application/json, text/plain, */*",
    headers: { "user-agent": WEIBO_UA, cookie: `SUB=${sub[1]}` },
    timeoutMs: 30_000,
  });
  if (!response.ok) {
    if (response.status === 432) {
      throw new Error("Weibo status returned HTTP 432 (risk control): the visitor cookie (SUB) is missing or expired; retry to refresh it via headless warmup");
    }
    throw new Error(`Weibo status API returned HTTP ${response.status}`);
  }
  const payload = JSON.parse((await readLimitedBody(response, 5 * 1024 * 1024)).toString("utf8"));
  // show 接口成功时顶层就是 status 对象(有 id/idstr);失败时是 { ok: 0, msg }。
  if (!payload || (payload.ok === 0 || (!payload.id && !payload.idstr))) {
    const msg = payload?.msg || payload?.message || "the visitor cookie may need a refresh";
    throw new Error(`Weibo status API rejected the request: ${msg}`);
  }
  const mblog = payload;
  const author = String(mblog?.user?.screen_name || "微博用户");
  const statusUrl = `https://m.weibo.cn/status/${mblog.idstr || mblog.id}`;
  const { html: text, videoUrl } = cleanWeiboText(mblog);
  const day = formatWeiboTime(mblog?.created_at).slice(0, 10);
  const contentHtml = `<article class="weibo-status">${mblogItemHtml({ ...mblog, id: mblog.idstr || mblog.id })}</article>`;
  return {
    title: `@${author} 微博 ${day}`,
    byline: author,
    siteName: "m.weibo.cn",
    contentHtml,
    images: (Array.isArray(mblog?.pics) ? mblog.pics : [])
      .map((pic) => pic?.large?.url || pic?.url).filter(Boolean),
    extractionMethod: "weibo-json",
    url: String(url),
    canonicalUrl: statusUrl,
    identityUrl: `weibo-status:${mblog.idstr || mblog.id}`,
    extractionStatus: "complete",
  };
}

async function extractWeibo(url, fetchImpl = globalThis.fetch, cookieGetter = null) {
  if (isWeiboSearchUrl(url)) return extractWeiboSearch(url, fetchImpl, cookieGetter);
  if (weiboStatusId(url)) return extractWeiboStatus(url, fetchImpl, cookieGetter);
  return null;
}

async function extractWeiboSearch(url, fetchImpl = globalThis.fetch, cookieGetter = null) {
  if (!isWeiboSearchUrl(url)) return null;
  const containerid = searchContainerId(url);
  if (!containerid) return null;

  const cookie = cookieGetter ? await cookieGetter("https://m.weibo.cn") : "";
  const sub = /(?:^|;\s*)SUB=([^;]+)/.exec(String(cookie || ""));
  if (!sub) {
    throw new Error("Weibo search needs its visitor cookie (SUB); open the weibo isolated session in plugin settings once, or retry to let headless warmup plant it");
  }

  const api = `https://m.weibo.cn/api/container/getIndex?containerid=${encodeURIComponent(containerid)}&page_type=searchall`;
  // safeFetch 返回 { response, finalUrl } 包装对象,与 xhsclip/zhihuclip 同款约定。
  const { response } = await fetchImpl(api, {
    accept: "application/json, text/plain, */*",
    headers: { "user-agent": WEIBO_UA, cookie: `SUB=${sub[1]}` },
    timeoutMs: 30_000,
  });
  if (!response.ok) {
    if (response.status === 432) {
      throw new Error("Weibo search returned HTTP 432 (risk control): the visitor cookie (SUB) is missing or expired; retry to refresh it via headless warmup");
    }
    throw new Error(`Weibo search API returned HTTP ${response.status}`);
  }
  // safeFetch 的 response 是自定义对象(headers.get + async-iterable body),
  // 没有标准 .json();全项目统一用 readLimitedBody 读体。
  const body = (await readLimitedBody(response, 5 * 1024 * 1024)).toString("utf8");
  const payload = JSON.parse(body);
  if (payload?.ok !== 1 || !payload.data) {
    throw new Error(`Weibo search API rejected the request (ok=${payload?.ok}); the visitor cookie may need a refresh`);
  }
  const mblogs = collectMblogs(payload.data);
  if (!mblogs.length) {
    throw new Error("Weibo search returned no posts for this containerid");
  }

  const topicTitle = searchTopicTitle(containerid);
  return {
    title: topicTitle,
    byline: "微博",
    siteName: "m.weibo.cn",
    contentHtml: weiboSearchHtml(topicTitle, mblogs),
    images: mblogs.flatMap((mblog) => (Array.isArray(mblog?.pics) ? mblog.pics : []))
      .map((pic) => pic?.large?.url || pic?.url).filter(Boolean),
    extractionMethod: "weibo-json",
    url: String(url),
    canonicalUrl: String(url),
    identityUrl: `weibo-search:${containerid}`,
    extractionStatus: "complete",
  };
}

module.exports = {
  WEIBO_UA,
  cleanWeiboText,
  collectMblogs,
  extractWeibo,
  extractWeiboSearch,
  extractWeiboStatus,
  isWeiboSearchUrl,
  isWeiboStatusUrl,
  isWeiboUrl,
  searchContainerId,
  searchTopicTitle,
  weiboStatusId,
};
