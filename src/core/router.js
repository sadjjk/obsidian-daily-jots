"use strict";

const { translate } = require("./i18n");
const { extractUrls } = require("./util");
const { getChannelMeta } = require("./settings");
const {
  formatRemoteAckText,
  formatRemoteCancelText,
  formatRemoteDisabledText,
  formatRemoteExportReceipt,
  formatRemoteHelpText,
  parseRemoteCommand,
  stripRemoteCommandNoise,
} = require("./remote-search");

function displayFolder(value, fallback) {
  return String(value || fallback).replace(/^\/+|\/+$/g, "").trim() || fallback;
}

function folderFromPath(filePath, fallback) {
  const parts = String(filePath || "").replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length > 1 ? parts.slice(0, -1).join("/") : fallback;
}

function displayTitle(value, locale = "zh-CN") {
  const fallback = translate(locale, "未命名网页", "Untitled web page");
  const title = String(value || fallback).replace(/\s+/g, " ").trim() || fallback;
  return title.length > 100 ? `${title.slice(0, 99)}…` : title;
}

function formatAgentGuide(result = {}, locale = "zh-CN") {
  return locale === "en"
    ? "Hi~ I'm your quick-capture ✍️ Send me anything to remember — it syncs straight into Obsidian."
    : "嗨~ 我是你的随手记✍️ 想记什么直接发给我，会同步保存在 Obsidian 里";
}

function formatHelpText(locale = "zh-CN", result = {}) {
  const commands = locale === "en" ? [
    "Available commands:",
    "• Send text, a voice note, an image, or a file: add it to today's note",
    "• Send a web link: extract articles, cloud documents, PDFs, images, technical-community posts, answers, and supported comment threads into a Markdown clipping",
    "• /clip <URL>: clip only the specified page",
    "• /status: show the current channel connection status",
    "• Remote search needs a space: search keyword. Without the space it is saved as diary text.",
    ...(result.remoteSearchEnabled ? [
      "",
      formatRemoteHelpText({ remoteSearch: { exportFormat: result.remoteExportFormat || "md" } }, "en"),
    ] : []),
  ] : [
    "可用指令：",
    "• 直接发送文字、语音、图片或文件：写入今天的笔记",
    "• 直接发送网页链接：提取文章、云文档、PDF、图片，以及社区媒体帖子、问答和支持的评论串，生成 Markdown 剪藏",
    "• /clip <链接>：只剪藏指定网页",
    "• /status：查看当前渠道连接状态",
    "• 远程查询必须加空格：查 关键词。写成「查手机卡」会当作普通日记记录。",
    ...(result.remoteSearchEnabled ? [
      "",
      formatRemoteHelpText({ remoteSearch: { exportFormat: result.remoteExportFormat || "md" } }, "zh-CN"),
    ] : []),
  ];
  return [formatAgentGuide(result, locale), "", ...commands].join("\n");
}

const HELP_TEXT = formatHelpText("zh-CN");

