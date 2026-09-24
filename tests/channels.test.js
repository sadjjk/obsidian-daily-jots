"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ChannelManager } = require("../src/channels");

test("failed re-pairing restores an enabled channel and resumes its previous session", async () => {
  let saves = 0;
  let creates = 0;
  let resumed = false;
  const plugin = {
    settings: { channels: { wechat: { enabled: true, token: "existing-token" } } },
    saveSettings: async () => { saves += 1; },
    t: (zh) => zh,
  };
  const manager = new ChannelManager(plugin, async () => {});
  manager.create = () => {
    creates += 1;
    if (creates === 1) {
      return {
        beginPairing: async () => { throw new Error("pairing failed"); },
        stop: async () => {},
      };
    }
    return { start: async () => { resumed = true; } };
  };

  await assert.rejects(() => manager.pair("wechat", {}), /pairing failed/);
  assert.equal(plugin.settings.channels.wechat.enabled, true);
  assert.equal(resumed, true);
  assert.equal(manager.instances.has("wechat"), true);
  assert.equal(saves, 2);
});

test("failed first-time pairing remains disabled", async () => {
  const plugin = {
    settings: { channels: { wechat: { enabled: false, token: "" } } },
    saveSettings: async () => {},
    t: (zh) => zh,
  };
  const manager = new ChannelManager(plugin, async () => {});
  manager.create = () => ({
    beginPairing: async () => { throw new Error("pairing failed"); },
    stop: async () => {},
  });

  await assert.rejects(() => manager.pair("wechat", {}), /pairing failed/);
  assert.equal(plugin.settings.channels.wechat.enabled, false);
  assert.equal(manager.getStatuses().wechat.state, "error");
});

test("qq channel surfaces a friendly error when the open platform is unreachable", async () => {
  // 预检:token 端点网络层失败时给出可操作的提示(带底层原因),不再甩晦涩的 "Network error"
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } });
  };
  try {
    const { QQChannel } = require("../src/channels/qq");
    const channel = new QQChannel({ appId: "a", appSecret: "b" }, { t: (zh) => zh });
    await assert.rejects(() => channel.start(), /无法访问 QQ 开放平台\(bots\.qq\.com\):ENOTFOUND/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cors-free fetch adapter maps requestUrl onto a Response-like object", async () => {
  const { createCorsFreeFetch } = require("../src/channels/qq");
  const originalFetchMarker = globalThis.fetch;
  const calls = [];
  const requestUrl = async (options) => {
    calls.push(options);
    return { status: 200, headers: { "X-Tps-Trace-Id": "trace-1", "content-type": "application/json" }, text: '{"access_token":"tok"}', arrayBuffer: new ArrayBuffer(3) };
  };
  const fetchImpl = createCorsFreeFetch(requestUrl);
  const response = await fetchImpl("https://bots.qq.com/app/getAppAccessToken", { method: "POST", headers: { "content-type": "application/json" }, body: '{"appId":"a"}' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://bots.qq.com/app/getAppAccessToken");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].throw, false);
  assert.equal(response.ok, true);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-tps-trace-id"), "trace-1"); // 小写归一化,SDK 读 trace 头不落空
  assert.equal(await response.text(), '{"access_token":"tok"}');
  assert.deepEqual(await response.json(), { access_token: "tok" });
  assert.equal((await response.arrayBuffer()).byteLength, 3);
  // 无 obsidian 模块的环境(单测)回退原生 fetch 引用
  assert.equal(createCorsFreeFetch(null, originalFetchMarker), originalFetchMarker);
});
