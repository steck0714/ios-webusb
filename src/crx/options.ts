// options.ts — bridge URL / token settings page
import { parseBridgeUrl } from '../core/url.ts';

type Ext = typeof chrome;
const ext: Ext = (globalThis as unknown as { browser?: Ext }).browser ?? chrome;

const ja = /^ja\b/i.test(navigator.language);
const T = ja ? {
  saved: '保存しました',
  testing: '接続を確認しています…',
  ok: (server: string) => `接続できました (${server})`,
  ng: (msg: string) => `接続できませんでした: ${msg}`,
  invalid: (msg: string) => `URLを確認してください: ${msg}`,
  insecure: 'ws:// は暗号化されません。信頼できるネットワークの中だけで使ってください。',
} : {
  saved: 'Saved',
  testing: 'Checking the connection…',
  ok: (server: string) => `Connected (${server})`,
  ng: (msg: string) => `Could not connect: ${msg}`,
  invalid: (msg: string) => `Check the URL: ${msg}`,
  insecure: 'ws:// is not encrypted. Use it only on a network you trust.',
};

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const urlInput = $<HTMLInputElement>('bridgeUrl');
const tokenInput = $<HTMLInputElement>('token');
const status = $<HTMLParagraphElement>('status');
const warn = $<HTMLParagraphElement>('warn');

const show = (text: string, kind: 'ok' | 'ng' | '' = ''): void => { status.textContent = text; status.dataset.kind = kind; };

function validate(): URL | null {
  try {
    const url = parseBridgeUrl(urlInput.value);
    warn.textContent = url.protocol === 'ws:' ? T.insecure : '';
    return url;
  } catch (e) {
    show(T.invalid(e instanceof Error ? e.message : String(e)), 'ng');
    return null;
  }
}

urlInput.addEventListener('input', () => { show(''); try { warn.textContent = parseBridgeUrl(urlInput.value).protocol === 'ws:' ? T.insecure : ''; } catch { warn.textContent = ''; } });

$<HTMLFormElement>('form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!validate()) return;
  await ext.storage.local.set({ bridgeUrl: urlInput.value.trim(), token: tokenInput.value });
  show(T.saved, 'ok');
});

$<HTMLButtonElement>('test').addEventListener('click', async () => {
  if (!validate()) return;
  show(T.testing);
  try {
    const res = (await ext.runtime.sendMessage({ type: 'ios-webusb:test', bridgeUrl: urlInput.value.trim(), token: tokenInput.value })) as
      { ok: boolean; info?: { server: string }; error?: string } | undefined;
    if (res?.ok) show(T.ok(res.info?.server ?? '?'), 'ok');
    else show(T.ng(res?.error ?? 'no answer from the extension'), 'ng');
  } catch (e) {
    show(T.ng(e instanceof Error ? e.message : String(e)), 'ng');
  }
});

void ext.storage.local.get(['bridgeUrl', 'token']).then((r) => {
  urlInput.value = typeof r.bridgeUrl === 'string' ? r.bridgeUrl : '';
  tokenInput.value = typeof r.token === 'string' ? r.token : '';
  if (urlInput.value) validate();
});