function formatCaptureReceipt(result, locale = "zh-CN", preview = null) {
  const clips = result.clips || [];
  const clipFailures = result.clipFailures?.length || 0;
  // 明细为 diary 层拼好的 "URL: 错误信息" 字符串;回复中只保留错误信息(链接已在日记里)
  const clipFailureDetails = Array.isArray(result.clipFailures) ? result.clipFailures : [];
  const failureReason = (line) => {
    const idx = String(line).indexOf(": ");
    return idx > 0 ? String(line).slice(idx + 2) : String(line);
  };
  const attachmentFailures = result.attachmentFailures?.length || 0;
  const attachmentExtractionFailures = result.attachmentExtractionFailures?.length || 0;
  const savedAttachments = Number(result.savedAttachments) || 0;
  const diaryFallback = translate(locale, "日记", "Daily");
  const clippingFallback = translate(locale, "全渠道剪藏", "Clippings");
  const diaryFolder = displayFolder(result.diaryFolder || folderFromPath(result.diaryPath, diaryFallback), diaryFallback);
  // 剪藏实际路径为 <分类>/<日期>/文件,显示到分类级(去掉文件名与日期段)
  const clipPathParts = String(clips[0]?.notePath || "").replace(/\\/g, "/").split("/").filter(Boolean);
  const clippingFolder = displayFolder(
    (clipPathParts.length > 2 ? clipPathParts.slice(0, -2).join("/") : "")
      || result.clippingFolder || folderFromPath(clips[0]?.notePath, clippingFallback),
    clippingFallback,
  );
  const chatFolder = displayFolder(result.attachmentChatFolder, "Attachments");
  const lines = [];

  // 保存结果预览:与笔记同源的 markdown 正文,滤掉图片与视频链接,保留换行,截断补 …。
  const buildPreviewLine = (clip) => {
    if (!preview?.enabled || !(Number(preview.chars) > 0)) return "";
    const markdown = String(clip.article?.markdown || "")
      .replace(/(?:\s*·\s*)?\[视频\]\([^)]*\)/g, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/<img\b[^>]*>/gi, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!markdown) return "";
    const chars = Number(preview.chars);
    return markdown.length > chars ? `${markdown.slice(0, chars)}…` : markdown;
  };
  const pushWithPreview = (line, clip) => {
    lines.push(line);
    const previewLine = buildPreviewLine(clip);
    if (previewLine) {
      lines.push("");
      lines.push(locale === "en"
        ? `Preview (first ${Number(preview.chars) || 200} chars):`
        : `预览如下，仅展示前 ${Number(preview.chars) || 200} 字：`);
      lines.push(previewLine);
    }
  };

  for (const clip of clips) {
    const title = displayTitle(clip.article?.title, locale);
    const savedImages = Math.max(0, Number(clip.savedImages) || 0);
    const failedImages = clip.imageFailures?.length || 0;
    // 超出单篇图片上限被跳过的图片:保留远程地址,不算保存失败,单独说明
    const skippedImages = clip.imageSkipped?.length || 0;
    const savedFiles = Math.max(0, Number(clip.savedFiles) || 0);
    const failedFiles = clip.fileFailures?.length || 0;
    const commentCount = Math.max(0, Number(clip.article?.commentCount) || 0);
    const isPdf = clip.article?.extractionMethod === "pdf-text";
    const pageCount = Math.max(0, Number(clip.article?.pageCount) || 0);
    if (clip.reused && !failedImages && !failedFiles) {
      lines.push(locale === "en"
        ? `🔖 “${title}” was already saved. Reused the clipping in “${clippingFolder}”.`
        : `🔖 《${title}》之前已经保存，已复用「${clippingFolder}」中的剪藏`);
      continue;
    }
    if (isPdf) {
      if (locale === "en") {
        const pages = pageCount ? `${pageCount}-page ` : "";
        if (clip.article?.extractionStatus === "partial") pushWithPreview(`⚠️ “${title}” was saved to “${clippingFolder}”, but only part of the ${pages}PDF text could be extracted.`, clip);
        else pushWithPreview(`🔖 “${title}” was saved to “${clippingFolder}” with the extracted ${pages}PDF text.${savedFiles ? " The original PDF was also saved." : ""}`, clip);
      } else if (clip.article?.extractionStatus === "partial") {
        pushWithPreview(`⚠️ 《${title}》已保存到「${clippingFolder}」，但${pageCount ? ` ${pageCount} 页` : ""} PDF 正文提取不完整`, clip);
      } else {
        pushWithPreview(`🔖 《${title}》已提取${pageCount ? ` ${pageCount} 页` : ""} PDF 正文并保存到「${clippingFolder}」${savedFiles ? "，并保留原 PDF" : ""}`, clip);
      }
      continue;
    }
    // 正文有无以 textless 显式标志为准:小红书纯图笔记本来就无文字
    // (excerpt 经 articleFromHtml 会 fallback 成标题,各平台语义不一,不可作判据)
    const hasBody = !clip.article?.textless;
    const enList = (textContent) => {
      const items = [];
      if (hasBody) items.push(textContent);
      if (commentCount) items.push(`${commentCount} comment${commentCount === 1 ? "" : "s"}`);
      items.push(`${savedImages} image${savedImages === 1 ? "" : "s"}`);
      if (items.length === 1) return items[0];
      if (items.length === 2) return `${items[0]} and ${items[1]}`;
      return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
    };
    const zhList = (textContent) => {
      const items = [];
      if (hasBody) items.push(textContent);
      if (commentCount) items.push(`${commentCount} 条评论`);
      items.push(`${savedImages} 张图片`);
      const last = items.pop();
      // 纯图片时带前导空格:与 "已提取/已保存" 拼出 "已提取 8 张图片"
      return items.length ? `${items.join("、")}和 ${last}` : ` ${last}`;
    };
    const extractedEn = enList("the full text");
    const partialEn = enList("the available text");
    const extractedZh = zhList("正文");
    const partialZh = zhList("正文片段");
    const savedFileDetail = savedFiles ? (locale === "en" ? ` The original source file was also saved.` : `，并保留 ${savedFiles} 个原文件`) : "";
    // 来源渠道标注(frontmatter platform 同源);普通网页无信息量,不标注
    const sourceLabel = String(clip.sourceLabel || "").trim();
    const sourceDetail = sourceLabel && sourceLabel !== "普通网页" ? (locale === "en" ? `, from ${sourceLabel}` : `，来自${sourceLabel}`) : "";
    const skippedDetail = skippedImages ? (locale === "en"
      ? `; ${skippedImages} more image${skippedImages === 1 ? "" : "s"} beyond the per-clipping limit kept their remote URLs`
      : `，另有 ${skippedImages} 张图片超出单篇上限已在正文保留原链`)
      : "";
    if (locale === "en") {
      if (clip.article?.extractionStatus === "partial") {
        const failed = [];
        if (failedImages) failed.push(`${failedImages} additional image${failedImages === 1 ? "" : "s"}`);
        if (failedFiles) failed.push(`${failedFiles} original file${failedFiles === 1 ? "" : "s"}`);
        const failedDetail = failed.length ? `; ${failed.join(" and ")} failed to save` : "";
        pushWithPreview(`⚠️ “${title}” was only partially extracted. ${partialEn[0].toUpperCase()}${partialEn.slice(1)} were saved to “${clippingFolder}”${sourceDetail}${failedDetail}${skippedDetail}.`, clip);
      } else if (failedImages || failedFiles) {
        const failed = [];
        if (failedImages) failed.push(`${failedImages} additional image${failedImages === 1 ? "" : "s"}`);
        if (failedFiles) failed.push(`${failedFiles} original file${failedFiles === 1 ? "" : "s"}`);
        pushWithPreview(`⚠️ “${title}” was saved to “${clippingFolder}”${sourceDetail} with ${extractedEn}; ${failed.join(" and ")} failed to save${skippedDetail}.`, clip);
      } else {
        pushWithPreview(`🔖 “${title}” was saved to “${clippingFolder}”${sourceDetail} with ${extractedEn}.${savedFileDetail}${skippedDetail}`, clip);
      }
    } else {
      if (clip.article?.extractionStatus === "partial") {
        const failedDetail = `${failedImages ? `，另有 ${failedImages} 张图片保存失败` : ""}${failedFiles ? `，${failedFiles} 个原文件保存失败` : ""}`;
        pushWithPreview(`⚠️ 《${title}》正文提取不完整，已保存${partialZh}到「${clippingFolder}」${sourceDetail}${failedDetail}${skippedDetail}`, clip);
      } else if (failedImages || failedFiles) {
        const failedDetail = `${failedImages ? `，另有 ${failedImages} 张图片保存失败` : ""}${failedFiles ? `，${failedFiles} 个原文件保存失败` : ""}`;
        pushWithPreview(`⚠️ 《${title}》已提取${extractedZh}并保存到「${clippingFolder}」${sourceDetail}${failedDetail}${skippedDetail}`, clip);
      } else {
        pushWithPreview(`🔖 《${title}》已提取${extractedZh}并保存到「${clippingFolder}」${sourceDetail}${savedFileDetail}${skippedDetail}`, clip);
      }
    }
  }


  if (locale === "en") {
    if (!clips.length && !clipFailures) lines.push(`✍️ Saved to today's note in “${diaryFolder}”.`);
    if (savedAttachments) lines.push(`📎 Saved ${savedAttachments} attachment${savedAttachments === 1 ? "" : "s"} to “${chatFolder}”.`);
    if (clipFailures) {
      lines.push(`⚠️ ${clipFailures} web page${clipFailures === 1 ? "" : "s"} could not be extracted. The original link${clipFailures === 1 ? " was" : "s were"} kept in today's note in “${diaryFolder}”.`);
      for (const detail of clipFailureDetails) lines.push(`Reason: ${failureReason(detail)}`);
    }
    if (attachmentFailures) lines.push(`⚠️ ${attachmentFailures} attachment${attachmentFailures === 1 ? "" : "s"} failed to save. The original message was kept in today's note in “${diaryFolder}”.`);
    if (attachmentExtractionFailures) lines.push(`⚠️ Text could not be extracted from ${attachmentExtractionFailures} saved PDF attachment${attachmentExtractionFailures === 1 ? "" : "s"}. The original PDF${attachmentExtractionFailures === 1 ? " was" : "s were"} kept.`);
  } else {
    if (!clips.length && !clipFailures) lines.push(`✍️ 已保存到今天的「${diaryFolder}」`);
    if (savedAttachments) lines.push(`📎 已保存 ${savedAttachments} 个附件到「${chatFolder}」`);
    if (clipFailures) {
      lines.push(`⚠️ ${clipFailures} 个网页未能提取正文，原始链接已保存在今天的「${diaryFolder}」`);
      for (const detail of clipFailureDetails) lines.push(`原因：${failureReason(detail)}`);
    }
    if (attachmentFailures) lines.push(`⚠️ ${attachmentFailures} 个附件保存失败，原消息已保存在今天的「${diaryFolder}」`);
    if (attachmentExtractionFailures) lines.push(`⚠️ ${attachmentExtractionFailures} 个 PDF 附件未能提取正文，原 PDF 已保存`);
  }
  const hasResults = clips.length > 0;
  if (hasResults) return lines.join("\n");
  return [formatAgentGuide({ ...result, diaryFolder }, locale), "", ...lines].join("\n");
}

