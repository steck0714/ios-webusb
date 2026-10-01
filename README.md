# ios-webusb

**状態: WIP (0.0.0)** — iOSのブラウザに `navigator.usb` (WebUSB) を足すポリフィルです。

iOSのブラウザはWebUSBに対応しておらず、ページや拡張機能から生のUSBにも触れません。そこで、USBデバイスをつないだ**別のコンピューター上の「ブリッジ」をWebSocketで呼び出す**構成にしています。ページ側からは普通の `navigator.usb` に見えます。

```
 iPhone / iPad                                       USBデバイスをつないだPC など
┌───────────────────────────────┐   WebSocket    ┌────────────────┐
│ ページ ─ navigator.usb        │ ◀────────────▶ │ ブリッジ        │ ─ USB
│        (ios-webusb ポリフィル) │  JSON-RPC (v0) │ (別プロセス)    │
└───────────────────────────────┘                └────────────────┘
```

## できていること / まだのこと

| | |
|---|---|
| ✅ | `navigator.usb` の型 (`types/`) と、それを実装するオブジェクトモデル (`src/core/usb.ts`) |
| ✅ | crx版 (Manifest V3) とショートカット版 (Webページ上でJavaScriptを実行) |
| ✅ | iOSのシート形式のデバイス選択ダイアログ (ライト/ダーク、iPhone/iPad幅) |
| ✅ | ブリッジとのプロトコル v0 と、Python製のモックブリッジ (仮想デバイス1台) |
| ⬜ | **実際のUSBに触れるブリッジ** (今はモックだけ。fox-webusb のネイティブホストや tauri-webusb のバックエンドを、このプロトコルに合わせる想定) |
| ⬜ | **iOS実機での動作確認** (後述「検証できていないこと」) |

## 2つのビルド

| | crx版 | ショートカット版 |
|---|---|---|
| 動く場所 | 拡張機能 (MV3) | Safariの共有シート → ショートカット「Webページ上でJavaScriptを実行」 |
| 注入のタイミング | ページ読み込み前 (`document_start`) | 手動で実行した時 (読み込み後) |
| WebSocketを持つのは | 拡張のバックグラウンド (ページのCSP・混在コンテンツの制約を受けない) | ページ自身 (制約を受ける。httpsのページでは `wss://` が必要) |
| ダイアログの信頼性 | content script内で表示。本物の操作 (`isTrusted`) だけ受け付け、`grantDevice` はページから呼べない | ページ内で表示。ページのスクリプトが迂回できるので、ブリッジ側の承認が前提 |
| 設定 | 拡張のオプションページ (URL / トークン) | JavaScript先頭の `IOS_WEBUSB_CONFIG` |

## セットアップ

```sh
npm install
npm run build        # dist/ に crx(展開済み)・ショートカット・型 を出力
npm test             # ビルド → 90件 (後述)
npm run typecheck    # 型検査 4構成
npm run setup:py     # モックブリッジ用の venv (websockets) 。結合テストにも必要
npm run bridge -- --port 8765 --token SECRET --host 0.0.0.0   # モックブリッジ起動
npm run pack:crx     # dist/ios-webusb-0.0.0a1.crx と .zip
npm run preview      # ダイアログのスクリーンショット → docs/screenshots/
```

Node 22.18 以上が必要です (TypeScriptをそのまま実行するテストのため)。

## 使い方

### crx版

