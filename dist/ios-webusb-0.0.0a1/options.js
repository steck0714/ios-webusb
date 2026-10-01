"use strict";
(() => {
  // src/core/url.ts
  function parseBridgeUrl(value) {
    let url;
    try {
      url = new URL(value.trim());
    } catch {
      throw new Error(`not a valid URL: ${value}`);
    }
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      throw new Error(`the bridge URL must start with ws:// or wss:// (got ${url.protocol}//)`);
    }
    return url;
  }

  // src/crx/options.ts
  var ext = globalThis.browser ?? chrome;
  var ja = /^ja\b/i.test(navigator.language);
  var T = ja ? {
    saved: "\u4FDD\u5B58\u3057\u307E\u3057\u305F",
    testing: "\u63A5\u7D9A\u3092\u78BA\u8A8D\u3057\u3066\u3044\u307E\u3059\u2026",
    ok: (server) => `\u63A5\u7D9A\u3067\u304D\u307E\u3057\u305F (${server})`,
    ng: (msg) => `\u63A5\u7D9A\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F: ${msg}`,
    invalid: (msg) => `URL\u3092\u78BA\u8A8D\u3057\u3066\u304F\u3060\u3055\u3044: ${msg}`,
    insecure: "ws:// \u306F\u6697\u53F7\u5316\u3055\u308C\u307E\u305B\u3093\u3002\u4FE1\u983C\u3067\u304D\u308B\u30CD\u30C3\u30C8\u30EF\u30FC\u30AF\u306E\u4E2D\u3060\u3051\u3067\u4F7F\u3063\u3066\u304F\u3060\u3055\u3044\u3002"
  } : {
    saved: "Saved",
    testing: "Checking the connection\u2026",
    ok: (server) => `Connected (${server})`,
    ng: (msg) => `Could not connect: ${msg}`,
    invalid: (msg) => `Check the URL: ${msg}`,
    insecure: "ws:// is not encrypted. Use it only on a network you trust."
  };
  var $ = (id) => document.getElementById(id);
  var urlInput = $("bridgeUrl");
  var tokenInput = $("token");
  var status = $("status");
  var warn = $("warn");
  var show = (text, kind = "") => {
    status.textContent = text;
    status.dataset.kind = kind;
  };
  function validate() {
    try {
      const url = parseBridgeUrl(urlInput.value);
      warn.textContent = url.protocol === "ws:" ? T.insecure : "";
      return url;
    } catch (e) {
      show(T.invalid(e instanceof Error ? e.message : String(e)), "ng");
      return null;
    }
  }
  urlInput.addEventListener("input", () => {
    show("");
    try {
      warn.textContent = parseBridgeUrl(urlInput.value).protocol === "ws:" ? T.insecure : "";
    } catch {
      warn.textContent = "";
    }
  });
  $("form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!validate()) return;
    await ext.storage.local.set({ bridgeUrl: urlInput.value.trim(), token: tokenInput.value });
    show(T.saved, "ok");
  });
  $("test").addEventListener("click", async () => {
    if (!validate()) return;
    show(T.testing);
    try {
      const res = await ext.runtime.sendMessage({ type: "ios-webusb:test", bridgeUrl: urlInput.value.trim(), token: tokenInput.value });
      if (res?.ok) show(T.ok(res.info?.server ?? "?"), "ok");
      else show(T.ng(res?.error ?? "no answer from the extension"), "ng");
    } catch (e) {
      show(T.ng(e instanceof Error ? e.message : String(e)), "ng");
    }
  });
  void ext.storage.local.get(["bridgeUrl", "token"]).then((r) => {
    urlInput.value = typeof r.bridgeUrl === "string" ? r.bridgeUrl : "";
    tokenInput.value = typeof r.token === "string" ? r.token : "";
    if (urlInput.value) validate();
  });
})();
