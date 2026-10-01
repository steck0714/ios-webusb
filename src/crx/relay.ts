// relay.ts — content script logic (isolated world)
// =================================================
// Sits between the page (untrusted) and the background (holds the bridge connection).
// Everything security-relevant is decided HERE, not by the page:
//   * the user gesture is observed with real (isTrusted) events, never read from a message;
//   * the page may only call PAGE_RPC_METHODS; `listAvailableDevices` / `grantDevice` are
//     reachable only through `requestDevice`, which shows the chooser in this world;
//   * the page cannot choose the origin (the background reads it from the port sender).
// Dependencies are injected so the logic can be tested without a browser (tests/crx.relay.test.ts).

import { PAGE_RPC_METHODS, type RpcMethod, type WireDevice } from '../core/protocol.ts';
import {
  RELAY_CHANNEL, targetOriginOf, type RelayToContent, type RelayToPage,
} from '../core/transports/postmessage.ts';
import { checkFilters, deviceRef, type DeviceChooser } from '../core/usb.ts';

export interface PortLike {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(cb: (message: unknown) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
}

export interface RelayDeps {
  win: Window;
  connect(): PortLike;
  chooser: DeviceChooser;
  locale: string;
  now?: () => number;
  isTrusted?: (e: Event) => boolean;
  gestureWindowMs?: number;
}

export interface Relay {
  stop(): void;
}

const GESTURE_EVENTS = ['click', 'keydown', 'pointerdown', 'touchstart'];
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function startRelay(deps: RelayDeps): Relay {
  const win = deps.win;
  const doc = win.document;
  const now = deps.now ?? Date.now;
  const isTrusted = deps.isTrusted ?? ((e: Event) => e.isTrusted);
  const gestureWindowMs = deps.gestureWindowMs ?? 5000; // same conservative window as the sibling projects

  let lastGesture = Number.NEGATIVE_INFINITY;
  const onGesture = (e: Event): void => { if (isTrusted(e)) lastGesture = now(); };
  for (const type of GESTURE_EVENTS) doc.addEventListener(type, onGesture, true);
  const hasGesture = (): boolean => now() - lastGesture < gestureWindowMs;

  // ---------------------------------------------------------------- background port
  let port: PortLike | null = null;
  let nextId = 1;
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();

  const failAll = (error: Error): void => {
    for (const [id, p] of pending) { p.reject(error); pending.delete(id); }
  };

  const toPage = (msg: RelayToPage): void => { win.postMessage(msg, targetOriginOf(win)); };

  const onPortMessage = (raw: unknown): void => {
    const msg = raw as { kind?: string; id?: number; result?: unknown; error?: string; event?: string; device?: WireDevice } | null;
    if (!msg || typeof msg !== 'object') return;
    if (msg.kind === 'response' && typeof msg.id === 'number') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (typeof msg.error === 'string') p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    } else if (msg.kind === 'event' && (msg.event === 'connect' || msg.event === 'disconnect') && msg.device) {
      toPage({ channel: RELAY_CHANNEL, dir: 'toPage', kind: 'event', event: msg.event, device: msg.device });
    }
  };

  const ensurePort = (): PortLike => {
    if (port) return port;
    const p = deps.connect();
    p.onMessage.addListener(onPortMessage);
    p.onDisconnect.addListener(() => {
      if (port !== p) return;
      port = null; // reconnect lazily on the next call (e.g. after the service worker restarted)
      failAll(new Error('the extension connection was lost, please try again'));
    });
    port = p;
    return p;
  };

  const callBackground = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      try {
        ensurePort().postMessage({ kind: 'call', id, method, params, hasGesture: hasGesture(), locale: deps.locale });
      } catch (e) {
        pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });

  // ---------------------------------------------------------------- requestDevice (trusted UI)
  let chooserOpen = false;
  const requestDevice = async (params: unknown): Promise<WireDevice> => {
    const p = (params ?? {}) as { filters?: unknown; exclusionFilters?: unknown };
    let filters, exclusionFilters;
    try {
      filters = checkFilters(p.filters ?? [], 'filters');
      exclusionFilters = checkFilters(p.exclusionFilters ?? [], 'exclusionFilters');
    } catch (e) {
      throw new Error(`DataError: ${errorText(e)}`);
    }
    if (!hasGesture()) throw new Error('SecurityError: Must be handling a user gesture to show a permission request.');
    if (chooserOpen) throw new Error('InvalidStateError: A device chooser is already open.');
    chooserOpen = true;
    try {
      const list = async (): Promise<WireDevice[]> =>
        (await callBackground('listAvailableDevices', { filters, exclusionFilters })) as WireDevice[];
      const candidates = await list();
      const chosen = await deps.chooser.choose(candidates, { filters, exclusionFilters, refresh: list });
      if (!chosen) throw new Error('NotFoundError: No device selected.');
      return (await callBackground('grantDevice', deviceRef(chosen))) as WireDevice;
    } finally {
      chooserOpen = false;
    }
  };

  // ---------------------------------------------------------------- page messages
  const allowed = PAGE_RPC_METHODS as readonly string[];
  const onPageMessage = (ev: MessageEvent): void => {
    if (ev.source !== win) return;
    const d = ev.data as Partial<RelayToContent> | undefined;
    if (!d || d.channel !== RELAY_CHANNEL || d.dir !== 'toContent' || d.kind !== 'call') return;
    const { id, method } = d;
    if (typeof id !== 'number' || typeof method !== 'string') return;
    const reply = (r: { result?: unknown; error?: string }): void =>
      toPage({ channel: RELAY_CHANNEL, dir: 'toPage', kind: 'response', id, ...r });

    if (!allowed.includes(method)) {
      reply({ error: 'NotSupportedError: this method cannot be called from a web page' });
      return;
    }
    const run = method === 'requestDevice'
      ? requestDevice(d.params)
      : callBackground(method as RpcMethod, d.params);
    run.then((result) => reply({ result }), (err: unknown) => reply({ error: errorText(err) }));
  };
  win.addEventListener('message', onPageMessage);

  return {
    stop(): void {
      win.removeEventListener('message', onPageMessage);
      for (const type of GESTURE_EVENTS) doc.removeEventListener(type, onGesture, true);
      failAll(new Error('relay stopped'));
      try { port?.disconnect(); } catch { /* already gone */ }
      port = null;
    },
  };
}
