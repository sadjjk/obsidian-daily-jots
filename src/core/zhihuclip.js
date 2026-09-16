"use strict";

const { parseHTML } = require("linkedom");
const { readLimitedBody, safeFetch } = require("./network");

const ZHIHU_HTML_LIMIT = 5 * 1024 * 1024;
const ZHIHU_CHALLENGE_PATTERN = /安全验证|系统监测到您的网络环境|请完成身份验证|verify you are human/i;

function hostMatches(hostname, suffix) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  return host === suffix || host.endsWith(`.${suffix}`);
}

function isZhihuUrl(value) {
  try {
    return hostMatches(new URL(value).hostname, "zhihu.com");
  } catch (_) { return false; }
}

function isZhihuNoteUrl(value) {
  return Boolean(answerUrlParts(value) || articleIdFromUrl(value) || questionIdFromUrl(value));
}

function answerUrlParts(value) {
  try {
    const match = new URL(value).pathname.match(/\/question\/(\d+)\/answer\/(\d+)/i);
    return match ? { questionId: match[1], answerId: match[2] } : null;
  } catch (_) { return null; }
}

function articleIdFromUrl(value) {
  try {
    return new URL(value).pathname.match(/\/p\/(\d+)/i)?.[1] || "";
  } catch (_) { return ""; }
}

// Pure question page (/question/{id}, no /answer/{id} suffix).
function questionIdFromUrl(value) {
  try {
    return new URL(value).pathname.match(/\/question\/(\d+)\/?$/i)?.[1] || "";
  } catch (_) { return ""; }
}

function parseInitialData(html) {
  const { document } = parseHTML(String(html || ""));
  const script = document.querySelector("#js-initialData")
    || [...document.querySelectorAll("script")].find((candidate) => /js-initialData|"initialState"/.test(candidate.textContent || ""));
  if (!script) return null;
  try { return JSON.parse(script.textContent || ""); } catch (_) { return null; }
}