async function sendReplyWithRetry(reply, text, delays = [0, 700, 2_000]) {
  let lastError;
  for (const delay of delays) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      await reply(text);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("回执发送失败");
}

class CaptureRouter {
  constructor(diary, getStatus, options = {}) {
    this.diary = diary;
    this.getStatus = getStatus;
    this.replyRetryDelays = options.replyRetryDelays || [0, 700, 2_000];
    this.getLocale = options.getLocale || (() => "zh-CN");
    this.getStorage = options.getStorage || (() => ({}));
    this.getRemoteSearch = options.getRemoteSearch || (() => ({ enabled: false, exportFormat: "md" }));
    this.remoteSearch = options.remoteSearch || null;
    this.getCaptureSettings = options.getCaptureSettings || (() => ({}));
  }

  async reply(envelope, text) {
    if (!envelope.reply) return;
    await sendReplyWithRetry(envelope.reply, text, this.replyRetryDelays);
  }

  async sendFile(envelope, file) {
    if (!file?.buffer) return { status: "unsupported" };
    if (typeof envelope.replyFile !== "function") return { status: "unsupported" };
    try {
      await envelope.replyFile(file);
      return { status: "sent" };
    } catch (error) {
      return { status: "failed", error: error?.message || String(error) };
    }
  }

