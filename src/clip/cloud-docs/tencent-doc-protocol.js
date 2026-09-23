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

// 企微文档段落样式兜底表(2026-09-20 实测):样式 id 逐篇可变,优先用 pr.styles 样式表的 name/outlineLvl 语义解析
const PARAGRAPH_STYLE_FALLBACK = { rdbvau: { heading: 1 }, wb5joj: { heading: 2 }, "4gbizg": { heading: 3 }, wkxqic: { heading: 4 }, phispn: { code: true } };
const PARAGRAPH_STYLE_CODE = new Set(["phispn"]);

// Word OOXML 风格样式定义 → 语义:heading N / Title → 标题层级;Preformatted/Code → 代码段
function styleHeadingLevel(def) {
  if (!def) return 0;
  if (typeof def.heading === "number") return def.heading;
  const name = String(def?.name?.val || "");
  const m = name.match(/^heading (\d)$/i);
  if (m) return Number(m[1]);
  if (/^title$/i.test(name)) return 1;
  const lvl = Number(def?.pPr?.outlineLvl?.val);
  if (Number.isFinite(lvl) && lvl >= 0 && lvl < 9) return lvl + 1;
  return 0;
}

function styleIsCode(def, styleId) {
  if (!def) return false;
  if (def.code) return true;
  if (PARAGRAPH_STYLE_CODE.has(styleId)) return true;
  return /pre(?:formatted)?|code/i.test(String(def?.name?.val || ""));
}

