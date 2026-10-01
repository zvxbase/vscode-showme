<!-- translated-from README.md: {
  "vscode-showme": "42f683fb429fed8f",
  "What it does not do": "54fc2279eea3e95f",
  "How it fits": "4c5abb5353dbc3b8",
  "Requirements": "7ab6f66a01d391d1",
  "Getting started": "41a61fb5a6d788b7",
  "Quick start": "3ba7061efade0007",
  "What to ask": "2da544e57b0cf0cc",
  "Agent setup in detail": "dc39082df429eabd",
  "What you will see": "0a3f91e9e362c755",
  "Commands": "b21b96b0fd1e39bd",
  "Tools": "f8e4dfd9171875e2",
  "Settings": "a674388fc1d37f0f",
  "Opening files outside the workspace": "908e3968f41fafdd",
  "Troubleshooting": "26084671cb7eec20",
  "Uninstall": "ca746396cb15acdd",
  "Safety, in one table": "1a6de0e3f428c49b",
  "Packages": "548565c3d5677140",
  "Languages": "174627b9997a152c",
  "Status": "679eaa58a07efb55",
  "How this was built": "cfd7cce72c3841b1",
  "License": "1e5e273a2aae7f48"
} -->
# vscode-showme

> English: [README.md](README.md)

**AI エージェントに VS Code の手足を与える。**

Claude Code・Copilot CLI・Codex はコードを変えられるが、あなたの画面には触れない。
vscode-showme はその隙間だけを埋める。見慣れないリポジトリをエージェントに案内してもらうとき、
エージェントがファイルを開き、番号付きのコメントで該当箇所を指し、2箇所を並べ、図を描いて
メモを貼る ―― 隣に座った同僚がするように。

![クーポンを使うと税が安くなる理由をエージェントが説明する。コードに番号付きのコメントの吹き出しを3つ残し、人間がそれを順にたどり、続けて図を頼むとパネルに図が開く](media/readme/showme-hero.gif)

