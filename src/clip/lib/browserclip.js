"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const WebSocket = require("ws");
const { validateResolvedHost } = require("../../core/network");
const { COMMUNITY_SERVICES, RENDER_SERVICES } = require("./web-platforms");
const stealthScript = require("./stealth-script");

const KNOWN_BROWSER_PATHS = process.platform === "darwin" ? [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
] : process.platform === "win32" ? [
  path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google/Chrome/Application/chrome.exe"),
  path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Microsoft/Edge/Application/msedge.exe"),
  path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
] : ["/usr/bin/google-chrome", "/usr/bin/microsoft-edge", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/brave-browser"];

const SUPPORTED_BROWSER_NAMES = new Set([
  "brave", "brave browser", "brave-browser", "brave.exe", "chrome", "chrome.exe", "chromium", "chromium-browser",
  "google chrome", "google-chrome", "google-chrome-stable", "microsoft edge", "microsoft-edge", "msedge", "msedge.exe",
]);

function isSupportedBrowserExecutablePath(value) {
  const requested = String(value || "").trim();
  return path.isAbsolute(requested) && SUPPORTED_BROWSER_NAMES.has(path.basename(requested).toLowerCase());
}

function findBrowserExecutable(override = "") {
  const requested = String(override || "").trim();
  if (requested) {
    if (!isSupportedBrowserExecutablePath(requested)) throw new Error("Configured executable is not a supported Chrome, Edge, Brave, or Chromium browser");
    if (!fs.existsSync(requested)) throw new Error(`Configured browser was not found: ${requested}`);
    return requested;
  }
  const found = KNOWN_BROWSER_PATHS.find((candidate) => candidate && fs.existsSync(candidate));
  if (!found) throw new Error("No supported local Chrome, Edge, Brave, or Chromium browser was found");
  return found;
}

function freeLocalPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

function httpJson(url, method = "GET") {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        if ((response.statusCode || 0) >= 400) return reject(new Error(`Browser debugging endpoint returned HTTP ${response.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (error) { reject(error); }
      });
    });
    request.once("error", reject);
    request.setTimeout(2_000, () => request.destroy(new Error("Browser debugging endpoint timed out")));
    request.end();
  });
}

async function waitForDebugger(port, child, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Browser exited before startup (code ${child.exitCode})`);
    try { return await httpJson(`http://127.0.0.1:${port}/json/version`); }
    catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  throw lastError || new Error("Browser startup timed out");
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.on("message", (raw) => this.onMessage(raw));
    socket.on("close", () => this.failPending(new Error("Browser debugging connection closed")));
    socket.on("error", (error) => this.failPending(error));
  }

  static connect(url, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { handshakeTimeout: timeoutMs });
      socket.once("open", () => resolve(new CdpClient(socket)));
      socket.once("error", reject);
    });
  }

  onMessage(raw) {
    let message;
    try { message = JSON.parse(String(raw)); } catch (_) { return; }
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || "Browser command failed"));
      else pending.resolve(message.result || {});
      return;
    }
    for (const listener of this.listeners.get(message.method) || []) {
      try { listener(message.params || {}); } catch (_) {}
    }
  }

  send(method, params = {}, timeoutMs = 20_000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
    return () => this.listeners.set(method, (this.listeners.get(method) || []).filter((item) => item !== listener));
  }

  waitFor(method, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      let off;
      const timer = setTimeout(() => {
        off?.();
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      off = this.on(method, (params) => {
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    try { this.socket.close(); } catch (_) {}
  }
}

function selectorsForService(service) {
  return RENDER_SERVICES[service]?.contentSelectors || ["main", "article", "body"];
}

function commentSelectorsForService(service) {
  return RENDER_SERVICES[service]?.commentSelectors || [
    "[itemprop='comment']", "[data-testid*='comment' i]", ".topic-post", ".comment-item", ".comment", ".reply", ".answer",
  ];
}

function looksLikeAuthentication(payload, service) {
  const url = String(payload?.url || "");
  const text = String(payload?.text || "").replace(/\s+/g, " ").slice(0, 4_000);
  if (/\/(?:login|signin|passport)(?:[/?#]|$)/i.test(url)) return true;
  const configured = RENDER_SERVICES[service]?.authPattern;
  const phrases = configured ? new RegExp(configured, "i") : service === "feishu" ? /扫码登录|登录飞书|sign in to (?:lark|feishu)/i
    : service === "tencent" ? /登录腾讯文档|微信扫码登录|qq扫码登录|sign in.*tencent docs/i
      : service === "wps" ? /登录.*wps|扫码登录|sign in.*wps/i
        : /verify you are human|security verification|captcha|access denied/i;
  return text.length < 2_000 && phrases.test(text);
}

function looksLikeBlockedPage(payload) {
  const title = String(payload?.title || "");
  const text = String(payload?.text || "").replace(/\s+/g, " ").slice(0, 4_000);
  return text.length < 2_000 && /(?:403 forbidden|http error 403|access denied|request blocked|temporarily unavailable|页面访问受限|访问被拒绝)/i.test(`${title} ${text}`);
}

function renderedPayloadExpression(service, options = {}) {
  const config = JSON.stringify({
    selectors: selectorsForService(service),
    commentSelectors: commentSelectorsForService(service),
    removeSelectors: RENDER_SERVICES[service]?.removeSelectors || ["script", "style", "noscript", "template"],
    virtualDocument: RENDER_SERVICES[service]?.virtualDocument || null,
    maxVirtualCaptureMs: Math.max(5_000, Math.min(45_000, Number(options.maxVirtualCaptureMs) || 45_000)),
  });
  return `(async () => {
    const config = ${config};
    const snapshot = () => {
      let root = document.body;
      for (const selector of config.selectors) {
        const candidate = document.querySelector(selector);
        if (candidate && (candidate.innerText || '').trim().length > 60) { root = candidate; break; }
      }
      const container = document.createElement('main');
      const content = root ? root.cloneNode(true) : document.body.cloneNode(true);
      for (const selector of config.removeSelectors) {
        try { for (const node of content.querySelectorAll(selector)) node.remove(); } catch (_) {}
      }
      container.appendChild(content);
      let comments = [];
      for (const selector of config.commentSelectors) {
        try {
          const candidates = [...document.querySelectorAll(selector)].filter((node) => (node.innerText || '').trim().length > 1);
          if (candidates.length) { comments = candidates; break; }
        } catch (_) {}
      }
      const rootIncludesComments = comments.some((node) => root === node || root.contains(node));
      if (comments.length && !rootIncludesComments) {
        const section = document.createElement('section');
        const heading = document.createElement('h2');
        heading.textContent = 'Comments (' + comments.length + ')';
        section.appendChild(heading);
        for (const comment of comments.slice(0, 300)) section.appendChild(comment.cloneNode(true));
        container.appendChild(section);
      }
      const title = (document.querySelector('meta[property="og:title"]') || {}).content || document.title || location.hostname;
      const author = (document.querySelector('meta[name="author"]') || {}).content || '';
      const description = (document.querySelector('meta[property="og:description"]') || document.querySelector('meta[name="description"]') || {}).content || '';
      return { title, author, description, url: location.href, html: container.innerHTML, text: container.innerText, commentCount: comments.length };
    };

    const virtual = config.virtualDocument;
    if (!virtual) return snapshot();
    let scroller = null;
    for (const selector of virtual.scrollSelectors || []) {
      try {
        const candidate = document.querySelector(selector);
        if (candidate && candidate.clientHeight > 120 && candidate.scrollHeight > candidate.clientHeight + 200) {
          scroller = candidate;
          break;
        }
      } catch (_) {}
    }
    if (!scroller) {
      scroller = [...document.querySelectorAll('*')]
        .filter((node) => node.clientHeight > 120 && node.scrollHeight > node.clientHeight + 200)
        .sort((left, right) => (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight))[0] || null;
    }
    if (!scroller) return snapshot();

    const frame = () => new Promise((resolve) => {
      let finished = false;
      const done = () => { if (!finished) { finished = true; resolve(); } };
      requestAnimationFrame(done);
      setTimeout(done, 100);
    });
    const originalTop = scroller.scrollTop;
    const blocks = new Map();
    let order = 0;
    let htmlChars = 0;
    const capture = () => {
      let added = 0;
      let candidates = [];
      try { candidates = [...scroller.querySelectorAll(virtual.blockSelector)]; } catch (_) {}
      for (const block of candidates) {
        const type = block.getAttribute(virtual.blockTypeAttribute) || '';
        if (type === virtual.pageBlockType) continue;
        const parent = block.parentElement?.closest(virtual.blockSelector);
        if (!parent || parent.getAttribute(virtual.blockTypeAttribute) !== virtual.pageBlockType) continue;
        const id = block.getAttribute(virtual.blockIdAttribute);
        if (!id) continue;
        const pageId = parent.getAttribute(virtual.blockIdAttribute) || 'page';
        const key = pageId + ':' + id;
        const clone = block.cloneNode(true);
        for (const selector of [...config.removeSelectors, 'svg', '.docx-block-zero-space', '.fold-handler']) {
          try { for (const node of clone.querySelectorAll(selector)) node.remove(); } catch (_) {}
        }
        const text = (clone.innerText || clone.textContent || '').trim();
        const html = clone.outerHTML;
        const previous = blocks.get(key);
        if (!previous) {
          blocks.set(key, { id: key, type, text, html, order: order++ });
          htmlChars += html.length;
          added += 1;
        } else if (text.length > previous.text.length || html.length > previous.html.length) {
          htmlChars += html.length - previous.html.length;
          blocks.set(key, { id: key, type, text, html, order: previous.order });
        }
      }
      return added;
    };

    const startedAt = performance.now();
    const maxSteps = Math.max(1, Number(virtual.maxSteps) || 2400);
    const maxHtmlChars = Math.max(1024 * 1024, Number(virtual.maxHtmlChars) || 16 * 1024 * 1024);
    let steps = 0;
    let endStable = 0;
    let reachedEnd = false;
    let timedOut = false;
    scroller.scrollTop = 0;
    await frame();
    await frame();
    capture();
    while (steps < maxSteps) {
      if (performance.now() - startedAt >= config.maxVirtualCaptureMs) { timedOut = true; break; }
      const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      if (scroller.scrollTop >= maxTop - 1) {
        await frame();
        const added = capture();
        const nextMax = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        if (nextMax <= maxTop + 1 && added === 0) endStable += 1;
        else endStable = 0;
        if (endStable >= 2) { reachedEnd = true; break; }
      } else {
        const step = Math.max(480, Math.floor(scroller.clientHeight * 1.15));
        scroller.scrollTop = Math.min(maxTop, scroller.scrollTop + step);
        await frame();
        capture();
        endStable = 0;
      }
      steps += 1;
    }
    const capturedTop = scroller.scrollTop;
    const capturedHeight = scroller.scrollHeight;
    scroller.scrollTop = originalTop;

    const items = [...blocks.values()].sort((left, right) => left.order - right.order);
    if (!items.length) return snapshot();
    const payload = snapshot();
    payload.html = '<main data-omnichannel-virtual-document="true">' + items.map((item) => item.html).join('\\n') + '</main>';
    payload.text = items.map((item) => item.text).filter(Boolean).join('\\n');
    payload.virtualCapture = {
      used: true,
      complete: reachedEnd && !timedOut && htmlChars <= maxHtmlChars,
      reachedEnd,
      timedOut,
      blockCount: items.length,
      htmlChars,
      textChars: payload.text.length,
      steps,
      capturedTop,
      capturedHeight,
    };
    return payload;
  })()`;
}

async function runtimeValue(client, expression, awaitPromise = false, timeoutMs = 30_000) {
  const result = await client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise }, timeoutMs);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Page script failed");
  return result.result?.value;
}

async function waitForStablePage(client, service, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let stable = 0;
  let previous = -1;
  while (Date.now() < deadline) {
    if (COMMUNITY_SERVICES[service] || service === "community-generic") {
      await runtimeValue(client, "window.scrollTo(0, Math.min(document.body.scrollHeight, window.scrollY + window.innerHeight * 1.5)); true");
    }
    const length = Number(await runtimeValue(client, "document.body ? document.body.innerText.length : 0")) || 0;
    stable = length === previous && length > 60 ? stable + 1 : 0;
    previous = length;
    if (stable >= 2) return;
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
}

class WebSessionManager {
  constructor(rootPath) {
    this.rootPath = rootPath;
    this.active = new Map();
    this.locks = new Map();
  }

  profilePath(service) {
    const directory = path.join(this.rootPath, service);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  hasSessionData(service) {
    const directory = path.join(this.rootPath, service);
    if (!fs.existsSync(directory)) return false;
    return fs.readdirSync(directory).some((name) => !name.startsWith("."));
  }

  async start(service, { browserExecutable = "", headless = true, initialUrl = "about:blank" } = {}) {
    const existing = this.active.get(service);
    if (existing && existing.child.exitCode === null) return { ...existing, owned: false };
    const executable = findBrowserExecutable(browserExecutable);
    const port = await freeLocalPort();
    const args = [
      `--user-data-dir=${this.profilePath(service)}`,
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-allow-origins=*",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-component-update",
    ];
    if (headless) args.push("--headless=new", "--disable-gpu", "--hide-scrollbars", initialUrl);
    else args.push(`--app=${initialUrl}`);
    const child = childProcess.spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
    let startupError = "";
    child.stderr?.on("data", (chunk) => { startupError = `${startupError}${chunk}`.slice(-4_000); });
    const version = await waitForDebugger(port, child).catch((error) => {
      try { child.kill("SIGTERM"); } catch (_) {}
      throw new Error(`${error.message}${startupError ? `: ${startupError.trim().split("\n").at(-1)}` : ""}`);
    });
    const entry = { child, port, browserWebSocketDebuggerUrl: version.webSocketDebuggerUrl, headless };
    this.active.set(service, entry);
    child.once("exit", () => {
      if (this.active.get(service)?.child === child) this.active.delete(service);
    });
    return { ...entry, owned: true };
  }

  async openLogin(service, options = {}) {
    const config = RENDER_SERVICES[service];
    if (!config) throw new Error(`Unsupported browser service: ${service}`);
    const entry = await this.start(service, { ...options, headless: false, initialUrl: config.loginUrl });
    this.scheduleLoginCookieCapture(service);
    return { service, name: config.name, profilePath: this.profilePath(service), alreadyOpen: !entry.owned };
  }

  sessionCookiesFile(service) {
    return path.join(this.rootPath, service, "omni-session-cookies.json");
  }

  // 登录 cookie 持久化:Chrome 对这类 profile 的 Cookies 数据库不保证及时落盘
  // (实测用户关闭登录窗口后磁盘 0 行),因此把活跃实例内存里的 cookie 抓成插件自己的文件,
  // 登录窗口关闭后剪藏仍可使用,直到平台使 cookie 失效。
  persistCookiesFile(service, cookieHeader) {
    try {
      const file = this.sessionCookiesFile(service);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify({ capturedAt: Date.now(), cookieHeader }), { mode: 0o600 });
      return true;
    } catch (_) {
      return false;
    }
  }

  readPersistedCookies(service) {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.sessionCookiesFile(service), "utf8"));
      return String(parsed.cookieHeader || "");
    } catch (_) {
      return "";
    }
  }

  // 从活跃实例的 CDP 抓 cookie;suffix 非空时按域名过滤,否则存全量(独立 profile 内只有本服务站点)
  async captureActiveCookies(service, suffix = "") {
    const entry = this.active.get(service);
    if (!entry || entry.child.exitCode !== null) return "";
    let client;
    try {
      client = await CdpClient.connect(entry.browserWebSocketDebuggerUrl, 2_000);
      const result = await client.send("Storage.getCookies", {}, 8_000).catch(() => ({ cookies: [] }));
      const cookies = (result.cookies || []).filter((cookie) => {
        if (!suffix) return true;
        return cookie.domain === suffix || cookie.domain === `.${suffix}` || cookie.domain.endsWith(`.${suffix}`);
      });
      if (!cookies.length) return "";
      const header = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
      this.persistCookiesFile(service, header);
      return header;
    } catch (_) {
      return "";
    } finally {
      if (client) client.close();
    }
  }

  // 登录窗口打开后轮询抓取:用户完成登录的时机未知,cookie 一旦种上即持久化,
  // 抓到即停;每 15s 一次,10 分钟上限。用户随后关闭窗口不影响已持久化的会话。
  scheduleLoginCookieCapture(service) {
    if (!this.loginCaptureTimers) this.loginCaptureTimers = new Map();
    const previous = this.loginCaptureTimers.get(service);
    if (previous) clearInterval(previous);
    const timer = setInterval(() => {
      const entry = this.active.get(service);
      if (!entry || entry.child.exitCode !== null) {
        clearInterval(timer);
        this.loginCaptureTimers.delete(service);
        return;
      }
      void this.captureActiveCookies(service).then((header) => {
        if (header) {
          clearInterval(timer);
          this.loginCaptureTimers.delete(service);
        }
      });
    }, 15_000);
    setTimeout(() => {
      clearInterval(timer);
      this.loginCaptureTimers.delete(service);
    }, 600_000);
    this.loginCaptureTimers.set(service, timer);
  }

  async createPage(entry) {
    const target = await httpJson(`http://127.0.0.1:${entry.port}/json/new?${encodeURIComponent("about:blank")}`, "PUT");
    return CdpClient.connect(target.webSocketDebuggerUrl);
  }

  /**
   * Headless Chrome leaks automation fingerprints (UA contains "HeadlessChrome",
   * navigator.webdriver is true), and hard-gated sites like Zhihu reject such
   * requests with 403 before any cookie can be planted. Override the UA with the
   * real browser product string and inject the MIT-licensed stealth evasions
   * before any page script runs.
   */
  async configurePage(client) {
    const platform = process.platform === "win32"
      ? "Windows NT 10.0; Win64; x64"
      : process.platform === "linux" ? "X11; Linux x86_64" : "Macintosh; Intel Mac OS X 10_15_7";
    let engine = "132.0.0.0";
    try {
      // Browser.getVersion reports e.g. "HeadlessChrome/132.0.6834.83": keep the
      // exact engine version of this executable in a normal-Chrome UA.
      engine = String((await client.send("Browser.getVersion", {}, 5_000))?.product || "").match(/Chrome\/([\d.]+)/)?.[1] || engine;
    } catch (_) { /* keep the static engine version */ }
    // omni-article-markdown uses the same Edge-branded UA for its Zhihu cookie
    // warmup; mirror it so hard-gated sites see a regular desktop browser.
    const major = engine.split(".")[0];
    const userAgent = `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${engine} Safari/537.36 Edg/${major}`;
    await client.send("Emulation.setUserAgentOverride", { userAgent, acceptLanguage: "zh-CN,zh;q=0.9,en;q=0.8" }, 10_000).catch(() => undefined);
    await client.send("Page.addScriptToEvaluateOnNewDocument", { source: stealthScript }, 10_000).catch(() => undefined);
  }

  async extract(url, service, options = {}) {
    const previous = this.locks.get(service) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.locks.set(service, tail);
    await previous;
    try { return await this.extractUnlocked(url, service, options); }
    finally {
      release();
      if (this.locks.get(service) === tail) this.locks.delete(service);
    }
  }

  async extractUnlocked(url, service, options = {}) {
    await validateResolvedHost(url);
    const entry = await this.start(service, { browserExecutable: options.browserExecutable, headless: true });
    const client = await this.createPage(entry);
    await this.configurePage(client);
    const validatedHosts = new Map();
    const validateRequest = async (requestUrl) => {
      if (/^(?:about|blob|data):/i.test(requestUrl)) return true;
      let hostname;
      try { hostname = new URL(requestUrl).hostname; } catch (_) { return false; }
      if (!validatedHosts.has(hostname)) validatedHosts.set(hostname, validateResolvedHost(requestUrl).then(() => true, () => false));
      return validatedHosts.get(hostname);
    };
    const offFetch = client.on("Fetch.requestPaused", (event) => {
      void validateRequest(event.request?.url || "").then((allowed) => client.send(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", allowed
        ? { requestId: event.requestId }
        : { requestId: event.requestId, errorReason: "BlockedByClient" }, 10_000).catch(() => undefined));
    });
    try {
      await client.send("Page.enable");
      await client.send("Runtime.enable");
      await client.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
      const loaded = client.waitFor("Page.loadEventFired", 30_000).catch(() => undefined);
      await client.send("Page.navigate", { url }, 30_000);
      await loaded;
      await waitForStablePage(client, service, options.timeoutMs || 25_000);
      const captureTimeoutMs = Math.max(30_000, Math.min(60_000, Number(options.captureTimeoutMs) || 55_000));
      const payload = await runtimeValue(client, renderedPayloadExpression(service, {
        maxVirtualCaptureMs: captureTimeoutMs - 5_000,
      }), true, captureTimeoutMs);
      await validateResolvedHost(payload.url);
      if (payload.virtualCapture?.used && !payload.virtualCapture.complete) {
        const details = payload.virtualCapture;
        const reason = details.timedOut ? "timed out before reaching the end"
          : !details.reachedEnd ? "did not reach the end"
            : "exceeded the safe rendered-document size limit";
        const error = new Error(`${RENDER_SERVICES[service]?.name || service} virtualized document capture ${reason}`);
        error.code = "DOCUMENT_CAPTURE_INCOMPLETE";
        error.capture = {
          blockCount: Number(details.blockCount) || 0,
          textChars: Number(details.textChars) || 0,
          steps: Number(details.steps) || 0,
        };
        throw error;
      }
      if (looksLikeBlockedPage(payload)) {
        const error = new Error(`${RENDER_SERVICES[service]?.name || service} blocked automated page access`);
        error.code = "PAGE_ACCESS_BLOCKED";
        throw error;
      }
      if (looksLikeAuthentication(payload, service)) {
        const serviceName = RENDER_SERVICES[service]?.name || service;
        const error = new Error(`${serviceName}页面需要登录:请先在「浏览器会话」面板打开「${serviceName}」登录窗口完成登录,再重新剪藏`);
        error.code = "DOCUMENT_LOGIN_REQUIRED";
        throw error;
      }
      return payload;
    } finally {
      offFetch();
      try { await client.send("Page.close", {}, 2_000); } catch (_) {}
      client.close();
      if (entry.owned) await this.close(service);
    }
  }

  async close(service) {
    const entry = this.active.get(service);
    if (!entry) return;
    // 优雅关闭前先抓一次内存 cookie(尽量持久化,失败不影响关闭流程)
    await this.captureActiveCookies(service).catch(() => {});
    this.active.delete(service);
    try {
      const client = await CdpClient.connect(entry.browserWebSocketDebuggerUrl, 2_000);
      await client.send("Browser.close", {}, 3_000).catch(() => undefined);
      client.close();
    } catch (_) {
      try { entry.child.kill("SIGTERM"); } catch (_) {}
    }
    if (entry.child.exitCode === null) {
      await Promise.race([
        new Promise((resolve) => entry.child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 3_000)),
      ]);
    }
    if (entry.child.exitCode === null) {
      try { entry.child.kill("SIGTERM"); } catch (_) {}
    }
  }

  async closeAll() {
    await Promise.all([...this.active.keys()].map((service) => this.close(service)));
  }

  /**
   * Launch (or reuse) the service's persistent headless profile and return the
   * site's cookies as a Cookie header string. Order:
   * 1. read cookies already persisted in the profile (instant when the user has
   *    opened the isolated session once);
   * 2. otherwise visit `warmupUrl` (UA override + stealth active) so the site
   *    plants its cookies;
   * 3. optionally retry with `options.fallbackUrl` when the warmup page did not
   *    yield `options.requiredCookie`.
   */
  async collectCookies(service, warmupUrl, options = {}) {
    // 三级获取:1) 登录窗口活着→抓内存 cookie(最准,顺手持久化);
    // 2) 之前抓取过的持久化文件(窗口已关的兜底);3) 新起 headless 读 Chrome 磁盘数据库
    let suffix = "";
    try { suffix = new URL(warmupUrl).hostname.toLowerCase().split(".").slice(-2).join("."); } catch (_) { return ""; }
    const activeCookies = await this.captureActiveCookies(service, suffix).catch(() => "");
    if (activeCookies) return activeCookies;
    const savedCookies = this.readPersistedCookies(service);
    if (savedCookies) return savedCookies;
    const entry = await this.start(service, { browserExecutable: options.browserExecutable, headless: true });
    let client;
    try {
      client = await this.createPage(entry);
      await client.send("Page.enable");
      await client.send("Runtime.enable");
      await this.configurePage(client);
      const readCookies = async () => {
        const result = await client.send("Storage.getCookies", {}, 10_000).catch(() => ({ cookies: [] }));
        return (result.cookies || [])
          .filter((cookie) => cookie.domain === suffix || cookie.domain === `.${suffix}` || cookie.domain.endsWith(`.${suffix}`))
          .map((cookie) => `${cookie.name}=${cookie.value}`)
          .join("; ");
      };
      const required = String(options.requiredCookie || "");
      const persisted = await readCookies();
      if (!required || persisted.includes(`${required}=`)) return persisted;
      const settleMs = Math.max(0, Number(options.settleMs) || 4_000);
      const visit = async (url) => {
        // omni waits for DOMContentLoaded then polls for the required cookie
        // instead of sleeping a fixed duration; mirror that here.
        const domReady = client.waitFor("Page.domContentEventFired", 20_000).catch(() => undefined);
        await client.send("Page.navigate", { url }, 20_000).catch(() => undefined);
        await domReady;
        await new Promise((resolve) => setTimeout(resolve, settleMs));
        if (required) {
          const deadline = Date.now() + 8_000;
          let cookies = await readCookies();
          while (!cookies.includes(`${required}=`) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            cookies = await readCookies();
          }
          return cookies;
        }
        return readCookies();
      };
      const warm = await visit(warmupUrl);
      if (!required || warm.includes(`${required}=`)) return warm;
      const fallbackUrl = String(options.fallbackUrl || "");
      if (!fallbackUrl) return warm;
      return await visit(fallbackUrl);
    } finally {
      try { if (client) { try { await client.send("Page.close", {}, 2_000); } catch (_) {} } } catch (_) {}
      try { if (client) client.close(); } catch (_) {}
      if (entry.owned) await this.close(service);
    }
  }
}

module.exports = {
  CdpClient,
  KNOWN_BROWSER_PATHS,
  WebSessionManager,
  commentSelectorsForService,
  findBrowserExecutable,
  isSupportedBrowserExecutablePath,
  looksLikeBlockedPage,
  looksLikeAuthentication,
  renderedPayloadExpression,
  selectorsForService,
};
