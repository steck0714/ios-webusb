// chooser.ts — the device picker, styled as an iOS sheet
// ======================================================
// Phone: bottom sheet with a grabber; swipe down (or tap outside / Cancel) to dismiss.
// Wide screens (iPad, landscape): centred form sheet. The look follows iOS: system colours
// (light/dark through prefers-color-scheme), SF type that follows Dynamic Type where WebKit
// supports it, an inset grouped list with a trailing checkmark, and the usual
// Cancel / title / Connect bar.
//
// Device strings come from USB descriptors, i.e. from whatever is plugged in: they are only
// ever written with textContent, stripped of control/bidi characters and truncated
// (sanitizeLabel). Nothing here uses innerHTML (Trusted Types) or inline style attributes
// (CSP), and the stylesheet is adopted as a constructed sheet where supported.
//
// `requireTrustedInput: true` (crx content script) makes every action ignore synthetic
// events, so a page script cannot "tap" the sheet for the user. The Shortcuts build runs
// inside the page and cannot offer that guarantee.

import type { DeviceChooser, DeviceChooserContext } from './usb.ts';
import type { WireDevice } from './protocol.ts';

export interface ChooserOptions {
  document?: Document;
  /** 'closed' hides the sheet's internals from page scripts. Tests use 'open'. */
  shadowMode?: 'open' | 'closed';
  locale?: string;
  /** Shown as "who is asking" (host[:port] of the page). */
  origin?: string;
  requireTrustedInput?: boolean;
  /** Slide in/out. Default true; always off under prefers-reduced-motion. Tests pass false. */
  animate?: boolean;
}

type Lang = 'ja' | 'en';

interface Strings {
  title: string;
  lead: (origin: string) => string;
  list: string;
  connect: string;
  cancel: string;
  refresh: string;
  searching: string;
  found: (n: number) => string;
  empty: string;
  hint: string;
  unnamed: string;
  failed: string;
}

const STRINGS: Record<Lang, Strings> = {
  ja: {
    title: 'USBデバイスを選択',
    lead: (o) => `${o} がUSBデバイスへのアクセスを求めています。`,
    list: '利用できるUSBデバイス',
    connect: '接続',
    cancel: 'キャンセル',
    refresh: '再検索',
    searching: '検索しています…',
    found: (n) => `${n}件のUSBデバイスが見つかりました`,
    empty: 'USBデバイスが見つかりません',
    hint: 'ブリッジ側のコンピュータにデバイスを接続してから、「再検索」をタップしてください。',
    unnamed: '名称不明のデバイス',
    failed: '検索に失敗しました',
  },
  en: {
    title: 'Select a USB Device',
    lead: (o) => `${o} wants to use a USB device.`,
    list: 'Available USB Devices',
    connect: 'Connect',
    cancel: 'Cancel',
    refresh: 'Search Again',
    searching: 'Searching…',
    found: (n) => `${n} USB device${n === 1 ? '' : 's'} found`,
    empty: 'No USB Devices Found',
    hint: 'Plug the device into the computer that runs the bridge, then tap Search Again.',
    unnamed: 'Unnamed Device',
    failed: 'Search failed',
  },
};

