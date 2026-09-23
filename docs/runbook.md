# runbook

手を動かすときの手順書。ここには**やり方と、実際に見えたもの**だけを書く
。

---

## 現在地（増分6 まで main にマージ済み。2026-09-13）

エージェントから10本のツールが使える（`packages/protocol/src/tools.ts` の `TOOL_NAMES`）。
位置の指定は `text`（リテラル文字列・推奨）か `symbol` か `lines`。下の節は増分ごとに
足してある ―― 増分3〜5 の分は各増分の設計書の §1 を見ること。

### 増分6 で入ったもの — 印と注釈を1つの物にし、人間に読む順と消す手を渡す

- **ハイライトは「今ここ」、注釈は「後で戻る」。** `show_code` のハイライト（スポットライト）は
  **窓ごと**で、次の `show_code` と `arrange_editors close-own` で消える（ファイルごとに残す
  LRU は消えた）。色つきの注釈は**行にも同じ色で塗られ**、注釈と一緒に消える
  （`mode: "clear"` / `replace` / 押し出し / 停止）。`annotate` の `location.color` は無くなった
  （項目の `color` が作者名と塗りの両方を決める）
- **注釈に順番。** 2件以上なら作者名の先頭に `1/7 ·` が付く（`items[]` の順。`add` は続き番号で、
  既存の吹き出しの分母も書き直される）。`annotate` の結果の各 `resolution` に `id` と `index`、
  `get_editor_state` に `annotations: [{ id, index, path, line, color?, resolved }]`（本文は無い）
- **人間向けの命令（パレットに2つ ＋ 吹き出しのボタン）。** コマンドパレットの
  **ShowMe: Clear highlights** はスポットライトだけ、**ShowMe: Clear annotations** は吹き出しと
  注釈の塗りを消す（2つは独立）。吹き出しの右上の **‹ ›** で隣の注釈へ（起点は押した吹き出し。
  読了済みも飛ばさない。端ではボタンが出ない。飛び先は**人間の規則**で開く ―― 見えていれば
  そのエディタ、無ければ人間の今の列、フォーカスも移る。開いたタブは人間のもの。増分6.1 D79。
  パレットの Next / Previous annotation は撤回）。同じ場所の **Resolve / Unresolve** で「読んだ」を返すと、
  エージェントには `annotations[].resolved` の1ビットだけが届く。**どれも預けていない窓でも、
  設定で機能を切っていても動く** ―― 設定が縛るのはエージェントであって人間ではない
- **設定は機能の粒度。** `showme.stage.enabled`（開く・スクロール・split・`show_note`）/
  `showme.html.enabled`（`show_html`）/ `showme.layout.enabled`（`arrange_editors`・`show_view`）。
  既定は全部 `true`、machine スコープでワークスペースからは変えられない。
  **`showme.tools.disabled` は消え、`showme.editorGroup` は `showme.stage.editorGroup` に移った。**
  `stage` を切ると `show_code` は**印だけ**（位置を解決して塗りを登録するが、開かない・
  スクロールしない。ステータスバーに `ShowMe: 印 path:line` が出て、人間がファイルを開くと
  塗りが見える）。`list_workspaces` の `features` / `disabledTools` で、エージェントは自分に
  何ができるかを先に知る

### 増分2A で入ったもの — 窓を「預ける」操作

- **エージェント操作の既定は「不可」。** 窓の役割（`role`）の既定は `idle` で、
  この状態では `show_code` / `annotate` / `get_editor_state` はすべて拒否される
- 人間が**ステータスバーのアイコンをクリック**すると、その窓の役割が `stage`
  （預けた状態）に切り替わる。預けていない窓にブリッジが繋ぐこと自体はできるが、
  ツール呼び出しは全部拒否される
- 同じフォルダを2つの窓で開いていても、**預けた方だけ**がブリッジから選ばれる
  （`selectWindow` が役割で絞る。パスでは区別できない）。2窓運用ができる
- `show_code` の `layout: "split"` で、舞台の2箇所（最大2列）を左右に並べられる。
  既定 `"single"` は1列にタブとして重ねる

### 増分2B で入ったもの — 見る・説明する・シンボルで指す

- **`get_editor_state`**: 人間がいま見ている場所を返す（引数なし）。開いているタブの
  一覧・アクティブなパス・カーソル位置・可視行に加え、**選択テキスト**を返すことがある
  ―― ただし**人間が本当に選んだものだけ**（マウス/キーボード由来・エージェント自身が
  直前に触った直後ではない・同じ選択を二度返さない、など8つの条件をすべて満たすときだけ）。
  `show_code` は `TextEditor.selection` を変更しないので、エージェントが自分で選択を
  作って読み出すことはできない（この2つは対になっている）
- **`annotate`**: 指定した行の下に説明の吹き出し（comment thread）を出す。
  **本文はプレーンな文字列であって markdown ではない** ―― 太字も箇条書きもリンクも
  展開されない。`mode: "replace"`（既定）は毎回全部消してから出すので、同じ引数で
  2回呼んでも吹き出しは増えない。`mode: "add"` で積み増せる
- **`symbol` 解決**: `executeDocumentSymbolProvider` を繋いだので、`text` / `lines` に加えて
  シンボル名でも位置を指せる（`show_code` と `annotate` の両方）。**制限モードでも
  JSON / CSS / HTML / Markdown のシンボルは解決できる。** TS/JS は制限モードでは
  解決できない（`typescript-language-features` が信頼を要求するため）―― その場合は
  `reason: "restricted-mode"` が返る（`no-provider` ではない。人間が信頼を与えれば直る
  ことがエージェントに伝わる）

まだ無いもの・未確認のことは下の「増分1で達成していないこと」を見ること。

### テストの現在数（2026-09-13 時点のスナップショット。数は変わるので鵜呑みにせず `npm run test` 等の出力を見ること）

| 種別 | コマンド | 件数 |
|---|---|---|
| 単体 | `npm run test` | 1478 |
| 統合（1窓・信頼＋制限モード） | `env -u SHOWME_SOCK npm run -w packages/extension test:integration:xvfb` | 279（信頼187 / 制限92） |
| 統合（2窓・役割で窓を選ぶ） | `env -u SHOWME_SOCK npm run -w packages/extension test:integration:two-windows:xvfb` | 9 |
| 統合（日本語の言語パック） | `env -u SHOWME_SOCK npm run -w packages/extension test:integration:locale-ja:xvfb` | 3 |

`env -u SHOWME_SOCK` は、拡張が統合ターミナルに注入した `SHOWME_SOCK` を外すため
（2窓のスイートに「env に無い」を主張する検査があり、VS Code の端末から素で走らせると1件赤になる）。

---

## セットアップ

拡張とブリッジの**両方**が要る。VS Code の API 境界がそう決めている
（拡張が「手」で、MCP サーバが「口」。設計書 §3.1）。

### 1. ビルド

```bash
npm ci
npm run build
```

`packages/extension/out/extension.js` と `packages/bridge/dist/index.js` ができる。

### 2. 拡張を入れる

開発中は VSIX を作らず、開発ホストで動かすのが速い。

```
VS Code で repo を開く → F5（`.vscode/launch.json` の「拡張を開発ホストで実行」）
```

新しいウィンドウが開き、そこで拡張が動く。ステータスバー右下に `$(eye) ShowMe` が出れば起動している。

配布する場合:

```bash
npm run -w packages/extension package    # build -> vsce package
code --install-extension packages/extension/vscode-showme-0.0.0.vsix
```

VSIX には**ブリッジが同梱される**（`extension/bridge/index.js`。設計書 D26 /
不変条件12）。中身を確かめたいときは `npx vsce ls --no-dependencies` を
`packages/extension` の中で走らせる（リポジトリのルートで走らせると
「Missing vscode engine compatibility version」になる。読んでいる package.json が
違う）。

### 3. エージェントにブリッジを教える