**ネットワークを使わない。** ShowMe はネットワークのポートを開かず、ネットワークへの接続もせず、
テレメトリも持たない。エージェントが起動するブリッジと VS Code の中の拡張は、ローカルのソケット
（Windows では名前付きパイプ）で話す。ShowMe 自身があなたのマシンの外へ送るものは何も無い。
エージェントはいつも通り自分のモデルの提供元と通信し、ShowMe がエージェントに伝えたこと（どこに何が
あるか、あなたが何を選択しているか）は、エージェントが読むほかのものと同じくその会話に入る。
[仕組み](#仕組み)を参照。

## これは何ではないか

- コード編集・シェル実行・診断/LSP は提供しない。エージェントが既に持っている
- ツアーの事前生成も、独自の LLM 呼び出しもしない。教え方はエージェントが持っている

## 仕組み

<img src="media/readme/how-it-fits.png" width="880" alt="エージェント（VS Code 内蔵の Copilot・Claude Code・Codex CLI・Copilot CLI）は、自分が起動した ShowMe ブリッジと stdio の MCP で話す。ブリッジは VS Code の中の ShowMe 拡張とローカルのソケットか名前付きパイプで話す。拡張はエージェントのタブ・コメントの吹き出し・HTML パネル・メモをエディタに出す。すべてあなたのマシンの上で動き、ネットワークは使わない。">

エージェントは、拡張に同梱された ShowMe ブリッジを自分の子プロセスとして起動し、stdio で MCP を
話す（VS Code 内蔵の Copilot では VS Code が起動する）。ブリッジは ShowMe 拡張に Unix ソケット
（Windows では名前付きパイプ）で繋ぎ、両側が接続のトークンを持っていることを互いに確かめる。トークンは
あなたのアカウントだけが読めるフォルダに置く（Windows では SYSTEM と Administrators も読める）。
HTTP サーバも TCP のポートも無い。Windows の名前付きパイプは、原理的には SMB 越しにネットワークから
開ける（`\\<host>\pipe\…`）が、それにはあなたのアカウントの資格情報が要り、接続にはさらにトークンが要る。
エージェントが見せる HTML は、スクリプトも外への要求も無い砂箱で動く（`connect-src 'none'`、画像は
`data:` だけ）。詳しくは[安全性の要点](#安全性の要点)。

## 必要なもの

- VS Code 1.101 以上。
- **VS Code 内蔵の Copilot（エージェントモード）:** ほかに要るものは無い。ShowMe は VS Code 自身の
  実行環境でブリッジを起動するので、Node.js は要らない。
- **Claude Code・Codex CLI・Copilot CLI:** こちらもほかに要るものは無い。Node.js 20 以上は任意で、
  ShowMe が示す設定には、Node.js を使う形と使わない形がある（[エージェントの設定の詳細](#エージェントの設定の詳細)）。

## 使い始める

| エージェント | すること |
|---|---|
| VS Code 内蔵の Copilot（エージェントモード） | 拡張を入れる。それだけで、拡張が VS Code に自分を登録する。 |
| Claude Code・Codex CLI・Copilot CLI | 拡張を入れ、**ShowMe: エージェント設定を表示**（`ShowMe: Show agent configuration`）を実行し、使っているエージェントの1行か1ブロックを貼り、エージェントを起動し直す。 |

あとはどのエージェントでも同じ。ステータスバーの **`ShowMe: オフ`**（`ShowMe: Off`）をクリックして
**`ShowMe: オン`**（`ShowMe: On`）にし、エージェントに「ShowMe を使って……」と頼む。

### すぐ始める

1. **拡張を入れる。** VS Code Marketplace か Open VSX から入れる（`zvxbase.vscode-showme`）。または
   [Releases](https://github.com/zvxbase/vscode-showme/releases) から VSIX を取ってきて
   `code --install-extension vscode-showme-<版>.vsix`。エージェントが話すブリッジは拡張に同梱
   されているので、npm から入れるものは無い。
2. **エージェントに登録する**（Claude Code・Codex CLI・Copilot CLI。VS Code 内蔵の Copilot はこの手順が
   要らない）。コマンドパレットで **ShowMe: エージェント設定を表示**（`ShowMe: Show agent configuration`）を実行する。
   そのまま貼れる断片（実際のインストール先入り）が読み取り専用の文書で開く:
   - **Claude Code** — `claude mcp add` の行を端末で実行し、一覧の許可ルールを `.claude/settings.json`
     の `permissions.allow` に足す（足さないと、呼び出しのたびに Claude Code が確認を求める）
   - **Codex CLI** — `~/.codex/config.toml` に `[mcp_servers.showme]` の節を足す
   - **Copilot CLI** — `~/.copilot/mcp-config.json` に `"showme"` の項目を足し、起動時に
     `--allow-tool 'showme'` を付ける

   そのあとエージェントを起動し直す（または新しいセッションを始める）と、ShowMe が読み込まれる。
3. **エージェントに使わせる窓でオンにする。** 許可するまで、どの窓も操作されない。
   その窓のステータスバーの **`ShowMe: オフ`**（`ShowMe: Off`）をクリックすると **`ShowMe: オン`**（`ShowMe: On`）になり、
   エージェントが繋がると **`ShowMe: 接続中`**（`ShowMe: Connected`）になる。もう一度クリックすればオフに戻る。
   同じフォルダを2窓で開いて片方だけオンにすることもでき、エージェントはオンの窓を使う。

   <img src="media/readme/screenshot-statusbar.png" width="342" alt="オンにした ShowMe のステータスバーの項目と、この窓で ShowMe がオンであり、クリックするとオフになることを伝える tooltip">
4. **エージェントに頼む。** 「ShowMe を使って……」と言うと、エージェントが ShowMe を使う ―― 下を参照。

### 頼み方の例

「ShowMe を使って……」で始める。エージェントは見せて説明し、そこで止まる。あなたは自分のペースで
読み、次の質問をする。

- 「ShowMe を使って、このリポジトリでリクエストがどう処理されるかを順に見せて」 ―― エージェントが
  ファイルを1つずつエージェントのタブに開き、読む順に番号の付いたコメントの吹き出しを残す。吹き出しの
  **‹ ›** で前後の吹き出しへ移れる
- 「ShowMe を使って、`parseConfig` の定義と使われている場所を並べて見せて」 ―― 定義と呼び出し箇所が
  隣り合って開く
- 「ShowMe を使って、`src/server.ts` の大事な行に注釈を付けて」 ―― その行の下に、読む順の番号
  （`1/7 ·`、`2/7 ·`、…）の付いた吹き出しが出る
- 「ShowMe を使って、このモジュール同士の依存関係を図にして」 ―― コードの隣のパネルに図が開く

### エージェントの設定の詳細

**2つの形。** Claude Code・Codex CLI・Copilot CLI について、ShowMe が示す設定は、どのエージェントにも
同じ項目の完全な形を2つ示す。どちらか1つを使う:

- **VS Code の実行環境**は Node.js が要らない。Node.js を入れていなければこちらを選ぶ。パスは
  VS Code の入れ方に属するので、一部の環境（リモート・AppImage・Nix）では VS Code の更新や再起動の後に
  設定し直す。Flatpak 版の VS Code ではこの形は出ない（その実行環境は砂箱の外のエージェントからは
  起動できない）。
- **`node`** は `PATH` に Node.js 20 以上が要る。エージェントを起動する端末で `which node`（Windows では
  `where.exe node`）を実行して確かめる。Node.js を入れた後は、VS Code とその端末を完全に終了して
  起動し直す。Node.js が入っていればこちらを選ぶ。VS Code の場所に依らないので VS Code を更新しても
  動き続け、Windows では VS Code の更新の仕組みにも止められない。

**エージェントごとの中身。** 使っているエージェントの断片を
**ShowMe: エージェント設定を表示**（`ShowMe: Show agent configuration`）から写す。ShowMe が他のツールの設定ファイルを書き換えることはない。

- **Claude Code** — 形ごとに `claude mcp add` の1行（`claude mcp add -e ELECTRON_RUN_AS_NODE=1 --transport stdio showme -- …` と `claude mcp add --transport stdio showme -- node …`）と、`.claude/settings.json` の
  `permissions.allow` に足す許可ルールの一覧。許可ルールが無いと、表示するだけのツールでも
  毎回確認が出る
- **Codex CLI** — `~/.codex/config.toml` に足す、形ごとの `[mcp_servers.showme]` の節。許可の設定は要らない
- **Copilot CLI** — `~/.copilot/mcp-config.json` に足す、形ごとの `"showme"` の項目。起動時に
  `--allow-tool 'showme'` を付ける
- **VS Code 内蔵の Copilot（エージェントモード）** — 設定不要。拡張が MCP サーバとして自分を
  登録する（制限モードでは効かない）

**VS Code の入っている場所。** 文書は実行環境の形を先に示す。VS Code の場所が変わったら、
**ShowMe: エージェント設定を表示**（`ShowMe: Show agent configuration`）を開き直すと今のパスが出る。
VS Code をリモート（WSL・SSH・dev container）に繋いでいるときは、実行環境のパスは VS Code Server の
もので、VS Code を更新するたびに変わるので、文書は `node` の形を先に示す。実行環境の形を使うなら、
更新したら設定し直す。AppImage で動かしている VS Code と、
macOS でダウンロードした場所から開いた VS Code（App Translocation）も同じで、こちらは VS Code を起動し直す
たびにパスが変わる。Nix のストアに入れた VS Code では、更新のたびにパスが変わる。Flatpak 版の VS Code では、砂箱の外のエージェントは VS Code の実行環境を起動できないので、
文書は `node` の形だけを示す。Snap 版では、断片は更新に追従する `/snap/code/current/` を指す。

断片は「入っている中でいちばん新しい ShowMe」を起動するので、拡張を更新しても貼り直さなくてよい。
Windows では、`claude mcp add` の行は入っている版のフォルダを名指す（PowerShell とコマンド
プロンプトのどちらでも動く形にするため）。拡張を更新したら打ち直す。

Claude Code の許可ルールに `arrange_editors` を入れていないのは意図的で、タブを閉じうる唯一の
ツールだから。使いたければ `"mcp__showme__arrange_editors"` を自分で1行足す。

**スコープ（この repo だけ／すべての repo／チームで共有）。** 同じ文書にそれぞれの設定がある。
Claude Code の既定（`--scope local`）はすでに「この repo だけ・自分だけ」で、`--scope user` にすると
自分のすべての repo、`--scope project` にすると `.mcp.json` でチームと共有する。Codex CLI は、
trusted にした project だけ repo の `.codex/config.toml` を読む。Copilot CLI は、そのフォルダを
信頼すると `.mcp.json` か `.github/mcp.json`（`"tools": ["*"]` 付き）を読む。`.mcp.json` の項目1つで
Claude Code と Copilot CLI の両方に使える。断片にはこの機械のインストール先のパスが入るので、
コミットしたファイルは他の人の機械ではそのままでは動かない ―― ShowMe がホームのフォルダの下に
入っていれば、文書は人ごとのホームの下から ShowMe を探す項目も示す（この項目は `node` で起動するので、
Node.js 20 以上が要る）。他人の repo にある MCP の設定は、
承認する前に中身を確かめる。

文書の最後には、設定をエージェントに頼むためのプロンプトがある。エージェントが行う変更の責任は
使う人にある。先にプロンプトを読むこと。

**同じマシン、同じ環境。** エージェントと VS Code は同じマシンの同じ環境で動いている必要がある。
devcontainer なら両方コンテナの中、Remote-SSH なら両方リモート側、WSL に繋いだ VS Code ならエージェントも
WSL の中。Windows で動くエージェントは WSL に繋いだ VS Code の窓に届かず、その逆も届かない。

## 画面に出るもの

- **エージェントのタブ** — エージェントが見せるファイルは、エージェント専用のタブに開く。ファイルの
  読み取り専用の映しで、あなたの未保存の変更も映る。タブの名前に色が付き、**SM** のバッジが付く
  （読み取り専用のタブは代わりに鍵のアイコン）ので、自分のタブと見分けられる。「定義へ移動」と
  「すべての参照を検索」もここで効く。あなたが動かしてもエージェントのタブのままなので、
  エージェントが自分で片づけられる。同じファイルをあなたが自分で開いたタブは、あなたのもののまま
- **本物のファイルを開く** — タブのタイトルバーの **ShowMe: 本物のファイルを開く**（`ShowMe: Open the real file`）ボタンで、
  同じファイルの同じ行を今いる列（エージェントのタブの隣）に開く。そのタブはあなたのもので、エージェントのものではない。`arrange_editors` の `close-own` では閉じない
- **注釈** — エージェントのタブの行の下の吹き出し。エージェントの読む順に番号（`1/7 ·`）が付く。
  エージェントがコードを指すのはこれだけで、塗られた箇所には必ずコメントがある。塗りは吹き出しの色
  （エージェントが色を付けなければ灰）で、エージェントが文字列で探して指したときは、その文字列だけを塗る（その行に2回以上あれば行全体）。
  `show_code` でファイルを開いても何も塗らない。吹き出しの `‹ ›`
  （**前の注釈へ** / **次の注釈へ**）で順にたどれる。開くのはエージェントのタブで、あなたの列に開くこともあり、
  あなたが目を離せばエージェントが片づけることがある。**解決済みにする** で「読んだ」を返せ、**未解決に戻す** で取り消せる
- **HTML パネル** — 表や図。スクリプトは動かない
- **メモ** — untitled のエディタ。保存するかどうかはあなたが決める
- **片づけ** — **ShowMe: 注釈を消す**（`ShowMe: Clear annotations`）。吹き出しと塗りが一緒に消える

<img src="media/readme/screenshot-bubbles-comments.png" width="880" alt="src/cart.ts のエージェントのタブ。塗られた行の下に番号付きのコメントの吹き出しが2つあり、同じ3つの注釈が VS Code のコメントパネルにも並ぶ">

<img src="media/readme/screenshot-show-html.png" width="880" alt="エージェントが描いた図の HTML パネル。subtotal・applyDiscount・addTax・total が横に並び、クーポンの有無で税を比べる棒が下にある">

## コマンド

コマンドパレット（Ctrl+Shift+P、macOS では Cmd+Shift+P）から実行できる。日本語化の拡張を入れていない
VS Code では英語名で出る。

<!-- BEGIN GENERATED: commands -->
| コマンド | すること |
|---|---|
| **ShowMe: この窓でオン／オフ**（`ShowMe: Turn on / off for this window`） | この窓をエージェントに預ける、または預けるのをやめる。ステータスバーの ShowMe をクリックするのと同じ。 |
| **ShowMe: 拡張を停止する／再開する**（`ShowMe: Stop / Resume the extension`） | すべての窓で ShowMe を止める、または再開する。再開するまで止まったまま（ユーザー設定の showme.enabled に保存される）。 |
| **ShowMe: エージェント設定を表示**（`ShowMe: Show agent configuration`） | Claude Code / Codex CLI / Copilot CLI にそのまま貼れる設定を、実際のインストール先入りで開く。 |
| **ShowMe: 操作ログを表示**（`ShowMe: Show the operations log`） | ツール呼び出しの記録を開く（選択テキストは記録しない）。 |
| **ShowMe: 撤去手順と設定の削除方法を表示**（`ShowMe: Show teardown steps and how to remove the configuration`） | エージェントから ShowMe の登録を消し、拡張を撤去する手順を開く。 |
| **ShowMe: 注釈を消す**（`ShowMe: Clear annotations`） | エージェントの注釈をすべて消す。 |
| **ShowMe: 本物のファイルを開く**（`ShowMe: Open the real file`） | エージェントのタブのファイルを、同じ行で、あなたのタブとして開く。エージェントのタブが前面にあるときだけ出る。 |
<!-- END GENERATED: commands -->

吹き出しのボタン（`‹ ›` の **前の注釈へ**（`Previous annotation`）/ **次の注釈へ**（`Next annotation`）と、
**解決済みにする**（`Resolve`）/ **未解決に戻す**（`Unresolve`））はコマンドパレットには無い。押した吹き出しに
対して働くため。

## ツール

| ツール | すること |
|---|---|
| `list_workspaces` | 繋がっている VS Code の窓をエージェントに教える |
| `get_editor_state` | あなたが見ているところ（ファイル・カーソル・選択・見えている行・開いているタブ） |
| `show_code` | ファイルを開き、その場所までスクロールする。塗らない。`realFile: true` で本物のファイルを開き、あなたが編集できるようにする |
| `annotate` | コードを指す。行の下に番号付きの吹き出しを付け、その箇所を塗る（色が無ければ灰。文字列で指したら一致した文字列だけ。その行に文字列が2回以上あれば行全体）。`reveal: true` で、`show_code` と同じやり方でファイルを開き、最初の吹き出しまでスクロールもする。`realFile: true` で本物のファイルに付ける |
| `show_html` | 表や図をパネルに出す（スクリプトは動かない） |
| `show_note` | untitled のメモを開く |
| `find_definition` | シンボルの定義場所（「定義へ移動」と同じ答え） |
| `find_references` | シンボルが使われている場所 |
| `show_view` | エクスプローラーでファイルを示す・サイドバーの切り替え・パネルの開閉・Zen モード |
| `arrange_editors` | エディタの列を並べ替え・片づける（既定では自分が出したパネルしか閉じない） |

どのツールもファイルの中身を返さない。中身はエージェントが自分の道具で読む。

## 設定

どれもユーザー設定。読んでいるリポジトリの `.vscode/settings.json` から安全に関わる設定は変えられない。

<!-- BEGIN GENERATED: settings -->
| 設定 | 既定 | 意味 |
|---|---|---|
| `showme.enabled` | `true` | エージェントからの接続を受け付ける。オフにするとすべての窓で ShowMe が止まる。切り替えはコマンド「ShowMe: 拡張を停止する／再開する」（ShowMe: Stop / Resume the extension）で行う。 |
| `showme.stage.enabled` | `true` | エージェントがファイルやタブを開き、スクロールし、エディタを分割することを許す（show\_code がファイルを開く部分と show\_note）。オフにすると show\_code は位置を解決して返すだけで開かず、annotate は reveal を付けてもファイルを開かず、show\_note は断られる。注釈と読み取りのツールは常に使える。 |
| `showme.stage.editorGroup` | `"shared"` | エージェントがファイル・メモ・パネルを開く列。この設定で、エージェントが閉じたり動かしたりしてよいあなたのタブは変わらない。 `"shared"`: 既定。あなたの列より右の列を先に使う。右に無ければ列を増やさずにあなたの列を使い、split でまだ足りないときだけ列を足す。 `"dedicated"`: あなたの列はあなた専用にする。右の列に開き、足りなければ列を足す。ただし、あなたのタブが1枚も無い列（空か、エージェントのタブだけ）なら使う。 `"active"`: 常にあなたの列に開く。エージェントの layout と枠は見ない。 |
| `showme.stage.agentTabs` | `true` | エージェントの編集器を、エージェント専用のタブとして開く（ファイルの映しで、showme.stage.editable をオンにしていない限り読み取り専用）。エージェントのタブには印が付く: タブの名前が showme.agentTabForeground の色になり（テーマで変えられる）、VS Code がバッジを出す所には「SM」のバッジが出る（読み取り専用のタブではバッジの代わりに鍵のアイコンが出る）。あなたがタブを動かしても、同じファイルを自分で開いても、エージェントのタブのままなので、エージェントが自分で片づけられる。オフにすると、エージェントは今までどおり普通のファイルのタブを開く。切り替えが効くのはこの後に開くタブだけで、開いているタブはそのまま。 |
| `showme.stage.editable` | `false` | エージェントのタブでの編集・保存を許す。保存は本物のファイルに書く。映しの編集は保存するまで人間の file: タブに見えない。書けないファイル（ディスクで読み取り専用のもの・ハードリンク）は読み取り専用で開く。showme.stage.agentTabs がオンでなければ効かない。切り替えが効くのはこの後に開くタブだけで、開いているタブはそのまま。 |
| `showme.stage.definitionTarget` | `"file"` | エージェントのタブで「定義へ移動」（Ctrl+クリック / F12）したとき、別のファイルで定義された名前の行き先。同じファイルの中への移動は、どちらでもエージェントのタブのまま。「すべての参照を検索」も同じ規則に従う。 `"file"`: 本物のファイル（あなたのタブ）を開く。そのまま作業に入れる。 `"agentTab"`: エージェントのタブで開く。エージェントと並んで読み進められる。 |
| `showme.stage.avoidToolColumns` | `false` | ターミナル・他の拡張のパネル（Claude Code・Copilot などのエージェントを含む）・Settings のようなファイルでないタブを表示している列には、エージェントがファイル・メモ・パネルを開かない。別の列を使い、使える列が無ければ断る。arrange\_editors もそうした列を巻き込むプリセットや、そこへの移動を断る。既定はオフ。showme.stage.editorGroup が "active" のときは開く動作にしか効かない ―― arrange\_editors の断りは変わらず効く。 |
| `showme.html.enabled` | `true` | エージェントが HTML パネルを出すことを許す（show\_html）。オフにすると show\_html は断られる。 |
| `showme.html.maxPanels` | `2` | エージェントが同時に出せる HTML パネルの枚数。既定 2。0 にすると上限が無くなるが、どのパネルも閉じるまでメモリを使い続ける。エージェントには上限が伝わる。 |
| `showme.layout.enabled` | `true` | エージェントがエディタを並べ替え・移動・閉じ、表示を切り替えることを許す（arrange\_editors、show\_view）。オフにするとどちらも断られる。 |
| `showme.layout.closeHumanTabs` | `false` | arrange\_editors が、エージェント自身の出したパネルだけでなく、あなたが開いたタブも閉じたり動かしたりしてよいか。既定では閉じない。 |
| `showme.layout.closeDirtyTabs` | `false` | arrange\_editors が未保存のタブも閉じてよいか。既定では、showme.layout.closeHumanTabs を有効にしていても未保存のタブは残る。 |
| `showme.layout.protectViewingTab` | `false` | オンにすると、あなたがいま見ているタブをエージェントは閉じたり動かしたりしない。既定はオフで、エージェントは自分で開いたタブなら、あなたが見ている最中でも片づけられる。あなた自身のタブと未保存のタブを閉じてよいかは、引き続き showme.layout.closeHumanTabs と showme.layout.closeDirtyTabs で決まる。 |
| `showme.redactedPathPatterns` | `[]` | エージェントから隠すパスのパターンを足す。足すことしかできず、組み込みの一覧（.env / .env.\* / \*.pem / \*.key / \*.p12 / \*.pfx / id\_rsa\* / id\_ed25519\* / credentials\* / \*.keystore / .npmrc / .netrc）は取り除けない。一致するファイルはエージェントが求めても断られ、そのファイルの選択テキストも返さない。 |
| `showme.blockLinksToRedactedFiles` | `true` | 秘匿ファイル（.env など）へのハードリンクを、秘匿でない名前でも秘匿として扱う。普通のハードリンク（pnpm の node\_modules など）には影響しない。ただし非常に大きなワークスペース（走査しないフォルダ（.git・node\_modules・.venv・venv・target・.tox・\_\_pycache\_\_・.cache）の外に 50,000 項目を超える）では拒まれ、操作ログにそう出る。オフにするとハードリンクは名前だけで判定する。 |
| `showme.allowOutsideWorkspace` | `false` | ワークスペースの外のファイルも、絶対パスで開けるようにする。既定はオフで、オンにするのは自己責任。リスクは2つある。(1) エージェントに設定したフォルダの読み取り制限を迂回する経路になる ―― ファイルの中身はエージェントに返さないが、同じファイルを何度も探させれば中身を推測できる。(2) 読んでいるリポジトリに仕込まれた指示でエージェントがだまされると、ホームフォルダの秘密のファイルが画面に出る。画面共有や録画をしていれば流出する。オンでも、秘匿のパスのパターンに当たるファイルと、資格情報の置き場所（~/.ssh・~/.aws・~/.config/gh・~/.claude・ブラウザのプロフィール・シェルの履歴など。どのユーザーのホームでも）は開けず、ワークスペースの外のハードリンクは断る（showme.blockLinksToRedactedFiles がオンの間）。ただし、すべては守れない。 |
| `showme.maxSelectionChars` | `4000` | get\_editor\_state が返す選択テキストの上限文字数。 |
| `showme.injectTerminalEnv` | `true` | 統合ターミナルに SHOWME\_SOCK（ShowMe のソケットのパス）を入れる。ビルドスクリプトなど、あなたの他のプロセスにそのパスを渡したくなければオフにする。そのときエージェントは、ShowMe が登録するファイルから ShowMe を見つける。 |
| `showme.listAllWorkspaces` | `false` | list\_workspaces が、エージェントが繋がっている窓以外の VS Code の窓も返すようにする。既定はオフ。オンにすると、他の窓のフォルダのパスがエージェントに見える。 |
<!-- END GENERATED: settings -->

既定の `editorGroup: "shared"` では、あなたの列にエージェントのタブが開くことがあるので、その瞬間
そこで打鍵していると何文字かがエージェントのタブに入ることがある。エージェントのタブは既定で読み取り
専用なので、打鍵の行き先が変わるだけで何かが書き換わることはない（`showme.stage.editable: true` なら
本物のファイルに書けるが、それでも画面に見えている変更で、保存はあなたの操作）。エージェントに自分の
列へ入ってほしくなければ、`showme.stage.editorGroup: "dedicated"`（見ているタブも守るなら
`showme.layout.protectViewingTab: true` も）にする。

全部まとめて止めるには **ShowMe: 拡張を停止する／再開する**（`ShowMe: Stop / Resume the extension`）。ツール呼び出しはすべて
**ShowMe: 操作ログを表示**（`ShowMe: Show the operations log`）に記録される（選択テキストは記録しない）。

### ワークスペースの外のファイルを開く

既定では、エージェントが指せるのはワークスペースの中のファイルだけ。`showme.allowOutsideWorkspace`
をオンにすると（ユーザー設定だけ。リポジトリからはオンにできない）、ワークスペースの外のファイルも
**絶対パス**で見せ・注釈し・探せる（`~` は展開しない）。既定でオフなのは、オンにするとき次の2つの
リスクを受け入れることになるから:

- **エージェントに設定したフォルダの制限を迂回する経路になる。** ShowMe はファイルの中身を返さないが、
  同じファイルを何度も探させれば中身を推測できる。
- **読んでいるリポジトリに仕込まれた指示で、秘密のファイルが画面に出る。** 画面共有や録画をしていれば
  流出する。

オンでも、秘匿のパスのパターン（`.env`・鍵・あなたが足したパターン）、どのユーザーのホームでも資格情報の
置き場所（`~/.ssh`・`~/.aws`・`~/.config/gh`・`~/.claude`・ブラウザのプロフィール・シェルの履歴など）、
`/proc` などのシステムのフォルダ、ワークスペースの外のハードリンクは断る。この一覧ですべては守れない。
設定がオンの間、ステータスバーの `ShowMe: オン`（`ShowMe: On`）/ `ShowMe: 接続中`（`ShowMe: Connected`）に
警告の印が付き、警告色になる。

`show_html` の HTML ファイルと **エクスプローラーで表示**（Reveal in Explorer）はワークスペースの中だけの
まま。外のファイルのエージェントのタブは、ディスクの変更では読み直されない。エージェントにもう一度
見せてもらう。
Windows では、`NAME~1` のような部分（8.3 形式の短い名前の形。`C:\PROGRA~1\…` など）を含むパスは、
ファイル自体が許されていても断る。短い名前は同じファイルの別の綴りだから。長い名前で指す。

## 動かないとき

まずステータスバーを見る。ShowMe は自分のしていることをそこに出す。

| 表示 | 意味 |
|---|---|
| `ShowMe: オフ`（`ShowMe: Off`） | この窓はエージェントに預けていない。クリックでオン |
| `ShowMe: オン`（`ShowMe: On`） | オンだが、エージェントはまだ繋がっていない |
| `ShowMe: 接続中`（`ShowMe: Connected`） | 動いている |
| 警告の印と警告色の付いた `ShowMe: オン`（`ShowMe: On`）/ `ShowMe: 接続中`（`ShowMe: Connected`） | `showme.allowOutsideWorkspace` がオン。エージェントはワークスペースの外のファイルも開ける。要らないときはオフにする |
| `ShowMe: 停止中`（`ShowMe: Stopped`） | 拡張が止まっている。**ShowMe: 拡張を停止する／再開する**（`ShowMe: Stop / Resume the extension`）で再開 |
| `ShowMe: 起動できません`（`ShowMe: Failed to start`） | 理由は tooltip に出る。ディレクトリが出ていたら `ls -ld`（Windows では `icacls`）で所有者と権限を確かめる |
| `ShowMe: 2本目の接続を拒否`（`ShowMe: second connection refused`） | 同時に繋げるエージェントは1つまで。もう片方を止める。2つ目を動かした覚えが無いなら、あなたの別のプロセスが先に繋いでいる。何かを確かめること |
| `ShowMe: 見つからず …`（`ShowMe: not found …`）/ `ShowMe: 複数一致 …`（`ShowMe: multiple matches …`） | エージェントが場所を探して、ちょうど1つに決まらなかった。エージェント側で指定を絞る必要がある |
| `ShowMe: 回数制限 …`（`ShowMe: rate limited …`） | エージェントが同じ要求を短時間に繰り返した |

**エージェントが「VS Code ウィンドウが見つからない」と言う。** どこかの窓で ShowMe がオンか、
エージェントが VS Code と同じ環境で動いているか（[エージェントの設定の詳細](#エージェントの設定の詳細)）、両方が同じ `$TMPDIR`（Windows では同じ
`TEMP`）を見ているかを確かめる。

**VS Code の Copilot で ShowMe に `spawn node ENOENT` が出る。** ShowMe 0.1.5 以前は、VS Code が
起動したときの `PATH` にある `node` でブリッジを起動していた。VS Code 自身の実行環境を使う 0.1.6
以降に更新する。0.1.5 のまま使うなら、Node.js を入れてから VS Code を完全に終了して起動し直す
（新しい窓を開くだけでは足りない）。

**Windows で VS Code を更新すると、エージェントから ShowMe が切れる。** VS Code の更新の仕組みは、
VS Code のフォルダから動いているプログラムをすべて止める。エージェントが VS Code の実行環境で起動した
ShowMe もその1つ。エージェントで ShowMe を繋ぎ直す（Claude Code なら `/mcp`）。ShowMe を `node`
（Node.js 20 以上）で起動すれば、これは起きない。

**Configure Tools で ShowMe の下に「Update Tools」しか出ない。** ShowMe をまだ動かしていない
ワークスペースでは、VS Code はサーバを起動するまでツールを知らず、最初のチャットを送ったときに
起動する。VS Code の仕組みどおりで、エラーではない。すぐ見たいなら **Update Tools** を押す。
ShowMe を更新した後も、同じように一覧が取り直される。

**Windows で ShowMe が起動せず、理由に TEMP/TMP が出る。** `TEMP` か `TMP` が、他の利用者も書ける
フォルダを指している。直し方は下の「現在地と開発の場所」にある。

**`.env` や鍵ファイルが「見つからない」と言われる。** 仕様。ShowMe はそれらのパスを隠し、
場所も教えない。

## 撤去

エージェント側の登録を先に消し、拡張は最後に消す。詳しい手順は
**ShowMe: 撤去手順と設定の削除方法を表示**（`ShowMe: Show teardown steps and how to remove the configuration`）で開けるが、このコマンドは拡張の中にあるので、
拡張を消すと一緒に消える。

1. エージェントから ShowMe の登録を消す:
   - Claude Code: `claude mcp remove showme`（複数のスコープにあると、`-s local`・`-s user`・
     `-s project` のどれかで選ぶよう求められる）。`.claude/settings.json` の `permissions.allow` に足した `mcp__showme__*` の
     行も消す
   - Codex CLI: `~/.codex/config.toml` の `[mcp_servers.showme]` の節を消す（repo の
     `.codex/config.toml` に置いたなら、そこからも）
   - Copilot CLI: `~/.copilot/mcp-config.json` の `"showme"` の項目を消す
   - repo に置いた設定: `.mcp.json` か `.github/mcp.json` の `"showme"` の項目を消す
2. 拡張をアンインストールする: `code --uninstall-extension zvxbase.vscode-showme`。ソケットと
   登録ファイルは拡張が自分で消す。ユーザー設定に書いた `showme.*` は、消すまで残る
3. 既に開いていたターミナルは開き直す（または変数を外す: bash / zsh は `unset SHOWME_SOCK`、
   PowerShell は `Remove-Item Env:SHOWME_SOCK`、コマンド プロンプトは `set SHOWME_SOCK=`）

拡張だけ消してエージェント側の登録が残っても、エージェントが ShowMe の起動に失敗して
`ShowMe is not installed in …` と出るだけで、ほかには何も起きない。エラーを止めるには登録を消す。

## 安全性の要点

| 性質 | 仕組み |
|---|---|
| ネットワークリスナーを持たず、テレメトリも無い | Unix socket / 名前付きパイプのみ。HTTP サーバも TCP のポートも決して立てず、ShowMe が自分からネットワークに繋ぐことも、テレメトリを送ることもない。Windows の名前付きパイプを SMB 越しに開けるのはあなたのアカウントの資格情報を持つ相手だけで、接続にはさらにトークンが要る。 |
| どのツールもファイルの中身を返さない | `show_code` が返すのは解決した位置と、どう解決したかだけ。テキストは返さない。 |
| 選択を動かさない | 注釈の塗りは装飾、位置合わせは `revealRange`。選択を動かすと `get_editor_state` を通してテキストが漏れる。 |
| エージェントの HTML はスクリプトを持たない | 二重の iframe で、内側は `sandbox=""`、`connect-src 'none'`、`img-src data:`（egress ゼロ）。 |
| エージェントの舞台は有界 | 上限2列。既定（`editorGroup: "shared"`）では、右に余地が無いとき列を足す代わりにあなたの列を使う。`editorGroup: "dedicated"` にすると、あなたが今いる列は、あなたのタブが1枚でもあれば使わない（あなたの列より右の既存の列は再利用する）。片づけ（`arrange_editors`）は、`closeHumanTabs` を設定しない限りエージェントが開いたものしか閉じず、`closeDirtyTabs` を設定しない限り未保存のタブを閉じない。`protectViewingTab` を設定すると、あなたが見ているタブにも触れない。 |
| ツールが前面に出した選択は、あなたが選び直すまで渡さない | ツールの呼び出しであなたの前面の編集器が変わったら、見えている選択（VS Code が自分で戻したものも含む）は、あなたが自分で何かを選ぶまで `get_editor_state` に返らない。 |
| 安全に関わる設定はワークスペースから読まない | ユーザー設定だけが効く。読んでいるリポジトリは敵かもしれず、その `.vscode/settings.json` では何も広げられない。 |
| ツールは外の世界に触れないと宣言する | 全ツールが `openWorldHint: false`。 |
| ワークスペースの外は既定で開けない | ユーザー設定で `showme.allowOutsideWorkspace` をオンにしたときだけ。オンでも資格情報の置き場所（`~/.ssh` など）と秘匿のファイルは断り、オンの間はステータスバーが警告を出す。 |
| 既定はオフ | ステータスバーに `ShowMe: オフ`（`ShowMe: Off`）と出る。クリックするまで何も操作されない。1クリックで全部止まる。制限モードでも動く。 |

セキュリティ報告の対象範囲は [`SECURITY.md`](SECURITY.md) にある。

## 構成

| パッケージ | 役割 |
|---|---|
| `packages/protocol` | 共有スキーマ・ツール定義・注釈（定義はここにしか無い） |
| `packages/bridge` | stdio MCP サーバ。エージェントが起動する |
| `packages/extension` | VS Code 拡張。VS Code の API を実際に呼ぶ |

VS Code の API を呼べるのは拡張だけで、エージェントは stdio の MCP で話す。だから ShowMe には両方が
要る ―― エージェントが起動する MCP サーバと、VS Code の中で動く拡張。

## 言語

エージェントが読む文字列（ツールの説明・エラー）は**英語のみ**。人間が読む文字列
（ステータスバー・通知・コマンド名・設定の説明・設定断片と撤去手順の文書）は**英語が既定**で、
VS Code の表示言語が日本語なら日本語になる。

## 現在地と開発の場所

**プレビュー版。** Linux・macOS・Windows で確認済み（それぞれ単体テストと、実 VS Code での統合テスト）。

**Windows ではネイティブで動く。** ShowMe は接続のトークンを `%TEMP%` の下のフォルダに置き、その
フォルダを読めるのが自分・SYSTEM・Administrators だけであることを確かめる。`TEMP` か `TMP` が、他の
利用者も書けるフォルダを指していると、理由を出して起動を断る。たとえば共有の `C:\Temp` や、
`D:\Temp` のようなシステムドライブ以外のフォルダ（そのドライブの既定の権限のままで、他の利用者も中に
作れる）。直すには、`TEMP` と `TMP` を自分だけが書けるフォルダ（既定の `%LOCALAPPDATA%\Temp` など）に
向けて、VS Code を起動し直す。WSL や dev container の VS Code も今までどおり使える。エージェントと
VS Code は同じ環境で動いている必要がある（[エージェントの設定の詳細](#エージェントの設定の詳細)）。

GitHub の公開 repo は**リリースのミラー**である。開発は private の repo で行い、リリースごとに
1 コミットとしてそこに載せる（`CONTRIBUTING.md`）。個人のプロジェクトで、対応の期限の約束は無い。
Issue / PR は歓迎で、メンテナが時間のあるときに返事をする。取り込んだ PR は private 側に当て直して
次のリリースに入り、`CHANGELOG.md` でクレジットする。

## 作り方

コードは Claude Code で書いた。どの変更も、マージの前に仕様のレビューと品質のレビュー（テストの
変異検査を含む）を通している。上の安全性は作法ではなくテストで守っている ―― repo 全体の検査は
`test/`（たとえば「サニタイザは1つ」「どのツールもファイルの中身を返さない」）に、単体と統合の
スイートは `packages/` の下にある。

## ライセンス

MIT。拡張は第三者のコンポーネント（MCP SDK・zod・parse5 とそれらの依存。どれも MIT・ISC・BSD）を
同梱している。それらのライセンスは VSIX の中の `THIRD-PARTY-NOTICES.txt` に再掲してあり、ビルドが
実際に束ねたものから生成している。
