import { describe, expect, it } from "vitest";
import {
  ALL_ACCESS_RIGHTS,
  noForeignCreateVerdict,
  parseAccessRights,
  parseDacl,
  privateDirVerdict,
} from "./windows-acl.js";

/**
 * 入力は **Windows の実機で測った SDDL をそのまま**使う（設計 D104 の「調べて分かったこと」。
 * windows-latest の runner、2026-09-28）。runner の本人は RID 500 なので、`LA` は本人である。
 */
const RUNNER_SID = "S-1-5-21-3162555376-3447873500-144036907-500";

const DEFAULT_TEMP = "D:(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;LA)";
const LOCKED = "D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;LA)";
const SHARED =
  "D:AI(A;OICI;0x1301bf;;;BU)(A;ID;0x1301bf;;;AU)(A;OICIIOID;SDGXGWGR;;;AU)(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;0x1200a9;;;BU)";
const INSIDE_SHARED =
  "D:AI(A;OICIID;0x1301bf;;;BU)(A;ID;0x1301bf;;;AU)(A;OICIIOID;SDGXGWGR;;;AU)(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)";
const DRIVE_ROOT =
  "D:AI(A;;0x1000a1;;;S-1-15-3-65536-1888954469-739942743-1668119174-2468466756-4239452838-1296943325-355587736-700089176)(A;;LC;;;AU)(A;OICIIO;SDGXGWGR;;;AU)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)S:PAI(ML;OINPIO;NW;;;HI)";
const USERS =
  "D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;0x1200a9;;;BU)(A;OICIIO;GXGR;;;BU)(A;;0x1200a9;;;WD)(A;OICIIO;GXGR;;;WD)(A;;0x100021;;;S-1-15-3-65536-4045685566-1323397456-4055816110-285687253-194181-4019357623-1925838800-191844675)S:AINO_ACCESS_CONTROL";
const WINDOWS_TEMP =
  "D:AI(A;;FA;;;BU)(A;ID;FA;;;S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464)(A;CIIOID;GA;;;S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464)(A;ID;FA;;;SY)(A;OICIIOID;GA;;;SY)(A;ID;FA;;;BA)(A;OICIIOID;GA;;;BA)(A;ID;0x1200a9;;;BU)(A;OICIIOID;GXGR;;;BU)(A;OICIIOID;GA;;;CO)(A;ID;0x1200a9;;;AC)(A;OICIIOID;GXGR;;;AC)(A;ID;0x1200a9;;;S-1-15-2-2)(A;OICIIOID;GXGR;;;S-1-15-2-2)";

const STANDARD_SID = "S-1-5-21-1-2-3-1003";

describe("実機の SDDL の表（D104）", () => {
  const table: ReadonlyArray<
    readonly [name: string, sddl: string, self: string, privateDir: boolean, noForeign: boolean]
  > = [
    ["既定の %TEMP%", DEFAULT_TEMP, RUNNER_SID, true, true],
    ["締めた後", LOCKED, RUNNER_SID, true, true],
    ["共有フォルダ", SHARED, RUNNER_SID, false, false],
    ["共有フォルダの中に作ったディレクトリ", INSIDE_SHARED, RUNNER_SID, false, false],
    ["C:\\（AU に LC = 0x4 がこのオブジェクトに効く）", DRIVE_ROOT, RUNNER_SID, false, false],
    ["C:\\Users（他人は読み・実行だけ）", USERS, RUNNER_SID, false, true],
    ["C:\\Windows\\Temp", WINDOWS_TEMP, RUNNER_SID, false, false],
    [
      "ふつうの利用者が本人の SID で締めたもの",
      `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;${STANDARD_SID})`,
      STANDARD_SID,
      true,
      true,
    ],
  ];

  for (const [name, sddl, self, privateDir, noForeign] of table) {
    it(`${name}: privateDir=${privateDir} noForeignCreate=${noForeign}`, () => {
      expect(privateDirVerdict(sddl, self).ok).toBe(privateDir);
      expect(noForeignCreateVerdict(sddl, self).ok).toBe(noForeign);
    });
  }

  it("落ちた理由は英語で、違反した主体を名指す", () => {
    const shared = privateDirVerdict(SHARED, RUNNER_SID);
    expect(shared.ok).toBe(false);
    if (!shared.ok) expect(shared.reason).toContain("BU");
    const root = noForeignCreateVerdict(DRIVE_ROOT, RUNNER_SID);
    expect(root.ok).toBe(false);
    if (!root.ok) expect(root.reason).toContain("AU");
    const temp = noForeignCreateVerdict(WINDOWS_TEMP, RUNNER_SID);
    expect(temp.ok).toBe(false);
    if (!temp.ok) expect(temp.reason).toContain("BU");
  });
});