  previewConfig() {
    const capture = this.getCaptureSettings() || {};
    return { enabled: capture.receiptPreview !== false, chars: Number(capture.receiptPreviewChars) || 200 };
  }

  helpContext() {
    const storage = this.getStorage() || {};
    const remote = this.getRemoteSearch() || {};
    return {
      diaryFolder: storage.diaryFolder,
      remoteSearchEnabled: remote.enabled === true,
      remoteExportFormat: remote.exportFormat || "md",
    };
  }

  async handleRemoteCommand(envelope, command, locale) {
    if (this.getRemoteSearch()?.enabled !== true) {
      await this.reply(envelope, formatRemoteDisabledText(locale));
      return { command: `remote-${command.type}`, ignored: "remote-disabled" };
    }
    if (command.type === "help") {
      await this.reply(envelope, formatRemoteHelpText({ remoteSearch: this.getRemoteSearch() }, locale));
      return { command: "remote-help" };
    }
    if (!this.remoteSearch) {
      await this.reply(envelope, translate(locale, "远程查询服务尚未就绪。", "Remote search is not ready."));
      return { command: `remote-${command.type}`, error: "unavailable" };
    }
    const owner = { channel: envelope.channel, senderId: envelope.senderId };
    if (command.type === "cancel") {
      this.remoteSearch.clearOwner(owner.channel, owner.senderId);
      await this.remoteSearch.persist();
      await this.reply(envelope, formatRemoteCancelText(locale));
      return { command: "remote-cancel" };
    }
    if (command.type === "search") {
      try {
        await this.reply(envelope, formatRemoteAckText("search", locale));
        const result = await this.remoteSearch.search(command.keyword, owner);
        await this.reply(envelope, locale === "en" ? result.replyEn : result.replyZh);
        return { command: "remote-search", session: result.session };
      } catch (error) {
        await this.reply(envelope, translate(locale, "查询失败：{error}", "Search failed: {error}", { error: error?.message || error }));
        return { command: "remote-search", error: error?.message || String(error) };
      }
    }
    if (command.type === "export") {
      if (!command.indexes) {
        await this.reply(envelope, translate(locale, "请回复编号，例如：确认 1,3", "Reply with numbers, for example: confirm 1,3"));
        return { command: "remote-export", error: "missing-indexes" };
      }
      try {
        await this.reply(envelope, formatRemoteAckText("export", locale));
        const file = await this.remoteSearch.createExport(command.queryId, command.indexes, owner);
        const delivery = await this.sendFile(envelope, file);
        const channelName = getChannelMeta(envelope.channel, locale).name || envelope.channel || translate(locale, "该渠道", "this channel");
        await this.reply(envelope, formatRemoteExportReceipt(file, channelName, locale, delivery.status, delivery.error));
        return { command: "remote-export", file, delivery };
      } catch (error) {
        await this.reply(envelope, translate(locale, "导出失败：{error}", "Export failed: {error}", { error: error?.message || error }));
        return { command: "remote-export", error: error?.message || String(error) };
      }
    }
    return { command: "remote-unknown" };
  }

