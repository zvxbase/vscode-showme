import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  TOKEN_HEX_LENGTH,
  WIRE_PROTOCOL_VERSION,
  type WindowCandidate,
  type WindowRole,
  chooseStageWindow,
  processUid,
  runtimeDirCandidates,
  windowRoleSchema,
} from "@zvx/vscode-showme-protocol";
import { z } from "zod";

/**
 * 拡張が実行時ディレクトリに書く登録ファイルの形。
 *
 * 書く側は `packages/extension/src/server.ts` の `ShowMeSocketServer.start()`。
 * 読むのはブリッジだけなので、読み手側のスキーマとしてここに置く。
 *
 * `.strict()` にしない。拡張が先に新しくなって鍵が増えたときに、ブリッジが
 * 「登録ファイルが1件も無い」と誤診して「VS Code が居ません」と言い出すのは
 * 直しようのない失敗の仕方になる。互換性の切れ目は `protocolVersion` が持つ。
 */
const registryEntrySchema = z.object({
  protocolVersion: z.number().int(),
  workspacePath: z.string(),
  pid: z.number().int(),
  startedAt: z.string(),
  socketPath: z.string().min(1),
  // 拡張は randomBytes(32) の hex を書く。形が違うものは登録ファイルではない。
  authToken: z
    .string()
    .length(TOKEN_HEX_LENGTH)
    .regex(/^[0-9a-f]+$/),
  /**
   * 窓ごとに一意な id（設計書 §2A.4）。
   *
   * **無くても登録ごと捨てない。** 役割を知らない古い拡張が書いた登録を捨てると、
   * ブリッジは「登録が1件も無い＝拡張が居ない」と誤診する。捨てずに読んで、
   * 役割の側でフェイルクローズする（下記 `role`）。
   */
  windowId: z.string().min(1).optional(),
  /**
   * この窓が預けられているか。**読めない値は全部 `idle` に倒す。**
   *
   * 鍵が無い（古い拡張）・綴りが知らない（新しい拡張）・大文字（別物）の
   * どれでも、迷ったら「預かっていない」側に倒す。逆に倒すと、預けていない窓が
   * エージェントに操作される（設計書 §2A.1 の既定が崩れる）。
   */
  role: z.unknown().transform((value): WindowRole => {
    const parsed = windowRoleSchema.safeParse(value);
    return parsed.success ? parsed.data : "idle";
  }),
});

export type RegistryEntry = z.infer<typeof registryEntrySchema>;