// Content snippets (answer/article HTML from initial-data or DOM) are fragments;
// linkedom only builds <body> for complete documents, so wrap them explicitly.
function parseFragment(html) {
  return parseHTML(`<!doctype html><html><head></head><body>${String(html || "")}</body></html>`).document;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function absoluteZhihuImage(value) {
  const source = String(value || "").trim();
  if (!source) return "";
  try { return new URL(source, "https://www.zhihu.com").toString(); } catch (_) { return ""; }
}

function normalizeContentImages(html) {
  const document = parseFragment(html);
  const body = document.body;
  if (!body) return String(html || "");
  for (const image of body.querySelectorAll("img")) {
    const candidate = image.getAttribute("data-actualsrc") || image.getAttribute("data-original")
      || image.getAttribute("data-src") || image.getAttribute("src");
    const resolved = absoluteZhihuImage(candidate);
    if (resolved) image.setAttribute("src", resolved);
    for (const attribute of ["data-actualsrc", "data-original", "data-src", "srcset"]) image.removeAttribute(attribute);
  }
  return body.innerHTML;
}

function collectImages(contentHtml) {
  const document = parseFragment(contentHtml);
  return [...new Set([...(document.querySelectorAll("img[src]") || [])]
    .map((image) => image.getAttribute("src"))
    .filter((src) => /^https:/i.test(src || "")))];
}

function textFromHtml(html) {
  const document = parseFragment(html);
  return String(document.body?.textContent || "").replace(/\s+/g, " ").trim();
}

function secondsToIso(seconds) {
  const numeric = Number(seconds);
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  const date = new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function formatVoteup(count) {
  const numeric = Number(count);
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  return numeric >= 1000 ? `${(numeric / 1000).toFixed(1).replace(/\.0$/, "")}K` : String(numeric);
}

function userName(value, users) {
  if (!value) return "";
  if (typeof value === "object") return String(value.name || "").trim();
  return String(users?.[value]?.name || "").trim();
}

function questionTitle(value, questions) {
  if (!value) return "";
  if (typeof value === "object") return String(value.title || "").trim();
  return String(questions?.[value]?.title || "").trim();
}

function initialStateEntities(state) {
  // 真实页面顶层是 {"initialState":{"entities":...}};容忍少数变体直接内联 entities
  return state?.initialState?.entities || state?.entities || {};
}

function answerFromInitialState(state, answerId, questionId) {
  const entities = initialStateEntities(state);
  const answers = entities.answers || {};
  const entry = (answerId && answers[answerId]) || Object.values(answers).find((candidate) => candidate?.content);
  if (!entry?.content) return null;
  return {
    title: questionTitle(entry.question || questionId, entities.questions || {}),
    author: userName(entry.author, entities.users || {}),
    contentHtml: String(entry.content || ""),
    createdTime: entry.createdTime,
    voteupCount: entry.voteupCount,
  };
}

function articleFromInitialState(state, articleId) {
  const entities = initialStateEntities(state);
  const articles = entities.articles || {};
  const entry = (articleId && articles[articleId]) || Object.values(articles).find((candidate) => candidate?.content);
  if (!entry?.content) return null;
  return {
    title: String(entry.title || "").trim(),
    author: userName(entry.author, entities.users || {}),
    contentHtml: String(entry.content || ""),
    createdTime: entry.created,
    voteupCount: entry.voteupCount,
  };
}

function answerFromDom(html) {
  const { document } = parseHTML(String(html || ""));
  const title = String(document.querySelector(".QuestionHeader-title")?.textContent || "").trim();
  const rich = document.querySelector(".RichContent-inner");
  if (!rich || !title) return null;
  const author = String(document.querySelector(".AuthorInfo meta[itemprop='name']")?.getAttribute("content")
    || document.querySelector("meta[name='author']")?.getAttribute("content") || "").trim();
  return { title, author, contentHtml: rich.innerHTML || "", createdTime: 0, voteupCount: 0 };
}

function articleFromDom(html) {
  const { document } = parseHTML(String(html || ""));
  const title = String(document.querySelector(".Post-Title")?.textContent || document.querySelector("h1")?.textContent || "").trim();
  const rich = document.querySelector(".Post-RichText") || document.querySelector(".RichContent-inner");
  if (!rich || !title) return null;
  const author = String(document.querySelector("meta[name='author']")?.getAttribute("content") || "").trim();
  return { title, author, contentHtml: rich.innerHTML || "", createdTime: 0, voteupCount: 0 };
}

// Question entities ride the same initialState shape as answers: the question
// itself plus the first screen of answer entities (the page lazy-loads more).
function questionFromInitialState(state, questionId) {
  const entities = initialStateEntities(state);
  const question = (questionId && entities.questions?.[questionId]) || null;
  const answers = Object.values(entities.answers || {}).filter((candidate) => candidate?.content);
  if (!question && answers.length === 0) return null;
  return {
    title: String(question?.title || "").trim(),
    detailHtml: String(question?.detail || ""),
    answerCount: Number(question?.answerCount ?? 0),
    followerCount: Number(question?.followerCount ?? 0),
    createdTime: question?.createdTime ?? question?.created ?? 0,
    answers: answers.map((entry) => ({
      author: userName(entry.author, entities.users || {}),
      contentHtml: String(entry.content || ""),
      createdTime: entry.createdTime,
      voteupCount: entry.voteupCount,
    })),
  };
}

function questionDataFromState(state, questionId, finalUrl) {
  const base = questionFromInitialState(state, questionId);
  if (!base) return null;
  const detailHtml = base.detailHtml ? normalizeContentImages(base.detailHtml) : "";
  const sections = base.answers.map((entry) => {
    const contentHtml = normalizeContentImages(entry.contentHtml);
    const voteup = formatVoteup(entry.voteupCount);
    const author = entry.author ? escapeHtml(entry.author) : "匿名用户";
    return `<section class="zhihu-answer"><p class="zhihu-answer-meta">${author}${voteup ? ` · ${voteup} 赞同` : ""}</p>${contentHtml}</section>`;
  });
  const detailText = detailHtml ? textFromHtml(detailHtml) : "";
  const answerTexts = base.answers.map((entry) => textFromHtml(entry.contentHtml));
  const plainText = [base.title, detailText, ...answerTexts].filter(Boolean).join("\n").trim();
  if (!plainText) return null;
  const title = base.title.replace(/\s+/g, " ").trim().slice(0, 160);
  const canonicalUrl = `https://www.zhihu.com/question/${questionId}`;
  const answerCountNote = base.answerCount > base.answers.length
    ? `<p class="zhihu-question-meta">共 ${base.answerCount} 个回答,已收录首屏 ${base.answers.length} 条</p>`
    : "";
  return {
    url: finalUrl,
    canonicalUrl,
    identityUrl: canonicalUrl,
    title,
    byline: "",
    excerpt: (detailText || answerTexts[0] || title).replace(/\s+/g, " ").slice(0, 240),
    siteName: "知乎",
    contentHtml: `<article class="zhihu-content"><h1>${escapeHtml(title)}</h1>${detailHtml ? `<div class="zhihu-question-detail">${detailHtml}</div>` : ""}<p class="zhihu-question-meta">${base.answerCount} 个回答${base.followerCount ? ` · ${base.followerCount} 人关注` : ""}</p>${sections.join("")}${answerCountNote}</article>`,
    plainText: `${title}\n${plainText}`,
    images: collectImages([detailHtml, ...base.answers.map((entry) => entry.contentHtml)].join("")),
    publishedAt: secondsToIso(base.createdTime),
    extractionMethod: state ? "zhihu-initial-state" : "zhihu-dom",
    extractionStatus: plainText.length >= 60 ? "complete" : "partial",
  };
}

function zhihuDataFromHtml(html, finalUrl) {
  if (!isZhihuUrl(finalUrl)) return null;
  const answerParts = answerUrlParts(finalUrl);
  const articleId = articleIdFromUrl(finalUrl);
  const questionId = questionIdFromUrl(finalUrl);
  if (!answerParts && !articleId && !questionId) return null;
  const state = parseInitialData(html);
  if (questionId) return questionDataFromState(state, questionId, finalUrl);
  let base = null;
  let kind = "answer";
  if (answerParts) base = answerFromInitialState(state, answerParts.answerId, answerParts.questionId);
  if (!base && articleId) {
    base = articleFromInitialState(state, articleId);
    kind = "article";
  }
  if (!base && answerParts) base = answerFromDom(html);
  if (!base && articleId) base = articleFromDom(html);
  const contentHtml = base ? normalizeContentImages(base.contentHtml) : "";
  const plainText = contentHtml ? textFromHtml(contentHtml) : "";
  if (!plainText) return null;
  const title = String(base.title || plainText).replace(/\s+/g, " ").trim().slice(0, 160);
  const voteup = formatVoteup(base.voteupCount);
  const identityPath = answerParts
    ? `question/${answerParts.questionId}/answer/${answerParts.answerId}`
    : `p/${articleId}`;
  const canonicalUrl = `https://www.zhihu.com/${identityPath}`;
  return {
    url: finalUrl,
    canonicalUrl,
    identityUrl: canonicalUrl,
    title,
    byline: String(base.author || "").trim(),
    excerpt: plainText.slice(0, 240),
    siteName: kind === "article" ? "知乎专栏" : "知乎",
    contentHtml: `<article class="zhihu-content"><h1>${escapeHtml(title)}</h1>${contentHtml}${voteup ? `<p>${voteup} 赞同</p>` : ""}</article>`,
    plainText: `${title}\n${plainText}`,
    images: collectImages(contentHtml),
    publishedAt: secondsToIso(base.createdTime),
    extractionMethod: state ? "zhihu-initial-state" : "zhihu-dom",
    extractionStatus: plainText.length >= 60 ? "complete" : "partial",
  };
}

async function extractZhihu(value, fetchImpl = safeFetch, cookieProvider = null) {
  if (!isZhihuUrl(value)) return null;
  const baseOptions = {
    // Mirror omni-article-markdown's request surface for Zhihu exactly.
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    headers: { "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" },
    timeoutMs: 30_000,
  };
  let { response, finalUrl } = await fetchImpl(value, baseOptions);
  if ([403, 429].includes(response.status) && cookieProvider) {
    // 知乎对无 cookie 请求硬风控(403/40362):从隔离会话的持久 profile 取 cookie 后重试一次
    const cookieHeader = await cookieProvider(value);
    if (cookieHeader) {
      ({ response, finalUrl } = await fetchImpl(value, {
        ...baseOptions,
        headers: { ...baseOptions.headers, cookie: cookieHeader, referer: "https://www.zhihu.com/" },
      }));
    }
  }
  if (!response.ok) throw new Error(`Zhihu page returned HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("html") && !contentType.includes("xml")) {
    throw new Error(`Unsupported Zhihu page type: ${contentType || "unknown"}`);
  }
  const html = (await readLimitedBody(response, ZHIHU_HTML_LIMIT)).toString("utf8");
  const data = zhihuDataFromHtml(html, finalUrl);
  if (!data && isZhihuNoteUrl(finalUrl)) {
    throw new Error(
      `Zhihu extraction failed: no note data in page (HTTP ${response.status}, ${html.length} bytes, `
      + `${ZHIHU_CHALLENGE_PATTERN.test(html) ? "verification challenge detected" : "no challenge marker"}). `
      + `Open its isolated session in plugin settings once to refresh cookies, or retry later.`,
    );
  }
  return data;
}

module.exports = {
  ZHIHU_HTML_LIMIT,
  extractZhihu,
  isZhihuNoteUrl,
  isZhihuUrl,
  parseInitialData,
  zhihuDataFromHtml,
};