  async handle(envelope) {
    const text = stripRemoteCommandNoise(envelope.text);
    const appLocale = this.getLocale();
    if (text === "/help" || text.toLowerCase() === "help" || text === "帮助" || text === "幫助") {
      const locale = text.toLowerCase() === "help" ? "en" : (text === "幫助" || text === "帮助" ? "zh-CN" : appLocale);
      await this.reply(envelope, formatHelpText(locale, this.helpContext()));
      return { command: "help" };
    }
    const remoteCommand = parseRemoteCommand(text);
    if (remoteCommand) return this.handleRemoteCommand(envelope, remoteCommand, remoteCommand.locale || appLocale);
    const locale = appLocale;
    if (text === "/status") {
      const status = this.getStatus();
      const connected = Object.values(status).filter((item) => item.state === "connected").length;
      await this.reply(envelope, locale === "en"
        ? `Omnichannel Diary: ${connected} ${connected === 1 ? "channel" : "channels"} online. Data is written only to the current Vault.`
        : `Omnichannel Diary：${connected} 个渠道在线，数据只写入当前 Vault。`);
      return { command: "status" };
    }
    if (text.startsWith("/clip")) {
      const url = extractUrls(text)[0];
      if (!url) {
        await this.reply(envelope, translate(locale, "请使用 /clip https://example.com", "Use /clip https://example.com"));
        return { command: "clip", error: "missing-url" };
      }
      envelope.text = url;
    }
    const result = await this.diary.capture(envelope);
    if (result.ignored === "duplicate" && result.pendingReceipt && envelope.reply) {
      await this.reply(envelope, result.pendingReceipt);
      await this.diary.completeReceipt?.(result.messageKey);
      return result;
    }
    if (envelope.reply && !result.ignored) {
      const receipt = formatCaptureReceipt(result, locale, this.previewConfig());
      await this.diary.queueReceipt?.(result.messageKey, receipt);
      await this.reply(envelope, receipt);
      await this.diary.completeReceipt?.(result.messageKey);
    }
    return result;
  }
}

module.exports = { CaptureRouter, HELP_TEXT, formatAgentGuide, formatCaptureReceipt, formatHelpText, sendReplyWithRetry };
