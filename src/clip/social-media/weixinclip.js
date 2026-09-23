"use strict";

// 微信公众号文章(mp.weixin.qq.com/s/…):页面 SSR 直出,正文容器 #js_content,
// 标题在 og:title / #activity-name。两个坑:
// 1) 图片一律 data-src 懒加载,src 是灰色占位(data: SVG)——不提升 data-src
//    的话正文图会被通用管线全丢;
// 2) 微信对可疑环境返回 cooldown_tips 验证页(无 js_content),要能区分
//    "被风控"和"结构变化",不留假成功。
// 图床 mmbiz.qpic.cn 对带正常 referer 的请求放行,无需特殊处理。

const { readLimitedBody } = require("../../core/network");
const { localIso } = require("../../core/util");
const { parseHTML } = require("linkedom");

const WEIXIN_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

function isWeixinArticleUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.hostname === "mp.weixin.qq.com"
      && (/\/s\/[^/]+/.test(url.pathname) || Boolean(url.searchParams.get("__biz")));
  } catch (_) { return false; }
}

function weixinArticleId(url) {
  try {
    const u = new URL(String(url || ""));
    return /\/s\/([^/?#]+)/.exec(u.pathname)?.[1] || u.searchParams.get("__biz") || "";
  } catch (_) { return ""; }
}

function promoteLazyImages(container) {
  const images = [];
  for (const img of container.querySelectorAll("img")) {
    const dataSrc = img.getAttribute("data-src") || "";
    const current = img.getAttribute("src") || "";
    const src = dataSrc.startsWith("http") ? dataSrc : (current.startsWith("http") ? current : dataSrc || current);
    if (!src) { img.remove(); continue; }
    img.setAttribute("src", src.startsWith("//") ? `https:${src}` : src);
    img.removeAttribute("data-src");
    images.push(img.getAttribute("src"));
  }
  return images;
}

// 微信对可疑请求只是"降级 DOM 渲染"(js_content 容器不出),window.cgiDataNew
// 里的数据始终完整。content_noencode 是正文:富文本文章为完整 HTML(含 <p>/<img
// data-src>),纯文本文章是 \n\n 分段的文字流。JS 字符串用 \xNN/\uXXXX 转义,需解码。
function extractCgiString(html, marker) {
  const match = new RegExp(`${marker}\\s*[:=]\\s*(["'])`).exec(html);
  if (!match) return "";
  const quote = match[1];
  let index = match.index + match[0].length;
  let out = "";
  while (index < html.length) {
    const ch = html[index];
    if (ch === "\\") {
      const next = html[index + 1];
      if (next === "x") { out += String.fromCharCode(parseInt(html.slice(index + 2, index + 4), 16)); index += 4; continue; }
      if (next === "u") { out += String.fromCharCode(parseInt(html.slice(index + 2, index + 6), 16)); index += 6; continue; }
      if (next === "n") { out += "\n"; index += 2; continue; }
      if (next === "t") { out += "\t"; index += 2; continue; }
      out += next; index += 2; continue;
    }
    if (ch === quote) break;
    out += ch; index += 1;
  }
  return out;
}

function normalizeWeixinContent(raw) {
  if (/<p[ >]|<img[ >]|<section/i.test(raw)) {
    // 富文本:把懒加载 data-src 提升为 src,剥掉占位 src。
    return raw.replace(/<img([^>]*?)\s(?:data-src|src)="([^"]*)"([^>]*?)>/gi, (tag, before, src, after) => {
      if (!/^(https?:|\/\/)/i.test(src)) return tag;
      const clean = (before + after).replace(/\s(?:data-src|src)="[^"]*"/gi, "");
      return `<img${clean} src="${src.startsWith("//") ? `https:${src}` : src}">`;
    });
  }
  return raw.split(/\n{2,}/).map((para) => `<p>${para.trim().replace(/\n/g, "<br>")}</p>`).join("");
}

