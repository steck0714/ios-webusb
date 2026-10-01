"use strict";
(() => {
  // src/core/chooser.ts
  var STRINGS = {
    ja: {
      title: "USB\u30C7\u30D0\u30A4\u30B9\u3092\u9078\u629E",
      lead: (o) => `${o} \u304CUSB\u30C7\u30D0\u30A4\u30B9\u3078\u306E\u30A2\u30AF\u30BB\u30B9\u3092\u6C42\u3081\u3066\u3044\u307E\u3059\u3002`,
      list: "\u5229\u7528\u3067\u304D\u308BUSB\u30C7\u30D0\u30A4\u30B9",
      connect: "\u63A5\u7D9A",
      cancel: "\u30AD\u30E3\u30F3\u30BB\u30EB",
      refresh: "\u518D\u691C\u7D22",
      searching: "\u691C\u7D22\u3057\u3066\u3044\u307E\u3059\u2026",
      found: (n) => `${n}\u4EF6\u306EUSB\u30C7\u30D0\u30A4\u30B9\u304C\u898B\u3064\u304B\u308A\u307E\u3057\u305F`,
      empty: "USB\u30C7\u30D0\u30A4\u30B9\u304C\u898B\u3064\u304B\u308A\u307E\u305B\u3093",
      hint: "\u30D6\u30EA\u30C3\u30B8\u5074\u306E\u30B3\u30F3\u30D4\u30E5\u30FC\u30BF\u306B\u30C7\u30D0\u30A4\u30B9\u3092\u63A5\u7D9A\u3057\u3066\u304B\u3089\u3001\u300C\u518D\u691C\u7D22\u300D\u3092\u30BF\u30C3\u30D7\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
      unnamed: "\u540D\u79F0\u4E0D\u660E\u306E\u30C7\u30D0\u30A4\u30B9",
      failed: "\u691C\u7D22\u306B\u5931\u6557\u3057\u307E\u3057\u305F"
    },
    en: {
      title: "Select a USB Device",
      lead: (o) => `${o} wants to use a USB device.`,
      list: "Available USB Devices",
      connect: "Connect",
      cancel: "Cancel",
      refresh: "Search Again",
      searching: "Searching\u2026",
      found: (n) => `${n} USB device${n === 1 ? "" : "s"} found`,
      empty: "No USB Devices Found",
      hint: "Plug the device into the computer that runs the bridge, then tap Search Again.",
      unnamed: "Unnamed Device",
      failed: "Search failed"
    }
  };
  function sanitizeLabel(value, max = 80) {
    let s = typeof value === "string" ? value : "";
    s = s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "");
    s = s.replace(/\s+/g, " ").trim();
    return s.length > max ? `${s.slice(0, max - 1)}\u2026` : s;
  }
  var hex4 = (n) => (Number.isInteger(n) ? n : 0).toString(16).padStart(4, "0");
  var CSS = `
:host { all: initial; color-scheme: light dark; }
*, *::before, *::after { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
[hidden] { display: none !important; }

.scrim {
  --sheet: #f2f2f7; --cell: #ffffff; --label: #000000;
  --label2: rgba(60, 60, 67, .6); --label3: rgba(60, 60, 67, .3);
  --sep: rgba(60, 60, 67, .29); --press: rgba(60, 60, 67, .12); --grab: rgba(60, 60, 67, .3);
  --blue: #007aff; --red: #ff3b30; --tile: #8e8e93;
  position: fixed; inset: 0; z-index: 2147483647;
  display: flex; align-items: flex-end; justify-content: center;
  padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) 0 env(safe-area-inset-left, 0px);
  background: rgba(0, 0, 0, .4); touch-action: none;
  font: 17px/1.3 -apple-system, "SF Pro Text", "Hiragino Sans", "Hiragino Kaku Gothic ProN", system-ui, sans-serif;
  color: var(--label); -webkit-text-size-adjust: 100%; text-size-adjust: 100%;
  -webkit-font-smoothing: antialiased; line-break: strict;
  animation: fade .25s ease-out;
}
@media (prefers-color-scheme: dark) {
  .scrim {
    --sheet: #1c1c1e; --cell: #2c2c2e; --label: #ffffff;
    --label2: rgba(235, 235, 245, .6); --label3: rgba(235, 235, 245, .3);
    --sep: rgba(84, 84, 88, .65); --press: rgba(255, 255, 255, .1); --grab: rgba(235, 235, 245, .3);
    --blue: #0a84ff; --red: #ff453a; --tile: #636366;
  }
}

.sheet {
  display: flex; flex-direction: column; width: 100%; overflow: hidden; outline: none;
  background: var(--sheet); border-radius: 16px 16px 0 0;
  max-height: calc(100vh - 48px); max-height: calc(100dvh - 48px - env(safe-area-inset-top, 0px));
  box-shadow: 0 -6px 34px rgba(0, 0, 0, .2); will-change: transform;
  animation: rise .42s cubic-bezier(.32, .72, 0, 1);
}

.top {
  flex: none; position: relative; z-index: 1; touch-action: none; user-select: none; -webkit-user-select: none;
  background: var(--sheet);
}
@supports (backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)) {
  .top { background: color-mix(in srgb, var(--sheet) 80%, transparent); -webkit-backdrop-filter: saturate(180%) blur(20px); backdrop-filter: saturate(180%) blur(20px); }
}
.top::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: .5px; background: var(--sep); opacity: 0; transition: opacity .15s; }
.scrolled .top::after { opacity: 1; }
.grabber { width: 36px; height: 5px; margin: 6px auto 0; border-radius: 3px; background: var(--grab); }
/* the side buttons never shrink below their text; the title is what gives way (ellipsis) on narrow screens */
.bar { display: grid; grid-template-columns: minmax(max-content, 1fr) minmax(0, auto) minmax(max-content, 1fr); align-items: center; min-height: 52px; padding: 0 8px; }
.bar h2 { min-width: 0; margin: 0; padding: 0 4px; text-align: center; font-size: 17px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.txt {
  font: inherit; font-size: 17px; min-width: 44px; min-height: 44px; padding: 0 8px; border: 0; border-radius: 8px;
  background: none; color: var(--blue); cursor: pointer; white-space: nowrap; touch-action: manipulation;
}
.txt.cancel { justify-self: start; }
.txt.done { justify-self: end; font-weight: 600; }
.txt:disabled { color: var(--label3); cursor: default; }
.txt:active:not(:disabled) { opacity: .4; }

.body {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; touch-action: pan-y;
  padding: 2px 16px calc(28px + env(safe-area-inset-bottom, 0px));
}
.lead, .foot { margin: 6px 16px 8px; font-size: 13px; line-height: 1.35; color: var(--label2); overflow-wrap: anywhere; text-wrap: pretty; word-break: auto-phrase; }
.foot { margin-top: 8px; min-height: 1.35em; }
.foot.err { color: var(--red); }

.group { margin: 0; padding: 0; border: 0; min-width: 0; background: var(--cell); border-radius: 12px; overflow: hidden; }
.group legend { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.row {
  position: relative; display: flex; align-items: center; gap: 12px; min-height: 60px; padding: 8px 16px;
  cursor: pointer; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
}
.row + .row::before { content: ""; position: absolute; top: 0; left: 58px; right: 0; height: .5px; background: var(--sep); }
.row:active { background: var(--press); }
.row input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
@supports selector(:has(*)) { .row:has(input:focus-visible) { outline: 3px solid var(--blue); outline-offset: -3px; } }
.tile { flex: none; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 7px; background: var(--tile); color: #fff; }
.tile svg { width: 20px; height: 20px; }
.text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.name { overflow-wrap: anywhere; }
.meta { font-size: 13px; line-height: 1.35; color: var(--label2); overflow-wrap: anywhere; }
.check { flex: none; width: 20px; height: 20px; color: var(--blue); opacity: 0; }
.row input:checked ~ .check { opacity: 1; }

.empty { padding: 30px 28px 14px; text-align: center; color: var(--label2); }
.empty svg { width: 46px; height: 46px; margin-bottom: 10px; color: var(--label3); }
.empty strong { display: block; font-size: 17px; font-weight: 600; color: var(--label); }
.empty span { display: block; margin-top: 4px; font-size: 15px; line-height: 1.35; text-wrap: balance; word-break: auto-phrase; }

.actions { margin-top: 20px; }
.act {
  display: flex; align-items: center; justify-content: space-between; width: 100%; min-height: 44px; padding: 0 16px;
  border: 0; background: none; font: inherit; font-size: 17px; text-align: left; color: var(--blue); cursor: pointer; touch-action: manipulation;
}
.act:active:not(:disabled) { background: var(--press); }
.act:disabled { color: var(--label3); cursor: default; }
.spin { width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--label3); border-top-color: var(--label2); animation: spin .8s linear infinite; }

@supports (font: -apple-system-body) {
  .scrim, .txt, .name, .act { font: -apple-system-body; }
  .bar h2 { font: -apple-system-headline; }
  .txt.done { font-weight: 600; }
  .meta, .lead, .foot { font: -apple-system-footnote; }
  .empty strong { font: -apple-system-headline; }
  .empty span { font: -apple-system-subheadline; }
}
.nw { display: inline-block; max-width: 100%; overflow-wrap: anywhere; }
.mono { font-family: ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace; font-size: .96em; }
:focus-visible { outline: 3px solid var(--blue); outline-offset: 2px; }
.sheet:focus-visible, .row input:focus-visible { outline: none; }

.closing { opacity: 0; transition: opacity .28s ease-in; }
.closing .sheet { transform: translateY(100%); transition: transform .28s cubic-bezier(.4, 0, 1, 1); }

@media (min-width: 600px) {
  .scrim { align-items: center; padding-bottom: env(safe-area-inset-bottom, 0px); }
  .sheet {
    width: 540px; border-radius: 14px; box-shadow: 0 20px 60px rgba(0, 0, 0, .3);
    max-height: min(80vh, 640px); max-height: min(80dvh, 640px); animation: pop .3s cubic-bezier(.32, .72, 0, 1);
  }
  .grabber { display: none; }
  .bar { min-height: 56px; }
  .closing .sheet { transform: scale(.97); }
}
@keyframes rise { from { transform: translateY(100%); } to { transform: none; } }
@keyframes pop { from { transform: scale(.96); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes spin { to { transform: rotate(360deg); } }
.still, .still .sheet, .still .spin { animation: none !important; transition: none !important; }
@media (prefers-reduced-motion: reduce) { .scrim, .sheet { animation: none !important; transition: none !important; } .spin { animation-duration: 2s; } }
`;
  function applyStyles(doc, root) {
    try {
      const Sheet = doc.defaultView?.CSSStyleSheet;
      if (Sheet && "replaceSync" in Sheet.prototype && "adoptedStyleSheets" in root) {
        const sheet = new Sheet();
        sheet.replaceSync(CSS);
        root.adoptedStyleSheets = [sheet];
        return;
      }
    } catch {
    }
    const style = doc.createElement("style");
    style.textContent = CSS;
    root.append(style);
  }
  function el(doc, tag, attrs = {}, ...children) {
    const node = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    for (const c of children) node.append(c);
    return node;
  }
  var SVG_NS = "http://www.w3.org/2000/svg";
  function icon(doc, shapes, attrs = {}) {
    const node = doc.createElementNS(SVG_NS, "svg");
    const base = { viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false", fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round", "stroke-linejoin": "round" };
    for (const [k, v] of Object.entries({ ...base, ...attrs })) node.setAttribute(k, v);
    for (const [tag, a] of shapes) {
      const s = doc.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(a)) s.setAttribute(k, v);
      node.append(s);
    }
    return node;
  }
  var USB_SHAPES = [
    ["path", { d: "M12 4.6V18" }],
    ["path", { d: "M12 2.2l-1.9 2.9h3.8z", fill: "currentColor" }],
    ["path", { d: "M12 14.6l-4.2-2.6V9.8" }],
    ["circle", { cx: "7.8", cy: "8.3", r: "1.5" }],
    ["path", { d: "M12 11.6l4.2-2.6V8.4" }],
    ["rect", { x: "14.7", y: "5.3", width: "3", height: "3", rx: ".4" }],
    ["circle", { cx: "12", cy: "20", r: "2", fill: "currentColor" }]
  ];
  var CHECK_SHAPES = [["path", { d: "M4.5 12.8l5 5 10-11.3" }]];
  var OverlayChooser = class {
    #doc;
    #mode;
    #lang;
    #origin;
    #trusted;
    #animate;
    constructor(options = {}) {
      this.#doc = options.document ?? document;
      this.#mode = options.shadowMode ?? "closed";
      const locale2 = options.locale ?? (typeof navigator !== "undefined" ? navigator.language : "en");
      this.#lang = /^ja\b/i.test(locale2) ? "ja" : "en";
      this.#origin = sanitizeLabel(options.origin ?? this.#doc.location?.host ?? "", 120) || "?";
      this.#trusted = options.requireTrustedInput ?? false;
      this.#animate = options.animate ?? true;
    }
    choose(candidates, context) {
      const doc = this.#doc;
      const win = doc.defaultView;
      const t = STRINGS[this.#lang];
      const accept = (e) => !this.#trusted || e.isTrusted;
      const still = !this.#animate || (win?.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
      return new Promise((resolve) => {
        const previouslyFocused = doc.activeElement;
        let list = candidates.slice();
        let selected = -1;
        let busy = false;
        let done = false;
        let drag = null;
        const host = el(doc, "div", { "data-ios-webusb-chooser": "" });
        const root = host.attachShadow({ mode: this.#mode });
        applyStyles(doc, root);
        const cancelBtn = el(doc, "button", { type: "button", class: "txt cancel" }, t.cancel);
        const doneBtn = el(doc, "button", { type: "button", class: "txt done" }, t.connect);
        doneBtn.disabled = true;
        const top = el(
          doc,
          "header",
          { class: "top" },
          el(doc, "div", { class: "grabber", "aria-hidden": "true" }),
          el(doc, "div", { class: "bar" }, cancelBtn, el(doc, "h2", { id: "ttl" }, t.title), doneBtn)
        );
        const lead = el(doc, "p", { class: "lead" }, t.lead(this.#origin));
        const group = el(doc, "fieldset", { class: "group" });
        const empty = el(
          doc,
          "div",
          { class: "empty" },
          icon(doc, USB_SHAPES, { "stroke-width": "1.3" }),
          el(doc, "strong", {}, t.empty),
          el(doc, "span", {}, t.hint)
        );
        const spin = el(doc, "span", { class: "spin", hidden: "" });
        const refreshBtn = el(doc, "button", { type: "button", class: "act" }, el(doc, "span", {}, t.refresh), spin);
        const actions = el(doc, "div", { class: "group actions" }, refreshBtn);
        actions.hidden = !context.refresh;
        const foot = el(doc, "p", { class: "foot", role: "status", "aria-live": "polite" });
        const body = el(doc, "div", { class: "body" }, lead, group, empty, actions, foot);
        const sheet = el(doc, "div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-labelledby": "ttl", tabindex: "-1" }, top, body);
        const scrim = el(doc, "div", { class: still ? "scrim still" : "scrim" }, sheet);
        root.append(scrim);
        const renderList = () => {
          group.replaceChildren(el(doc, "legend", {}, t.list));
          selected = -1;
          doneBtn.disabled = true;
          group.hidden = list.length === 0;
          empty.hidden = list.length > 0;
          list.forEach((d, i) => {
            const name = sanitizeLabel(d.productName) || t.unnamed;
            const maker = sanitizeLabel(d.manufacturerName, 60);
            const serial = sanitizeLabel(d.serialNumber, 40);
            const parts = [];
            if (maker) parts.push(maker);
            parts.push(el(doc, "span", { class: "mono" }, `${hex4(d.vendorId)}:${hex4(d.productId)}`));
            if (serial) parts.push(el(doc, "span", { class: "nw" }, `S/N ${serial}`));
            const meta = el(doc, "span", { class: "meta" });
            parts.forEach((p, n) => {
              if (n > 0) meta.append(" \xB7 ");
              meta.append(p);
            });
            const input = el(doc, "input", { type: "radio", name: "device", value: String(i) });
            input.addEventListener("click", (e) => {
              if (!accept(e)) e.preventDefault();
            });
            input.addEventListener("change", (e) => {
              if (!accept(e)) {
                input.checked = false;
                return;
              }
              selected = i;
              doneBtn.disabled = false;
            });
            group.append(el(
              doc,
              "label",
              { class: "row" },
              input,
              el(doc, "span", { class: "tile" }, icon(doc, USB_SHAPES)),
              el(doc, "span", { class: "text" }, el(doc, "span", { class: "name" }, name), meta),
              icon(doc, CHECK_SHAPES, { class: "check", "stroke-width": "2.4" })
            ));
          });
        };
        const observer = new (win?.MutationObserver ?? MutationObserver)(() => {
          if (!host.isConnected) finish(null);
        });
        function finish(value) {
          if (done) return;
          done = true;
          observer.disconnect();
          resolve(value);
          const remove = () => {
            host.remove();
            try {
              previouslyFocused?.focus?.({ preventScroll: true });
            } catch {
            }
          };
          if (still || !host.isConnected) {
            remove();
            return;
          }
          sheet.style.transform = "";
          scrim.classList.add("closing");
          setTimeout(remove, 300);
        }
        const connect = () => {
          if (selected >= 0) finish(list[selected] ?? null);
        };
        doneBtn.addEventListener("click", (e) => {
          if (accept(e)) connect();
        });
        cancelBtn.addEventListener("click", (e) => {
          if (accept(e)) finish(null);
        });
        scrim.addEventListener("click", (e) => {
          if (e.target === scrim && accept(e)) finish(null);
        });
        body.addEventListener("scroll", () => scrim.classList.toggle("scrolled", body.scrollTop > 0));
        refreshBtn.addEventListener("click", (e) => {
          if (!accept(e) || busy || !context.refresh) return;
          busy = true;
          refreshBtn.disabled = true;
          spin.hidden = false;
          foot.className = "foot";
          foot.textContent = t.searching;
          context.refresh().then((next) => {
            list = next.slice();
            renderList();
            foot.textContent = list.length > 0 ? t.found(list.length) : "";
          }).catch((err) => {
            foot.className = "foot err";
            foot.textContent = `${t.failed}: ${sanitizeLabel(err instanceof Error ? err.message : String(err), 120)}`;
          }).finally(() => {
            busy = false;
            refreshBtn.disabled = false;
            spin.hidden = true;
          });
        });
        top.addEventListener("pointerdown", (ev) => {
          const e = ev;
          if (!accept(e) || (win?.innerWidth ?? 0) >= 600 || e.target.closest("button")) return;
          drag = { startY: e.clientY, t0: e.timeStamp, dy: 0 };
          try {
            top.setPointerCapture?.(e.pointerId);
          } catch {
          }
          sheet.style.transition = "none";
        });
        top.addEventListener("pointermove", (ev) => {
          if (!drag) return;
          drag.dy = Math.max(0, ev.clientY - drag.startY);
          sheet.style.transform = `translateY(${drag.dy}px)`;
        });
        const endDrag = (ev) => {
          if (!drag) return;
          const { dy, t0 } = drag;
          drag = null;
          const velocity = dy / Math.max(1, ev.timeStamp - t0);
          sheet.style.transition = "";
          if (ev.type === "pointerup" && (dy > 120 || dy > 40 && velocity > 0.5)) finish(null);
          else sheet.style.transform = "";
        };
        top.addEventListener("pointerup", endDrag);
        top.addEventListener("pointercancel", endDrag);
        root.addEventListener("keydown", (ev) => {
          const e = ev;
          if (e.key === "Escape") {
            if (accept(e)) {
              e.preventDefault();
              finish(null);
            }
            return;
          }
          if (e.key === "Enter" && e.target.matches?.('input[type="radio"]')) {
            if (accept(e)) {
              e.preventDefault();
              connect();
            }
            return;
          }
          if (e.key !== "Tab") return;
          const items = [...root.querySelectorAll("input, button")].filter((n) => !n.disabled && !n.closest("[hidden]"));
          if (items.length === 0) {
            e.preventDefault();
            return;
          }
          const first = items[0];
          const last = items[items.length - 1];
          const active = root.activeElement;
          if (e.shiftKey && (active === first || active === sheet)) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && active === last) {
            e.preventDefault();
            first.focus();
          }
        });
        renderList();
        (doc.documentElement ?? doc.body).append(host);
        observer.observe(doc.documentElement, { childList: true });
        sheet.focus({ preventScroll: true });
      });
    }
  };

  // src/core/protocol.ts
  var RPC_METHODS = [
    "hello",
    "bridgeInfo",
    "requestDevice",
    "getDevices",
    "listAvailableDevices",
    "grantDevice",
    "open",
    "close",
    "forget",
    "selectConfiguration",
    "claimInterface",
    "releaseInterface",
    "selectAlternateInterface",
    "resetDevice",
    "clearHalt",
    "controlTransferIn",
    "controlTransferOut",
    "transferIn",
    "transferOut",
    "isochronousTransferIn",
    "isochronousTransferOut"
  ];
  var BRIDGE_METHODS = RPC_METHODS.filter((m) => m !== "requestDevice");
  var TRUSTED_ONLY_METHODS = ["hello", "listAvailableDevices", "grantDevice"];
  var PAGE_RPC_METHODS = RPC_METHODS.filter(
    (m) => !TRUSTED_ONLY_METHODS.includes(m)
  );

  // src/core/transports/postmessage.ts
  var RELAY_CHANNEL = "__iosWebusb__";
  function targetOriginOf(win) {
    const origin = win.location.origin;
    return origin && origin !== "null" ? origin : "*";
  }

  // src/core/usb.ts
  function deviceRef(w) {
    return {
      deviceId: w.deviceId,
      vendorId: w.vendorId,
      productId: w.productId,
      serialNumber: w.serialNumber ?? void 0
    };
  }
  function isUint(value, max) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
  }
  function checkFilter(f, name) {
    if (typeof f !== "object" || f === null) throw new TypeError(`${name} contains an invalid USBDeviceFilter`);
    const r = f;
    const fields = [
      ["vendorId", 65535],
      ["productId", 65535],
      ["classCode", 255],
      ["subclassCode", 255],
      ["protocolCode", 255]
    ];
    for (const [key, max] of fields) {
      if (r[key] !== void 0 && !isUint(r[key], max)) {
        throw new TypeError(`${name}: ${key} must be an integer between 0 and ${max}`);
      }
    }
    if (r.serialNumber !== void 0 && typeof r.serialNumber !== "string") {
      throw new TypeError(`${name}: serialNumber must be a string`);
    }
    if (r.productId !== void 0 && r.vendorId === void 0) throw new TypeError(`${name}: productId requires vendorId`);
    if (r.subclassCode !== void 0 && r.classCode === void 0) throw new TypeError(`${name}: subclassCode requires classCode`);
    if (r.protocolCode !== void 0 && r.subclassCode === void 0) throw new TypeError(`${name}: protocolCode requires subclassCode`);
    return f;
  }
  function checkFilters(filters, name) {
    if (!Array.isArray(filters)) throw new TypeError(`${name} must be an array`);
    return filters.map((f) => checkFilter(f, name));
  }

  // src/crx/relay.ts
  var GESTURE_EVENTS = ["click", "keydown", "pointerdown", "touchstart"];
  var errorText = (e) => e instanceof Error ? e.message : String(e);
  function startRelay(deps) {
    const win = deps.win;
    const doc = win.document;
    const now = deps.now ?? Date.now;
    const isTrusted = deps.isTrusted ?? ((e) => e.isTrusted);
    const gestureWindowMs = deps.gestureWindowMs ?? 5e3;
    let lastGesture = Number.NEGATIVE_INFINITY;
    const onGesture = (e) => {
      if (isTrusted(e)) lastGesture = now();
    };
    for (const type of GESTURE_EVENTS) doc.addEventListener(type, onGesture, true);
    const hasGesture = () => now() - lastGesture < gestureWindowMs;
    let port = null;
    let nextId = 1;
    const pending = /* @__PURE__ */ new Map();
    const failAll = (error) => {
      for (const [id, p] of pending) {
        p.reject(error);
        pending.delete(id);
      }
    };
    const toPage = (msg) => {
      win.postMessage(msg, targetOriginOf(win));
    };
    const onPortMessage = (raw) => {
      const msg = raw;
      if (!msg || typeof msg !== "object") return;
      if (msg.kind === "response" && typeof msg.id === "number") {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (typeof msg.error === "string") p.reject(new Error(msg.error));
        else p.resolve(msg.result);
      } else if (msg.kind === "event" && (msg.event === "connect" || msg.event === "disconnect") && msg.device) {
        toPage({ channel: RELAY_CHANNEL, dir: "toPage", kind: "event", event: msg.event, device: msg.device });
      }
    };
    const ensurePort = () => {
      if (port) return port;
      const p = deps.connect();
      p.onMessage.addListener(onPortMessage);
      p.onDisconnect.addListener(() => {
        if (port !== p) return;
        port = null;
        failAll(new Error("the extension connection was lost, please try again"));
      });
      port = p;
      return p;
    };
    const callBackground = (method, params) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      try {
        ensurePort().postMessage({ kind: "call", id, method, params, hasGesture: hasGesture(), locale: deps.locale });
      } catch (e) {
        pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    let chooserOpen = false;
    const requestDevice = async (params) => {
      const p = params ?? {};
      let filters, exclusionFilters;
      try {
        filters = checkFilters(p.filters ?? [], "filters");
        exclusionFilters = checkFilters(p.exclusionFilters ?? [], "exclusionFilters");
      } catch (e) {
        throw new Error(`DataError: ${errorText(e)}`);
      }
      if (!hasGesture()) throw new Error("SecurityError: Must be handling a user gesture to show a permission request.");
      if (chooserOpen) throw new Error("InvalidStateError: A device chooser is already open.");
      chooserOpen = true;
      try {
        const list = async () => await callBackground("listAvailableDevices", { filters, exclusionFilters });
        const candidates = await list();
        const chosen = await deps.chooser.choose(candidates, { filters, exclusionFilters, refresh: list });
        if (!chosen) throw new Error("NotFoundError: No device selected.");
        return await callBackground("grantDevice", deviceRef(chosen));
      } finally {
        chooserOpen = false;
      }
    };
    const allowed = PAGE_RPC_METHODS;
    const onPageMessage = (ev) => {
      if (ev.source !== win) return;
      const d = ev.data;
      if (!d || d.channel !== RELAY_CHANNEL || d.dir !== "toContent" || d.kind !== "call") return;
      const { id, method } = d;
      if (typeof id !== "number" || typeof method !== "string") return;
      const reply = (r) => toPage({ channel: RELAY_CHANNEL, dir: "toPage", kind: "response", id, ...r });
      if (!allowed.includes(method)) {
        reply({ error: "NotSupportedError: this method cannot be called from a web page" });
        return;
      }
      const run = method === "requestDevice" ? requestDevice(d.params) : callBackground(method, d.params);
      run.then((result) => reply({ result }), (err) => reply({ error: errorText(err) }));
    };
    win.addEventListener("message", onPageMessage);
    return {
      stop() {
        win.removeEventListener("message", onPageMessage);
        for (const type of GESTURE_EVENTS) doc.removeEventListener(type, onGesture, true);
        failAll(new Error("relay stopped"));
        try {
          port?.disconnect();
        } catch {
        }
        port = null;
      }
    };
  }

  // src/crx/content.ts
  var ext = globalThis.browser ?? chrome;
  var locale = ext.i18n?.getUILanguage?.() ?? navigator.language;
  startRelay({
    win: window,
    connect: () => ext.runtime.connect({ name: "ios-webusb" }),
    // The chooser lives in this world and only reacts to real (trusted) input.
    chooser: new OverlayChooser({ locale, origin: location.host, requireTrustedInput: true }),
    locale
  });
  try {
    const script = document.createElement("script");
    script.src = ext.runtime.getURL("page.js");
    script.onload = () => script.remove();
    script.onerror = () => script.remove();
    (document.head ?? document.documentElement).appendChild(script);
  } catch {
  }
})();