/** 登録ファイル1件を読む。読めない・形が違うなら undefined（黙って飛ばす）。 */
export function parseRegistryEntry(raw: string): RegistryEntry | undefined {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = registryEntrySchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

export interface DiscoveryHints {
  /** `$SHOWME_SOCK`。拡張が統合ターミナルに注入する最適化。 */
  sock?: string | undefined;
  /**
   * 呼び出し側が指定したワークスペース。
   *
   * 増分1 では**どのツールもこれを引数に持たない**ので、常に undefined で呼ばれる。
   * 経路だけ先に用意して、`sock` との優先関係（下記）を検査で固定しておく。
   */
  workspacePath?: string | undefined;
  /** 接続に失敗したと分かっているソケット。再試行で同じ死体を掴まないため。 */
  exclude?: readonly string[] | undefined;
}

export type SelectionFailure =
  /** 登録ファイルが1件も無い。拡張が動いていないか、名前空間がずれている */
  | "no-entries"
  /** 登録はあるが、どれもこのブリッジと版が違う */
  | "version-mismatch"
  /** 候補は全部試して尽きた（再試行後） */
  | "exhausted"
  /** 窓は居るが、人間がどれも預けていない（既定の状態・設計書 §2A.1） */
  | "no-stage"
  /** 預けられた窓が複数あって、ヒントでも解けない */
  | "multiple-stages";

export type Selection =
  | { ok: true; entry: RegistryEntry }
  | { ok: false; reason: Exclude<SelectionFailure, "no-stage" | "multiple-stages"> }
  /** 候補の**数**だけを持つ。窓のパスや id は持ち帰らない（下の言葉の作り方を見よ） */
  | { ok: false; reason: "no-stage"; idleCount: number }
  | { ok: false; reason: "multiple-stages"; stages: readonly WindowCandidate[] };

/** 失敗した側の Selection。言葉を作るのに必要な中身を持っている。 */
export type SelectionFailed = Extract<Selection, { ok: false }>;

/**
 * 登録1件を指す鍵。**両候補の走査で同じ窓を2つに数えないため**に要る。
 *
 * `windowId` を書かない古い拡張のために後退先を持つ。後退先では両候補にある
 * 同じ窓を畳めない（ソケットは実行時ディレクトリの中にあるので、候補ごとに
 * パスが違う）が、役割を書かない拡張の窓はそもそも `idle` 扱いで選ばれない。
 * 畳み損ねの影響は「候補の数が多く見える」ことに留まる。
 */
function windowKey(entry: RegistryEntry): string {
  return entry.windowId ?? `socket:${entry.socketPath}`;
}

function toCandidate(entry: RegistryEntry): WindowCandidate {
  return {
    windowId: windowKey(entry),
    role: entry.role,
    socketPath: entry.socketPath,
    workspacePath: entry.workspacePath,
  };
}

/**
 * どのウィンドウに繋ぐかを決める。
 *
 * **役割が第一の軸である**（設計書 §2A.5）。決めているのは protocol の
 * `chooseStageWindow` で、ここがやるのはその前後 ―― 版の食い違いと、
 * 届かなかった候補の除外 ―― だけ。役割の規則を2箇所に置かない。
 *
 * `$SHOWME_SOCK` も `workspace_path` も**主経路ではない**。前者は制限モードで
 * 死に（統合ターミナルが既定でブロックされる）、tmux でも伝播しない。後者は
 * 同じフォルダを2窓で開くと判別できない。どちらも「預けられた窓が複数あるとき、
 * その中の同点を解く」ためだけに使う。
 */
export function selectWindow(entries: readonly RegistryEntry[], hints: DiscoveryHints): Selection {
  if (entries.length === 0) return { ok: false, reason: "no-entries" };

  const sameVersion = entries.filter((e) => e.protocolVersion === WIRE_PROTOCOL_VERSION);
  if (sameVersion.length === 0) return { ok: false, reason: "version-mismatch" };

  const excluded = new Set(hints.exclude ?? []);
  const usable = sameVersion.filter((e) => !excluded.has(e.socketPath));
  if (usable.length === 0) return { ok: false, reason: "exhausted" };

  const byWindow = new Map(usable.map((e) => [windowKey(e), e] as const));
  const chosen = chooseStageWindow(usable.map(toCandidate), {
    sock: hints.sock,
    workspacePath: hints.workspacePath,
  });

  if (chosen.ok) {
    const entry = byWindow.get(chosen.entry.windowId);
    // 候補は usable から作っているので必ず引ける。引けないのは組み立ての破損で、
    // そのときに繋ぎ先を当て推量するくらいなら繋がない方がよい。
    if (entry !== undefined) return { ok: true, entry };
    return { ok: false, reason: "no-stage", idleCount: usable.length };
  }

  if (chosen.reason === "multiple-stages") {
    return { ok: false, reason: "multiple-stages", stages: chosen.stages ?? [] };
  }
  if (chosen.reason === "no-stage") {
    // 「預けた窓に届かなかった」のと「そもそも預けていない」のは別物。
    // 前者に「ステータスバーを押してください」と言うのは嘘になる。
    const staged = sameVersion.some((e) => e.role === "stage" && excluded.has(e.socketPath));
    if (staged) return { ok: false, reason: "exhausted" };
    return { ok: false, reason: "no-stage", idleCount: chosen.idleCount ?? usable.length };
  }
  // ここに来るのは `chooseStageWindow` が候補ゼロと言ったときだけで、`usable` は
  // 空でないので起きない。protocol 側に理由が増えたら**この行で型が落ちる** ――
  // 増えた理由を黙って「拡張が居ない」に丸めると、直しようのない言葉になる。
  const remaining: "no-entries" = chosen.reason;
  return { ok: false, reason: remaining };
}

/** 実行時ディレクトリを開いた結果。3つを区別する（無いのと危ないのは違う）。 */
export type DirState =
  | { kind: "absent" }
  | { kind: "unsafe"; reason: string }
  | { kind: "ok"; names: readonly string[] };

export interface RegistryFileSystem {
  openDir(dir: string): DirState;
  /** 登録ファイルを読む。衛生検査に落ちたら undefined。 */
  read(dir: string, name: string): string | undefined;
}

export interface RegistryScan {
  dir: string;
  /** ディレクトリがそこにあったか。false なら拡張が居ないか名前空間がずれている */
  present: boolean;
  /** 衛生検査に落ちた理由。あるなら黙って迂回せず人間に見せる（設計書 D22） */
  unsafe?: string;
  entries: RegistryEntry[];
}

/** 実行時ディレクトリの中の登録ファイルを全部読む。 */
export function scanRegistry(dir: string, io: RegistryFileSystem): RegistryScan {
  const state = io.openDir(dir);
  if (state.kind === "absent") return { dir, present: false, entries: [] };
  if (state.kind === "unsafe") return { dir, present: true, unsafe: state.reason, entries: [] };

  const entries: RegistryEntry[] = [];
  for (const name of state.names) {
    if (!name.endsWith(".json")) continue;
    const raw = io.read(dir, name);
    if (raw === undefined) continue;
    const entry = parseRegistryEntry(raw);
    if (entry !== undefined) entries.push(entry);
  }
  return { dir, present: true, entries };
}

/** 両方の候補を走査した結果。 */
export interface RegistryRead {
  /** 実際に走査したディレクトリ（重複は畳んである） */
  dirs: readonly string[];
  /** どれか1つでもディレクトリがそこにあったか */
  present: boolean;
  /** 衛生検査に落ちて**読まなかった**ディレクトリと、その理由（設計書 D22） */
  unsafe: readonly { dir: string; reason: string }[];
  /** 窓ごとに1件に畳んだ登録。候補の順（先頭は書き込み先の候補） */
  entries: RegistryEntry[];
}

/**
 * 登録ファイルを**両方の候補から**読む（設計書 §2A.6）。
 *
 * 拡張とブリッジで `$XDG_RUNTIME_DIR` が食い違うと、同じマシンにいても別の
 * 場所を探して黙って見つからなくなる（長生きした tmux サーバが古い値を握る、
 * ログアウト後に `/run/user/<uid>` が消える）。**読むときだけ両方見る。
 * 書き込みは1箇所のまま**（拡張側の `runtimeDirPath`）。
 *
 * 同じ窓が両方の候補に書いていることがある ―― というより、**普通はそうなる**。
 * 拡張は両候補に同じ内容を書くからである（設計書 §2A.6）。`windowId` で1件に
 * 畳み、**候補の順序が先の方を残す**。
 *
 * **自己申告の `startedAt` で決めない。** 同一 uid のプロセスは 0600 の登録を
 * 読めるので、本物の `windowId` と未来の `startedAt` を後退先に置くだけで、
 * `socketPath` と `authToken` を差し替えられた（レビュー N2）。同一 uid では
 * 原理的に防ぎきれないが、順序で決めればこの置き換えは安くなくなる ――
 * 攻撃者は「拡張自身の第一候補より先の候補」に置く必要がある。
 * 先頭は拡張の書き込みの第一候補なので、正規の登録が必ず勝つ。
 *
 * **同じディレクトリの中の重複までは解けない**（順序が readdir 任せになる）。
 * そこは同一 uid では原理的に防げない領域で、ここで塞いだと言わない。
 * 塞いだのは「後退先に置くだけで先頭の登録を差し替えられる」という、
 * 両候補走査が持ち込んだ分だけである。
 *
 * 衛生検査に落ちた候補は**読まずに飛ばし、理由を持ち帰る**。ここで全体を
 * 止めると、`/tmp`（1777）に後退先の名前で先回りするだけで、誰でも疎通を
 * 止められる。読まないので、飛ばしても攻撃者の登録は1件も入らない。
 */
export function readRegistryEntries(dirs: readonly string[], io: RegistryFileSystem): RegistryRead {
  const scanned = new Set<string>();
  const unsafe: { dir: string; reason: string }[] = [];
  const byWindow = new Map<string, RegistryEntry>();
  const order: string[] = [];
  let present = false;

  for (const dir of dirs) {
    // 同じディレクトリを2度走査すると、同じ窓の登録が2つに見える。
    if (scanned.has(dir)) continue;
    scanned.add(dir);

    const scan = scanRegistry(dir, io);
    if (scan.present) present = true;
    if (scan.unsafe !== undefined) unsafe.push({ dir, reason: scan.unsafe });

    for (const entry of scan.entries) {
      const key = windowKey(entry);
      if (byWindow.has(key)) continue;
      byWindow.set(key, entry);
      order.push(key);
    }
  }

  const entries: RegistryEntry[] = [];
  for (const key of order) {
    const entry = byWindow.get(key);
    if (entry !== undefined) entries.push(entry);
  }
  return { dirs: [...scanned], present, unsafe, entries };
}

/**
 * 自分のものであり、他人に書けないこと。
 *
 * 実行時ディレクトリのパスは決定的で、`/tmp` は 1777 なので、先回りして
 * ディレクトリを作られうる（設計書 S7 / D22）。拡張は作る側でこれを検査するが、
 * **読む側にも同じ検査が要る**。他人が書ける場所に置かれた登録ファイルは、
 * ブリッジを攻撃者のソケットへ繋がせ、エージェントに偽の解決結果を掴ませられる。
 *
 * モードは「グループ・その他に一切許可が無い」で見る。拡張は 0700 ちょうどを
 * 要求するが、ここで見たいのは「他人が書き込めないこと」そのもの。
 */
function ownedAndPrivate(st: fs.Stats, what: string, target: string): string | undefined {
  if (st.isSymbolicLink()) return `${what} is a symlink: ${target}`;
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    return `${what} is owned by another user (uid ${st.uid}): ${target}`;
  }
  const mode = st.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    return `${what} is accessible to other users (mode ${mode.toString(8)}): ${target}`;
  }
  return undefined;
}