function extractFallbackContent(html) {
  const raw = extractCgiString(html, "content_noencode");
  if (!raw || !raw.trim()) return { contentHtml: "", images: [] };
  const contentHtml = normalizeWeixinContent(raw);
  // linkedom 解析 HTML fragment 时不填充 body,内容挂在 documentElement 下。
  const parsed = parseHTML(`<div>${contentHtml}</div>`).document;
  const root = parsed.body?.firstElementChild || parsed.documentElement;
  const images = promoteLazyImages(root);
  return { contentHtml, images };
}

async function extractWeixinArticle(url, fetchImpl = globalThis.fetch, cookieGetter = null) {
  if (!isWeixinArticleUrl(url)) return null;

  // 微信对"无 cookie 的裸请求"渐进触发 cooldown 验证页;无头会话先开一次
  // 文章页种下游客 cookie 再带 cookie 请求,可显著降低被拦概率。
  const cookie = cookieGetter ? await cookieGetter("https://mp.weixin.qq.com") : "";
  const headers = { "user-agent": WEIXIN_UA, "accept-language": "zh-CN,zh;q=0.9" };
  if (cookie) headers.cookie = cookie;

  const { response } = await fetchImpl(String(url), {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    headers,
    timeoutMs: 30_000,
  });
  if (!response.ok) throw new Error(`WeChat article returned HTTP ${response.status}`);
  const html = (await readLimitedBody(response, 8 * 1024 * 1024)).toString("utf8");

  const document = parseHTML(html).document;
  const title = String(
    document.querySelector('meta[property="og:title"]')?.getAttribute("content")
    || document.querySelector("#activity-name")?.textContent
    || "",
  ).trim();
  // 壳页无 #js_name,公众号名在 cgiDataNew.nick_name;发布时间 create_time 是 'YYYY-MM-DD HH:mm' 字符串。
  const nickName = String(document.querySelector("#js_name")?.textContent || "").trim() || extractCgiString(html, "nick_name");
  const cardCreateTime = extractCgiString(html, "create_time");
  const cardPublishTime = cardCreateTime && /^\d{4}-\d{2}-\d{2}/.test(cardCreateTime) && !Number.isNaN(new Date(cardCreateTime.replace(" ", "T")).getTime())
    ? localIso(new Date(cardCreateTime.replace(" ", "T")))
    : "";
  const container = document.querySelector("#js_content");
  let contentHtml = "";
  let images = [];
  if (container && container.innerHTML.trim()) {
    images = promoteLazyImages(container);
    contentHtml = `<article class="weixin-article">${container.innerHTML}</article>`;
  } else {
    // DOM 被降级时正文仍在 window.cgiDataNew.content_noencode;两处都没有才是真冷却页。
    const fallback = extractFallbackContent(html);
    if (!fallback.contentHtml) {
      throw new Error("WeChat rate-limited this request (cooldown verification page); retry in a bit");
    }
    images = fallback.images;
    // 卡片壳的封面在 cgiDataNew.cdn_url(不在正文里):前置 img 标签进正文——本地化管线
    // 下载后会把正文里的 src 重写为 vault 路径,md 才有引用(只进 images 列表不会出现在 md)。
    const cover = extractCgiString(html, "cdn_url").replace(/^http:\/\//, "https://");
    if (/^https:\/\/mmbiz\.qpic\.cn/.test(cover)) {
      images.unshift(cover);
      fallback.contentHtml = `<p class="weixin-card-cover"><img src="${cover}" alt="封面" /></p>` + fallback.contentHtml;
    }
    contentHtml = `<article class="weixin-article">${fallback.contentHtml}</article>`;
  }

  return {
    title: title || "微信文章",
    byline: nickName || "微信公众号",
    siteName: "mp.weixin.qq.com",
    contentHtml,
    images,
    publishedAt: cardPublishTime,
    extractionMethod: "weixin",
    url: String(url),
    canonicalUrl: String(url),
    identityUrl: `weixin-article:${weixinArticleId(url)}`,
    extractionStatus: "complete",
  };
}

module.exports = { WEIXIN_UA, extractWeixinArticle, isWeixinArticleUrl, weixinArticleId };
