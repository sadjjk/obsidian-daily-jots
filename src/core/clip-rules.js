"use strict";

const { parseXStatusUrl } = require("./xclip");
const { isBilibiliUrl } = require("./biliclip");
const { isXiaohongshuUrl } = require("./xhsclip");
const { isWeiboArticleUrl, isWeiboSearchUrl, isWeiboStatusUrl } = require("./weiboclip");
const { isDouyinUrl } = require("./douyinclip");
const { sourceNameForUrl } = require("./source-names");
const { documentServiceForUrl, isLikelyPdfUrl } = require("./web-platforms");

const CLIP_FAMILY_IDS = ["articles", "social", "documents", "pdfs"];

const CLIP_FAMILIES = {
  articles: {
    id: "articles",
    zh: "普通网页",
    en: "Articles",
    defaultFolder: "Articles",
    zhDesc: "未被来源表收录的网站兜底(个人博客、官方博客、未收录新站)",
    enDesc: "Fallback for sites not in the source table (personal blogs, official blogs, and unlisted sites)",
  },
  social: {
    id: "social",
    zh: "社区媒体",
    en: "Community media",
    defaultFolder: "Social",
    zhDesc: "社交平台、新闻媒体和技术社区(微博、知乎、小红书、抖音、腾讯新闻、掘金等,含对应海外站点)",
    enDesc: "Social platforms, news media, tech communities, and their overseas peers",
  },
  documents: {
    id: "documents",
    zh: "云文档",
    en: "Cloud documents",
    defaultFolder: "Documents",
    zhDesc: "飞书 / Lark、腾讯文档、WPS、Google Docs / Sheets / Slides、Microsoft 365 / OneDrive",
    enDesc: "Feishu / Lark, Tencent Docs, WPS, Google Docs / Sheets / Slides, and Microsoft 365 / OneDrive",
  },
  pdfs: {
    id: "pdfs",
    zh: "PDF",
    en: "PDFs",
    defaultFolder: "PDFs",
    zhDesc: "在线 PDF 和聊天里的 PDF 附件",
    enDesc: "Online PDFs and PDF attachments from chat",
  },
};

function defaultClipRules() {
  return Object.fromEntries(CLIP_FAMILY_IDS.map((id) => [id, {
    enabled: true,
    folder: CLIP_FAMILIES[id].defaultFolder,
  }]));
}

function sanitizeSubfolder(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.{2,}/g, ".")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
}

function normalizeClipRules(saved) {
  const defaults = defaultClipRules();
  const source = saved && typeof saved === "object" ? saved : {};
  const output = {};
  for (const id of CLIP_FAMILY_IDS) {
    const incoming = source[id] && typeof source[id] === "object" ? source[id] : {};
    output[id] = {
      enabled: incoming.enabled !== false,
      folder: Object.prototype.hasOwnProperty.call(incoming, "folder")
        ? sanitizeSubfolder(incoming.folder)
        : defaults[id].folder,
    };
  }
  return output;
}

function isWeChatArticleUrl(value) {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "") === "mp.weixin.qq.com";
  } catch (_) {
    return false;
  }
}

function classifyClipFamily(url, article = null, settings = null) {
  const raw = String(article?.url || url || "");
  const method = String(article?.extractionMethod || "");
  if (
    raw.startsWith("attachment:")
    || method === "pdf-text"
    || /pdf/i.test(method)
    || isLikelyPdfUrl(raw)
  ) return "pdfs";
  if (documentServiceForUrl(raw) || method.includes("rendered-document")) return "documents";
  if (parseXStatusUrl(raw) || isXiaohongshuUrl(raw) || isWeChatArticleUrl(raw) || isBilibiliUrl(raw)
    || isWeiboSearchUrl(raw) || isWeiboStatusUrl(raw) || isWeiboArticleUrl(raw) || isDouyinUrl(raw)
    || method.includes("xiaohongshu") || method.includes("wechat-article") || method.includes("bilibili")
    || method.includes("weibo") || method.includes("douyin") || method.includes("zhihu")
    || /^x-/.test(method)) {
    return "social";
  }
  // 来源映射命中(内置 + 自定义)即社区媒体;未命中一律兜底普通网页。
  if (sourceNameForUrl(raw, settings)) return "social";
  return "articles";
}

function isClipFamilyEnabled(settings, family) {
  const id = CLIP_FAMILIES[family] ? family : "articles";
  const rules = normalizeClipRules(settings?.capture?.clipRules);
  return rules[id].enabled !== false;
}

function resolveClipFolder(settings, family) {
  const id = CLIP_FAMILIES[family] ? family : "articles";
  const root = String(settings?.storage?.clippingFolder || "Omnichannel Diary/Clippings")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  const subfolder = normalizeClipRules(settings?.capture?.clipRules)[id].folder;
  return subfolder ? `${root}/${subfolder}` : root;
}

function clipFamilyLabel(family, locale = "zh-CN") {
  const meta = CLIP_FAMILIES[family] || CLIP_FAMILIES.articles;
  return locale === "en" ? meta.en : meta.zh;
}

module.exports = {
  CLIP_FAMILIES,
  CLIP_FAMILY_IDS,
  classifyClipFamily,
  clipFamilyLabel,
  defaultClipRules,
  isClipFamilyEnabled,
  isWeChatArticleUrl,
  normalizeClipRules,
  resolveClipFolder,
  sanitizeSubfolder,
};
