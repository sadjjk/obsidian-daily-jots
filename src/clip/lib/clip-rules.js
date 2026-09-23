"use strict";

const { parseXStatusUrl } = require("../social-media/xclip");
const { isBilibiliUrl } = require("../social-media/biliclip");
const { isXiaohongshuUrl } = require("../social-media/xhsclip");
const { isWeiboArticleUrl, isWeiboSearchUrl, isWeiboStatusUrl } = require("../social-media/weiboclip");
const { isDouyinUrl } = require("../social-media/douyinclip");
const { sourceNameForUrl } = require("./source-names");
const { documentServiceForUrl } = require("./web-platforms");
const { joinRoot } = require("../../core/util");

const CLIP_FAMILY_IDS = ["articles", "social", "documents"];

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
    zhDesc: "微博、知乎、小红书、抖音等；完整来源见下方「社区媒体来源」清单",
    enDesc: "Weibo, Zhihu, Xiaohongshu, Douyin, and more; see the Community-media sources list below",
  },
  documents: {
    id: "documents",
    zh: "云文档",
    en: "Cloud documents",
    defaultFolder: "Documents",
    zhDesc: "飞书 / Lark、腾讯文档、WPS、钉钉文档等；完整平台与登录入口见下方「云文档来源」",
    enDesc: "Feishu / Lark, Tencent Docs, WPS, DingTalk Docs, and more; see the Cloud-document sources list below for the full platform list and sign-in",
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
  const root = joinRoot(
    String(settings?.storage?.rootFolder || "Omnichannel Diary"),
    String(settings?.storage?.clippingFolder || "Clippings"),
  );
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
