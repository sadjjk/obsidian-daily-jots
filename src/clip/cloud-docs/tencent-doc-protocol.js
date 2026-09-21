// 腾讯系文档(腾讯文档 docs.qq.com / 企微文档 doc.weixin.qq.com)共享 opendoc 协议层:
// 接口 URL 拼装、mutations 解析、markdown 转换、渲染页 chrome 清洗。
// 两个产品同内核同协议,但字号体系/控制字符标记可能存在差异——结构差异靠诊断日志暴露,不靠猜。
const { readLimitedBody } = require("../../core/network");
const { localIso } = require("../../core/util");

// 渲染页工具栏/菜单按钮以短行混入正文(菜单/插入/标题 1/默认字体/快捷工具…),
// 以及 "View only / Log in now" 只读横幅;按完全锚定的短行黑名单剥离,不碰长正文行。
const TENCENT_UI_LINE = new RegExp("^(?:" + [
  "菜单", "插入", "更多", "大纲", "打印", "保存", "撤销", "重做", "查找", "替换",
  "视图", "帮助", "反馈", "分享", "评论", "收藏", "导出", "下载", "关闭", "取消",
  "复制", "粘贴", "剪切", "加粗", "斜体", "下划线", "删除线", "字体", "字号", "默认字体",
  "小二", "小四", "四号", "五号", "正文", "引用", "高亮", "批注", "表格", "图片",
  "链接", "代码块", "分隔线", "页面", "缩放", "快捷工具", "PDF转换", "生成图片", "排版美化",
  "腾讯文档", "微信", "QQ", "登录", "注册", "扫码", "标题\\s?\\d?", "text", "正在同步内容\\S*",
].join("|") + ")$", "i");

function stripTencentChrome(markdown) {
  return String(markdown || "").split("\n").filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    if (trimmed.length <= 14 && TENCENT_UI_LINE.test(trimmed)) return false;
    // 编辑器字体宽度测量串(mmmmmmmmmmlli1ƒ⁇! 形态),行超长但只含度量字符
    if (/^m{3,}[a-z0-9!ƒ⁇.·]*$/i.test(trimmed)) return false;
    if (trimmed.length <= 60 && /^(view only|log in now|log in to|login\b)/i.test(trimmed)) return false;
    return true;
  }).join("\n");
}

