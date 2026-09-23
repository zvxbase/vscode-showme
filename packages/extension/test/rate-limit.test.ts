import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TOOL_NAMES } from "@zvx/vscode-showme-protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  NO_CANONICAL_PATH_KEY,
  RateLimiter,
  UNNORMALIZED_PATH_KEY,
  fileRateLimitKey,
  panelCallLimiter,
} from "../src/rate-limit.js";
import { fileRateLimitCanonicalizer } from "../src/workspace-path-gate.js";

/**
 * レート制限の判断は vscode に依存しないので、ハンドラから切り出して
 * ここで直接確かめる。時計は注入する。正準化（realpath）は本物の
 * ファイルシステムに当てる — 別名を潰せているかは、実際にシンボリック
 * リンクを置いてみないと分からない。
 */

const made: string[] = [];
function tmpRoot(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "showme-rl-"));
  made.push(d);
  return d;
}
afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/**
 * ルートに縛った正準化。**`show-code.ts` / `annotate.ts` が実際に注入するもの**
 * （関門の口。偽物や生の `canonicalizeWorkspacePath` を渡すと、ここで見た鍵と
 * 本番の鍵が別物になる ―― 同じ量を2箇所で決める形）。
 */
function canonicalizer(root: string, patterns: readonly string[] = []) {
  return fileRateLimitCanonicalizer(root, patterns);
}

