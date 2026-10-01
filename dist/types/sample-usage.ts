// このファイルはREADME.mdの「TypeScript」節で説明している検証の実体です。
// `tsc -p tsconfig.types.json` (中身は `tsc --strict --noEmit webusb-polyfill.d.ts sample-usage.ts`
// 相当) がエラー無く通ることを、型定義を触るたびに手元で再確認できるようにするために同梱しています。

// webusb-polyfill.d.ts の型定義が実際に使えるかを検証するサンプルコード。
// ios-webusb はブリッジ越しにUSBを扱うので、大容量bulk転送やbridgeInfo()も含めて公開APIを一通り使う。

async function demo(): Promise<void> {
    // requestDevice / getDevices
    const device: USBDevice = await navigator.usb.requestDevice({
        filters: [{ vendorId: 0x2341, productId: 0x8036 }],
        exclusionFilters: [{ classCode: 0x09 }],
    });
    const known: USBDevice[] = await navigator.usb.getDevices();
    console.log(known.length);

    await device.open();
    if (device.configuration === null) {
        await device.selectConfiguration(1);
    }
    await device.claimInterface(0);
    await device.selectAlternateInterface(0, 0);

    // configurations などは frozen (ReadonlyArray)。読むだけなら普通に書ける。
    for (const config of device.configurations) {
        for (const iface of config.interfaces) {
            console.log(config.configurationValue, iface.interfaceNumber, iface.claimed, iface.alternate.endpoints.length);
        }
    }

    // 大容量bulk転送: 300KBのペイロードを送る
    const payload = new Uint8Array(300 * 1024);
    const outResult: USBOutTransferResult = await device.transferOut(2, payload);
    console.log(outResult.status, outResult.bytesWritten);

    const inResult: USBInTransferResult = await device.transferIn(1, 512);
    if (inResult.status === "babble") {
        console.warn("device babbled");
    } else if (inResult.status === "stall") {
        await device.clearHalt("in", 1);
    } else if (inResult.data) {
        const view: DataView = inResult.data;
        console.log(view.getUint8(0));
    }

    // controlTransfer
    const ctrlResult = await device.controlTransferIn(
        { requestType: "vendor", recipient: "device", request: 0x01, value: 0, index: 0 },
        64
    );
    console.log(ctrlResult.status);

    // isochronous
    const isoIn = await device.isochronousTransferIn(3, [188, 188, 188]);
    for (const packet of isoIn.packets) {
        console.log(packet.status, packet.data?.byteLength);
    }
    const isoOut = await device.isochronousTransferOut(4, payload.subarray(0, 564), [188, 188, 188]);
    for (const packet of isoOut.packets) {
        console.log(packet.status, packet.bytesWritten);
    }

    // connect/disconnect events
    navigator.usb.addEventListener("connect", (ev: USBConnectionEvent) => {
        console.log("connected:", ev.device.productName);
    });
    navigator.usb.ondisconnect = (ev: USBConnectionEvent) => {
        console.log("disconnected:", ev.device.serialNumber);
    };

    // ios-webusb固有: F12から `__iosWebUSB.bridgeInfo()` で今ページに効いている版・ブリッジを確認できる
    const info = window.__iosWebUSB;
    if (info) {
        const bridge: IosWebUSBBridgeInfo = await info.bridgeInfo();
        console.log(info.version, info.variant, info.protocolVersion, bridge.server, bridge.capabilities);
    }

    await device.reset();
    await device.close();
    await device.forget();
}

demo();