// 目录条目段样式(Word "toc N"):整段剥除,不进正文
function styleIsToc(def) {
  return /^toc \d+$/i.test(String(def?.name?.val || ""));
}

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
  // 通用样式表:pr.styles(Word OOXML 风格)提供 id→语义(name/outlineLvl);样式 id 逐篇可变,语义稳定。
  // 必须先全量收集样式表,再解析段落 pStyle(styles 表 mutation 可能排在段落 mutation 之后)
  const styleTable = {};
  for (const m of mutations) {
    const styles = m.pr?.styles?.style;
    if (styles && typeof styles === "object") Object.assign(styleTable, styles);
  }
  // 段落级属性挂在段尾 \r 的位置上(bi 指向段落标记符):值直接预解析为语义 { heading, code }
  const paraStyleAt = {};
  const blockQuoteAt = {};
  for (const m of mutations) {
    if (m?.ty !== "mp" || typeof m.bi !== "number") continue;
    const val = m.pr?.paragraph?.pStyle?.val;
    if (val) {
      const def = styleTable[val] || PARAGRAPH_STYLE_FALLBACK[val];
      paraStyleAt[m.bi] = { heading: styleHeadingLevel(def), code: styleIsCode(def, val), toc: styleIsToc(def) };
    }
    if (m.pr?.paragraph?.blockQuote) blockQuoteAt[m.bi] = true;
  }
  for (const m of mutations) {
    if (m?.ty !== "mp" || !m.pr || typeof m.bi !== "number" || typeof m.ei !== "number") continue;
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
  let inCodeBlock = false;
  const hasCodeCloseMark = String(rawText || "").includes("\x1d");
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
    if (!plain) {
      flushTable();
      // 代码块内"空"行可能是纯标记行(如 \x1d\x1e 收块标记被 strip 成空串):先处理块状态再当空行
      if (inCodeBlock) {
        if (line.includes("\x1d")) inCodeBlock = false;
        else if (codeLines.length) codeLines.push("");
        continue;
      }
      if (codeLines.length) codeLines.push(""); else if (!prevEmpty) { parts.push(""); prevEmpty = true; }
      continue;
    }
    prevEmpty = false;

    // 表格:\x1a 表头行;\x07\x06 数据行;\x07 续列
    if (line.startsWith("\x1a")) { flushCode(); tableRows.push(splitRow(line.slice(1))); continue; }
    if (line.startsWith("\x07\x06")) { flushCode(); tableRows.push(splitRow(line.replace(/^\x07\x06/, ""))); continue; }
    if (line.startsWith("\x07")) { if (!tableRows.length) tableRows.push([]); tableRows[tableRows.length - 1].push(...splitRow(line.replace(/^\x07/, ""))); continue; }
    flushTable();

    // 代码块:企微协议 \x0f 开块 \x1d 收块(可跨多个 \r 行,行可带 \x1e/\x1c 前缀标记);
    // 腾讯协议 \x1d 是逐行前缀标记;段落样式为代码(Preformatted/phispn)也按代码行收集。
    // 段落属性挂在段尾 \r 上:split("\r") 后 line 不含分隔符,标记位置 = lineStart + line.length
    const paraMarkPos = lineStart + line.length;
    const paraMark = paraStyleAt[paraMarkPos];
    const isCodePara = paraMark?.code;
    // 目录条目:样式 toc N 或域指令特征(HYPERLINK \l "section-N" / PAGEREF),整行剥除
    if (paraMark?.toc || /\\l "section-|PAGEREF /.test(line)) { flushTable(); prevEmpty = false; continue; }
    // 腾讯文档的 \x0f 是卡片/分隔装饰而非代码块开(其真代码块以 \x1d 收块);
    // 整篇存在 \x1d 时代码块状态机才启用,防止无 \x1d 的文档误开块吞掉全文
    if ((line.includes("\x0f") || inCodeBlock) && hasCodeCloseMark) {
      flushTable();
      let chunk = line.includes("\x0f") ? line.slice(line.indexOf("\x0f") + 1) : line;
      if (chunk.includes("\x1d")) {
        inCodeBlock = false;
        chunk = chunk.slice(0, chunk.indexOf("\x1d"));
      } else {
        inCodeBlock = true;
      }
      codeLines.push(...chunk.split("\x1e").map((s) => s.replace(/[\x00-\x1f]/g, "").trimEnd()));
      continue;
    }
    if (isCodePara) { flushTable(); codeLines.push(line.replace(/[\x00-\x1f]/g, "").trimEnd()); continue; }
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
      // 企微 @提及:\x13 MENTION_WXWORK 指令串 \x14 @名字 \x15 —— 直接还原 @名字,指令串不进 URL
      if (/^MENTION_WXWORK/.test(linkUrl.trim())) return display.trim();
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

    // 标题:段落样式语义(styles 表/fallback)优先,run 字号(腾讯)兜底
    const runHeading = Math.max(...Array.from({ length: line.length }, (_, i) => charFormat(lineStart + i).heading || 0), 0);
    const heading = paraMark?.heading || runHeading;
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

// —— sheet/slide 等二进制类型导出 ——
// opendoc 的 mutations 协议只覆盖 docx 文档;表格(sheet)/幻灯(slide)走导出链:
// opendoc 换服务端 globalPadId(URL localId 与之不同) → POST export_office → 轮询 query_progress → COS 预签名直链下载。
// 2026-09-22 按真实抓包实测:exportType=0 对 sheet 出 xlsx、对 slide 出 pptx;file_url 在轮询响应顶层(下划线命名)。
const TENCENT_EXPORT_PAD_TYPES = {
  sheet: { ext: "xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  slide: { ext: "pptx", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
};
const TENCENT_EXPORT_POLL_INTERVAL_MS = 1_500;
const TENCENT_EXPORT_POLL_MAX = 45;            // 45×1.5s ≈ 67s,实测大文件(47MB)2~3 次即完成
const TENCENT_EXPORT_MAX_BYTES = 256 * 1024 * 1024;
const TENCENT_EXPORT_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";

// 共享轮询:响应扁平 {ret,status,progress,file_url},file_url 出现即完成;企微需带 timestamp 防缓存
async function tencentPollExportFileUrl(host, operationId, referer, cookie, fetchImpl, siteName, { withTimestamp = false } = {}) {
  for (let i = 0; i < TENCENT_EXPORT_POLL_MAX; i++) {
    await new Promise((r) => setTimeout(r, TENCENT_EXPORT_POLL_INTERVAL_MS));
    const ts = withTimestamp ? `&timestamp=${Date.now()}` : "";
    const qResp = await fetchImpl(`https://${host}/v1/export/query_progress?operationId=${encodeURIComponent(operationId)}${ts}`, {
      headers: { cookie, referer, "user-agent": TENCENT_EXPORT_UA },
    });
    const qText = typeof qResp.text === "function" ? await qResp.text() : (await readLimitedBody(qResp, 1024 * 1024)).toString("utf8");
    let q; try { q = JSON.parse(qText); } catch (_) { q = {}; }
    if (q.ret !== 0) {
      const error = new Error(`${siteName}导出进度查询失败(ret=${q.ret})`);
      error.code = "TENCENT_DOCS_EXPORT_FAILED";
      throw error;
    }
    if (q.file_url) return q.file_url;
    if (String(q.status).toLowerCase() === "failed") {
      const error = new Error(`${siteName}导出失败(服务端 status=Failed)`);
      error.code = "TENCENT_DOCS_EXPORT_FAILED";
      throw error;
    }
  }
  const error = new Error(`${siteName}导出超时(${Math.round((TENCENT_EXPORT_POLL_MAX * TENCENT_EXPORT_POLL_INTERVAL_MS) / 1000)}s 无结果)`);
  error.code = "TENCENT_DOCS_EXPORT_TIMEOUT";
  throw error;
}

// 共享下载 + 组装 TENCENT_DOCS_BINARY(COS 预签名直链,无需会话 cookie)
async function tencentDownloadExportBuffer(fileUrl, fetchImpl, siteName, { padType, exportType, initialTitle, localId, author, publishedAt }) {
  const dlResp = await fetchImpl(fileUrl, { headers: { "user-agent": TENCENT_EXPORT_UA } });
  if (!dlResp.ok) throw new Error(`${siteName}导出文件下载失败 HTTP ${dlResp.status}`);
  const buffer = typeof dlResp.arrayBuffer === "function"
    ? Buffer.from(await dlResp.arrayBuffer())
    : await readLimitedBody(dlResp, TENCENT_EXPORT_MAX_BYTES);
  const disposition = typeof dlResp.headers?.get === "function" ? dlResp.headers.get("content-disposition") : (dlResp.headers?.["content-disposition"] || "");
  const fileName = tencentExportFileName(disposition, initialTitle, localId, exportType.ext);
  const error = new Error(`腾讯系文档(${padType}),已导出 ${exportType.ext}`);
  error.code = "TENCENT_DOCS_BINARY";
  error.buffer = buffer;
  error.fileName = fileName;
  error.meta = { padType, mimeType: exportType.mime, author: author || "", publishedAt: publishedAt || "" };
  throw error;
}

// 解析 COS content-disposition:优先 filename*(UTF-8 完整名),兜底 filename="(ASCII)"
function tencentExportFileName(disposition, initialTitle, localId, ext) {
  const utf8 = disposition?.match(/filename\*=UTF-8''([^;]+)/)?.[1];
  const ascii = disposition?.match(/filename="([^"]+)"/)?.[1];
  const fromHeader = decodeURIComponent(utf8 || ascii || "").trim();
  const base = (fromHeader || initialTitle || localId || "tencent-doc").replace(/[\\/:*?"<>|]/g, "").trim() || "tencent-doc";
  return /\.[A-Za-z0-9]+$/.test(base) ? base : `${base}.${ext}`;
}

async function extractTencentFileExport(url, { sessionService, siteName, collectSessionCookies, fetchImpl = globalThis.fetch } = {}) {
  const host = tencentHostForUrl(url);
  if (!host) throw new Error("不是腾讯文档链接");
  const cookie = collectSessionCookies ? await collectSessionCookies(sessionService, `https://${host}/`) : "";
  if (!cookie) {
    const error = new Error(`${siteName}表格/幻灯导出需要登录会话:先在浏览器会话中登录${siteName}后重试`);
    error.code = "DOCUMENT_LOGIN_REQUIRED";
    throw error;
  }
  // 企微文档导出协议不同:docId 直接用 URL localId(e3_ 前缀,无需 opendoc),form 体带 captcha 占位
  if (host === "doc.weixin.qq.com") {
    return await exportWecomFile(url, cookie, fetchImpl, siteName);
  }
  const parsed = new URL(url);
  const localId = parsed.searchParams.get("id") || parsed.pathname.split("/").filter(Boolean).pop();
  if (!localId) throw new Error("无法从链接解析腾讯文档 ID");

  // ① opendoc 换 globalPadId/padType/标题(URL localId ≠ 服务端 padId,直接用会导错文档)
  const metaUrl = `https://${host}/dop-api/opendoc?id=${encodeURIComponent(localId)}&normal=1&noEscape=1&outformat=1&doc_chunk_flag=1&t=${Date.now()}`;
  const metaResp = await fetchImpl(metaUrl, { headers: { accept: "*/*", cookie, referer: `https://${host}/`, "user-agent": TENCENT_EXPORT_UA } });
  if (!metaResp.ok) throw new Error(`${siteName} opendoc 返回 HTTP ${metaResp.status}`);
  const metaText = typeof metaResp.text === "function"
    ? await metaResp.text()
    : (await readLimitedBody(metaResp, 32 * 1024 * 1024)).toString("utf8");
  const globalPadId = metaText.match(/"globalPadId"\s*:\s*"([^"]+)"/)?.[1];
  const padType = metaText.match(/"padType"\s*:\s*"([^"]+)"/)?.[1];
  const initialTitle = (metaText.match(/"initialTitle"\s*:\s*"([^"]+)"/)?.[1] || "").replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const exportType = TENCENT_EXPORT_PAD_TYPES[padType];
  if (!globalPadId || !exportType) {
    const error = new Error(`${siteName}暂不支持导出该类型(${padType || "未知"})`);
    error.code = "TENCENT_DOCS_EXPORT_UNSUPPORTED";
    throw error;
  }

  // ①b 文档元信息(作者/创建时间):POST /v2/drive/file/desc,file_id 取 globalPadId 的 padId 段;
  // 失败静默(meta 留空),不阻塞导出
  let meta = { author: "", publishedAt: "" };
  try {
    const padId = globalPadId.includes("$") ? globalPadId.split("$")[1] : globalPadId;
    const descResp = await fetchImpl(`https://${host}/v2/drive/file/desc`, {
      method: "POST",
      headers: { cookie, referer: url, "content-type": "application/json", "x-requested-with": "XMLHttpRequest", "user-agent": TENCENT_EXPORT_UA },
      body: JSON.stringify({ file_id: padId, xsrf: "" }),
    });
    const descText = typeof descResp.text === "function" ? await descResp.text() : (await readLimitedBody(descResp, 1024 * 1024)).toString("utf8");
    const desc = JSON.parse(descText);
    const result = desc?.result || {};
    const createdMs = Number(result.createTime) || 0;
    meta = {
      author: result.ownerNick || "",
      publishedAt: createdMs ? localIso(new Date(createdMs)) : "",
      title: result.name || "",
    };
  } catch (_) {}

  // ② 发起导出
  const postResp = await fetchImpl(`https://${host}/v1/export/export_office`, {
    method: "POST",
    headers: { cookie, referer: url, "content-type": "application/x-www-form-urlencoded", "x-requested-with": "XMLHttpRequest", "user-agent": TENCENT_EXPORT_UA },
    body: `exportType=0&switches=${encodeURIComponent(JSON.stringify({ embedFonts: false }))}&exportSource=client&docId=${encodeURIComponent(globalPadId)}&version=2`,
  });
  const postText = typeof postResp.text === "function" ? await postResp.text() : (await readLimitedBody(postResp, 1024 * 1024)).toString("utf8");
  let postJson;
  try { postJson = JSON.parse(postText); } catch (_) { postJson = {}; }
  if (postJson.ret !== 0 || !postJson.operationId) {
    const error = new Error(`${siteName}导出请求失败(ret=${postJson.ret ?? "未知"})`);
    error.code = "TENCENT_DOCS_EXPORT_FAILED";
    throw error;
  }

  // ③④ 轮询 + 下载(与企微流共享 helper)
  const fileUrl = await tencentPollExportFileUrl(host, postJson.operationId, url, cookie, fetchImpl, siteName);
  await tencentDownloadExportBuffer(fileUrl, fetchImpl, siteName, { padType, exportType, initialTitle, localId, author: meta.author, publishedAt: meta.publishedAt });
}

// 企微文档(doc.weixin.qq.com)sheet/slide 导出:与腾讯的差异——docId 直接用 URL localId(e3_ 前缀,无需 opendoc 换取)、
// query 带 wedoc_xsrf=1(sid 可省)、form 体带 captcha 占位、轮询带 timestamp。2026-09-22 实测 27MB xlsx 一次通过。
async function exportWecomFile(url, cookie, fetchImpl, siteName) {
  const parsed = new URL(url);
  const localId = parsed.pathname.split("/").filter(Boolean).pop();
  const padType = (parsed.pathname.match(/\/(sheet|slide)\//) || [])[1];
  const exportType = TENCENT_EXPORT_PAD_TYPES[padType];
  if (!localId || !exportType) {
    const error = new Error(`${siteName}暂不支持导出该类型(${padType || "未知"})`);
    error.code = "TENCENT_DOCS_EXPORT_UNSUPPORTED";
    throw error;
  }
  const postResp = await fetchImpl("https://doc.weixin.qq.com/v1/export/export_office?wedoc_xsrf=1", {
    method: "POST",
    headers: { cookie, referer: url, "content-type": "application/x-www-form-urlencoded", "x-requested-with": "XMLHttpRequest", "user-agent": TENCENT_EXPORT_UA },
    body: `docId=${encodeURIComponent(localId)}&version=2&captchaTicket=&captchaRandstr=`,
  });
  const postText = typeof postResp.text === "function" ? await postResp.text() : (await readLimitedBody(postResp, 1024 * 1024)).toString("utf8");
  let postJson; try { postJson = JSON.parse(postText); } catch (_) { postJson = {}; }
  if (postJson.ret !== 0 || !postJson.operationId) {
    const error = new Error(`${siteName}导出请求失败(ret=${postJson.ret ?? "未知"})`);
    error.code = "TENCENT_DOCS_EXPORT_FAILED";
    throw error;
  }
  const fileUrl = await tencentPollExportFileUrl("doc.weixin.qq.com", postJson.operationId, url, cookie, fetchImpl, siteName, { withTimestamp: true });
  await tencentDownloadExportBuffer(fileUrl, fetchImpl, siteName, { padType, exportType, initialTitle: "", localId, author: "", publishedAt: "" });
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
    throw error;
  }
  let payload;
  try { payload = JSON.parse(text); } catch (_) {
    payload = JSON.parse(text.replace(/^[^(]*\(/, "").replace(/\)\s*;?\s*$/, ""));
  }
  const parsed = parseTencentDocPayload(payload);
  return { ...parsed, imageHeaders: { cookie } };
}

module.exports = {
  extractDoc,
  extractTencentFileExport,
  parseTencentDocPayload,
  stripTencentChrome,
  tencentDocApiUrl,
  tencentDocToMarkdown,
  tencentHostForUrl,
  tencentSessionServiceForUrl,
  tencentSiteNameForUrl,
};