describe("fileRateLimitKey", () => {
  it("同じファイルを指す綴り替えが同じ鍵になる", () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, "config.txt"), "x");
    const key = canonicalizer(root);
    // 生のパスを鍵にすると、この4つが別々のバケットになり、綴り替えだけで
    // 制限を4倍にできる（設計書 §4.1 ⑦）。
    expect(fileRateLimitKey("config.txt", key)).toBe("config.txt");
    expect(fileRateLimitKey("./config.txt", key)).toBe("config.txt");
    expect(fileRateLimitKey(".//config.txt", key)).toBe("config.txt");
    expect(fileRateLimitKey("a/../config.txt", key)).toBe("config.txt");
  });

  it("バックスラッシュ区切りも同じ鍵になる", () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, "src", "app"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "app", "main.ts"), "x");
    const key = canonicalizer(root);
    expect(fileRateLimitKey("src\\app\\main.ts", key)).toBe("src/app/main.ts");
  });

  it("シンボリックリンク経由の別名も同じ鍵になる（綴りの正規化では潰せない）", () => {
    // 自己参照リンクを1本置くだけで、綴りは無限に作れる。
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, "t.txt"), "x");
    fs.symlinkSync(".", path.join(root, "s"));
    const key = canonicalizer(root);
    expect(fileRateLimitKey("t.txt", key)).toBe("t.txt");
    expect(fileRateLimitKey("s/t.txt", key)).toBe("t.txt");
    expect(fileRateLimitKey("s/s/t.txt", key)).toBe("t.txt");
    expect(fileRateLimitKey("s/s/s/s/s/t.txt", key)).toBe("t.txt");
  });

  it("自己参照リンクで綴りを変えても予算は共有される", () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, "t.txt"), "x");
    fs.symlinkSync(".", path.join(root, "s"));
    const key = canonicalizer(root);
    const limiter = new RateLimiter({ limit: 3, windowMs: 60_000 });

    // 綴りを毎回変えても、同じファイルなら同じ予算から引かれる。
    expect(limiter.allow(fileRateLimitKey("t.txt", key))).toBe(true);
    expect(limiter.allow(fileRateLimitKey("s/t.txt", key))).toBe(true);
    expect(limiter.allow(fileRateLimitKey("s/s/t.txt", key))).toBe(true);
    expect(limiter.allow(fileRateLimitKey("s/s/s/t.txt", key))).toBe(false);
    expect(limiter.allow(fileRateLimitKey("./s/s/s/s/t.txt", key))).toBe(false);
    // 追跡中の鍵は1本しか増えていない（鍵の上限を綴りで埋められない）。
    expect(limiter.trackedKeys()).toBe(1);
  });

  it("正規化できないパスは1つのバケットにまとめる", () => {
    const key = canonicalizer(tmpRoot());
    expect(fileRateLimitKey("/etc/passwd", key)).toBe(UNNORMALIZED_PATH_KEY);
    expect(fileRateLimitKey("../../.ssh/id_rsa", key)).toBe(UNNORMALIZED_PATH_KEY);
    expect(fileRateLimitKey(".env::$DATA", key)).toBe(UNNORMALIZED_PATH_KEY);
  });

  it("正準パスを得られないものも1つのバケットにまとめる", () => {
    // 実在しないパスの綴りを撒くだけで鍵の上限を埋められては、正当な呼び出しが
    // 巻き添えで落ちる。
    const root = tmpRoot();
    fs.symlinkSync(".", path.join(root, "s"));
    const key = canonicalizer(root);
    expect(fileRateLimitKey("nope.txt", key)).toBe(NO_CANONICAL_PATH_KEY);
    expect(fileRateLimitKey("s/nope.txt", key)).toBe(NO_CANONICAL_PATH_KEY);
    expect(fileRateLimitKey("s/s/s/nope.txt", key)).toBe(NO_CANONICAL_PATH_KEY);
    // 正準化を拒む（＝秘匿として弾いた）判定を渡した場合も同じ扱いになる。
    expect(fileRateLimitKey("a.txt", () => undefined)).toBe(NO_CANONICAL_PATH_KEY);
  });

  it("秘匿パスは、存在するかどうかで鍵が変わらない（鍵の分かれ方が存在のオラクルにならない）", () => {
    // 鍵は正準名で作る。秘匿の綴りに realpath を当てて正準名を鍵にすると、
    // `.env` が実在すれば専用の鍵、無ければ共有の鍵、と**制限に当たるかどうか**から
    // 存在が読める（関門に見つかったのと同じ形）。
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, ".env"), "SECRET=1");
    expect(fs.existsSync(path.join(root, ".env.nope"))).toBe(false);
    const key = canonicalizer(root);
    const existing = fileRateLimitKey(".env", key);
    const missing = fileRateLimitKey(".env.nope", key);
    expect(existing).toBe(missing);
    expect(existing).toBe(NO_CANONICAL_PATH_KEY);
    // 綴り替えでも専用の鍵は生えない。
    expect(fileRateLimitKey("./a/../.env", key)).toBe(NO_CANONICAL_PATH_KEY);
  });

  it("秘匿の綴りは root が無くても固定の鍵になる（realpath を当てないことの証明は関門の検査が持つ）", () => {
    // 正準化を差し替えられないので、存在しないディレクトリを root にして
    // 「realpath が投げても落ちずに共有の鍵で返る」ことで代替する。
    const key = canonicalizer("/nonexistent-root-showme-issue-17");
    expect(fileRateLimitKey(".env", key)).toBe(NO_CANONICAL_PATH_KEY);
  });

  it("秘匿パスへのシンボリックリンクも専用の鍵を持たない（実体で当てる）", () => {
    // `docs/harmless.txt -> .env`。綴りは無害なので第一の関門を通り、正準化して
    // `.env` に着く。ここで正準名を鍵にすると `.env` の専用の鍵が生える。
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, ".env"), "SECRET=1");
    fs.mkdirSync(path.join(root, "docs"));
    fs.symlinkSync(path.join(root, ".env"), path.join(root, "docs", "harmless.txt"));
    const key = canonicalizer(root);
    expect(fileRateLimitKey("docs/harmless.txt", key)).toBe(NO_CANONICAL_PATH_KEY);
  });

  it("設定で足した秘匿パターンも鍵に効く", () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, "secrets"));
    fs.writeFileSync(path.join(root, "secrets", "a.txt"), "x");
    const key = canonicalizer(root, ["secrets/**"]);
    expect(fileRateLimitKey("secrets/a.txt", key)).toBe(NO_CANONICAL_PATH_KEY);
    expect(fileRateLimitKey("secrets/nope.txt", key)).toBe(NO_CANONICAL_PATH_KEY);
  });

  it("まとめ先の鍵は正準パスとして到達できない", () => {
    // 正規化はコロンを含むパスを必ず拒否するので、実在のファイルが
    // これらの鍵に化けることはない（＝合法な要求が巻き添えにならない）。
    const key = canonicalizer(tmpRoot());
    for (const sentinel of [UNNORMALIZED_PATH_KEY, NO_CANONICAL_PATH_KEY]) {
      expect(sentinel).toContain(":");
      expect(fileRateLimitKey(sentinel, key)).toBe(UNNORMALIZED_PATH_KEY);
    }
  });
});