> **近道:** コマンドパレットの `ShowMe: エージェント設定を表示` が、以下の断片を
> **実際のブリッジのパスを埋めた状態**で untitled 文書として開く。
> そこから写せば `<BRIDGE>` を自分で探さなくてよい。撤去は `ShowMe: 撤去手順を表示`。
> どちらも見せるだけで、設定ファイルは書き換えない。

**npm を経路にしない。** ブリッジは拡張に同梱された絶対パスを指す（設計書 D26）。
`<BRIDGE>` に入れるのは次のどちらか。

```bash
# (a) 開発中: このリポジトリの中の束ね出力（npm run build で作られる）
echo "$PWD/packages/extension/bridge/index.js"

# (b) VSIX でインストールした拡張の中（remote / devcontainer は .vscode-server 側）
ls ~/.vscode-server/extensions/zvxbase.vscode-showme-*/bridge/index.js 2>/dev/null \
  || ls ~/.vscode/extensions/zvxbase.vscode-showme-*/bridge/index.js
```

`packages/bridge/dist/index.js`（tsc の出力）でも動くが、こちらは
`node_modules` に依存しているので、リポジトリの外へ持ち出せない。

```bash
# Claude Code
claude mcp add showme -- node <BRIDGE>
```

```toml
# Codex — ~/.codex/config.toml
[mcp_servers.showme]
command = "node"
args = ["<BRIDGE>"]
```

```jsonc
// Copilot CLI — ~/.copilot/mcp-config.json
{ "mcpServers": { "showme": { "type": "stdio", "command": "node", "args": ["<BRIDGE>"] } } }
```

> **Copilot CLI の `type` は `"stdio"` か `"local"` か、実測で確定していない**（増分4）。
> 片方で繋がらなければもう片方を試すこと。

### 4. 許可ルールを入れる（これが無いと毎回確認が出る）

**注釈だけでは足りない。** 3クライアントを調べた結果、MCP のツール注釈で承認が変わるのは
Codex CLI だけだった（設計書 §4.3 / A6）。Claude Code と Copilot CLI は注釈を承認判断に
使わない。だから許可ルールを別に入れる。

```jsonc
// Claude Code — .claude/settings.json の permissions.allow
"mcp__showme__show_code",
"mcp__showme__list_workspaces"
```

```bash
# Copilot CLI
copilot --allow-tool 'showme'
```

Codex は注釈（`destructiveHint: false` / `openWorldHint: false`）を読むので追加設定は要らない。

### 撤去

```bash
claude mcp remove showme
# ~/.codex/config.toml から [mcp_servers.showme] を削除
# ~/.copilot/mcp-config.json から "showme" を削除
# VS Code で拡張をアンインストール
```

**既に開いているターミナルには `SHOWME_SOCK` が残る**（環境変数はプロセス生成時にしか
入らない）。開き直すこと。それ以外の生成物（ソケット・登録ファイル）は `deactivate` で
消える。他ツールの設定ファイルはこちらから書き換えていないので、消すのは上の3行だけ。

---

## 動かないときに見る順番

**ステータスバーが何を出しているかを最初に見る。** この道具は「副作用が全て画面に出る」
ことを安全性の柱にしているので、表示が一次情報になる。

| 表示 | 意味 |
|---|---|
| `$(shield) ShowMe: オフ`（en: `ShowMe: Off`） | 既定の状態（増分2A）。この窓の役割は `idle` で、`show_code` / `annotate` / `get_editor_state` はすべて拒否される。クリックでオンにする（＝この窓を預ける）。`預けていません` / `Not lent` から改名 |
| `$(eye) ShowMe: オン`（en: `ShowMe: On`） | この窓を預けている（オン）。エージェントはまだ繋いでいない。`預け中` / `Lent` から改名 |
| `$(plug) ShowMe: 接続中` | 預けていて、繋がっている |
| `$(circle-slash) ShowMe: 停止中` | 停止スイッチが押されている（拡張全体）。コマンドパレットの「ShowMe: 拡張を停止する／再開する」で再開 |
| `$(error) ShowMe: 起動できません` | ソケットを立てられなかった。**tooltip に理由が出る** |
| `$(search-stop) ShowMe: 見つからず <path>` | エージェントが探して空振りした |
| `$(list-selection) ShowMe: 複数一致 <path>` | 複数当たった。エージェントが選び直す |
| `$(circle-slash) ShowMe: 回数制限 <path>` | `show_code` / `annotate` が同じファイルへの解決試行を短時間に繰り返した。**綴りを変えても抜けられない**（予算はファイル単位） |
| `$(circle-slash) ShowMe: 画面の読み取りを制限` | `get_editor_state` の呼び出しが短時間に多すぎた（増分2B）。**パスは出ない**（呼び出し単位の予算で、特定のファイルに紐づかないため） |
| `$(warning) ShowMe: 2本目の接続を拒否` | 既に1本つながっている。下の「2本目の接続を拒否」を見ること |

`ShowMe: 操作ログを表示` に全ツール呼び出しが出る（**選択テキストは記録されない**）。

### 「VS Code ウィンドウが見つかりません」

ブリッジは理由を名指しで返す。多いのは次の3つ。

1. **拡張が動いていない** — VS Code のステータスバーに `ShowMe` が出ているか
2. **名前空間が違う** — エージェントと VS Code が同じ場所にいる必要がある。
   devcontainer なら**両方コンテナの中**、Remote-SSH なら**両方リモート側**。
   ホストのターミナルからコンテナの VS Code には**届かない**（設計書 §3.4）
3. **`$TMPDIR` がずれている** — `os.tmpdir()` は `$TMPDIR` に従う。両端が同じ値を
   見ていないと、同じマシンでも別のディレクトリを探す

確かめ方:

```bash
# 拡張が立てた登録ファイル（両端で同じ場所を見ているか）
ls -la "${XDG_RUNTIME_DIR:-/tmp}"/vscode-showme*/ 2>/dev/null

# 統合ターミナルなら注入されているはず
echo "$SHOWME_SOCK"
```

### 「2本目の接続を拒否」と出る／エージェントが急に繋がらなくなった

同時接続は**1本まで**（設計書 §3.5 / D21）。2本目はハンドシェイクを通っても
その場で切られ、ツール呼び出しは1つも通らない。

- **エージェント自身の並行呼び出しではない。** Claude Code は1つの応答に複数の
  `tool_use` を載せてくるが、ブリッジは呼び出しを直列にするので（`invoke.ts`）、
  自分で自分を締め出すことはない。実機で3本を同時に投げて確認済み
- エージェントを2つ同時に繋いでいるなら、片方を止める
- 心当たりが無いのにこれが出るなら、**同一ユーザの別プロセスが繋いでいる**。
  この道具の利用者は、読んでいるまさにその OSS を `npm install` / `make` する。
  ソケットのパスは `/proc/net/unix` から誰でも読めるし、統合ターミナルには
  `SHOWME_SOCK` が入っている（設計書 S11）。**同一ユーザからの到達は防げない
  ので、見えるようにしてある。** 心当たりが無いならそれ自体が所見である
- 一時的に閉じたいなら、ステータスバーをクリックして停止する。あるいは
  `showme.injectTerminalEnv` をオフにして端末を開き直す

先に座られている側が正規のブリッジであることもある（先着順なので）。
その場合エージェントには「VS Code ウィンドウに届きませんでした」が返る。

### 「起動できません」と出る

tooltip の理由を読む。実行時ディレクトリの検証に失敗した場合、**黙って別の場所を使わずに
止まる**設計になっている（先回りされたディレクトリを迂回すると、そこに登録ファイルを
書いてしまうため。設計書 D22）。理由に出たパスを `ls -ld` で見て、所有者と権限を確かめること。

### エージェントは起動するが `show_code` が必ず失敗する

VS Code が無くてもブリッジは起動に成功し、`tools/list` も返す（設計書 §6.3）。
これは意図した動作で、**エージェント本体の起動を詰まらせないため**。
`tools/call` だけが期限内にエラーを返す。

### `.env` などが「見つからない」と言われる

除外リストに当たっている。これは仕様で、**内容も位置も返さない**。
組み込みリストは設定から取り除けない（加算専用・設計書 §4.6）。

---

