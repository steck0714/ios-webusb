#!/usr/bin/env python3
"""ios-webusb mock bridge: a fake USB host for development and tests.

It speaks the ios-webusb wire protocol (src/core/protocol.ts) over WebSocket and exposes
one virtual device, so the polyfill can be exercised end to end without hardware:

    python bridge/mock_bridge.py --port 8765 [--host 0.0.0.0] [--token SECRET] [--debug-rpc]

The virtual device is "Virtual Loopback" (1209:0001, serial MOCK-0001):
  configuration 1
    interface 0 / alt 0   vendor class, bulk OUT 1 + bulk IN 1 (loopback FIFO)
    interface 1 / alt 0   no endpoints
    interface 1 / alt 1   isochronous IN 2 + OUT 2
  vendor control IN 0x01 -> b"MOCK"; 0x03 -> value/index echoed; vendor control OUT 0x02 accepted.
With --debug-rpc, `__debug.unplug` / `__debug.plug` simulate hot-plugging for every client.

NOT a security reference: grants are per `meta.origin` ("local" when absent), nothing is
persisted and the token is compared in clear text. Bind it to a trusted network only.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import binascii
import json
import signal
import struct
from dataclasses import dataclass, field
from typing import Any

from websockets.asyncio.server import ServerConnection, serve
from websockets.exceptions import ConnectionClosed

PROTOCOL = 0
SERVER = "ios-webusb-mock-bridge/0.0.0a1"
VID, PID, SERIAL = 0x1209, 0x0001, "MOCK-0001"

# interface number -> alternate setting -> [(endpoint number, direction, type, packet size)]
LAYOUT: dict[int, dict[int, list[tuple[int, str, str, int]]]] = {
    0: {0: [(1, "out", "bulk", 64), (1, "in", "bulk", 64)]},
    1: {0: [], 1: [(2, "in", "isochronous", 188), (2, "out", "isochronous", 188)]},
}


class RpcError(Exception):
    def __init__(self, kind: str, detail: str) -> None:
        super().__init__(detail)
        self.kind = kind


def descriptor(active: int | None) -> dict[str, Any]:
    interfaces = [
        {
            "interfaceNumber": number,
            "alternates": [
                {
                    "alternateSetting": alt,
                    "interfaceClass": 0xFF,
                    "interfaceSubclass": 0,
                    "interfaceProtocol": 0,
                    "interfaceProtected": False,
                    "interfaceName": None,
                    "endpoints": [
                        {"endpointNumber": n, "direction": d, "type": t, "packetSize": size}
                        for n, d, t, size in endpoints
                    ],
                }
                for alt, endpoints in alternates.items()
            ],
        }
        for number, alternates in LAYOUT.items()
    ]
    return {
        "deviceId": "mock-0",
        "vendorId": VID,
        "productId": PID,
        "manufacturerName": "ios-webusb",
        "productName": "Virtual Loopback",
        "serialNumber": SERIAL,
        "deviceClass": 0,
        "deviceSubclass": 0,
        "deviceProtocol": 0,
        "usbVersionMajor": 2,
        "usbVersionMinor": 0,
        "usbVersionSubminor": 0,
        "deviceVersionMajor": 0,
        "deviceVersionMinor": 1,
        "deviceVersionSubminor": 0,
        "configurations": [{"configurationValue": 1, "configurationName": None, "interfaces": interfaces}],
        "activeConfigurationValue": active,
    }


def matches(f: dict[str, Any]) -> bool:
    expected = {"vendorId": VID, "productId": PID, "serialNumber": SERIAL,
                "classCode": 0xFF, "subclassCode": 0, "protocolCode": 0}
    return all(expected[k] == v for k, v in f.items() if k in expected)


def b64e(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def b64d(text: Any) -> bytes:
    try:
        return base64.b64decode(text, validate=True)
    except (binascii.Error, TypeError, ValueError) as e:
        raise RpcError("DataError", "invalid base64 payload") from e


@dataclass
class Handle:
    owner: ServerConnection
    origin: str
    claimed: set[int] = field(default_factory=set)
    alt: dict[int, int] = field(default_factory=dict)


class Bridge:
    def __init__(self, token: str | None, debug_rpc: bool) -> None:
        self.token = token
        self.debug_rpc = debug_rpc
        self.present = True
        self.active: int | None = None
        self.grants: set[str] = set()
        self.handles: dict[int, Handle] = {}
        self.next_handle = 1
        self.fifo = bytearray()
        self.clients: set[ServerConnection] = set()

    # ---- helpers
    def _present(self) -> None:
        if not self.present:
            raise RpcError("NotFoundError", "The device was disconnected.")

    def _handle(self, ws: ServerConnection, params: dict[str, Any]) -> Handle:
        self._present()
        h = self.handles.get(params.get("handle", -1))
        if h is None or h.owner is not ws:
            raise RpcError("InvalidStateError", "The device must be opened first.")
        return h

    def _endpoint(self, h: Handle, number: int, direction: str, kinds: tuple[str, ...]) -> None:
        for iface in sorted(h.claimed):
            for n, d, t, _ in LAYOUT[iface][h.alt.get(iface, 0)]:
                if n == number and d == direction and t in kinds:
                    return
        raise RpcError("NotFoundError", "The specified endpoint is not part of a claimed and selected alternate interface.")

    def drop_handles(self, predicate: Any) -> None:
        for key in [k for k, h in self.handles.items() if predicate(h)]:
            del self.handles[key]

    # ---- protocol methods (names match RpcMethodMap)
    def rpc_bridgeInfo(self, ws: ServerConnection, p: dict[str, Any], meta: dict[str, Any]) -> Any:
        return {"protocol": PROTOCOL, "server": SERVER, "capabilities": ["mock", "isochronous", "hotplug"]}

    rpc_hello = rpc_bridgeInfo

    def rpc_getDevices(self, ws: ServerConnection, p: dict[str, Any], meta: dict[str, Any]) -> Any:
        granted = self.present and (meta.get("origin") or "local") in self.grants
        return [descriptor(self.active)] if granted else []

    def rpc_listAvailableDevices(self, ws: ServerConnection, p: dict[str, Any], meta: dict[str, Any]) -> Any:
        if not self.present:
            return []
        filters = p.get("filters") or []
        excluded = p.get("exclusionFilters") or []
        ok = (not filters or any(matches(f) for f in filters)) and not any(matches(f) for f in excluded)
        return [descriptor(self.active)] if ok else []

    def rpc_grantDevice(self, ws: ServerConnection, p: dict[str, Any], meta: dict[str, Any]) -> Any:
        self._present()
        if (p.get("vendorId"), p.get("productId")) != (VID, PID):
            raise RpcError("NotFoundError", "No such device.")
        self.grants.add(meta.get("origin") or "local")
        return descriptor(self.active)

    def rpc_open(self, ws: ServerConnection, p: dict[str, Any], meta: dict[str, Any]) -> Any:
        self._present()
        origin = meta.get("origin") or "local"
        if origin not in self.grants:
            raise RpcError("SecurityError", "Access denied: the device was not granted to this origin.")
        handle = self.next_handle
        self.next_handle += 1
        self.handles[handle] = Handle(owner=ws, origin=origin)
        return {"handle": handle, "descriptor": descriptor(self.active)}

    def rpc_close(self, ws: ServerConnection, p: dict[str, Any], meta: dict[str, Any]) -> Any:
        self.handles.pop(p.get("handle", -1), None)
        return None

    def rpc_forget(self, ws: ServerConnection, p: dict[str, Any], meta: dict[str, Any]) -> Any:
        origin = meta.get("origin") or "local"
        self.grants.discard(origin)
        self.drop_handles(lambda h: h.origin == origin)
        return None

    def rpc_selectConfiguration(self, ws: ServerConnection, p: dict[str, Any], meta: dict[str, Any]) -> Any:
        h = self._handle(ws, p)
        if p.get("configurationValue") != 1:
            raise RpcError("NotFoundError", "The configuration value provided is not supported by the device.")
        self.active = 1
        h.claimed.clear()
        h.alt.clear()
        return None

    def rpc_claimInterface(self, ws: ServerConnection, p: dict[str, Any], meta: dict[str, Any]) -> Any:
        h = self._handle(ws, p)
        number = p.get("interfaceNumber")
        if self.active is None:
            raise RpcError("InvalidStateError", "No configuration is selected.")
        if number not in LAYOUT:
            raise RpcError("NotFoundError", "The interface number provided is not supported by the device in its current configuration.")
        h.claimed.add(number)
        return None

    def rpc_releaseInterface(self, ws: ServerConnection, p: dict[str, Any], meta: dict[str, Any]) -> Any:
        h = self._handle(ws, p)
        number = p.get("interfaceNumber")
        if number not in h.claimed:
            raise RpcError("NotFoundError", "The interface is not claimed.")
        h.claimed.discard(number)
        h.alt.pop(number, None)
        return None

    def rpc_selectAlternateInterface(self, ws: ServerConnection, p: dict[str, Any], meta: dict[str, Any]) -> Any:
        h = self._handle(ws, p)
        number, alt = p.get("interfaceNumber"), p.get("alternateSetting")
        if number not in h.claimed:
            raise RpcError("InvalidStateError", "The interface must be claimed first.")
        if alt not in LAYOUT[number]:
            raise RpcError("NotFoundError", "The alternate setting provided is not supported by the device.")
        h.alt[number] = alt
        return None

    def rpc_resetDevice(self, ws: ServerConnection, p: dict[str, Any], meta: dict[str, Any]) -> Any:
        h = self._handle(ws, p)
        h.claimed.clear()
        h.alt.clear()
        self.fifo.clear()
        return None

    def rpc_clearHalt(self, ws: ServerConnection, p: dict[str, Any], meta: dict[str, Any]) -> Any:
        h = self._handle(ws, p)
        self._endpoint(h, p.get("endpointNumber"), p.get("direction"), ("bulk", "interrupt", "isochronous"))
        return None

    def rpc_controlTransferIn(self, ws: ServerConnection, p: dict[str, Any], meta: dict[str, Any]) -> Any:
        self._handle(ws, p)
        s, length = p["setup"], int(p["length"])
        if s["requestType"] == "vendor" and s["request"] == 1:
            return {"status": "ok", "data": b64e(b"MOCK"[:length])}
        if s["requestType"] == "vendor" and s["request"] == 3:
            return {"status": "ok", "data": b64e(struct.pack("<HH", s["value"], s["index"])[:length])}
        return {"status": "stall", "data": ""}

    def rpc_controlTransferOut(self, ws: ServerConnection, p: dict[str, Any], meta: dict[str, Any]) -> Any:
        self._handle(ws, p)
        s, data = p["setup"], b64d(p.get("data", ""))
        if s["requestType"] == "vendor" and s["request"] == 2:
            return {"status": "ok", "bytesWritten": len(data)}
        return {"status": "stall", "bytesWritten": 0}

    def rpc_transferIn(self, ws: ServerConnection, p: dict[str, Any], meta: dict[str, Any]) -> Any:
        h = self._handle(ws, p)
        self._endpoint(h, p["endpointNumber"], "in", ("bulk", "interrupt"))
        length = int(p["length"])
        data = bytes(self.fifo[:length])
        del self.fifo[:length]
        return {"status": "ok", "data": b64e(data)}

    def rpc_transferOut(self, ws: ServerConnection, p: dict[str, Any], meta: dict[str, Any]) -> Any:
        h = self._handle(ws, p)
        self._endpoint(h, p["endpointNumber"], "out", ("bulk", "interrupt"))
        data = b64d(p.get("data", ""))
        self.fifo.extend(data)
        return {"status": "ok", "bytesWritten": len(data)}

    def rpc_isochronousTransferIn(self, ws: ServerConnection, p: dict[str, Any], meta: dict[str, Any]) -> Any:
        h = self._handle(ws, p)
        self._endpoint(h, p["endpointNumber"], "in", ("isochronous",))
        return [{"status": "ok", "data": b64e(bytes([i & 0xFF]) * int(n))} for i, n in enumerate(p["packetLengths"])]

    def rpc_isochronousTransferOut(self, ws: ServerConnection, p: dict[str, Any], meta: dict[str, Any]) -> Any:
        h = self._handle(ws, p)
        self._endpoint(h, p["endpointNumber"], "out", ("isochronous",))
        b64d(p.get("data", ""))
        return [{"status": "ok", "bytesWritten": int(n)} for n in p["packetLengths"]]

    # ---- dispatch / events
    def call(self, ws: ServerConnection, method: Any, params: Any, meta: Any) -> Any:
        if not isinstance(method, str) or not method.isidentifier() or method.startswith("_"):
            raise RpcError("NotSupportedError", f"unknown method {method!r}")
        fn = getattr(self, f"rpc_{method}", None)
        if fn is None:
            raise RpcError("NotSupportedError", f"unknown method {method}")
        return fn(ws, params if isinstance(params, dict) else {}, meta if isinstance(meta, dict) else {})

    async def broadcast(self, event: str) -> None:
        message = json.dumps({"event": event, "device": descriptor(self.active), "origins": sorted(self.grants)})
        await asyncio.gather(*(ws.send(message) for ws in list(self.clients)), return_exceptions=True)

    async def debug(self, method: str) -> Any:
        if method == "__debug.unplug" and self.present:
            self.present, self.active = False, None
            self.handles.clear()
            await self.broadcast("disconnect")
        elif method == "__debug.plug" and not self.present:
            self.present = True
            await self.broadcast("connect")
        return None


async def serve_forever(args: argparse.Namespace) -> None:
    bridge = Bridge(args.token, args.debug_rpc)

    async def handler(ws: ServerConnection) -> None:
        bridge.clients.add(ws)
        authed = False
        try:
            async for raw in ws:
                try:
                    req = json.loads(raw)
                    rid, method = req.get("id"), req.get("method")
                except (ValueError, AttributeError):
                    continue
                try:
                    if method == "hello":
                        if bridge.token and (req.get("params") or {}).get("token") != bridge.token:
                            raise RpcError("SecurityError", "invalid token")
                        authed = True
                    elif not authed:
                        raise RpcError("SecurityError", "send hello first")
                    if isinstance(method, str) and method.startswith("__debug."):
                        if not bridge.debug_rpc:
                            raise RpcError("NotSupportedError", "debug RPC is disabled")
                        result = await bridge.debug(method)
                    else:
                        result = bridge.call(ws, method, req.get("params"), req.get("meta"))
                    await ws.send(json.dumps({"id": rid, "result": result}))
                except RpcError as e:
                    await ws.send(json.dumps({"id": rid, "error": f"{e.kind}: {e}"}))
                except Exception as e:  # noqa: BLE001 - report, never crash the server
                    await ws.send(json.dumps({"id": rid, "error": f"NetworkError: {type(e).__name__}: {e}"}))
        except ConnectionClosed:
            pass
        finally:
            bridge.clients.discard(ws)
            bridge.drop_handles(lambda h: h.owner is ws)

    async with serve(handler, args.host, args.port, max_size=8 * 1024 * 1024) as server:
        port = server.sockets[0].getsockname()[1]
        print(json.dumps({"listening": f"ws://{args.host}:{port}/", "port": port, "protocol": PROTOCOL}), flush=True)
        loop = asyncio.get_running_loop()
        stop: asyncio.Future[None] = loop.create_future()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, lambda: stop.done() or stop.set_result(None))
            except (NotImplementedError, RuntimeError):
                pass
        await stop


def main() -> None:
    parser = argparse.ArgumentParser(description="ios-webusb mock bridge (fake USB host)")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765, help="0 picks a free port (printed as JSON on stdout)")
    parser.add_argument("--token", default=None, help="require this token in `hello`")
    parser.add_argument("--debug-rpc", action="store_true", help="enable __debug.unplug / __debug.plug")
    asyncio.run(serve_forever(parser.parse_args()))


if __name__ == "__main__":
    main()