describe("信頼する主体", () => {
  it("LA は本人の RID が 500 のときだけ信頼する", () => {
    // 既定の %TEMP% の形でも、本人がふつうの利用者なら LA は他人である。
    expect(privateDirVerdict(DEFAULT_TEMP, STANDARD_SID).ok).toBe(false);
    expect(noForeignCreateVerdict(DEFAULT_TEMP, STANDARD_SID).ok).toBe(false);
    const r = privateDirVerdict(DEFAULT_TEMP, STANDARD_SID);
    if (!r.ok) expect(r.reason).toContain("LA");
  });

  it("SY / BA は別名でも SID でも信頼する", () => {
    const sddl = `D:P(A;OICI;FA;;;S-1-5-18)(A;OICI;FA;;;S-1-5-32-544)(A;OICI;FA;;;${STANDARD_SID})`;
    expect(privateDirVerdict(sddl, STANDARD_SID).ok).toBe(true);
    expect(noForeignCreateVerdict(sddl, STANDARD_SID).ok).toBe(true);
  });

  it("SID は完全一致で比べる（前方一致ではない）", () => {
    const sddl = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;S-1-5-21-1-2-3-10030)";
    expect(privateDirVerdict(sddl, STANDARD_SID).ok).toBe(false);
    expect(noForeignCreateVerdict(sddl, STANDARD_SID).ok).toBe(false);
    const shorter = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;S-1-5-21-1-2-3-100)";
    expect(privateDirVerdict(shorter, STANDARD_SID).ok).toBe(false);
  });

  it("本人の SID の綴りが SID でなければ閉じる", () => {
    expect(privateDirVerdict(LOCKED, "").ok).toBe(false);
    expect(privateDirVerdict(LOCKED, "WD").ok).toBe(false);
    expect(noForeignCreateVerdict(LOCKED, "not-a-sid").ok).toBe(false);
  });

  it("本人の RID 500 は LA の別名にも SID にも効く", () => {
    const sddl = `D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;${RUNNER_SID})`;
    expect(privateDirVerdict(sddl, RUNNER_SID).ok).toBe(true);
  });

  it("他の別名（WD・AU・BU・CO・OW など）は信頼しない", () => {
    for (const alias of ["WD", "AU", "BU", "CO", "OW", "IU", "AN", "PS"]) {
      expect(privateDirVerdict(`D:P(A;;FR;;;${alias})`, STANDARD_SID).ok, alias).toBe(false);
    }
  });
});