## `npm install` はワークスペースのルートで

`packages/extension/` などの中で直接 `npm install` しないこと。npm はそこから
`@zvx/*` を**公開レジストリに取りに行きます**（実測で `registry.npmjs.org` へ GET が飛ぶ）。
`@zvx` スコープは未取得なので、第三者がこれを取得して同名パッケージを publish すると、
その install スクリプトが実行されうる（依存混同）。

リポジトリ直下の `.npmrc` が `@zvx` の解決先を到達不能なアドレスに固定してあるので、
その経路は**黙って他人のコードを取るのではなく、はっきり失敗します**（実測で 70 秒後に
ECONNREFUSED）。ワークスペース内の解決はレジストリを見ないので、`npm ci` には影響しません。

将来 `@zvx` スコープを取得して publish する判断をしたら、`.npmrc` のその行を消すこと。

---

## 開発ループ

```bash
npm run typecheck   # tsc --build
npm run lint        # biome check .
npm run test        # vitest（単体）
npm run build       # 3パッケージ
npm run -w packages/extension test:integration:xvfb   # 実 VS Code
```

**終了コードをパイプ越しに読まないこと。** zsh では `cmd | tail` の後の `$?` は `tail` の
値になる。パイプせずに実行して `$?` を見る（zsh なら `${pipestatus[1]}`）。
このリポジトリでは実際に、`biome check . | tail` の出力末尾が「エラー無し」に見えて、
本当のエラーが出力の**先頭**にあったことがある。

---

## 増分1で達成していないこと

「後でやる」と「できなかった」を混ぜないために、ここに分けて書く。2A / 2B で解決した項目は
消してあり、残っているものと 2A / 2B の過程で新しく分かったものだけを載せる。

| 項目 | 状態 |
|---|---|
| `show_mermaid` / `show_html` / `show_note`（webview 3種） | **未実装**（増分2C） |
| `ShowMe: エージェント設定を表示` / `撤去手順を表示` | **実装済み**。untitled 文書で見せるだけで、ファイルには書かない |
| Copilot CLI / Codex の実接続 | **未確認**（増分4） |
| Windows の名前付きパイプ | **未確認**。squatting 対策は **Node が API を公開しておらず実装できない**（設計書 §3.5） |
| 装飾（ハイライト）と comment thread（`annotate` の吹き出し）が**実際に描かれていること** | 自動化できない。VS Code に読み出し API が無いため。目視手順は下記「目で見る確認」 |
| 制限モードでの環境変数注入が届かないこと | 申告値は確認したが、実際の注入内容は未測定 |
| 孤児ソケット（`.sock` だけ残った場合）の掃除 | 未実装。pid の手がかりが無いため。実害は薄いがゴミが溜まる |
| 無効にしたツールを**一覧から消す**（D13 / §6.1） | **未実装**。ブリッジは常に全部のツールを登録し、切られた機能（`showme.stage.enabled` / `showme.html.enabled` / `showme.layout.enabled`。増分6 D74）のツールは呼び出し時に `disabled` を返すだけ。ブリッジは別プロセスなので、設定を知るには線上に新しい通知が要る（増分2以降）。`package.json` の設定説明文は実装に合わせてある |
| 追跡する鍵が上限（512）を埋めたときの縮退 | 予算はファイル単位になったので、埋めるには実在するファイルを 512 個叩く必要がある。埋まると正当な呼び出しも `rate-limited` になる（fail closed）。窓（60秒）が過ぎれば自然に回復し、その間も画面には出る |
| 2窓スイート（`test:integration:two-windows*`）が CI に入っていない | 手で走らせる以外に確認する手段が無い |

2A / 2B で解決したもの（履歴として残す）:

| 項目 | 解決した増分 |
|---|---|
| `symbol` による位置解決（`no-provider` しか返さなかった） | 2B。`executeDocumentSymbolProvider` を繋いだ。制限モードは JSON/CSS/HTML/Markdown のみ、TS/JS は `restricted-mode` |
| `get_editor_state` / `annotate` が未実装 | 2B |
| エージェント操作の既定が受け付け寄りだった | 2A。既定を `idle`（不可）にし、ステータスバーのトグルで窓を預ける方式にした |

---

## 統合テスト（実 VS Code）

単体テスト（`npm run test`）は vscode API を一度も叩かない。`vscode.window` /
`TextEditor` / ワークスペース信頼が本物のときにどうなるかは、実 VS Code を落として
確かめるしかない。それがこの節である。

CI では pull request のときに Linux で3スイート（`test:integration` /
`test:integration:two-windows` / `test:integration:locale-ja`）が `env -u SHOWME_SOCK` 付きの
xvfb で走り、Windows は**非ブロッキングの観測**として同じ `test:integration` を走らせる。

### 走らせ方

```bash
# 画面がある環境（普通のデスクトップ）
npm run -w packages/extension test:integration

# 画面が無い環境（コンテナ・CI）
npm run -w packages/extension test:integration:xvfb

# 2窓の受け入れテスト（別のスイート。下の「2窓の受け入れテスト」を見よ）
npm run -w packages/extension test:integration:two-windows
npm run -w packages/extension test:integration:two-windows:xvfb
```

どちらも `build` →統合テストの `tsc` →`out-test/runTest.js` の順に走る。
`runTest.js` は VS Code を**2回**起動する（信頼モードと制限モード）。両方 exit 0 で
なければ全体も exit 0 にならない。

`compile:integration` は `packages/bridge` も先に `tsc --build` する。統合テストは
ブリッジの窓選択（`readRegistryEntries` / `selectWindow`）を**実物のまま**呼ぶので、
その宣言ファイルが要る。まっさらな作業ツリーでも1コマンドで走るようにしてある。

### 前提

| 要るもの | 確かめ方 | 無いとどうなるか |
|---|---|---|
| ネットワーク | `curl -sI https://update.code.visualstudio.com/api/releases/stable` | VS Code を落とせず起動前に止まる |
| 仮想画面（ヘッドレスのとき） | `which xvfb-run` | `Missing X server or $DISPLAY` で即 exit 1 |
| Electron の共有ライブラリ | 下記 | 起動時に `error while loading shared libraries` |

Debian/Ubuntu 系のコンテナで足りないことがあるもの:

```bash
sudo apt-get install -y --no-install-recommends \
  libgtk-3-0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libx11-xcb1 libsecret-1-0 libxss1 libatspi2.0-0 xvfb
```

VS Code 本体は `packages/extension/.vscode-test/` に落ちる（`.gitignore` 済み）。
初回だけ数十秒かかる。`dbus` に繋げない旨のエラーが出るが、これは無害で、テストは通る。

### ワークスペースはリポジトリの中に作らない

フィクスチャは `os.tmpdir()` の下に毎回作り直す（`test/integration/fixture.ts`）。
理由は2つある。

1. `.env` という名前のファイルをコミットしたくない。中身が偽物でも、検査器と人間の
   両方に本物との取り違えをさせる
2. 検査の途中でワークスペースの中にシンボリックリンクを作る。作りかけの実験材料が
   作業ツリーに残ると、次の `git add` に巻き込まれる

失敗したときは、標準出力に出る `workspace:` のパスを見ればその回の木がそのまま残っている。

### 何を確かめているか

`packages/extension/test/integration/suite/trusted.test.ts`（28件。うち注釈が6件、symbol が3件）:

