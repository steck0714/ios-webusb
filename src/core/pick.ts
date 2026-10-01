// pick.ts — the two ways of running "chooser -> grant" (UsbRuntime.requestDevice)
// ==============================================================================
// createLocalPicker: everything happens where this code runs. Used by the Shortcuts
//   build, which has no trusted world: the chooser lives in the page, so a script of the
//   page can skip it and call `grantDevice` itself. The bridge therefore has to ask the
//   host owner for approval on its own (README "Known limitations").
// createRelayPicker: the crx build. The page only sends `requestDevice`; the content
//   script (isolated world) shows the chooser, waits for a *trusted* click, and only
//   then sends `grantDevice`. Page scripts cannot reach `grantDevice` at all.

import type { DeviceChooser, RequestDeviceContext, UsbRuntime } from './usb.ts';
import { deviceRef } from './usb.ts';
import type { RpcTransport, WireDevice } from './protocol.ts';
import { throwFromRpcError } from './errors.ts';

export function createLocalPicker(transport: RpcTransport, chooser: DeviceChooser): UsbRuntime['requestDevice'] {
  return async (ctx: RequestDeviceContext): Promise<WireDevice> => {
    const meta = { hasGesture: ctx.hasGesture };
    const list = async (): Promise<WireDevice[]> => {
      try {
        return await transport.call(
          'listAvailableDevices',
          { filters: ctx.filters, exclusionFilters: ctx.exclusionFilters },
          meta,
        );
      } catch (e) {
        return throwFromRpcError(e);
      }
    };
    const candidates = await list();
    const chosen = await chooser.choose(candidates, {
      filters: ctx.filters,
      exclusionFilters: ctx.exclusionFilters,
      refresh: list,
    });
    if (!chosen) throw new DOMException('No device selected.', 'NotFoundError');
    try {
      return await transport.call('grantDevice', deviceRef(chosen), meta);
    } catch (e) {
      return throwFromRpcError(e);
    }
  };
}

export function createRelayPicker(transport: RpcTransport): UsbRuntime['requestDevice'] {
  return async (ctx: RequestDeviceContext): Promise<WireDevice> => {
    try {
      return await transport.call('requestDevice', {
        filters: ctx.filters,
        exclusionFilters: ctx.exclusionFilters,
      });
    } catch (e) {
      return throwFromRpcError(e);
    }
  };
}