describe("RateLimiter", () => {
  const fixedClock = (at: { now: number }) => () => at.now;

  it("上限までは通し、超えたら落とす", () => {
    const at = { now: 0 };
    const limiter = new RateLimiter({ limit: 3, windowMs: 1000, now: fixedClock(at) });
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("a")).toBe(false);
  });

  it("鍵ごとに独立した予算を持つ", () => {
    const at = { now: 0 };
    const limiter = new RateLimiter({ limit: 1, windowMs: 1000, now: fixedClock(at) });
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("a")).toBe(false);
    expect(limiter.allow("b")).toBe(true);
  });

  it("窓を抜けた試行は数えない", () => {
    const at = { now: 0 };
    const limiter = new RateLimiter({ limit: 2, windowMs: 1000, now: fixedClock(at) });
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("a")).toBe(false);
    at.now = 1001;
    expect(limiter.allow("a")).toBe(true);
  });

  it("落とされた試行そのものは予算を消費しない", () => {
    // 拒否のたびに時刻を積むと、窓の端が押し出され続けて永久に開かなくなる。
    const at = { now: 0 };
    const limiter = new RateLimiter({ limit: 1, windowMs: 1000, now: fixedClock(at) });
    expect(limiter.allow("a")).toBe(true);
    at.now = 500;
    expect(limiter.allow("a")).toBe(false);
    at.now = 1001;
    expect(limiter.allow("a")).toBe(true);
  });

  it("追跡する鍵の数に上限があり、期限切れの鍵は掃除される", () => {
    const at = { now: 0 };
    const limiter = new RateLimiter({ limit: 5, windowMs: 1000, now: fixedClock(at), maxKeys: 2 });
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("b")).toBe(true);
    expect(limiter.trackedKeys()).toBe(2);
    at.now = 1001;
    // 掃除で a と b が落ちるので、c は新しい鍵として入れる
    expect(limiter.allow("c")).toBe(true);
    expect(limiter.trackedKeys()).toBe(1);
  });

  it("生きた鍵で埋まっているときは新しい鍵を通さない（fail closed）", () => {
    // 生きたバケットを追い出すと、鍵を撒くだけで自分の予算を初期化できる。
    // 追い出す代わりに落とす。落とされた側は "rate-limited" として画面に出る。
    const at = { now: 0 };
    const limiter = new RateLimiter({ limit: 5, windowMs: 1000, now: fixedClock(at), maxKeys: 2 });
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("b")).toBe(true);
    expect(limiter.allow("c")).toBe(false);
    // 既存の鍵は引き続き予算の範囲で通る
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.trackedKeys()).toBe(2);
  });
});

describe("パネル系の器は、鍵の数をツールの数から導出する", () => {
  it("すべてのツール名が同時に鍵を持てる", () => {
    // **数を直に書くと、ツールを足した人が直し忘れる。** 実際に増分3で
    // `find_locations` と `show_view` が足されて鍵が5つになったが、
    // `maxKeys` は 3 のままだった ―― `allow()` は超過した新しい鍵を
    // fail-closed で落とすので、4つ目以降のツールが自分の予算を1度も
    // 使わないまま拒否されていた（互いに飢えさせ合う）。
    const limiter = new RateLimiter({ limit: 1, windowMs: 60_000, maxKeys: TOOL_NAMES.length });
    for (const tool of TOOL_NAMES) {
      expect(limiter.allow(`key:${tool}`), tool).toBe(true);
    }
  });

  it("本番の器も、ツールの数だけ鍵を持てる", () => {
    panelCallLimiter.clear();
    for (const tool of TOOL_NAMES) {
      expect(panelCallLimiter.allow(`probe:${tool}`), tool).toBe(true);
    }
    panelCallLimiter.clear();
  });

  it("鍵の数を超えたら新しい鍵は落ちる（fail closed は残っている）", () => {
    // 追い出す形にすると、鍵を撒くだけで自分の予算を初期化できてしまう。
    const limiter = new RateLimiter({ limit: 5, windowMs: 60_000, maxKeys: 2 });
    expect(limiter.allow("a")).toBe(true);
    expect(limiter.allow("b")).toBe(true);
    expect(limiter.allow("c")).toBe(false);
    // 既にある鍵は使える。
    expect(limiter.allow("a")).toBe(true);
  });
});