| 検査 | 何の証拠か |
|---|---|
| 拡張が activate する | `zvxbase.vscode-showme` が本当に有効になる |
| ソケットが実際に立っている | 登録ファイルと `.sock` が実在する。activate が例外を投げないことと**別**である |
| ファイルが開き、該当行が可視になる | `visibleTextEditors` に現れ、`revealRange` の行が `visibleRanges` に入る |
| `show_code` が `selection` を変更しない | 不変条件3。呼び出し前に置いた選択が呼び出し後も同じ |
| 信頼モードで `.ts` のシンボルが実際に解決される | `resolvedBy: "symbol"` と実在の行。制限モード側の `restricted-mode` と**対で**意味を持つ（片方だけなら、シンボルを一度も引かない1行でも通る） |
| 一覧は取れるが名前が無ければ `not-found` | `no-provider` と混ざっていない。`not-found` は一覧が取れたときにしか名乗れない（設計書 §3.4） |
| `symbol` で解決した位置にも注釈を出せる | `annotate` と `show_code` が同じ面・同じ組み立てでシンボルを引いている |
| 除外パスが解決されない | `.env` が `match: "none"` / `reason: "excluded-path"`、かつ開かれない |
| 多重一致で正確な件数を返さない | 4行当たるフィクスチャに対し候補が3件に切り詰められ、結果の鍵が `resolutionSchema` の許す集合に収まる |
| `realpath` 後の除外再判定が効く | 下記 |
| ワークスペース外へ出るリンクも読めない | `docs/escape.md -> <root の外>/secret.txt` が `none` |
| 信頼モードでも `symbolResolution` が false | 増分1では未実装。増分2で true になったらこのテストが落ちる |
| 行番号がファイルの実際の位置と一致する | 解決結果が実在の位置を指している |
| 同一ファイルへの試行が回数制限される | 設計書 §4.1 ⑦。しかも**自己参照シンボリックリンク経由の別名でも抜けられない**（予算は綴りではなくファイル単位） |
| 注釈が解決できた位置に1件立つ | `annotate` が本物の comment thread を作る（返り値に本文もファイルの内容も入らないことまで見る） |
| 同じ引数で2回呼んでも吹き出しが増えない | `mode: "replace"` が**実機でも**冪等。偽の面では `dispose()` が本当に消すかを判別しない |
| `mode: "add"` では増え、`replace` で戻る | 直前の検査の判別力。増えない実装でも「増えなかった」は成り立つ |
| 預けるのをやめると吹き出しが消え、`annotate` が拒否される | 装飾と同じ扱い（描いたものを残したまま「預けていない」と表示しない） |
| 空振りでも置換の約束を果たす | 1件も解決できなかったとき、古い注釈が新しい呼び出しの結果として残らない |
| 除外パスには注釈を出さない | `.env` が `excluded-path` で、吹き出しは0件 |

`realpath` の検査だけ組み立てが違うので書いておく。**同じパスに対して2回問い合わせる。**

1. `docs/notes.md` を**実ファイル**のまま引く → `match: "one"`。
   これが「第一の関門（生のパス文字列に対する除外判定）はこのパスを通す」ことの証拠になる
2. パスも問い合わせ文字列も変えず、**実体だけ**を `.env` へのシンボリックリンクに差し替える
   → `match: "none"` / `reason: "not-found"`

理由が `excluded-path` ではなく `not-found` であることまで見る。`excluded-path` なら
前段で落ちているので、検査したかった再判定は一度も走っていない。
そのリンク経由で `fs.readFileSync` が `.env` の中身を返すことも同時に assert している
――止めているのが OS ではなく我々であることを、この検査自身の中で示すため。

`packages/extension/test/integration/suite/restricted.test.ts`（16件）は下の節に書く。

### この検査が本当に判別することの確認

「緑だから通った」で終えないために、不変条件をわざと壊して落ちることを見た（2026-09-09）。

| 壊した場所 | 結果 |
|---|---|
| `show-code.ts` に `shown.selection = new vscode.Selection(range.start, range.end)` を足す | `show_code は TextEditor.selection を変更しない` が落ちる。メッセージは `列 2: 409:0-409:35` |
| `read-workspace-file.ts` の `isRedactedPath(canonical, ...)` の再判定を外す | `realpath 後の除外再判定が効く` が落ちる（`シンボリックリンク経由で .env が解決できた`） |
| `show-code.ts` の `if (!limiter.allow(...))` を `if (false)` にする | `同一ファイルへの試行は回数制限され、綴りを変えても抜けられない` が落ちる（`actual: not-found / expected: rate-limited`）。2026-09-09 |

全部元に戻してある。同じことをするときは `git diff` が空に戻ったことを必ず確かめること。

単体側でも同じことをした（2026-09-09）。**ここが判別していなかったせいで、
3本の防御のうち2本が壊しても緑だった。**

| 壊した場所 | 結果 |
|---|---|
| `handleShowCode` から `flashMiss` / `flashManyMatches` の呼び出しを消す | `show-code.test.ts` が3件落ちる |
| `handleShowCode` の `if (!limiter.allow(...))` を `if (false)` に | 同 4件落ちる |
| レート制限の鍵を綴り（`normalizeWorkspaceRelative`）に戻す | 同 1件落ちる（`自己参照シンボリックリンクで綴りを変えても予算は共有される`） |
| `annotations.ts` の本文を markdown の文字列型に変える（2026-09-10） | `test/annotation-body-is-plain-text.test.ts` の `注釈の経路に禁止語が現れない` が落ちる |
| `SYMBOL_PROBE_DELAYS_MS` を `[]` にする（＝1回引いて諦める。2026-09-10） | **統合テスト（制限モード）の `制限モードでも .json のシンボルは実際に解決され、その位置が開く` が落ちる**（`reason: no-provider`）。信頼モードの `.ts` は1回目で返るので落ちない ―― この判別器は `.json` にしか無い |
| `handleAnnotate` から `mode: "replace"` の `clearAll()` を消す（2026-09-10） | `annotate.test.ts` が5件落ちる（冪等性・置換・既定の mode・回数制限の器） |
| `cleanStaleRegistrations` の `REGISTRATION_NAME` の検査を外す | `server.test.ts` の `登録ファイルの名前でないものには触らない` が落ちる |
| 行長の上限を `buffer.toString("utf8").length` で測る | `server.test.ts` の `行長の上限はバイト数で測る` が落ちる |

### 落とし穴: `@vscode/test-electron` の `runTests()` は使わない

`runTests()` は引数列に `--disable-workspace-trust` を**常に**足す
（`node_modules/@vscode/test-electron/out/runTest.js`）。`launchArgs` は先頭に連結される
だけなので、後から打ち消せない。実測で、制限モードのはずの回が `isTrusted === true` で
開いた。だから `runTest.ts` はダウンロード（`downloadAndUnzipVSCode`）だけ借りて、
起動は自分で `spawn` している。引数列はあのファイルに全部書いてある。

---

## 2窓の受け入れテスト（役割で窓を選ぶ）

増分2A の中核の主張 ―― **同じフォルダを開いた2つの窓のうち、人間が預けた方だけが
選ばれる** ―― を実機で確かめる節（設計書 §2A.5）。1窓のスイートとは**起動の仕方が
違う**ので別のスイートにしてある。

```bash
npm run -w packages/extension test:integration:two-windows:xvfb
```

`out-test/runTwoWindows.js` が VS Code を**1回**起動し、その中でテスト側が2つ目の窓を
開く。走る場所は `test/integration/suite/two-windows.test.ts`（8件）。

### 何を確かめているか

| 検査 | 何の証拠か |
|---|---|
| 同じフォルダの2窓が、別々の登録を立てている | `windowId` と `socketPath` が別で、`.sock` が2本実在し、**`workspacePath` は同じ**。パスでは区別できないことがこの節の前提である |
| 片方だけを stage にできる | 登録ファイル上で stage が1件・idle が1件。両方 idle / 両方 stage の取り違えを塞ぐ |
| `$SHOWME_SOCK` 無し・`workspace_path` 無しで stage の窓が選ばれる | **2A の存在理由。** ヒントを1つも渡さず `selectWindow` が預けた窓を返す。拡張ホストに `$SHOWME_SOCK` が入っていないことも同じ検査の中で assert する |
| 預ける窓を移すと、選ばれる窓も移る | 「候補の先頭を返しているだけ」を落とす。登録の並びは動かないので、動く理由は役割しかない |
| 両方 stage にすると、両方を名指しして断る | 黙って先頭を選ばない。`describeSelectionFailure` の文言に2つの `windowId` が両方出ることまで見る。同点が `$SHOWME_SOCK` で解けることも同時に確かめる |
| 預けていない窓は、ソケットを直接叩いても拒否し、可視エディタも動かない | `show_code` も `list_workspaces` も `disabled` / `WINDOW_OFF_MESSAGE`。**ブリッジ越しではなく、その窓のソケットとトークンを直接使う** ―― ブリッジ経由だとそもそも選ばれないので、断っているのが窓なのか選択なのか判別しない |
| 対照: 同じ要求を、同じ窓が預けられている状態で投げると可視エディタが動く | 直前の検査に判別力があることの証拠。「動かなかった」は、動くはずのない要求を投げても成り立つ |
| 預けた窓に投げた要求は、その窓のエディタを開く | 要求が届いた窓の外へ出ない |