describe("privateDirVerdict", () => {
  it("継承専用（IO）の許可も数える（中身に効く）", () => {
    const sddl = `D:P(A;OICI;FA;;;${STANDARD_SID})(A;OICIIO;GR;;;BU)`;
    expect(privateDirVerdict(sddl, STANDARD_SID).ok).toBe(false);
  });

  it("権利の中身は問わない（読めるだけでも落とす）", () => {
    const sddl = `D:P(A;OICI;FA;;;${STANDARD_SID})(A;;0x1;;;WD)`;
    expect(privateDirVerdict(sddl, STANDARD_SID).ok).toBe(false);
  });

  it("拒否の ACE は数えない", () => {
    const sddl = `D:P(D;OICI;FA;;;WD)(OD;;FA;;;AU)(A;OICI;FA;;;${STANDARD_SID})`;
    expect(privateDirVerdict(sddl, STANDARD_SID).ok).toBe(true);
    expect(noForeignCreateVerdict(sddl, STANDARD_SID).ok).toBe(true);
  });

  it("OA は許可として扱う", () => {
    const sddl = `D:P(A;OICI;FA;;;${STANDARD_SID})(OA;;FR;;;WD)`;
    expect(privateDirVerdict(sddl, STANDARD_SID).ok).toBe(false);
    const trusted = `D:P(A;OICI;FA;;;${STANDARD_SID})(OA;;FR;;;SY)`;
    expect(privateDirVerdict(trusted, STANDARD_SID).ok).toBe(true);
  });

  it("条件付き・コールバックの ACE（X* / Z*）は主体を問わず閉じる", () => {
    // 条件式は引用符の中に括弧を持てるので、深さを数える読み方がずれる（レビューの所見）。
    // 条件式を読まずに、型だけで閉じる。
    for (const ace of [
      "(XA;;FA;;;SY)",
      "(ZA;;FA;;;SY)",
      "(XD;;FA;;;WD)",
      "(XU;;FA;;;SY)",
      "(ZQ;;FA;;;SY)",
      "(XA;;FA;;;SY;(Member_of {SID(BA)}))",
    ]) {
      const sddl = `D:P(A;OICI;FA;;;${STANDARD_SID})${ace}`;
      expect(privateDirVerdict(sddl, STANDARD_SID).ok, ace).toBe(false);
      expect(noForeignCreateVerdict(sddl, STANDARD_SID).ok, ace).toBe(false);
    }
  });

  it("引用符の中の括弧で読みをずらす SDDL は閉じる（レビューの所見の入力）", () => {
    for (const sddl of [
      'D:P(XA;;FR;;;SY;(@User.x == "("))(A;;FA;;;WD)(XA;;FR;;;SY;(@User.y == ")"))',
      'D:P(XD;;FR;;;SY;(@User.x == "("))(A;;FA;;;WD)(XD;;FR;;;SY;(@User.y == ")"))',
      `D:P(A;OICI;FA;;;${STANDARD_SID})(XA;;FR;;;SY;(@User.x == "("))S:(AU;SA;FA;;;WD)(XA;;FR;;;SY;(@User.y == ")"))(A;;FA;;;WD)`,
      `D:P(A;OICI;FA;;;${STANDARD_SID})S:(AU;SA;FA;;;"x")`,
    ]) {
      expect(privateDirVerdict(sddl, STANDARD_SID).ok, sddl).toBe(false);
      expect(noForeignCreateVerdict(sddl, STANDARD_SID).ok, sddl).toBe(false);
    }
  });

  it("欄が6つより多い ACE は壊れたものとして閉じる", () => {
    for (const ace of ["(A;;FR;;;SY;junk)", "(OA;;FA;;;SY;;WD)", "(A;;FA;;;SY;)"]) {
      const sddl = `D:P(A;OICI;FA;;;${STANDARD_SID})${ace}`;
      expect(privateDirVerdict(sddl, STANDARD_SID).ok, ace).toBe(false);
      expect(noForeignCreateVerdict(sddl, STANDARD_SID).ok, ace).toBe(false);
    }
  });

  it("分からない型の ACE は閉じる", () => {
    const sddl = `D:P(A;OICI;FA;;;${STANDARD_SID})(QQ;;FA;;;SY)`;
    expect(privateDirVerdict(sddl, STANDARD_SID).ok).toBe(false);
    expect(noForeignCreateVerdict(sddl, STANDARD_SID).ok).toBe(false);
  });

  it("読めない ACE（欄が足りない）は閉じる", () => {
    const sddl = `D:P(A;OICI;FA;;;${STANDARD_SID})(A;;FA)`;
    expect(privateDirVerdict(sddl, STANDARD_SID).ok).toBe(false);
    expect(noForeignCreateVerdict(sddl, STANDARD_SID).ok).toBe(false);
  });

  it("空の DACL（D: だけ）は誰にも許さないので通す", () => {
    expect(privateDirVerdict("D:", STANDARD_SID).ok).toBe(true);
    expect(noForeignCreateVerdict("D:", STANDARD_SID).ok).toBe(true);
    expect(privateDirVerdict("D:PAI", STANDARD_SID).ok).toBe(true);
    expect(privateDirVerdict("D:PS:PAI(ML;OINPIO;NW;;;HI)", STANDARD_SID).ok).toBe(true);
  });

  it("NULL DACL（NO_ACCESS_CONTROL）は全員に全部を許すので落とす", () => {
    expect(privateDirVerdict("D:NO_ACCESS_CONTROL", STANDARD_SID).ok).toBe(false);
    expect(noForeignCreateVerdict("D:NO_ACCESS_CONTROL", STANDARD_SID).ok).toBe(false);
    expect(noForeignCreateVerdict("D:NO_ACCESS_CONTROLS:PAI", STANDARD_SID).ok).toBe(false);
  });

  it("S: の側の NO_ACCESS_CONTROL は DACL ではない（C:\\Users の形）", () => {
    expect(noForeignCreateVerdict(USERS, RUNNER_SID).ok).toBe(true);
  });

  it("S: より後ろの ACE は数えない", () => {
    const sddl = `D:P(A;OICI;FA;;;${STANDARD_SID})S:(AU;SA;FA;;;WD)`;
    expect(privateDirVerdict(sddl, STANDARD_SID).ok).toBe(true);
  });

  it("O: / G: が前に在っても DACL を見つける", () => {
    const sddl = `O:BAG:SYD:P(A;OICI;FA;;;${STANDARD_SID})(A;;FR;;;WD)`;
    expect(privateDirVerdict(sddl, STANDARD_SID).ok).toBe(false);
    const ok = `O:BAG:SYD:P(A;OICI;FA;;;${STANDARD_SID})`;
    expect(privateDirVerdict(ok, STANDARD_SID).ok).toBe(true);
  });

  it("前後の空白・改行は無視する（icacls の出力の行）", () => {
    expect(privateDirVerdict(`  ${LOCKED}\r\n`, RUNNER_SID).ok).toBe(true);
  });
});

