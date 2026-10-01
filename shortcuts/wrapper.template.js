// ios-webusb __IOS_WEBUSB_VERSION__ — Shortcuts build
// ショートカット「Webページ上でJavaScriptを実行」(Run JavaScript on Web Page)に貼って使います。
// 書き換えるのは次の1行だけです: ブリッジのURL(httpsのページでは wss:// が必要)と、必要ならトークン。
var IOS_WEBUSB_CONFIG = { bridgeUrl: "wss://192.168.0.10:8765/", token: "" };

(function () {
  "use strict";
  var ATTR = "data-ios-webusb";
  var PAYLOAD = "__IOS_WEBUSB_PAYLOAD__";
  var ja = /^ja/i.test(navigator.language || "");
  var TEXT = {
    installed: ja ? "navigator.usb を有効にしました" : "navigator.usb is now available",
    "already-installed": ja ? "すでに有効です" : "Already enabled",
    "native-usb-present": ja ? "このブラウザはWebUSBに標準対応しています" : "This browser already supports WebUSB",
    "insecure-context": ja ? "https のページでのみ使えます" : "Only works on https pages",
    "permissions-policy": ja ? "このページはUSBの利用を許可していません" : "This page does not allow USB",
    blocked: ja ? "このページのセキュリティ設定(CSP)で注入できませんでした" : "The page's Content-Security-Policy blocked the injection"
  };

  function toast(text, ok) {
    try {
      var el = document.createElement("div");
      el.setAttribute("role", "status");
      el.textContent = (ok ? "\u2713  " : "\u2715  ") + text;
      // CSSOM only (no <style>, no style attribute): unaffected by the page's style-src CSP.
      el.style.cssText = "all:initial;position:fixed;z-index:2147483647;left:50%;" +
        "top:max(12px,env(safe-area-inset-top));transform:translateX(-50%);" +
        "max-width:min(92vw,420px);padding:13px 20px;border-radius:22px;text-align:center;" +
        "font:600 15px/1.35 -apple-system,BlinkMacSystemFont,'Hiragino Sans',system-ui,sans-serif;color:#fff;" +
        "background:rgba(44,44,46,.92);-webkit-backdrop-filter:saturate(180%) blur(20px);" +
        "backdrop-filter:saturate(180%) blur(20px);box-shadow:0 8px 28px rgba(0,0,0,.28);pointer-events:none";
      (document.body || document.documentElement).appendChild(el);
      // A Web Animation keeps running after this action finishes, and needs no timer of ours.
      if (el.animate) {
        el.animate([{ opacity: 0, transform: "translate(-50%,-14px)" }, { opacity: 1, transform: "translate(-50%,0)", offset: 0.1 }, { opacity: 1, transform: "translate(-50%,0)", offset: 0.8 }, { opacity: 0, transform: "translate(-50%,-14px)" }], { duration: 3400, fill: "forwards" })
          .finished.then(function () { el.remove(); }, function () { el.remove(); });
      } else {
        setTimeout(function () { el.remove(); }, 3000);
      }
    } catch (e) { /* no DOM to show it in */ }
  }

  function finish(ok, reason) {
    toast(TEXT[reason] || ("ios-webusb: " + reason), ok);
    if (typeof completion === "function") completion({ ok: ok, reason: reason });
  }

  try {
    var root = document.documentElement;
    if (root.getAttribute(ATTR) === "installed") { finish(true, "already-installed"); return; }
    var s = document.createElement("script");
    s.textContent = "(function(){" + PAYLOAD + "\n;__iosWebUsb.install(" + JSON.stringify(IOS_WEBUSB_CONFIG) + ");})();";
    (document.head || root).appendChild(s);
    s.remove();
    var state = root.getAttribute(ATTR);
    if (state === null) { finish(false, "blocked"); return; }
    var ok = state === "installed" || state === "native-usb-present";
    finish(ok, state);
  } catch (e) {
    finish(false, "error: " + (e && e.message ? e.message : String(e)));
  }
})();