### スパイクで判明した罠（この組み立ての理由）

- devcontainer のターミナルには `VSCODE_IPC_HOOK_CLI` があり、残っていると子プロセスが
  **ホスト側の VS Code に転送される**。`runTwoWindows.ts` は `VSCODE_*` を env から落とす
- `--extensionTestsPath` は**新しく開いた窓にも受け継がれる**。しかも**どれか1つの窓の
  `run()` が resolve するとアプリ全体が終了する**。だから `two-windows-index.ts` は
  錠ファイルで役を分け（先着が測る側）、測られる側は永久に resolve しない。
  役割の切り替えは、測る側からファイル越しに指図する（役割は窓ごとのメモリにあり、
  `showme.toggle` はその窓の拡張ホストでしか動かない）
- 同じフォルダの2窓目は `workbench.action.duplicateWorkspaceInNewWindow` で開く。
  `vscode.openFolder` に `forceNewWindow` を渡しても、**同一フォルダでは例外も投げずに
  何も起きない**（実測: 45秒待って登録は1件のまま）
- `XDG_RUNTIME_DIR` と `TMPDIR` の**両方**を実行ごとの新しい場所に向ける。ブリッジは
  実行時ディレクトリの候補を2つ走査する（§2A.6）ので、片方だけ隔離すると後退先の
  `<tmpdir>/vscode-showme-<uid>` に居る無関係な窓（開発者自身の VS Code、1窓側の残骸）が
  候補に混ざり、この検査は何も判別しなくなる
- `--extensionDevelopmentPath` も受け継がれる（実測）。2つ目の窓に拡張を別途入れる必要は無い

### この検査が本当に判別することの確認

`chooseStageWindow`（`packages/protocol/src/window-role.ts`）の役割の絞り込みを
`const stages = candidates.filter((c) => c.role === "stage")` から
`const stages = [...candidates]` に変えて走らせた（2026-09-10）。

| 結果 | |
|---|---|
| 落ちた | `$SHOWME_SOCK 無し・workspace_path 無しで、stage の窓が選ばれる` / `預ける窓を移すと、選ばれる窓も移る` の2件。どちらも `預けられている窓が複数あります: ... (ea86150d-...), ... (9f68e217-...)` |
| 通ったまま | 残り6件。窓を立てる側とゲートの側は役割の**絞り込み**を通らないので、これは正しい |
| ハーネス | `VS Code は exit 1` / `=== FAIL: 2 件のテストが落ちた` / `EXIT=1` |

元に戻してある（`git diff packages/protocol/src/window-role.ts` が空であることを確認済み）。

**終了コードだけで合否を決めていない。** 測る側が `results.json` を残さなければ、
たとえ VS Code が 0 で終わってもハーネスは落ちる ―― 何も走らないまま終わったのを
「通った」と読まないため。

---

## 制限モードでの確認（設計書 A1 の確定）

設計書 §5.5 は「拡張本体・ファイルを開く・装飾は動く（**実機確認は増分1の受け入れ条件**）」
と書いていた。ここでその推定を実機に当てた結果を残す。

**確認日**: 2026-09-09 /
**VS Code** 1.136.2（linux-x64、`@vscode/test-electron` が落としたもの） /
**Node** v24.16.0 / **OS** Ubuntu 24.04.4 LTS (x86_64) / xvfb 上

制限モードの回は `--disable-workspace-trust` を**付けずに**、まっさらな
`--user-data-dir` で開く。未知のフォルダなので VS Code は制限モードにする。
信頼ダイアログは `security.workspace.trust.startupPrompt: "never"` で抑えている
――これは**信頼させる設定ではない**。訊かないだけで、答えていないフォルダは制限モードの
ままである。それを確かめるために、制限モードの節の最初の検査が
`vscode.workspace.isTrusted === false` を assert している。ここが落ちたら、その回の
結論は制限モードの証拠にならない。

### 動いた（自動テストで確認済み）

| 事項 | 観察 |
|---|---|
| `workspace.isTrusted` | `false`。確かに制限モードで開いている |
| 拡張の activate | する（`capabilities.untrustedWorkspaces.supported: true` が効いている） |
| ソケット | **立つ**。登録ファイルと `.sock` が実行時ディレクトリに実在する |
| 貢献コマンドの登録 | `showme.toggle` / `showme.showAgentConfig` / `showme.showLog` / `showme.teardown` すべて登録される |
| `text` 指定の `show_code` | 動く。`match: "one"` を返し、ファイルが `visibleTextEditors` に現れ、対象行が `visibleRanges` に入る |
| 除外パス | 制限モードでも `.env` は `excluded-path` で拒否される |
| `list_workspaces` | `isTrusted: false`、`capabilities.symbolResolution: false`、`capabilities.terminalEnvInjection: false`、`otherWindowsListed: false`。`permissions` / `disabledTools` / `editorGroup` は信頼モードと同じく設定（グローバル値）を写す（D56） |

### 動かない・提供しない

| 事項 | 観察 |
|---|---|
| `.ts` の `symbol` 指定 | `match: "none"` / `reason: "restricted-mode"` / `resolvedBy: "symbol"`（2B で provider を繋いだので、増分1の `"no-provider"` から変わった）。**`.json` の `symbol` は制限モードでも解決できる**（下の「symbolResolution は過小申告である」を見よ） |
| `capabilities.terminalEnvInjection` | `false`（`isTrusted && injectTerminalEnv` で決まる） |

### `symbolResolution` は**過小申告である**（2B で provider を繋いだ後）

増分1では symbol 解決が未実装で、この値は信頼モードでも `false` だった（＝信頼の有無を
判別しなかった）。2B で `executeDocumentSymbolProvider` を繋いだので、いまは
`isTrusted` と同じ値を返す。

**だがこれは実態より狭い申告である。** 同じ制限モードの回で、`.json` のシンボルは
**実際に解決できている**（統合テストで `resolvedBy: "symbol"` / 正しい `range` まで
確認済み）。制限モードで落ちるのは TypeScript/JavaScript の文書シンボルだけで、
JSON / CSS / HTML / Markdown のプロバイダは動く。`capabilities` は単一の boolean なので
言語ごとの崖を表現できず、安全側（使えないと言う側）に倒してある。

倒したこと自体は害が少ないが、**書かないと `symbolResolution: isTrusted` が「事実」として
一人歩きする**。だから `TOOL_DESCRIPTIONS.list_workspaces`（エージェントが読む説明文）と
`package.json` の `untrustedWorkspaces.description`（人間が読む説明）の両方に、
「false でも symbol を試す価値がある」と書いてある。

エージェントが本当の可否を知る手段は `reason` である ―― `restricted-mode` なら人間が
信頼を与えれば直り、`no-provider` なら直らない。

### 増分2B の前提測定（2026-09-10）

増分2B は `annotate`（comment thread）と `symbol` 解決を制限モードでも動かす前提に
立っている。増分2 設計書 §3.4 は設計レビューの報告 ――「制限モードで無効になるのは
同梱97拡張のうち `typescript-language-features` と `git` の2つだけで、JSON / CSS /
HTML / Markdown のプロバイダは動く」―― をそのまま前提にしていた。**推定のまま実装を
始めないため、2B の最初の作業として実機に当てた。**

**測定日**: 2026-09-10 / **VS Code** 1.137.0（linux-x64、`@vscode/test-electron` が
落としたもの。前回の記録は 1.136.2 で、その後上がっている） / **Node** v24.16.0 /
**OS** Ubuntu 24.04.4 LTS (x86_64) / xvfb 上。

