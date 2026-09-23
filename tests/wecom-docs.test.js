"use strict";

// 企微文档(doc.weixin.qq.com)导出流单测:与腾讯分离,错误码 WECOM_DOCS_*。
// mock 只需三段接口:export_office / query_progress / COS 下载(企微无 opendoc 换 id、无 file/desc 元信息)。
const test = require("node:test");
const assert = require("node:assert/strict");
const { extractWecomFileExport } = require("../src/clip/cloud-docs/wecom-docs");

function wecomMockFetch({ pollPayloads, downloadBuffer, downloadDisposition }) {
  const calls = [];
  let pollCount = 0;
  const fetchImpl = async (target, init = {}) => {
    calls.push({ target, init });
    const jsonResponse = (payload) => ({
      ok: true, status: 200,
      headers: { get: () => "application/json" },
      body: (async function* () { yield Buffer.from(JSON.stringify(payload)); })(),
    });
    if (target.includes("/v1/export/export_office")) return jsonResponse({ ret: 0, operationId: "wecom-op-1" });
    if (target.includes("/v1/export/query_progress")) {
      const payload = pollPayloads[Math.min(pollCount, pollPayloads.length - 1)];
      pollCount += 1;
      return jsonResponse(payload);
    }
    return {
      ok: true, status: 200,
      headers: { get: (k) => (String(k).toLowerCase() === "content-disposition" ? downloadDisposition : "application/octet-stream") },
      body: (async function* () { yield downloadBuffer; })(),
    };
  };
  return { fetchImpl, calls };
}

test("wecomdoc sheet export posts form with captcha placeholders and timestamp polling", async () => {
  const cookieCalls = [];
  const { fetchImpl, calls } = wecomMockFetch({
    pollPayloads: [
      { ret: 0, status: "Processing", progress: 40 },
      { ret: 0, status: "Done", progress: 100, file_url: "https://wedoc-cos.example/export/sse/xlsx/e3_x/file.xlsx" },
    ],
    downloadBuffer: Buffer.from("504b0304wecom-xlsx"),
    downloadDisposition: "attachment; filename=\"特征及样本已迁移的表.xlsx\"",
  });
  await assert.rejects(
    extractWecomFileExport("https://doc.weixin.qq.com/sheet/e3_AXMA8gbzAFMCNaVZkdhWKSHyehvk7?scode=ADsAHgeCAAsgJH0WdEAXMA8gbzAFM&tab=78j3ml", {
      collectSessionCookies: async (service, target) => { cookieCalls.push({ service, target }); return "WEDOC_SID=tok"; },
      fetchImpl,
    }),
    (error) => {
      assert.equal(error.code, "WECOM_DOCS_BINARY");  // 企微错误码与腾讯分离
      assert.equal(error.fileName, "特征及样本已迁移的表.xlsx");
      assert.equal(error.meta.padType, "sheet");
      assert.match(error.meta.mimeType, /spreadsheetml\.sheet/);
      assert.equal(error.meta.author, "");            // 企微无元信息接口,留空
      return true;
    },
  );
  assert.deepEqual(cookieCalls[0], { service: "wecomdoc", target: "https://doc.weixin.qq.com/" });
  const postCall = calls.find((c) => c.target.includes("/v1/export/export_office"));
  assert.match(postCall.target, /wedoc_xsrf=1/);      // 企微 xsrf 走 query 参数
  assert.equal(postCall.init.body, "docId=e3_AXMA8gbzAFMCNaVZkdhWKSHyehvk7&version=2&captchaTicket=&captchaRandstr=");
  // 企微不需要 opendoc 换 globalPadId,也没有 file/desc 元信息接口
  assert.equal(calls.filter((c) => c.target.includes("/dop-api/opendoc")).length, 0);
  assert.equal(calls.filter((c) => c.target.includes("/v2/drive/file/desc")).length, 0);
  const pollCall = calls.find((c) => c.target.includes("/v1/export/query_progress"));
  assert.match(pollCall.target, /timestamp=\d+/);     // 企微轮询带 timestamp 防缓存
});

test("wecomdoc export requires wecomdoc session", async () => {
  await assert.rejects(
    extractWecomFileExport("https://doc.weixin.qq.com/sheet/e3_AXMA8gbzAFMCNaVZkdhWKSHyehvk7", { collectSessionCookies: async () => "" }),
    (error) => error.code === "DOCUMENT_LOGIN_REQUIRED",
  );
});

test("wecomdoc slide export uses pptx metadata", async () => {
  const { fetchImpl } = wecomMockFetch({
    pollPayloads: [{ ret: 0, status: "Done", progress: 100, file_url: "https://wedoc-cos.example/f" }],
    downloadBuffer: Buffer.from("504b0304wecom-pptx"),
    downloadDisposition: "attachment; filename=\"企微演示.pptx\"",
  });
  await assert.rejects(
    extractWecomFileExport("https://doc.weixin.qq.com/slide/e3_AXMA8gbzAFMCNaVZkdhWKSHyehvk7", {
      collectSessionCookies: async () => "WEDOC_SID=tok",
      fetchImpl,
    }),
    (error) => {
      assert.equal(error.code, "WECOM_DOCS_BINARY");
      assert.match(error.meta.mimeType, /presentationml\.presentation/);
      return true;
    },
  );
});