function tencentHostForUrl(url) {
  const host = String(url || "").replace(/^https?:\/\//i, "").split("/")[0].toLowerCase();
  if (host === "docs.qq.com" || host.endsWith(".docs.qq.com")) return "docs.qq.com";
  if (host === "doc.weixin.qq.com" || host.endsWith(".doc.weixin.qq.com")) return "doc.weixin.qq.com";
  return "";
}

// 会话服务按 host 分流:doc.weixin.qq.com 用独立的 wecomdoc 会话(cookie 与腾讯文档互不共享)
function tencentSessionServiceForUrl(url) {
  return tencentHostForUrl(url) === "doc.weixin.qq.com" ? "wecomdoc" : "tencent";
}

function tencentSiteNameForUrl(url) {
  return tencentHostForUrl(url) === "doc.weixin.qq.com" ? "企微文档" : "腾讯文档";
}

function tencentDocApiUrl(url) {
  const host = tencentHostForUrl(url);
  if (!host) throw new Error("不是腾讯文档链接");
  const parsed = new URL(url);
  const docId = parsed.searchParams.get("id") || parsed.pathname.split("/").filter(Boolean).pop();
  if (!docId) throw new Error("无法从链接解析腾讯文档 ID");
  const params = new URLSearchParams({ id: docId, normal: "1", noEscape: "1", outformat: "1", doc_chunk_flag: "1", t: String(Date.now()) });
  const scode = parsed.searchParams.get("scode");
  if (scode) params.set("scode", scode);
  return `https://${host}/dop-api/opendoc?${params.toString()}`;
}

// 深度优先按谓词取值(key, value 双参);这里路径已知,主要用于容错与元数据宽匹配
function pickTencentValue(payload, match) {
  const walk = (node, key) => {
    if (!node || typeof node !== "object") return undefined;
    if (Array.isArray(node)) {
      for (const item of node) { const hit = walk(item, key); if (hit !== undefined) return hit; }
      return undefined;
    }
    for (const [childKey, value] of Object.entries(node)) {
      if (match(childKey, value)) return value;
      if (value && typeof value === "object") { const hit = walk(value, childKey); if (hit !== undefined) return hit; }
    }
    return undefined;
  };
  return walk(payload, "");
}

// 企微文档段落样式(pStyle,挂在段尾 \r 位置):2026-09-20 按真实 opendoc 返回实测校准。
// 腾讯文档标题走 run.sz 字号,企微走段落样式 id;未知样式按正文处理并打诊断日志。
const PARAGRAPH_STYLE_HEADING = { rdbvau: 1, wb5joj: 2, "4gbizg": 3, wkxqic: 4 };
const PARAGRAPH_STYLE_CODE = new Set(["phispn"]);
const PARAGRAPH_STYLE_BODY = new Set(["ablt93"]);
const KNOWN_PARAGRAPH_STYLES = new Set([...Object.keys(PARAGRAPH_STYLE_HEADING), ...PARAGRAPH_STYLE_CODE, ...PARAGRAPH_STYLE_BODY]);

function parseTencentDocPayload(payload) {  const clientVars = payload && payload.clientVars;
  if (!clientVars) throw new Error("opendoc 响应缺少 clientVars");
  const textRoot = clientVars?.collab_client_vars?.initialAttributedText?.text;
  const commands = Array.isArray(textRoot)
    ? textRoot.flatMap((item) => (Array.isArray(item?.commands) ? item.commands : []))
    : [];
  const mutations = commands.flatMap((command) => (Array.isArray(command?.mutations) ? command.mutations : []));
  const seed = mutations.find((m) => typeof m?.s === "string" && m.s.length);
  if (!seed) throw new Error("opendoc 响应里没有文本 mutations");
  const rawText = mutations.filter((m) => typeof m?.s === "string").map((m) => m.s).join("");

  const formatMap = {};
  const imageMap = {};
  // 段落级属性挂在段尾 \r 的位置上(bi=ei-1 指向段落标记符):企微文档标题/代码走 pStyle 而非字号
  const paraStyleAt = {};
  const blockQuoteAt = {};
  for (const m of mutations) {
    if (m?.ty !== "mp" || typeof m.bi !== "number") continue;
    if (m.pr?.paragraph?.pStyle?.val) paraStyleAt[m.bi] = m.pr.paragraph.pStyle.val;
    if (m.pr?.paragraph?.blockQuote) blockQuoteAt[m.bi] = true;
    const pr = m.pr;
    const run = pr.run || {};
    const { bi, ei } = m;
    let heading = 0;
    const size = Number(run.sz?.val);
    if (size >= 480) heading = 1;
    else if (size >= 360) heading = 2;
    else if (size >= 300) heading = 3;
    else if (size >= 260) heading = 4;
    for (let i = bi; i < ei; i++) {
      if (heading) { formatMap[i] = formatMap[i] || {}; formatMap[i].heading = heading; }
      if (run.b?.val === true) { formatMap[i] = formatMap[i] || {}; formatMap[i].bold = true; }
      if (run.i?.val === true) { formatMap[i] = formatMap[i] || {}; formatMap[i].italic = true; }
      if (run.strike?.val === true) { formatMap[i] = formatMap[i] || {}; formatMap[i].strike = true; }
      if (run.bgclr?.val) { formatMap[i] = formatMap[i] || {}; formatMap[i].code = true; }
    }
    const pic = pr.drawing?.inlineKeyword?.graphic?.graphicData?.pic;
    const imageUrl = pic?.blipFill?.blip?.embed;
    if (typeof imageUrl === "string" && /^https?:/i.test(imageUrl)) {
      const width = Number(imageUrl.match(/[?&]w=(\d+)/)?.[1]) || null;
      const height = Number(imageUrl.match(/[?&]h=(\d+)/)?.[1]) || null;
      imageMap[bi] = { url: imageUrl, width, height, descr: pic?.nvPicPr?.cNvPr?.descr || "image" };
    }
  }

  // 诊断日志:结构差异(标题字号体系/代码块标记/元数据字段)靠真实返回暴露,不靠猜
  try {
    const runKeys = [...new Set(mutations.flatMap((m) => Object.keys(m?.pr || {})))].join(",");
    const runSubKeys = [...new Set(mutations.flatMap((m) => Object.keys(m?.pr?.run || {})))].join(",");
    const ctrl = [...new Set(rawText.match(/[\x01-\x1f]/g) || [])].map((c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`).join(" ");
    const metaCandidates = {};
    (function collect(node) {
      if (!node || typeof node !== "object" || Array.isArray(node)) return;
      for (const [key, value] of Object.entries(node)) {
        if (/(create|modify|owner|creator|author)/i.test(key) && (typeof value === "string" || typeof value === "number")) metaCandidates[key] = value;
        else if (value && typeof value === "object") collect(value);
      }
    })(clientVars);
    const unknownStyles = [...new Set(Object.values(paraStyleAt))].filter((s) => !KNOWN_PARAGRAPH_STYLES.has(s));
    if (unknownStyles.length) console.warn(`[omnichannel] opendoc 未知段落样式: [${unknownStyles.join(",")}] 按正文处理,请反馈校准`);
    console.warn(`[omnichannel] opendoc 结构: mutations=${mutations.length} pr=[${runKeys}] run=[${runSubKeys}] 控制字符=[${ctrl || "无"}] clientVars=[${Object.keys(clientVars).join(",")}] 元数据候选=${JSON.stringify(metaCandidates)}`);
  } catch (_) { /* 诊断日志不影响主流程 */ }

  // 作者:优先文档创建者(owner/creator);clientVars.userName 是当前登录者(剪藏人),仅兜底。
  // 接口返回的创建者只有 id(run.author/creatorId/ownerId 形如 "p.1310..." 或长数字),id 不是名字,一律排除
  const ID_LIKE = /^p\.?\d+$|^\d{6,}$/;
  let author = "";
  const ownerNode = pickTencentValue(payload, (key, value) => /^(owner|creator)$/i.test(key) && value != null && value !== "" && !ID_LIKE.test(String(value)));
  if (typeof ownerNode === "string") {
    author = ownerNode.trim();
  } else if (ownerNode && typeof ownerNode === "object") {
    const ownerName = pickTencentValue(ownerNode, (key, value) => /^(name|user_?name|nick_?name)$/i.test(key) && typeof value === "string" && value.trim() && !ID_LIKE.test(value));
    author = ownerName ? String(ownerName).trim() : "";
  }
  if (!author) {
    const hit = pickTencentValue(payload, (key, value) => typeof value === "string"
      && /(owner_?name|creator_?name|author)$/i.test(key) && !/(^id$|_?id$|key|token)$/i.test(key) && value.trim() && !ID_LIKE.test(value));
    author = hit ? String(hit).trim() : "";
  }
  if (!author) author = String(clientVars.userName || "").trim();
  // 创建时间:秒/毫秒自动判别,转 localIso
  const created = pickTencentValue(payload, (key, value) =>
    /(create_?time|created_?at|gmt_?create|doc_?create)/i.test(key) && (typeof value === "number" || /^\d+$/.test(String(value))));
  let publishedAt = "";
  const createdValue = Number(created);
  if (Number.isFinite(createdValue) && createdValue > 0) publishedAt = localIso(new Date(createdValue > 1e12 ? createdValue : createdValue * 1000));
  return {
    title: String(clientVars.title || "").trim(),
    author,
    publishedAt,
    markdown: tencentDocToMarkdown(rawText, formatMap, imageMap, String(clientVars.title || "").trim(), paraStyleAt, blockQuoteAt),
    // 图片 URL 喂给既有 downloadWebImages 管线;markdown 里的 URL 与之逐字一致,下载后自动替换成本地路径
    images: [...new Set(Object.values(imageMap).map((img) => img.url).filter(Boolean))],
  };
}

function tencentDocToMarkdown(rawText, formatMap = {}, imageMap = {}, title = "", paraStyleAt = {}, blockQuoteAt = {}) {
  const charFormat = (pos) => formatMap[pos] || {};
  const tableRows = [];
  const parts = [];
  let codeLines = [];
  let prevEmpty = false;
  let imageEntries = Object.entries(imageMap).map(([pos, img]) => [Number(pos), img]).sort((a, b) => a[0] - b[0]);
  let imageIndex = 0;
  let charPos = 0;
  let skippedTitle = false;

  const flushTable = () => {
    if (!tableRows.length) return;
    const rows = tableRows.splice(0).map((cells) => cells.map((cell) => cell.replace(/\|/g, "\\|").trim()));
    const width = Math.max(...rows.map((r) => r.length));
    rows.forEach((row) => { while (row.length < width) row.push(""); });
    parts.push("\n| " + rows[0].join(" | ") + " |", "| " + rows[0].map(() => "---").join(" | ") + " |");
    for (let i = 1; i < rows.length; i++) parts.push("| " + rows[i].join(" | ") + " |");
    parts.push("");
  };
  const flushCode = () => {
    if (!codeLines.length) return;
    parts.push("", fencedCode(codeLines.join("\n")), "");
    codeLines = [];
  };
  const splitRow = (line) => line.split("\x07").map((cell) => cell.replace(/[\x00-\x1f]/g, "").replace(/\s+/g, " ").trim());
  const isImageUrlOnly = (text) => /^(?:https?:\/\/\S+)$/i.test(text.trim());

  for (const line of String(rawText || "").split("\r")) {
    const lineStart = charPos;
    charPos += line.length + 1;

    while (imageIndex < imageEntries.length && imageEntries[imageIndex][0] < charPos) {
      flushTable(); flushCode();
      const img = imageEntries[imageIndex++][1];
      parts.push("", `![${(img.descr || "image").replace(/[[\]]/g, "")}](${img.url})`, "");
    }

    const plain = line.replace(/[\x00-\x08\x0e-\x1f]/g, "").replace(/\t/g, " ").trim();
    if (!plain) { flushTable(); if (codeLines.length) codeLines.push(""); else if (!prevEmpty) { parts.push(""); prevEmpty = true; } continue; }
    prevEmpty = false;

    // 表格:\x1a 表头行;\x07\x06 数据行;\x07 续列
    if (line.startsWith("\x1a")) { flushCode(); tableRows.push(splitRow(line.slice(1))); continue; }
    if (line.startsWith("\x07\x06")) { flushCode(); tableRows.push(splitRow(line.replace(/^\x07\x06/, ""))); continue; }
    if (line.startsWith("\x07")) { if (!tableRows.length) tableRows.push([]); tableRows[tableRows.length - 1].push(...splitRow(line.replace(/^\x07/, ""))); continue; }
    flushTable();

    // 代码块:企微协议 \x0f 开块 \x1e 块内行分隔 \x1d 收块(块内无 \r,一整段);
    // 腾讯协议 \x1d 是逐行前缀标记;段落 pStyle=phispn(企微代码样式)也按代码行收集。
    // 段落属性挂在段尾 \r 上:split("\r") 后 line 不含分隔符,标记位置 = lineStart + line.length
    const paraMarkPos = lineStart + line.length;
    const codeBlock = line.match(/\x0f([\s\S]*?)\x1d/);
    const paraStyle = paraStyleAt[paraMarkPos];
    const isCodePara = paraStyle && PARAGRAPH_STYLE_CODE.has(paraStyle);
    if (codeBlock || isCodePara) {
      flushTable();
      const blockLines = codeBlock ? codeBlock[1].split("\x1e") : [line];
      codeLines.push(...blockLines.map((s) => s.replace(/[\x00-\x1f]/g, "").trimEnd()));
      continue;
    }
    if (line.includes("\x1d")) { flushTable(); codeLines.push(line.replace(/[\x00-\x1f]/g, "").trimEnd()); continue; }
    if (codeLines.length) { parts.push("", fencedCode(codeLines.join("\n").replace(/^\n+|\n+$/g, "")), ""); codeLines = []; }

    // 行内格式按 formatMap 分段渲染;行中分支变化时出段,行尾残留段同样渲染
    const renderSegment = (text, fmt) => {
      let seg = String(text || "").replace(/\s+/g, " ").trim();
      if (!seg) return "";
      if (fmt.code) seg = `\`${seg}\``;
      if (fmt.bold) seg = `**${seg}**`;
      if (fmt.italic) seg = `*${seg}*`;
      if (fmt.strike) seg = `~~${seg}~~`;
      return seg;
    };
    let inline = "";
    let buffer = "";
    let key = "";
    let currentFmt = {};
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      // \x13\x14\x15 是链接结构标记,保留到渲染后统一替换,避免改变偏移破坏 formatMap 定位
      if (ch.charCodeAt(0) < 32 && ch !== "\x13" && ch !== "\x14" && ch !== "\x15") { if (ch === "\t") buffer += " "; continue; }
      const fmt = charFormat(lineStart + i);
      const fmtKey = `${fmt.bold ? 1 : 0}${fmt.italic ? 1 : 0}${fmt.strike ? 1 : 0}${fmt.code ? 1 : 0}`;
      if (fmtKey !== key) {
        const seg = renderSegment(buffer, currentFmt);
        if (seg) inline += (inline && !/\s$/.test(inline) ? " " : "") + seg;
        buffer = ""; key = fmtKey; currentFmt = fmt;
      }
      buffer += ch;
    }
    const tailSeg = renderSegment(buffer, currentFmt);
    if (tailSeg) inline += (inline && !/\s$/.test(inline) ? " " : "") + tailSeg;
    inline = inline.replace(/\s{2,}/g, " ").trim();
    // 结构化超链接(企微):\x13 URL \x14 显示文本 \x15 → [display](url);残留标记剥除。
    // 必须在旧 HYPERLINK 正则之前:\x14/\x15 不属于 \s,老正则会把 URL 与显示文本连成一个 \S+ 词
    inline = inline.replace(/\x13([^\x14]*)\x14([^\x15]*)\x15/g, (all, linkUrl, display) => {
      // URL 组尾部可能带 docLink 属性串(" docLink \tdft Doc ... \l"):URL 取第一个空白前的部分
      const url = linkUrl.replace(/^HYPERLINK\s+/i, "").trim().split(/\s+/)[0];
      const linkText = display.trim();
      return `[${linkText || url}](${url})`;
    }).replace(/[\x13\x14\x15]/g, "");
    if (inline.includes("HYPERLINK ")) {
      inline = inline.replace(/HYPERLINK\s+(\S+)\s+(\S+)([^[]*)/g, (all, linkUrl, display, tail) => {
        const urls = [linkUrl, ...(tail.match(/https?:\/\/\S+/g) || [])];
        const target = display === "normalLink" ? urls[urls.length - 1] || linkUrl : display;
        return `[${target}](${urls[urls.length - 1] || linkUrl})`;
      });
    }
    if (!inline || isImageUrlOnly(inline)) continue;
    // 文档首行常与标题重复(可能带粗体 run):剥掉 markdown 标记后再比较
    if (!skippedTitle && title && (inline.trim() === String(title).trim() || plain.trim() === String(title).trim())) { skippedTitle = true; continue; }

    // 标题:段落 pStyle(企微)优先,run 字号(腾讯)兜底
    const runHeading = Math.max(...Array.from({ length: line.length }, (_, i) => charFormat(lineStart + i).heading || 0), 0);
    const paraHeading = paraStyle ? PARAGRAPH_STYLE_HEADING[paraStyle] || 0 : 0;
    const heading = paraHeading || runHeading;
    if (heading) { parts.push("", "#".repeat(heading) + " " + inline, ""); continue; }
    if (blockQuoteAt[paraMarkPos]) { parts.push("> " + inline, ""); continue; }
    if (/^[•·▪◦●]\s*/.test(inline)) { parts.push("- " + inline.replace(/^[•·▪◦●]\s*/, "")); continue; }
    if (/^(\d+|[a-zA-Z])\.\s*/.test(inline)) { parts.push(inline); continue; }
    parts.push(inline, "");
  }
  flushTable();
  if (codeLines.length) parts.push("", fencedCode(codeLines.join("\n").replace(/^\n+|\n+$/g, "")), "");
  while (imageIndex < imageEntries.length) {
    const img = imageEntries[imageIndex++][1];
    parts.push("", `![${(img.descr || "image").replace(/[[\]]/g, "")}](${img.url})`, "");
  }
  // TOC 域还原不出有意义文本:首行是域指令(TOC \o "1-1" \h \z \u),条目是内部锚 id 链接,整块剥除;
  // MENTION_WXWORK at-... 是企微 @提及指令串,剥掉标记保留 @名字,无名字的提及行整行删除
  const cleaned = parts.join("\n").split("\n")
    .filter((line) => !/^TOC\s+\\/.test(line.trim()) && !/^\["[^"]+"\]\(\\l\)$/.test(line.trim()))
    .join("\n")
    .replace(/MENTION_WXWORK(?:\s+(?!@)[^\s@]+)+\s*(?=@)/g, "")
    .replace(/MENTION_WXWORK[^\n]*/g, "");
  return cleaned.replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function fencedCode(code) {
  const runs = [...String(code).matchAll(/`{3,}/g)].map((m) => m[0].length);
  const fence = "`".repeat(Math.max(3, ...runs, 2) + 1);
  return `${fence}\n${code}\n${fence}`;
}

// 会话 cookie 拉取 opendoc 并解析;任何失败抛错,由调用方回落渲染提取
async function extractDoc(url, { sessionService, siteName, collectSessionCookies, fetchImpl } = {}) {
  const host = tencentHostForUrl(url);
  if (!host) throw new Error("不是腾讯文档链接");
  const cookie = collectSessionCookies ? await collectSessionCookies(sessionService, `https://${host}/`) : "";
  if (!cookie) {
    const error = new Error(`${siteName}正文提取需要登录会话:先在浏览器会话中登录${siteName}后重试`);
    error.code = "DOCUMENT_LOGIN_REQUIRED";
    throw error;
  }
  const apiUrl = tencentDocApiUrl(url);
  const response = await fetchImpl(apiUrl, {
    headers: { accept: "*/*", cookie, referer: `https://${host}/` },
  });
  let text;
  try {
    text = typeof response.text === "function"
      ? await response.text()
      : (await readLimitedBody(response, 32 * 1024 * 1024)).toString("utf8");
  } catch (error) {
    console.warn(`[omnichannel] ${sessionService} opendoc 响应读取失败:`, error?.message || error);
    throw error;
  }
  if (!/^2\d\d$/.test(String(response.status))) {
    // 诊断输出:HTTP 状态异常多半是会话 cookie 不对/过期,把状态与响应片段留给用户排查
    console.warn(`[omnichannel] ${sessionService} opendoc HTTP ${response.status},cookie 长度 ${cookie.length},响应前 200 字:`, String(text).slice(0, 200));
  }
  let payload;
  try { payload = JSON.parse(text); } catch (_) {
    payload = JSON.parse(text.replace(/^[^(]*\(/, "").replace(/\)\s*;?\s*$/, ""));
  }
  const parsed = parseTencentDocPayload(payload);
  console.warn(`[omnichannel] ${sessionService} opendoc 提取成功:markdown ${parsed.markdown.length} 字符,图片 ${parsed.images.length} 张`);
  return { ...parsed, imageHeaders: { cookie } };
}

module.exports = {
  extractDoc,
  parseTencentDocPayload,
  stripTencentChrome,
  tencentDocApiUrl,
  tencentDocToMarkdown,
  tencentHostForUrl,
  tencentSessionServiceForUrl,
  tencentSiteNameForUrl,
};