検査は `packages/extension/test/integration/suite/restricted.test.ts` の
「2B の前提測定」節。対照（信頼モード側の在庫）は `trusted.test.ts` の
「2B の前提測定の対照」節にある。

| 測ったもの | 観察 | 2B への意味 |
|---|---|---|
| **comment thread** | **作れる。** `createCommentController` → `createCommentThread` が制限モードでも例外にならず、`uri` / `range`（4行目）/ 本文1件 / `body` が `string` のまま / `canReply === false` / `collapsibleState === Expanded` が、1回イベントループを回した後も保たれる | `annotate` は制限モードでも成立する。設計変更は不要 |
| **`setDecorations`** | **付く（例外にならない）。** 装飾の型が作れ、可視エディタに当てても、空配列で外しても例外にならない | ハイライトと `annotate` の下線は制限モードでも出せる |
| **`.json` のシンボル** | **実際に返る。** `data/config.json` に対して `vscode.executeDocumentSymbolProvider` が `["showmeSymbolTarget", "other"]` を返した。ただし**1回目の呼び出しでは返らない**（実測 `attempts: 2`）―― 言語拡張の activate を待つ必要がある | §3.4 の「`undefined` ＋ 信頼依存の言語なら `restricted-mode`」が成り立つ。**解決器は1回引いて諦めてはいけない** |
| **`.ts` のシンボル** | **返らない。** 5秒・21回引き直しても `undefined`（空配列ではない。設計書の「空配列は `undefined` に潰される」と整合） | 制限モードの `.ts` は `restricted-mode` を名乗れる |

**なぜ「制限モードのせい」と言えるか（対照）。** 統合テストは `--disable-extensions` を
付けて VS Code を起動する（`test/integration/runTest.ts`）。これは信頼の有無とは別の
理由で同梱拡張を落としうるので、それだけでは「制限モードで TS が死んだ」と
「起動引数で TS が死んだ」が同じ観測値になる。両方の回で `vscode.extensions.all` の
**一覧そのもの**を採って差集合を取った。

| | 拡張の総数 | うち `vscode.*` |
|---|---|---|
| 信頼モード | 96 | 91 |
| 制限モード | 93 | 88 |

信頼モードにあって制限モードに無いもの（差集合、実測）:

```
vscode.git
vscode.terminal-suggest
vscode.typescript-language-features
```

逆向きの差は空である。`--disable-extensions` は同梱拡張を落としていない（93件残っている）。

> **⚠️ 設計レビューの報告は 2 つではなく 3 つだった。** 実測で欠けるのは
> `typescript-language-features` と `git` に加えて **`vscode.terminal-suggest`** である。
> 2B の結論は変わらない（`terminal-suggest` は文書シンボルのプロバイダを持たない）が、
> 「2つだけ」という数はこの版では正しくない。数を根拠に何かを決めるときは測り直すこと。

**測れていないこと（この節を「動いた」と読まないために）。** VS Code は comment thread の
描画状態も装飾の適用状態も**問い合わせる口を持たない**。上で確定したのは
「拡張ホストの側で作れて、指定した属性が保たれる」までであり、
**吹き出しが実際に行の下に描かれていること・色が実際に乗っていること**は目で見るしかない。
手順は下の「目で見る確認」に追記した。

### まだ確かめていないこと

正直に残す。「確認済み」と書けるのは上の表だけである。

- **統合ターミナルへの環境変数注入が制限モードで実際に届かないこと。**
  A1 は「ターミナルが既定でブロックされる」と言っており、`list_workspaces` は
  `terminalEnvInjection: false` と申告する。だが `environmentVariableCollection` に
  実際に何が入ったか（あるいは端末が本当に開けないか）は、拡張ホストの外から
  観測する手段が無いので**測っていない**。手で確かめる手順は下の「目で見る確認」に置く
- **装飾（ハイライト）が実際に描かれていること。** 下記の理由で自動化できない。
  API が例外を投げないことは上の「2B の前提測定」で確認済みだが、**それは描かれた証拠ではない**
- **comment thread の吹き出しが実際に行の下に描かれていること。** 同じ理由（読み出し口が無い）
- **VS Code 内蔵エージェントが無効になること**（A1 の3つ目）。増分1の範囲外
- ~~`annotate` / `get_editor_state`。まだ実装していない（2B）~~ **増分2Bで実装済み。**
  乗る土台（comment thread・装飾・`.json` のシンボル）が制限モードで動くことは上の測定で
  確定していた通り、両方とも制限モードで機能する（symbol は TS/JS を除く）
- **`show_mermaid` / `show_html` / `show_note`**。まだ実装していない（増分2C）。
  §5.5 の要件の言い直しはこれらも含むので、実装と同時に同じ形の検査を足すこと。
  **土台の実測（CSP・`srcdoc`・WebRTC・mermaid・名前なしドキュメント）は
  下の「増分2C Task 0」で済んでいる**が、**実際に egress しないことはまだ測っていない**
- **エージェント（Claude Code / Copilot CLI / Codex CLI）から実際に呼べること。**
  疎通確認の手順は増分4で書く

---

## 増分3A: 配色が読めることを人間が見る（2026-09-11）

画面の見た目は自動で測れない。**ここは人間が目で見る手順である。**

実地で、エージェントが `<style>body{background:#fbfbfa;color:#1c1b1a}</style>` と
書いたら `background` だけが落ち、ダークテーマで**黒地に黒**になった
。単体テストは全部緑だった。

```
1. VS Code のテーマをダークにする
2. エージェントに show_html で **配色を一切指定しない HTML** を出させる
   例: <h2>見出し</h2><p>本文</p><table><tr><th>A</th><td>1</td></tr></table>
3. 読めることを目で見る（背景と文字に十分な差があるか）
4. テーマをライトに変えて、パネルを開いたままもう一度見る
   → color-scheme に追随して両方で読めること
5. エージェントに background と color を**両方**指定させて、そちらが勝つことを見る
```

**4 が要点である。** baseline は `Canvas` / `CanvasText`（CSS のシステム色）を使って
いるので、テーマ変数を通さずに追随する。ここが追随しないなら、
`frames.ts` の `buildDisplayDocument` が壊れている。

---

## 増分2C Task 6: egress の実測（2026-09-10）

`show_html` / `show_mermaid` の経路から外に出ないことを、**受信サーバを立てて**測った。
「CSP 違反が出たか」ではなく「実際に届いたか」で見る。

**再現手順**:

```bash
npm run -w packages/extension test:integration:xvfb
```

`packages/extension/test/integration/suite/egress.test.ts`。信頼モードと制限モードの
両方の回で走る。

### 受信側

- http サーバ（要求と接続を数える）
- https ポートは**平文の TCP サーバ**。証明書を用意しても Chromium は自己署名を
  拒否して要求まで進まないので、**繋ぎに来たこと**を接続で数える
- 増分2B の教訓の反映: 初版が `http://127.0.0.1` だけを待ち受けていたため、
  ワークベンチの `img-src` が `http:` を許さないせいで**危険な実装でも緑のまま**だった

### 空振りを見分ける仕掛け（3つ）

1. **受信サーバ自体は届く**（検査器が生きていることの確認）
2. **素直な図が実際に描けている**（mermaid の描画器が生きている。攻撃入力の多くは
   ソースとして壊れているので、これが無いと「描画器が死んでいるから緑」でも通る）
3. **表示フレームが読み込みを知らせてくる**（`show_html` の `shown: true` は元々
   「メッセージを投げた」しか意味していなかった。フレームからの受領確認を足して、
   本番の返り値の意味も「届いた」に正した）

### 結果: 2層を独立に外して測った（2×2）

| サニタイザ | 外側の CSP | 結果 |
|---|---|---|
| 有 | 本番 | **緑**（ゼロ） |
| **無** | 本番 | **緑** ―― CSP だけで止まる |
| 有 | **全開** | **緑** ―― サニタイザだけで止まる |
| 無 | 全開 | **赤** ―― 両方外すと届く |