describe("壊れた SDDL は閉じる", () => {
  const broken: ReadonlyArray<readonly [string, string]> = [
    ["空文字", ""],
    ["D: が無い", "S:PAI(ML;OINPIO;NW;;;HI)"],
    ["D: が無い（ACE だけ）", `(A;OICI;FA;;;${STANDARD_SID})`],
    ["括弧が閉じない", `D:P(A;OICI;FA;;;${STANDARD_SID}`],
    ["閉じ括弧が余る", `D:P(A;OICI;FA;;;${STANDARD_SID}))`],
    ["ACE の間にゴミ", `D:P(A;OICI;FA;;;${STANDARD_SID})x(A;;FA;;;SY)`],
    ["分からない DACL の旗", `D:ZZ(A;OICI;FA;;;${STANDARD_SID})`],
    ["D: が2つ", `D:P(A;OICI;FA;;;${STANDARD_SID})D:(A;;FA;;;WD)`],
  ];
  for (const [name, sddl] of broken) {
    it(name, () => {
      expect(privateDirVerdict(sddl, STANDARD_SID).ok).toBe(false);
      expect(noForeignCreateVerdict(sddl, STANDARD_SID).ok).toBe(false);
    });
  }

  it("括弧の中の D: は区切りと読まない（入れ子の括弧は壊れた ACE として閉じる）", () => {
    // 条件式の中身に "D:" が現れても DACL の始まりにはならない。その ACE 自体は
    // 欄が多すぎ・型が条件付きなので閉じる。区切りと読み違えて2つ目の D: と見なしても閉じる。
    const sddl = `D:P(A;OICI;FA;;;${STANDARD_SID})(XA;;FR;;;SY;(@User.D:x))`;
    expect(parseDacl(sddl)?.aces.length).toBe(2);
    expect(privateDirVerdict(sddl, STANDARD_SID).ok).toBe(false);
  });
});