/** 本物のファイルシステム。衛生検査つき。 */
export const nodeRegistryFileSystem: RegistryFileSystem = {
  openDir(dir) {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(dir);
    } catch {
      return { kind: "absent" };
    }
    if (!st.isDirectory()) {
      return { kind: "unsafe", reason: `runtime dir is not a directory: ${dir}` };
    }
    const bad = ownedAndPrivate(st, "runtime dir", dir);
    if (bad !== undefined) return { kind: "unsafe", reason: bad };
    try {
      return { kind: "ok", names: fs.readdirSync(dir) };
    } catch (e) {
      return { kind: "unsafe", reason: `cannot list runtime dir: ${String(e)}` };
    }
  },

  read(dir, name) {
    const target = path.join(dir, name);
    try {
      const st = fs.lstatSync(target);
      if (!st.isFile()) return undefined;
      if (ownedAndPrivate(st, "registry file", target) !== undefined) return undefined;
      return fs.readFileSync(target, "utf8");
    } catch {
      return undefined;
    }
  },
};

/**
 * 拡張と同じ規則で、読みに行く実行時ディレクトリの候補を出す。
 *
 * 両端が同じ答えを出すことが疎通の前提なので、規則は protocol の
 * `runtimeDirCandidates` / `processUid` に1つだけ置いてある（設計書 Y4）。
 * 先頭は必ず書き込み先の候補。
 */