**どちらの層も単独で十分だった。** `webrtc 'block'`（no-op で層として数えてはいけない）
とは違い、これは本物の多層防御である。

変異がビルド成果物に届いていることを**毎回確認した** ―― 最初の回はマーカーを
コメントで書いたため esbuild に落とされ、「変異が生き残った」と読みかけた。

### 途中で見つけた欠陥（判別器そのものの欠陥）

判別確認2（表示フレームに `allow-scripts` を足す）が3回赤くなり、そのたびに
理由が違った:

1. 内側スクリプトに nonce が無かった ―― `srcdoc` は親の CSP を**nonce ごと**継承する
   （Task 0 の実測）。sandbox ではなく CSP が止めていた
2. `fetch` を使っていた ―― webview の `connect-src` はワークベンチ側の CSP と交差する。
   落ちても「sandbox が効いた」とは言えない（交絡）
3. **ペイロードの `</script>` が外側の script を閉じていた** ―― 本番側（`frames.ts` の
   `escapeScriptEnd`）で塞いだのと同じ欠陥をプローブで踏んだ

**判別器そのものが壊れていると、緑も赤も意味を持たない。**
これは「1と2は本番の二重の層の証拠」でもある: 表示フレームを破るには
`allow-scripts` を足すだけでなく nonce も要る。対照の検査で固定してある。

### 測っていないこと

**DNS そのものは測っていない。** 攻撃の宛先は 127.0.0.1 なので名前解決が起きず、
`dns-prefetch` / `preconnect` によるホスト名への情報の埋め込みは観測できない。
その経路について言えるのは「`<link>` 要素はサニタイザが要素ごと落とす」ことだけで、
それは単体テストが**文字列の水準で**見ている。ネットワークの水準では未測定である。

**この経路は CSP が管轄しない**（CSP3 では `prefetch-src` が削除され、リソースヒントは
`default-src` の有無に依存する扱いになっている）。つまり `<link>` については
**サニタイザが唯一の層**であり、上の 2×2 の「CSP だけで止まる」は当てはまらない。

---

## 増分2C Task 0: webview の実測（2026-09-10）

増分2C（`show_mermaid` / `show_html` / `show_note`）の設計は、実機で一度も確かめて
いない6つの事実の上に立っていた（設計書 §5.5「未検証」）。**推定のまま実装に入らない**
ため、2C の最初の作業として実機に当てた。設計書 §4 はこの節の結果で書き換えてある。

**測定環境**: VS Code **1.137.0**（linux-x64、`@vscode/test-electron` が落としたもの） /
Electron **42.10.0** / Chromium **148.0.7778.280** / V8 14.8.178.38-electron.0 /
拡張ホストの Node **24.18.1**（ランナー側は v24.16.0） /
OS Ubuntu 24.04.4 LTS (x86_64) / xvfb 上。

**再現手順**:

```bash
npm run -w packages/extension test:integration:xvfb
```

検査は `packages/extension/test/integration/suite/spike-2c.test.ts` の
「実 VS Code / 増分2C の前提測定」節。**信頼モードと制限モードの両方の回で走る**
（`suite/index.ts` が両方に追加している）。下の答えは**両モードで同一**だった
―― webview も CSP のふるまいも名前なしドキュメントも、ワークスペース信頼の影響を受けない。
生の観測値は標準出力に `[測定/2C]` 印で JSON のまま出るので、疑ったらそれを読むこと。

### 問1: `openTextDocument({content, language})` の直後、`isDirty` は何か

**常に `true`。** エディタに出す前から `true` で、そのあと何をしても `true` のままだった。

| いつ | `isDirty` | `version` | `uri` |
|---|---|---|---|
| `openTextDocument` の直後（**まだ表示していない**） | `true` | 1 | `untitled:Untitled-1` |
| `showTextDocument` の直後 | `true` | 1 | 同上 |
| `WorkspaceEdit` で1行足した後 | `true` | 2 | 同上 |
| 全文を別の内容に差し替えた後 | `true` | 3 | 同上 |
| **同じ内容で**もう一度差し替えた後 | `true` | 3 | 同上 |

`{ content }` 版の名前なしドキュメントは、生まれた瞬間から「保存されていない変更がある」
状態だからである。**設計への影響**: 設計書 §4.3 の「`isDirty` かつ最後の書き込み以降に
変更があれば新しいドキュメントに逃がす」は、`isDirty` の側が常に真なので**何も絞っていない**。
`show_note` を呼ぶたびに新しいドキュメントが増えることになる。§4.3.1 で `version` による
判定に書き換えた。

### 問2: `TextDocument.version` は既知の値から始まり、編集で増えるか

**始まる（1）。増える。そして内容が変わらない差し替えでは増えない。**

- 初期値は **1**（0 ではない）
- `WorkspaceEdit` を1回適用するごとに +1（1 → 2 → 3）
- **同じ本文で全文を差し替えても増えない**（3 のまま）。VS Code が実質的な変更が無い
  編集を潰している

最後の性質があるので、我々自身の冪等な書き直し（同じ本文をもう一度渡す）が
「人間が編集した」に化けることはない。**問1 の代替判定として成立する。**

### 問3: webview の中の `<iframe srcdoc>` は、外側の CSP の `frame-src` の対象か

**`srcdoc` は対象外。ただし `src` 付きのフレームは対象。この2つを分けて測ること。**

外側 webview に4通りの CSP を書き、同じ `sandbox="allow-scripts"` の `srcdoc` フレームを
立てた。全4通りで**フレームは読み込まれ、中の nonce 付きスクリプトが動いた**。
外側には `frame-src` の違反イベントが**1件も出ていない**。

| 外側の CSP | `srcdoc` フレームは動いたか | 孫 `<iframe src="data:…">` | 孫 `<iframe src="https://…">` |
|---|---|---|---|
| `frame-src 'none'` | **動いた** | 落ちた | 落ちた |
| `frame-src 'self'` | **動いた** | 落ちた | 落ちた |
| `frame-src data:` | **動いた** | **通った** | 落ちた |
| `frame-src` を書かない（`default-src 'none'`） | **動いた** | 落ちた | 落ちた |

**この表の右2列が判別器である。** `srcdoc` が `frame-src 'none'` の下で動いたことだけを
見て「`frame-src` は webview では効かない」と読むと誤る。`data:` の列で
`frame-src data:` のときだけ孫が通っていることが、**同じ CSP が URL を読むフレームには
効いている**ことの証拠になっている。

同じ実験で分かった付随事実:

- **`srcdoc` は親の CSP を nonce ごと継承する。** 内側に nonce 付きと nonce 無しの
  script を両方置いたところ、前者は動き、後者は `script-src-elem` / `inline` の違反で落ちた
- **内側は不透明オリジンである。** `location.origin` は `"null"`、`href` は `about:srcdoc`
- **内側から `acquireVsCodeApi` は見えない**（`typeof` が `"undefined"`）
- **外側から `frame.contentWindow.location` に触ると `SecurityError`**。
  `sandbox` に `allow-same-origin` を与えていないため
- 外側 webview 自身のオリジンは `vscode-webview://<ハッシュ>`

**設計への影響**: 外側の CSP は `frame-src 'self' data:` ではなく **`frame-src 'none'`** に
する。我々の `srcdoc` フレーム2枚はそれで壊れず（上の表の1行目）、URL を読む孫フレームは
`data:` も含めて全部落ちる。`data:` を許していた元の書き方は、得るものが無いのに
孫フレームの経路を1つ開けていた。設計書 §4.1 を直した。

### 問4: CSP の `webrtc 'block'` は、この Chromium で honored か

**されていない。完全な no-op である。**

`sandbox="allow-scripts"` の不透明オリジンのフレームの中で、`webrtc 'block'` を
**入れた回**と**入れない回**（対照）を同じ形で測った。**両者の観測値は区別が付かない。**