/** Strip control / zero-width / bidi-override characters, collapse whitespace, truncate. */
export function sanitizeLabel(value: unknown, max: number = 80): string {
  let s = typeof value === 'string' ? value : '';
  s = s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const hex4 = (n: number): string => (Number.isInteger(n) ? n : 0).toString(16).padStart(4, '0');

// ------------------------------------------------------------------ styles

const CSS = `
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

function applyStyles(doc: Document, root: ShadowRoot): void {
  try {
    const Sheet = doc.defaultView?.CSSStyleSheet;
    if (Sheet && 'replaceSync' in Sheet.prototype && 'adoptedStyleSheets' in root) {
      const sheet = new Sheet();
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
      return;
    }
  } catch { /* fall back to a <style> element */ }
  const style = doc.createElement('style');
  style.textContent = CSS;
  root.append(style);
}

// ------------------------------------------------------------------ DOM helpers

type Child = Node | string;
function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document, tag: K, attrs: Record<string, string> = {}, ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) node.append(c);
  return node;
}

type Shape = [tag: 'path' | 'circle' | 'rect', attrs: Record<string, string>];
const SVG_NS = 'http://www.w3.org/2000/svg';
function icon(doc: Document, shapes: Shape[], attrs: Record<string, string> = {}): SVGSVGElement {
  const node = doc.createElementNS(SVG_NS, 'svg');
  const base = { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  for (const [k, v] of Object.entries({ ...base, ...attrs })) node.setAttribute(k, v);
  for (const [tag, a] of shapes) {
    const s = doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(a)) s.setAttribute(k, v);
    node.append(s);
  }
  return node;
}

// The USB trident: arrowhead on the stem, circle / square branches, circle at the foot.
const USB_SHAPES: Shape[] = [
  ['path', { d: 'M12 4.6V18' }],
  ['path', { d: 'M12 2.2l-1.9 2.9h3.8z', fill: 'currentColor' }],
  ['path', { d: 'M12 14.6l-4.2-2.6V9.8' }],
  ['circle', { cx: '7.8', cy: '8.3', r: '1.5' }],
  ['path', { d: 'M12 11.6l4.2-2.6V8.4' }],
  ['rect', { x: '14.7', y: '5.3', width: '3', height: '3', rx: '.4' }],
  ['circle', { cx: '12', cy: '20', r: '2', fill: 'currentColor' }],
];
const CHECK_SHAPES: Shape[] = [['path', { d: 'M4.5 12.8l5 5 10-11.3' }]];

// ------------------------------------------------------------------ the chooser

interface Drag { startY: number; t0: number; dy: number }

export class OverlayChooser implements DeviceChooser {
  #doc: Document;
  #mode: 'open' | 'closed';
  #lang: Lang;
  #origin: string;
  #trusted: boolean;
  #animate: boolean;

  constructor(options: ChooserOptions = {}) {
    this.#doc = options.document ?? document;
    this.#mode = options.shadowMode ?? 'closed';
    const locale = options.locale ?? (typeof navigator !== 'undefined' ? navigator.language : 'en');
    this.#lang = /^ja\b/i.test(locale) ? 'ja' : 'en';
    this.#origin = sanitizeLabel(options.origin ?? this.#doc.location?.host ?? '', 120) || '?';
    this.#trusted = options.requireTrustedInput ?? false;
    this.#animate = options.animate ?? true;
  }

  choose(candidates: WireDevice[], context: DeviceChooserContext): Promise<WireDevice | null> {
    const doc = this.#doc;
    const win = doc.defaultView;
    const t = STRINGS[this.#lang];
    const accept = (e: Event): boolean => !this.#trusted || e.isTrusted;
    const still = !this.#animate || (win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);

    return new Promise<WireDevice | null>((resolve) => {
      const previouslyFocused = doc.activeElement as HTMLElement | null;
      let list = candidates.slice();
      let selected = -1;
      let busy = false;
      let done = false;
      let drag: Drag | null = null;

      const host = el(doc, 'div', { 'data-ios-webusb-chooser': '' });
      const root = host.attachShadow({ mode: this.#mode });
      applyStyles(doc, root);

      // -- top bar: Cancel / title / Connect
      const cancelBtn = el(doc, 'button', { type: 'button', class: 'txt cancel' }, t.cancel);
      const doneBtn = el(doc, 'button', { type: 'button', class: 'txt done' }, t.connect);
      doneBtn.disabled = true;
      const top = el(doc, 'header', { class: 'top' },
        el(doc, 'div', { class: 'grabber', 'aria-hidden': 'true' }),
        el(doc, 'div', { class: 'bar' }, cancelBtn, el(doc, 'h2', { id: 'ttl' }, t.title), doneBtn),
      );

      // -- body
      const lead = el(doc, 'p', { class: 'lead' }, t.lead(this.#origin));
      const group = el(doc, 'fieldset', { class: 'group' });
      const empty = el(doc, 'div', { class: 'empty' },
        icon(doc, USB_SHAPES, { 'stroke-width': '1.3' }), el(doc, 'strong', {}, t.empty), el(doc, 'span', {}, t.hint));
      const spin = el(doc, 'span', { class: 'spin', hidden: '' });
      const refreshBtn = el(doc, 'button', { type: 'button', class: 'act' }, el(doc, 'span', {}, t.refresh), spin);
      const actions = el(doc, 'div', { class: 'group actions' }, refreshBtn);
      actions.hidden = !context.refresh;
      const foot = el(doc, 'p', { class: 'foot', role: 'status', 'aria-live': 'polite' });
      const body = el(doc, 'div', { class: 'body' }, lead, group, empty, actions, foot);

      const sheet = el(doc, 'div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ttl', tabindex: '-1' }, top, body);
      const scrim = el(doc, 'div', { class: still ? 'scrim still' : 'scrim' }, sheet);
      root.append(scrim);

      const renderList = (): void => {
        group.replaceChildren(el(doc, 'legend', {}, t.list));
        selected = -1;
        doneBtn.disabled = true;
        group.hidden = list.length === 0;
        empty.hidden = list.length > 0;
        list.forEach((d, i) => {
          const name = sanitizeLabel(d.productName) || t.unnamed;
          const maker = sanitizeLabel(d.manufacturerName, 60);
          const serial = sanitizeLabel(d.serialNumber, 40);
          const parts: Child[] = [];
          if (maker) parts.push(maker);
          parts.push(el(doc, 'span', { class: 'mono' }, `${hex4(d.vendorId)}:${hex4(d.productId)}`));
          if (serial) parts.push(el(doc, 'span', { class: 'nw' }, `S/N ${serial}`));
          const meta = el(doc, 'span', { class: 'meta' });
          parts.forEach((p, n) => { if (n > 0) meta.append(' · '); meta.append(p); });

          const input = el(doc, 'input', { type: 'radio', name: 'device', value: String(i) });
          // A script-initiated click() makes the browser fire a *trusted* change event, so the
          // gate has to sit on the click that starts the selection; cancelling it reverts the radio.
          input.addEventListener('click', (e) => { if (!accept(e)) e.preventDefault(); });
          input.addEventListener('change', (e) => {
            if (!accept(e)) { input.checked = false; return; }
            selected = i;
            doneBtn.disabled = false;
          });
          group.append(el(doc, 'label', { class: 'row' },
            input,
            el(doc, 'span', { class: 'tile' }, icon(doc, USB_SHAPES)),
            el(doc, 'span', { class: 'text' }, el(doc, 'span', { class: 'name' }, name), meta),
            icon(doc, CHECK_SHAPES, { class: 'check', 'stroke-width': '2.4' }),
          ));
        });
      };

      // -- closing
      const observer = new (win?.MutationObserver ?? MutationObserver)(() => { if (!host.isConnected) finish(null); });
      function finish(value: WireDevice | null): void {
        if (done) return;
        done = true;
        observer.disconnect();
        resolve(value); // the caller continues at once; the sheet animates away on its own
        const remove = (): void => {
          host.remove();
          try { previouslyFocused?.focus?.({ preventScroll: true }); } catch { /* element is gone */ }
        };
        if (still || !host.isConnected) { remove(); return; }
        sheet.style.transform = '';
        scrim.classList.add('closing');
        setTimeout(remove, 300);
      }
      const connect = (): void => { if (selected >= 0) finish(list[selected] ?? null); };

      doneBtn.addEventListener('click', (e) => { if (accept(e)) connect(); });
      cancelBtn.addEventListener('click', (e) => { if (accept(e)) finish(null); });
      scrim.addEventListener('click', (e) => { if (e.target === scrim && accept(e)) finish(null); });
      body.addEventListener('scroll', () => scrim.classList.toggle('scrolled', body.scrollTop > 0));

      refreshBtn.addEventListener('click', (e) => {
        if (!accept(e) || busy || !context.refresh) return;
        busy = true;
        refreshBtn.disabled = true;
        spin.hidden = false;
        foot.className = 'foot';
        foot.textContent = t.searching;
        context.refresh()
          .then((next) => { list = next.slice(); renderList(); foot.textContent = list.length > 0 ? t.found(list.length) : ''; })
          .catch((err: unknown) => {
            foot.className = 'foot err';
            foot.textContent = `${t.failed}: ${sanitizeLabel(err instanceof Error ? err.message : String(err), 120)}`;
          })
          .finally(() => { busy = false; refreshBtn.disabled = false; spin.hidden = true; });
      });

      // -- swipe down on the bar to dismiss (phone layout only)
      top.addEventListener('pointerdown', (ev) => {
        const e = ev as PointerEvent;
        if (!accept(e) || (win?.innerWidth ?? 0) >= 600 || (e.target as Element).closest('button')) return;
        drag = { startY: e.clientY, t0: e.timeStamp, dy: 0 };
        try { top.setPointerCapture?.(e.pointerId); } catch { /* synthetic event */ }
        sheet.style.transition = 'none';
      });
      top.addEventListener('pointermove', (ev) => {
        if (!drag) return;
        drag.dy = Math.max(0, (ev as PointerEvent).clientY - drag.startY);
        sheet.style.transform = `translateY(${drag.dy}px)`;
      });
      const endDrag = (ev: Event): void => {
        if (!drag) return;
        const { dy, t0 } = drag;
        drag = null;
        const velocity = dy / Math.max(1, ev.timeStamp - t0); // px per ms
        sheet.style.transition = '';
        if (ev.type === 'pointerup' && (dy > 120 || (dy > 40 && velocity > 0.5))) finish(null);
        else sheet.style.transform = '';
      };
      top.addEventListener('pointerup', endDrag);
      top.addEventListener('pointercancel', endDrag);

      // -- keyboard: Esc cancels, Enter connects, Tab stays inside the sheet
      root.addEventListener('keydown', (ev) => {
        const e = ev as KeyboardEvent;
        if (e.key === 'Escape') { if (accept(e)) { e.preventDefault(); finish(null); } return; }
        if (e.key === 'Enter' && (e.target as Element).matches?.('input[type="radio"]')) { if (accept(e)) { e.preventDefault(); connect(); } return; }
        if (e.key !== 'Tab') return;
        const items = [...root.querySelectorAll<HTMLElement>('input, button')].filter((n) => !(n as HTMLButtonElement).disabled && !n.closest('[hidden]'));
        if (items.length === 0) { e.preventDefault(); return; }
        const first = items[0]!;
        const last = items[items.length - 1]!;
        const active = root.activeElement;
        if (e.shiftKey && (active === first || active === sheet)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
      });

      renderList();
      (doc.documentElement ?? doc.body).append(host);
      observer.observe(doc.documentElement, { childList: true });
      sheet.focus({ preventScroll: true });
    });
  }
}