export function defaultRuntimeDirs(): string[] {
  return runtimeDirCandidates(process.env, os.tmpdir(), processUid(process));
}

/**
 * 繋げなかった理由を、人間とエージェントの両方に効く言葉にする。
 *
 * 設計書 §3.4 は「黙って失敗させない」と言う。「VS Code が見つかりません」だけだと、
 * 拡張が無効なのか、窓を預けていないだけなのか、ホストのシェルからコンテナ内の
 * VS Code を見に行っているのかが区別できず、直しようがない。
 * **どの言葉も「人間が次に何をすればよいか」を含む。**
 *
 * 漏らす情報の線引き:
 *
 * - `no-stage` では**候補の数だけ**を言う。数は「拡張が動いていない」との区別に
 *   要るが、**預けていない窓のパスや id をエージェントに渡す理由は無い**。
 * - `multiple-stages` では窓を名指しする。人間がどちらかを外すために要る情報で、
 *   どちらの窓も既に人間がエージェントに預けている。
 */
export function describeSelectionFailure(
  failure: SelectionFailed,
  read: Pick<RegistryRead, "dirs" | "present">,
): string {
  const where = read.dirs.join(", ");
  switch (failure.reason) {
    case "no-entries":
      return [
        read.present
          ? `No VS Code window found. The runtime directory (${where}) has no registration. `
          : `No VS Code window found. The runtime directory (${where}) does not exist. `,
        "Check that the ShowMe extension is enabled and a window is open, and that ",
        "the agent and VS Code are in the same environment (same container / same WSL distro / ",
        "same $TMPDIR). ",
        // 候補の食い違いは「同じマシンにいるのに見つからない」の主な原因である。
        // 走査先を上に出しているので、人間は両側の値を突き合わせられる。
        "Also check that $XDG_RUNTIME_DIR does not differ between the extension and here ",
        "(if it is set on only one side, the two look in different places).",
      ].join("");
    case "version-mismatch":
      return [
        "The VS Code extension and this bridge speak different wire protocol versions ",
        `(this bridge is v${WIRE_PROTOCOL_VERSION}). `,
        "Bring both to the same version and reload the VS Code window.",
      ].join("");
    case "no-stage":
      return [
        `ShowMe is off in every VS Code window (${failure.idleCount} candidate window(s)). `,
        "Click ShowMe in the status bar of the window you want to use to turn it on ",
        "(if it says Stopped, resume it first).",
      ].join("");
    case "multiple-stages": {
      const named = failure.stages
        .map((s) => `${s.workspacePath === "" ? "(no folder)" : s.workspacePath} (${s.windowId})`)
        .join(", ");
      return [
        named === ""
          ? "ShowMe is on in more than one VS Code window. "
          : `ShowMe is on in more than one VS Code window: ${named}. `,
        "Use ShowMe in the status bar to turn it on in exactly one window.",
      ].join("");
    }
    case "exhausted":
      return [
        "None of the VS Code windows with ShowMe on responded. ",
        "A window may have just closed, leaving only its registration file behind.",
      ].join("");
  }
}

/** 実行時ディレクトリが衛生検査に落ちたときの言い方。使わずに止まる。 */
export function describeUnsafeRuntimeDir(reason: string, dir: string): string {
  return [
    `The runtime directory (${dir}) is not safe, so it will not be used: ${reason}. `,
    "Another process may have got there first. Its contents are left for a human to inspect, not deleted ",
    "(unchecked deletion in a shared directory would amount to arbitrary file deletion).",
  ].join("");
}
