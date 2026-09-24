"use strict";

// 微博搜索/话题页(m.weibo.cn/search?containerid=…)是 JS 渲染 + 游客墙:
// 页面壳对无 cookie 的请求一律返回 "Sina Visitor System",正文在
// /api/container/getIndex 的 JSON 里。实测(2026-09):接口唯一硬性要求是
// Cookie 里的 SUB(访客票据,无头会话可自动种出);SUBP/_T_WM/XSRF-TOKEN/
// referer/x-xsrf-token 等全部非必须,缺 SUB 时任何请求头都拿不到数据(432)。

const { readLimitedBody } = require("../../core/network");
const { parseHTML } = require("linkedom");

const TTARTICLE_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

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

// 微博头条文章(weibo.com/ttarticle/p/show?id=…):页面 SSR 直出正文且无登录墙,
// 但通用 Readability 会误选页头的作者信息卡而丢掉正文容器,必须固定选择器提取。
// 实测正文容器为 .WB_editor_iframe_new(fallback .main_editor);页面匿名可读,无需 cookie。
function isWeiboArticleUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!hostMatches(url, ["weibo.com", "weibo.cn"])) return false;
    return /\/ttarticle\/p\/show/i.test(url.pathname) && Boolean(url.searchParams.get("id"));
  } catch (_) { return false; }
}

function weiboArticleId(value) {
  try {
    return new URL(String(value || "")).searchParams.get("id") || "";
  } catch (_) { return ""; }
}

async function extractWeiboArticle(url, fetchImpl = globalThis.fetch, cookieGetter = null) {
  if (!isWeiboArticleUrl(url)) return null;

  const cookie = cookieGetter ? await cookieGetter("https://weibo.com") : "";
  const headers = { "user-agent": TTARTICLE_UA };
  if (cookie) headers.cookie = cookie;
  const { response } = await fetchImpl(String(url), { accept: "text/html", headers, timeoutMs: 30_000 });
  if (!response.ok) throw new Error(`Weibo article returned HTTP ${response.status}`);
  const html = (await readLimitedBody(response, 5 * 1024 * 1024)).toString("utf8");

  const document = parseHTML(html).document;
  const container = document.querySelector(".WB_editor_iframe_new") || document.querySelector(".main_editor");
  if (!container || !container.innerHTML.trim()) {
    throw new Error("Weibo article body container was not found on the page (markup may have changed)");
  }
  const title = String(document.querySelector('meta[property="og:title"]')?.getAttribute("content") || document.title || "").trim();
  const images = [...container.querySelectorAll("img")]
    .map((img) => img.getAttribute("src"))
    .filter(Boolean)
    .map((src) => (src.startsWith("//") ? `https:${src}` : src));
  const id = weiboArticleId(url);

  return {
    title: title || "微博头条文章",
    byline: "微博",
    siteName: "weibo.com",
    contentHtml: `<article class="weibo-ttarticle">${container.innerHTML}</article>`,
    images,
    extractionMethod: "ttarticle",
    url: String(url),
    canonicalUrl: String(url),
    identityUrl: `weibo-ttarticle:${id}`,
    extractionStatus: "complete",
  };
}

function searchContainerId(url) {
  try {
    const u = new URL(String(url || ""));
    let cid = u.searchParams.get("containerid") || "";
    // 流传形态②:containerid 值里的 &q= 未编码,被裸 & 截断;q 降级成独立参数。
    // 更糟的是 q 值里的裸 # 会把 "q=#话题#&_T_WM=…" 整段吞进 URL fragment,
    // query 里 q 参数直接消失。fragment 首段 "#话题#" 正是搜索词,恢复出来。
    // 微博 getIndex 认的是"含 q 的完整 containerid"——重组回去,恢复请求语义。
    const queryQ = u.searchParams.get("q");
    // WHATWG URL 会把 hash 里的非 ASCII percent-encode,恢复话题名要先解回来。
    let hashQ = /^#([^#/]+)#/.exec(u.hash || "")?.[1] || "";
    if (hashQ) { try { hashQ = decodeURIComponent(hashQ); } catch (_) { /* keep as-is */ } }
    let q = queryQ || hashQ;
    if (q && !q.includes("#")) q = `#${q}#`;
    // q 保持解码后的原文,不做预编码——extractWeiboSearch 出口会对整个 cid
    // 统一 encodeURIComponent,这里再编一次会变成双重编码。
    if (q && !/(?:^|&)q=/.test(cid)) {
      cid = `${cid}&q=${q}`;
    }
    return cid;
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
// show API 的 page_info.urls 即现成 mp4 直链(weibo.cn 域 referer 防盗链,下载链路 referrer 天然满足)。
// 优先级:mp4_hd_mp4(480p,体积友好)→ mp4_720p_mp4 → media_info.stream_url;
// page_url 是视频页链接而非直链(下载必得 HTML),只保留在正文,不进下载队列。
function weiboVideoUrls(mblog) {
  if (!mblog || mblog?.page_info?.type !== "video") return [];
  const urls = mblog.page_info?.urls || {};
  const candidates = [urls.mp4_hd_mp4, urls.mp4_720p_mp4, mblog.page_info?.media_info?.stream_url];
  const normalized = candidates
    .filter(Boolean)
    .map((value) => (String(value).startsWith("//") ? `https:${value}` : String(value)))
    .filter((value) => /^https?:\/\//.test(value));
  return [...new Set(normalized)];
}

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
  return `<article class="weibo-search"><p class="weibo-search-meta">${topicTitle} · 首屏 ${mblogs.length} 条</p>\n${items}\n</article>`;
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
    videoUrls: [...new Set([...weiboVideoUrls(mblog), ...weiboVideoUrls(mblog?.retweeted_status)])],
    extractionStatus: "complete",
  };
}

async function extractWeibo(url, fetchImpl = globalThis.fetch, cookieGetter = null) {
  if (isWeiboSearchUrl(url)) return extractWeiboSearch(url, fetchImpl, cookieGetter);
  if (isWeiboStatusUrl(url)) return extractWeiboStatus(url, fetchImpl, cookieGetter);
  if (isWeiboArticleUrl(url)) return extractWeiboArticle(url, fetchImpl, cookieGetter);
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
  extractWeiboArticle,
  extractWeiboSearch,
  extractWeiboStatus,
  isWeiboArticleUrl,
  isWeiboSearchUrl,
  isWeiboStatusUrl,
  isWeiboUrl,
  searchContainerId,
  searchTopicTitle,
  weiboStatusId,
};