describe("noForeignCreateVerdict", () => {
  const foreignWith = (rights: string, flags = ""): string =>
    `D:P(A;OICI;FA;;;${STANDARD_SID})(A;${flags};${rights};;;BU)`;

  it("作成・削除・権限変更の権利を他人に許していれば落とす", () => {
    for (const rights of [
      "0x2",
      "0x4",
      "0x40",
      "0x10000",
      "0x40000",
      "0x80000",
      "0x10000000",
      "0x40000000",
      "FA",
      "FW",
      "GA",
      "GW",
      "SD",
      "WD",
      "WO",
      "DC",
      "LC",
      "DT",
      "SDGXGWGR",
    ]) {
      expect(noForeignCreateVerdict(foreignWith(rights), STANDARD_SID).ok, rights).toBe(false);
    }
  });

  it("読み・実行だけなら通す（両方向）", () => {
    for (const rights of [
      "FR",
      "FX",
      "GR",
      "GX",
      "RC",
      "GXGR",
      "0x1200a9",
      "0x100021",
      "0x1000a1",
      "CCSWRPWPLOCR",
    ]) {
      expect(noForeignCreateVerdict(foreignWith(rights), STANDARD_SID).ok, rights).toBe(true);
    }
  });

  it("IO でない継承（ID だけ）はこのオブジェクトに効く", () => {
    expect(noForeignCreateVerdict(foreignWith("GA", "ID"), STANDARD_SID).ok).toBe(false);
  });

  it("子に継承される（OI / CI）書き込みの権利も落とす（作ってから締めるまでの間に効く）", () => {
    for (const flags of ["OICIIO", "OICIIOID", "CIIO", "OIIO", "CI", "OI"]) {
      expect(noForeignCreateVerdict(foreignWith("GA", flags), STANDARD_SID).ok, flags).toBe(false);
    }
    expect(noForeignCreateVerdict("D:(A;CIIO;FA;;;WD)", STANDARD_SID).ok).toBe(false);
  });

  it("子に継承される読み・実行だけの許可は通す（C:\\Users の形）", () => {
    expect(noForeignCreateVerdict(foreignWith("GXGR", "OICIIO"), STANDARD_SID).ok).toBe(true);
    expect(noForeignCreateVerdict(foreignWith("FR", "OICI"), STANDARD_SID).ok).toBe(true);
  });

  it("どこにも継承されない継承専用（IO だけ）は数えない", () => {
    expect(noForeignCreateVerdict(foreignWith("GA", "IO"), STANDARD_SID).ok).toBe(true);
  });

  it("CREATOR OWNER の継承専用は作った本人に置き換わるので数えない", () => {
    expect(noForeignCreateVerdict("D:(A;OICIIO;GA;;;CO)(A;OICI;FA;;;SY)", STANDARD_SID).ok).toBe(
      true,
    );
    expect(
      noForeignCreateVerdict("D:(A;OICIIO;GA;;;S-1-3-0)(A;OICI;FA;;;SY)", STANDARD_SID).ok,
    ).toBe(true);
    // IO でない CO はこのオブジェクトに効く ACE として他人扱い。
    expect(noForeignCreateVerdict("D:(A;OICI;GA;;;CO)(A;OICI;FA;;;SY)", STANDARD_SID).ok).toBe(
      false,
    );
    // 実行時ディレクトリの判定では CO も他人（締めた DACL に CO は無い）。
    expect(privateDirVerdict("D:(A;OICIIO;GA;;;CO)(A;OICI;FA;;;SY)", STANDARD_SID).ok).toBe(false);
  });

  it("読めない旗は、このオブジェクトに効くものとして扱う", () => {
    expect(noForeignCreateVerdict(foreignWith("GA", "OIXIO"), STANDARD_SID).ok).toBe(false);
  });

  it("読めない権利の書き方は全部の権利として扱う", () => {
    for (const rights of ["ZZ", "FAX", "0x", "0xZZ", "123", "0x123456789", "fa"]) {
      expect(noForeignCreateVerdict(foreignWith(rights), STANDARD_SID).ok, rights).toBe(false);
    }
  });

  it("16進は大小を問わず、0X の接頭辞も読む", () => {
    expect(noForeignCreateVerdict(foreignWith("0X1200A9"), STANDARD_SID).ok).toBe(true);
    expect(noForeignCreateVerdict(foreignWith("0x1301BF"), STANDARD_SID).ok).toBe(false);
  });

  it("信頼する主体への許可は権利を問わない", () => {
    expect(noForeignCreateVerdict(LOCKED, RUNNER_SID).ok).toBe(true);
  });
});