| 観測点 | `webrtc 'block'` あり | 対照（無し） |
|---|---|---|
| `typeof RTCPeerConnection` | `"function"` | `"function"` |
| コンストラクタ（`stun:127.0.0.1:19302`） | **成功**（例外を投げない） | 成功 |
| `createOffer()` | 成功、SDP に `ice-ufrag` あり | 同左 |
| `setLocalDescription()` 後の `iceGatheringState` | `"gathering"` | `"gathering"` |
| 収集された ICE 候補 | **1件**（`udp … .local 45462 typ host`） | 1件 |
| CSP 違反イベント | **0件** | 0件 |

対照を取らないと「不透明オリジンでは WebRTC がそもそも使えない」と同じ観測値になる。
実際には**どちらの回でも UDP のホスト候補が取れている** ―― API はスタブではなく生きている。
違反イベントすら出ないので、Chromium はこの指令を**知らない語として黙って捨てている**。

**設計への影響**: `connect-src 'none'` は WebRTC を塞がない。そして `webrtc 'block'` も
塞がない。**CSP には WebRTC を止める手段が無い**、というのがこの版での事実である。
設計書 §4.1 / §4.2.1 に「これは層として数えない」と明記し、実際に止めているものが何か
（作図フレームで動くコードが我々の mermaid だけであること）を書き直した。
指令自体は残す ―― 将来 Chromium が実装したときに効きはじめる無害な予約であり、
かつ「入れ忘れ」と「入れたが効かない」を後から区別できるようにするため。

### 問5: mermaid は `'unsafe-eval'`（あるいは `'wasm-unsafe-eval'`）を要るか

**要らない。**

`script-src 'nonce-…'` **だけ**（`unsafe-eval` も `wasm-unsafe-eval` も `unsafe-inline` も
無い）の CSP を持つ外側の下に `sandbox="allow-scripts"` の `srcdoc` フレームを作り、
バンドルした mermaid **11.17.2** をその中で評価して `render()` まで走らせた。

- バンドルの評価: 例外なし
- `mermaid.initialize({ startOnLoad: false, securityLevel: "strict" })` → `render()`: 成功。
  11,441 文字の `<svg …>` が返った
- **内側の CSP 違反イベント: 0件**（`eval` / `wasm-eval` の `blockedURI` も無し）
- 静的にも、束ねた出力に `new Function` は **0回**、`eval(` は **0回**

**設計への影響**: 無し（CSP を緩める必要が無いことが確定した）。設計書 §4.1 の
`script-src 'nonce-…'` はそのままでよい。ただしこれは**この版の mermaid での事実**なので、
版を上げるときは同じ検査を通すこと（`spike-2c.test.ts` が落ちる形にしてある）。

### 問6: 束ねた mermaid は何バイトか

**3,451,650 バイト（3.29 MiB）。** gzip で 950,668 バイト（929 KiB）。

```bash
# 測り方（テストが自動で同じことをする）
node_modules/.bin/esbuild <entry.mjs> --bundle --format=iife --minify \
  --platform=browser --target=es2022 --define:process.env.NODE_ENV='"production"' \
  --outfile=<out.js>
stat -c %s <out.js>
```

`entry.mjs` は `import mermaid from "mermaid"; globalThis.__mermaid = mermaid;` の2行。

**設計への影響**: 作図フレームの `srcdoc` に inline 展開するので、**呼び出しごとに
3.29 MiB の文字列を組んで渡す**設計だと払いすぎである。作図フレームは
**パネルごとに1枚作って生かしておき**、`show_mermaid` の呼び出しでは
**ソース文字列だけを `postMessage` で渡す**（SVG を `postMessage` で返す）。
そうすればバンドルはフレーム1枚あたり1回のコストになる。設計書 §4.1 に書いた。

### この節で測っていないこと

- **実際に egress したかどうかは、まだ測っていない。** ここで測ったのは CSP と API の
  ふるまいであって、パケットではない。受信サーバと DNS スタブを立てて
  「アクセスログとクエリログが両方空」を見るのは 2C Task 6 の仕事であり、
  その完了条件は設計書 §4.4 にある（http と https の両方で待ち受け、
  TLS 握手に至らない裸の TCP 接続も数える、判別確認を3つ通す）
- **`sandbox=""` の表示フレーム側は測っていない。** そこにはスクリプトが無いので、
  スクリプト由来の攻撃は「自明に通らない」―― 測っても検査器が入力を読まない緑になる
- **mermaid のソース文字列から脱出できないこと**は測っていない（`%%{init}%%` を含む
  入力の扱いは Task 4 / Task 6）

---

## 目で見る確認（自動化できない分）

### 装飾が実際に付いていること

VS Code の拡張 API に `setDecorations` の**読み出し口が無い**。付けたことは分かるが、
付いているかを問い合わせる手段が無い。だから自動テストで確かめられるのは
「ファイルが開いた」「対象行が可視範囲に入った」までで、色が乗っていることは
目で見るしかない。

1. `code <統合テストが作った workspace のパス>` で開く（パスは統合テストの標準出力に出る）
2. コマンドパレットに `ShowMe:` のコマンドが出ること（この窓でオン／オフ・停止／再開・エージェント設定・ログ・撤去手順
   に加えて、増分6 の Clear highlights / Clear annotations。
   Resolve / Unresolve と ‹ › はパレットには無く、吹き出しの右上に出る）
3. ステータスバーに `$(eye) ShowMe` が出ること
4. エージェント（あるいは開発ホストのデバッグコンソール）から `show_code` を
   `{"locations":[{"path":"src/sample.ts","text":"REVEAL_TARGET"}]}` で呼ぶ
5. **人間が使っている列ではない隣の列に** `src/sample.ts` が開くこと
6. その行に検索一致と同じ色の帯が乗り、概要ルーラー（右端の細い帯）にも印が付くこと
7. **カーソルと選択が動いていないこと**（フォーカスも取られていないこと）
8. （増分6）別のファイルへもう1回 `show_code` を呼ぶと、**5〜6 の帯が消えている**こと
   （スポットライトは窓ごと）。`annotate` を色つきで1件出すと、その行に同じ色の帯が乗り、
   もう1回 `show_code` を呼んでも**注釈の帯は残る**こと。コマンドパレットの
   **ShowMe: Clear annotations** で吹き出しと帯が一緒に消えること

6 が見えなければ `Highlights`（`src/decorations.ts`）が効いていない。
7 が崩れていたら不変条件3が壊れている ―― 自動テストも同時に落ちるはずなので、
まず `npm run -w packages/extension test:integration:xvfb` を走らせること。

### comment thread が実際に行の下に出ていること

`setDecorations` と同じで、comment thread にも**描画状態の読み出し口が無い**。
制限モードでも作れることは自動テストで確定したが（「2B の前提測定」）、
出ていることは目で見るしかない。`annotate` を実装したら、次を1回なぞること。

1. 上と同じワークスペースを開く（制限モード・信頼モードの両方でなぞる）
2. `annotate` を1件呼ぶ
3. **指定した行の下**に吹き出しが出ること（右端のアイコンだけで、開くと出る、では畳まれている
   ―― `collapsibleState` が `Expanded` になっていない）
4. 吹き出しに**返信欄が出ていないこと**（`canReply = false` と `commentingRangeProvider` 未設定）
5. 本文に**太字も箇条書きもリンクも展開されていないこと**。展開されていたら
   `body` が `string` ではなく `MarkdownString` になっている（設計書 §3.2.1）

### 制限モードを手で開く

1. 上のワークスペースを、**信頼していない状態**で開く
   （既に信頼してしまったら「ワークスペースの信頼を管理」から取り消す）
2. ウィンドウ左下に制限モードの表示が出ていること
3. 2〜7 を同じようになぞる。3〜7 は制限モードでも同じように動くはずである
   （自動テストではファイルが開くところまで確認済み）
4. 統合ターミナルを開こうとする。制限モードではブロックされる（A1）。
   ブロックされずに開けた場合は、`echo $SHOWME_SOCK` が空であることを確かめ、
   結果をこの節に追記すること ―― 上の「まだ確かめていないこと」が1つ減る

なお、注入を設定で切った場合、**既に開いている端末には残る**（設計書 §6.2）。
端末を開き直すこと。