1. `npm run build` → `dist/crx/` ができます。
2. Chromeなら `chrome://extensions` → デベロッパーモード → 「パッケージ化されていない拡張機能を読み込む」で `dist/crx` を選びます。iOSでは、Chrome拡張を扱えるブラウザが必要です。Orion (Kagi) がiOS/iPadOSでChrome・Firefox拡張をベータ対応しています (APIの対応範囲は限定的とされています: <https://help.kagi.com/orion/browser-extensions/ios-ipados-extensions.html>)。この拡張がOrionで動くかは**未検証**です。
3. 拡張のオプションページでブリッジのURL (`wss://…`) とトークンを入れ、「接続テスト」→「保存」。
4. WebUSBを使うページを開き、ページの接続ボタンをタップするとシートが出ます。

`.crx` について: Chrome / Chromium (75以降) は、Chrome Web Storeの署名がないCRXのインストールを拒否します (`CRX_REQUIRED_PROOF_MISSING`)。`npm run pack:crx` の `.crx` は自己署名 (鍵は `keys/` に自動生成、git管理外) なので、Chromeには「パッケージ化されていない拡張機能」か `.zip` を使ってください。

### ショートカット版

確実なのは手作業での作成です。

1. ショートカットApp → 新規 → アクション「Webページ上でJavaScriptを実行」を追加。
2. `dist/shortcuts/ios-webusb.js` の全文を貼り付け、先頭の `IOS_WEBUSB_CONFIG` のURLとトークンを書き換えます。
3. ショートカットの詳細で「共有シートに表示」をオンにし、受け取る種類を Safari の Webページ にします。
4. 使うとき: Safariで対象ページを開く → 共有 → このショートカット → 画面上部に「navigator.usb を有効にしました」→ ページの接続ボタンをタップ。

`dist/shortcuts/ios-webusb.unsigned.shortcut` は同じ内容の**未署名**ファイルです。ファイルからのインポートには署名が必要なので、Macで次を実行してからiPhoneへ送ってください (実機でのインポートは**未検証**です)。

```sh
shortcuts sign --mode anyone --input ios-webusb.unsigned.shortcut --output ios-webusb.shortcut
```

制約:
- ページ読み込み**後**に注入します。読み込み時に `navigator.usb` の有無で「非対応」と表示してしまうサイトでは、実行後にページ側の操作をやり直す必要があります。
- ページのCSPがインラインスクリプトを禁じていると注入できません (その場合は「CSPで注入できませんでした」と表示)。
- ページから直接WebSocketを開くので、httpsのページには `wss://` のブリッジが必要です。

## プロトコル (v0)

`{ id, method, params, meta? }` → `{ id, result }` または `{ id, error: "NotFoundError: …" }`。ブリッジからのイベントは `{ event: "connect" | "disconnect", device, origins? }`。バイナリはbase64です。

メソッド: `hello` `bridgeInfo` `getDevices` `listAvailableDevices` `grantDevice` `open` `close` `forget` `selectConfiguration` `claimInterface` `releaseInterface` `selectAlternateInterface` `resetDevice` `clearHalt` `controlTransferIn/Out` `transferIn/Out` `isochronousTransferIn/Out`。`requestDevice` はcrx内の中継専用でブリッジには届きません。型は `src/core/protocol.ts` が正です。デバイスの形はtauri-webusbの `bridge.ts`、`"Kind: detail"` 形式のエラー文字列とbase64はfox-webusbに合わせています。

ブリッジ側が守ること:
- `hello` でトークンを確かめる。
- `meta.origin` ごとに許可 (`grantDevice`) を管理し、`open` の前に確かめる。`meta.origin` はcrx版では拡張が付けます (ページは指定できません)。
- イベントには、許可を持つオリジンを `origins` に入れる。crx版は、`origins` がないイベントを**誰にも**転送しません。

## TypeScript (`types/`)

- `webusb-polyfill.d.ts` — `USB` `USBDevice` ほかのグローバル宣言、`Navigator.usb`、`window.__iosWebUSB`。`@types/w3c-web-usb` と**同時には読み込まない**でください (同じ名前を宣言します)。
- `sample-usage.ts` / `negative-check.ts` — 型が使えること、制約として効いていること (`@ts-expect-error`) の確認。他のwebusb系と同じ流儀です。

検証 (`npm run typecheck`): 本体 / `types/` の2ファイル / 実装クラスが自前のd.tsに適合 / 実装クラスが `@types/w3c-web-usb` に適合。わざと壊して (メソッド名・戻り値型・`@ts-expect-error` の除去) 検査が失敗することも確認しています。

## テスト (90件)

| 種類 | 内容 |
|---|---|
| 単体 | base64、エラー変換、版の整合、オブジェクトモデル (14)、インストーラ、WebSocket (偽ソケット) |
| jsdom | ダイアログ (14)、crxの中継 (12) とバックグラウンド (8)、ショートカットの注入 (7)、`.shortcut` のplist |
| 結合 | Python製モックブリッジと実WebSocketで一連のWebUSB操作、1 MiB転送、オリジン別の許可、トークン |
| 実ブラウザ | ヘッドレスChromiumで、本物のタップ、レイアウト (320〜1280px)、モーション、ショートカット版のUSB転送まで |

ヘッドレスChromiumは `@sparticuz/chromium` + `puppeteer-core` で動かします。起動できない環境では実ブラウザのテストだけスキップされます。

## 検証できていないこと

ここでの検証は Node・jsdom・ヘッドレスChromium・Pythonのモックだけです。

- **iOS実機 (Safari / Orion / WebKit)** での動作と見た目。スクリーンショットはChromiumの描画で、San Franciscoフォントは入っていません。
- Orion iOS上でこの拡張の `chrome.runtime.connect` / `storage` / MV3のservice workerが動くか。
- 「Webページ上でJavaScriptを実行」がどのJSワールドでスクリプトを動かすか、CSPとの関係、`.shortcut` のインポート。
- 実USBに触れるブリッジ。

## ダイアログ (`src/core/chooser.ts`)

iOSのシート形式です。プレビューは `docs/screenshots/`。

- iPhone: 下から出るシート (つまみ付き)。キャンセル / タイトル / 接続のバー、アイコン付きの項目リスト、選択は右端のチェックマーク。バーを下にスワイプ、暗い背景のタップ、キャンセル、Escで閉じます。
- iPad・横向き (幅600px以上): 中央のフォームシート。
- ライト/ダークはシステム設定に追従。文字は `-apple-system` で、WebKitでは Dynamic Type (`font: -apple-system-body` など) に追従。モーション低減設定ではアニメーションを切ります。
- 狭い画面 (320px) ではタイトルを省略して、ボタンと重ならないようにします。
- デバイス名などはUSBディスクリプタ由来なので、制御文字・双方向制御文字を除いて `textContent` だけで表示します (`innerHTML` もインラインstyle属性も使わず、CSPに強い作りです)。
- crx版では、シートはcontent scriptの `closed` なShadow DOMの中に出て、本物の操作だけ受け付けます。

## セキュリティ上の注意

- ブリッジは、つながっているUSBデバイスへのアクセスを渡します。トークンを設定し、信頼できるネットワークでだけ動かしてください。`ws://` は暗号化されません。
- モックブリッジはセキュリティの参考実装ではありません (許可は保存されず、トークンは平文比較)。
- ショートカット版には信頼できる実行環境がないため、ページ内のスクリプトがダイアログを迂回できます。許可の最終判断はブリッジ側で行ってください。

## バージョン表記

git タグは `v0.0.0a1`、`manifest.json` は `0.0.0.1` (数字だけ)、`package.json` は `0.0.0-a.1`。fox-webusb と同じ考え方で、`tests/version.test.ts` が3か所のずれを検出します。

## ライセンス

MIT (`LICENSE`)。

## 参考にしたもの

pyside6-webusb v0.0.6 / fox-webusb (firefoxブランチ, v0.0.0a2) / tauri-webusb v0.0.0。
- tauri-webusb: オブジェクトモデルの作り (`#private` を持つクラス階層)、デバイスの形、`types/` の流儀。
- fox-webusb: エラー文字列、base64、`web_accessible_resources` 経由の注入、content script による中継。
- pyside6-webusb: `types/` の `sample-usage.ts` / `negative-check.ts` の流儀。