describe("所有者（O:）", () => {
  it("在るなら信頼する主体でなければ閉じる", () => {
    expect(privateDirVerdict("O:WDG:WDD:P(A;;FA;;;SY)", STANDARD_SID).ok).toBe(false);
    expect(noForeignCreateVerdict("O:WDG:WDD:P(A;;FA;;;SY)", STANDARD_SID).ok).toBe(false);
    expect(privateDirVerdict("O:S-1-5-21-1-2-3-10030D:P(A;;FA;;;SY)", STANDARD_SID).ok).toBe(false);
    expect(privateDirVerdict("O:LAD:P(A;;FA;;;SY)", STANDARD_SID).ok).toBe(false);
  });

  it("信頼する所有者は通す（両方向）", () => {
    for (const owner of ["BA", "SY", "S-1-5-18", "S-1-5-32-544", STANDARD_SID]) {
      const sddl = `O:${owner}D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;${STANDARD_SID})`;
      expect(privateDirVerdict(sddl, STANDARD_SID).ok, owner).toBe(true);
      expect(noForeignCreateVerdict(sddl, STANDARD_SID).ok, owner).toBe(true);
    }
    expect(privateDirVerdict("O:LAD:P(A;;FA;;;SY)", RUNNER_SID).ok).toBe(true);
  });

  it("読めない所有者（空）は閉じる", () => {
    expect(privateDirVerdict("O:D:P(A;;FA;;;SY)", STANDARD_SID).ok).toBe(false);
  });
});

describe("parseAccessRights", () => {
  it("別名の値", () => {
    expect(parseAccessRights("FA")).toBe(0x1f01ff);
    expect(parseAccessRights("FR")).toBe(0x120089);
    expect(parseAccessRights("FW")).toBe(0x120116);
    expect(parseAccessRights("FX")).toBe(0x1200a0);
    expect(parseAccessRights("GA")).toBe(0x10000000);
    expect(parseAccessRights("GR")).toBe(0x80000000);
    expect(parseAccessRights("GW")).toBe(0x40000000);
    expect(parseAccessRights("GX")).toBe(0x20000000);
    expect(parseAccessRights("SDGXGWGR")).toBe(
      (0x10000 | 0x20000000 | 0x40000000 | 0x80000000) >>> 0,
    );
    expect(parseAccessRights("LC")).toBe(0x4);
  });

  it("16進", () => {
    expect(parseAccessRights("0x1301bf")).toBe(0x1301bf);
    expect(parseAccessRights("0XFFFFFFFF")).toBe(0xffffffff);
  });

  it("読めないものは全部の権利", () => {
    expect(parseAccessRights("")).toBe(ALL_ACCESS_RIGHTS);
    expect(parseAccessRights("F")).toBe(ALL_ACCESS_RIGHTS);
    expect(parseAccessRights("KA")).toBe(ALL_ACCESS_RIGHTS);
  });
});

describe("parseDacl", () => {
  it("ACE の型・旗・主体を取り出す", () => {
    const dacl = parseDacl(DRIVE_ROOT);
    expect(dacl?.nullDacl).toBe(false);
    expect(dacl?.aces.length).toBe(6);
    expect(dacl?.aces[1]).toMatchObject({ type: "A", flags: "", rights: 0x4, sid: "AU" });
    expect(dacl?.aces[2]).toMatchObject({ type: "A", flags: "OICIIO", sid: "AU" });
  });

  it("壊れていれば undefined", () => {
    expect(parseDacl("nope")).toBeUndefined();
  });
});
