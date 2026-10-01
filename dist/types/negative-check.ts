// このファイルはREADME.mdの「TypeScript」節で説明している検証の実体です。
// 各行が実際にコンパイルエラーになる(=型が制約として機能している)ことを
// `tsc -p tsconfig.types.json` の終了コード0で確認しています
// (@ts-expect-errorが「期待通りエラーになった」ことの確認なので、成功時の終了コードは0になります。
// 逆に、ここのどれかがエラーにならなくなると「Unused '@ts-expect-error' directive」で失敗します)。

// 型が実際に制約として機能しているかの否定的検証(コンパイルエラーになるべき箇所)。
async function bad(device: USBDevice): Promise<void> {
    // @ts-expect-error: 'overflow'は仕様のUSBTransferStatusに存在しない
    const s: USBTransferStatus = 'overflow';
    // @ts-expect-error: directionは'in'|'out'のみ、'inout'は無効
    await device.clearHalt('inout', 1);
    // @ts-expect-error: vendorIdは number、文字列は無効
    await navigator.usb.requestDevice({ filters: [{ vendorId: '0x2341' }] });
    // @ts-expect-error: filtersは必須メンバー
    await navigator.usb.requestDevice({});
    // @ts-expect-error: navigator.usbは読み取り専用
    navigator.usb = navigator.usb;
    // @ts-expect-error: openedは読み取り専用
    device.opened = true;
    // @ts-expect-error: configurationsはfrozen(ReadonlyArray)なのでpushできない
    device.configurations.push(device.configurations[0]);
    // @ts-expect-error: USBDeviceは外から構築できない(本物のブラウザと同じ"Illegal constructor")
    new USBDevice();
    // @ts-expect-error: requestTypeは'standard'|'class'|'vendor'のみ
    await device.controlTransferIn({ requestType: 'custom', recipient: 'device', request: 1, value: 0, index: 0 }, 8);
    // @ts-expect-error: transferOutのdataはBufferSource。stringは不可
    await device.transferOut(1, 'text');
    // @ts-expect-error: variantは'crx'|'shortcut'のみ
    const v: 'ios' = window.__iosWebUSB!.variant;
    void s; void v;
}

void bad;
