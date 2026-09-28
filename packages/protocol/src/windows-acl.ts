/**
 * Windows の実行時ディレクトリを DACL で確かめる判定（D104）。
 *
 * POSIX の「所有者が自分・0700」に当たるものを、`icacls /save` が書き出す SDDL で確かめる。
 * **拡張とブリッジが同じ関数を通す**（不変条件14）。ここは純関数だけで、SDDL を読む I/O は
 * 別のモジュールが持つ。
 *
 * **閉じる側に倒す。** 読めない SDDL・読めない ACE・分からない型・分からない権利の書き方は、
 * どれも「安全でない」の側に数える。Administrators と SYSTEM は、そもそも何でもできるので
 * 守る相手ではない（POSIX の root と同じ）。
 */

export type AclVerdict = { ok: true } | { ok: false; reason: string };

export interface DaclAce {
  /** ACE の型（`A`・`D`・`OA` など）。 */
  type: string;
  /** 継承の旗（`OICIIOID` など）。 */
  flags: string;
  /** 権利のマスク。読めない書き方は `ALL_ACCESS_RIGHTS`。 */
  rights: number;
  /** 主体（SDDL の2文字の別名か `S-1-...`）。 */
  sid: string;
}

export interface ParsedDacl {
  /** 所有者（`O:` の節）。節が無ければ `undefined`（`icacls /save` は所有者を出さない）。 */
  owner: string | undefined;
  /** `NO_ACCESS_CONTROL`（NULL DACL）。全員に全部を許す。 */
  nullDacl: boolean;
  /** ACE。欄がちょうど6つでない ACE は `undefined` で残す（判定が閉じる側に数える）。 */
  aces: ReadonlyArray<DaclAce | undefined>;
}

/** 読めない権利の書き方に当てるマスク（全部の権利）。 */
export const ALL_ACCESS_RIGHTS = 0xffffffff;

/**
 * 権利の別名。ファイル（`F*`）・汎用（`G*`）・標準（`SD` `RC` `WD` `WO`）・ディレクトリサービス系の
 * 2文字（ファイルのディレクトリでは同じビットが `FILE_ADD_FILE` などに当たる）。
 * ここに無い別名（レジストリの `K*`・ラベルの `N*` など）は読めないものとして全部の権利に数える。
 */
const RIGHT_ALIASES: ReadonlyMap<string, number> = new Map([
  ["GA", 0x10000000],
  ["GR", 0x80000000],
  ["GW", 0x40000000],
  ["GX", 0x20000000],
  ["SD", 0x00010000],
  ["RC", 0x00020000],
  ["WD", 0x00040000],
  ["WO", 0x00080000],
  ["FA", 0x001f01ff],
  ["FR", 0x00120089],
  ["FW", 0x00120116],
  ["FX", 0x001200a0],
  ["CC", 0x00000001],
  ["DC", 0x00000002],
  ["LC", 0x00000004],
  ["SW", 0x00000008],
  ["RP", 0x00000010],
  ["WP", 0x00000020],
  ["DT", 0x00000040],
  ["LO", 0x00000080],
  ["CR", 0x00000100],
]);

/**
 * 親に他人が持っていてはいけない権利（作成・削除・権限変更）。
 * `FILE_ADD_FILE` 0x2・`FILE_ADD_SUBDIRECTORY` 0x4・`FILE_DELETE_CHILD` 0x40・`DELETE`・
 * `WRITE_DAC`・`WRITE_OWNER`・`GENERIC_ALL`・`GENERIC_WRITE`。
 */
const FOREIGN_CREATE_RIGHTS =
  0x2 | 0x4 | 0x40 | 0x00010000 | 0x00040000 | 0x00080000 | 0x10000000 | 0x40000000;

/** 許可の型。 */
const ALLOW_TYPES = new Set(["A", "OA"]);
/** 拒否の型。判定では数えない（拒否を当てにしない側 ―― 閉じる側 ―― に倒れる）。 */
const DENY_TYPES = new Set(["D", "OD"]);
/**
 * 条件付き・コールバックの型（`XA` `XD` `ZA` など）。主体を問わず閉じる。条件式は引用符の中に
 * 括弧を持てるので、括弧の深さで ACE を切る読み方がずれうる。条件式を正しく読む代わりに、
 * 実行時ディレクトリにも `%TEMP%` にも現れないこの型を丸ごと断る。
 */
const CONDITIONAL_TYPE = /^[XZ]/;

/** CREATOR OWNER。継承専用の ACE では、子を作った本人に置き換わる。 */
const CREATOR_OWNER = new Set(["CO", "S-1-3-0"]);

/** ACE の継承の旗（2文字ずつ）。 */
const ACE_FLAGS = new Set(["OI", "CI", "NP", "IO", "ID", "SA", "FA", "TP", "CR"]);

/** SDDL の DACL の旗。 */
const DACL_FLAG = /^(?:P|AI|AR|NO_ACCESS_CONTROL)*/;
/** 最上位の節の始まり（所有者・グループ・DACL・SACL）。 */
const SECTION_START = /^[OGDS]:/;

const SID_STRING = /^S-1-\d+(?:-\d+)+$/;

/**
 * 権利の書き方を読む。別名の連結（`SDGXGWGR`）か 16 進（`0x` / `0X` と 1〜8 桁）。
 * 読めないものは全部の権利として返す（閉じる側）。
 */
export function parseAccessRights(text: string): number {
  if (/^0[xX][0-9a-fA-F]{1,8}$/.test(text)) return Number.parseInt(text.slice(2), 16) >>> 0;
  if (text.length === 0 || text.length % 2 !== 0) return ALL_ACCESS_RIGHTS;
  let mask = 0;
  for (let i = 0; i < text.length; i += 2) {
    const value = RIGHT_ALIASES.get(text.slice(i, i + 2));
    if (value === undefined) return ALL_ACCESS_RIGHTS;
    mask = (mask | value) >>> 0;
  }
  return mask;
}

/**
 * SDDL の最上位を、括弧の深さを数えながら節に分ける。
 * 条件付き ACE の中身は括弧を入れ子にし、`D:` のような綴りも含みうるので、
 * 深さ 0 の位置だけを区切りとして読む。読めなければ `undefined`。
 */
function splitSections(sddl: string): Map<string, string> | undefined {
  // 引用符は条件式の文字列だけに現れ、その中の括弧で深さの数え方がずれる。読まずに閉じる。
  if (sddl.includes('"')) return undefined;
  const sections = new Map<string, string>();
  let i = 0;
  while (i < sddl.length) {
    if (!SECTION_START.test(sddl.slice(i, i + 2))) return undefined;
    const name = sddl.charAt(i);
    if (sections.has(name)) return undefined;
    let j = i + 2;
    let depth = 0;
    while (j < sddl.length) {
      const c = sddl.charAt(j);
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth < 0) return undefined;
      } else if (depth === 0 && SECTION_START.test(sddl.slice(j, j + 2))) {
        // 旗の中の文字（`NO_ACCESS_CONTROL` の `S` など）は ":" を伴わないので区切りにならない。
        break;
      }
      j++;
    }
    if (depth !== 0) return undefined;
    sections.set(name, sddl.slice(i + 2, j));
    i = j;
  }
  return sections;
}

/**
 * ACE の中身（括弧の内側）を読む。欄がちょうど6つでなければ `undefined`。
 * 7欄目（条件式）を持てるのは条件付きの型だけで、それは判定が断るので、読み飛ばす必要が無い。
 * 余った欄を黙って捨てると、読めていないものを読めたことにする。
 */
function parseAce(body: string): DaclAce | undefined {
  const fields = body.split(";");
  if (fields.length !== 6) return undefined;
  const [type, flags, rights, , , sid] = fields as [string, string, string, string, string, string];
  if (type.length === 0 || sid.length === 0) return undefined;
  return { type, flags, rights: parseAccessRights(rights), sid };
}

/**
 * SDDL の DACL を読む（`D:` の後ろ、最上位の次の節か終わりまで）。
 * `D:` が無い・括弧が閉じない・ACE の間に別の字がある・分からない旗は `undefined`。
 */
export function parseDacl(sddl: string): ParsedDacl | undefined {
  const sections = splitSections(sddl.trim());
  if (sections === undefined) return undefined;
  const dacl = sections.get("D");
  if (dacl === undefined) return undefined;
  const owner = sections.get("O");

  const flags = DACL_FLAG.exec(dacl)?.[0] ?? "";
  const nullDacl = flags.includes("NO_ACCESS_CONTROL");
  const aces: Array<DaclAce | undefined> = [];
  let i = flags.length;
  while (i < dacl.length) {
    if (dacl.charAt(i) !== "(") return undefined;
    let depth = 0;
    let j = i;
    for (; j < dacl.length; j++) {
      const c = dacl.charAt(j);
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) return undefined;
    aces.push(parseAce(dacl.slice(i + 1, j)));
    i = j + 1;
  }
  return { owner, nullDacl, aces };
}

/** ACE の旗を2文字ずつ読む。分からない旗が混じれば `undefined`。 */
function parseAceFlags(flags: string): Set<string> | undefined {
  if (flags.length % 2 !== 0) return undefined;
  const tokens = new Set<string>();
  for (let i = 0; i < flags.length; i += 2) {
    const token = flags.slice(i, i + 2);
    if (!ACE_FLAGS.has(token)) return undefined;
    tokens.add(token);
  }
  return tokens;
}

/**
 * 信頼する主体か。本人の SID（完全一致）、SYSTEM、Administrators、
 * そして本人の RID が 500 のときだけ `LA`（その機械の組み込みの Administrator）。
 * `LA` が本人とは限らない（本人がドメインの RID 500 なら別のアカウント）が、組み込みの
 * Administrator は Administrators の一員なので、`BA` を信頼する以上、信頼しても守りは減らない。
 * RID 500 に限るのは、既定の `%TEMP%` の DACL が本人を `LA` の別名で書くのがその場合だけだから。
 * それ以外の別名はすべて他人として扱う。
 */
function isTrusted(sid: string, selfSid: string): boolean {
  if (sid === selfSid) return true;
  if (sid === "SY" || sid === "S-1-5-18") return true;
  if (sid === "BA" || sid === "S-1-5-32-544") return true;
  if (sid === "LA" && selfSid.split("-").pop() === "500") return true;
  return false;
}

type AceCheck = (ace: DaclAce) => string | undefined;

/** 2つの判定に共通の骨組み。読めないものは閉じ、許可の ACE だけを `check` に渡す。 */
function verdict(sddl: string, selfSid: string, check: AceCheck): AclVerdict {
  if (!SID_STRING.test(selfSid)) {
    return { ok: false, reason: "The current user's SID is not a valid SID string" };
  }
  const dacl = parseDacl(sddl);
  if (dacl === undefined)
    return { ok: false, reason: "The security descriptor could not be parsed" };
  if (dacl.owner !== undefined && !isTrusted(dacl.owner, selfSid)) {
    return {
      ok: false,
      reason: `The directory is owned by another principal ${dacl.owner || "(empty)"}`,
    };
  }
  if (dacl.nullDacl) {
    return {
      ok: false,
      reason: "The directory has no access control (NULL DACL): everyone has full access",
    };
  }
  for (const ace of dacl.aces) {
    if (ace === undefined)
      return { ok: false, reason: "The DACL has an entry that could not be parsed" };
    if (CONDITIONAL_TYPE.test(ace.type)) {
      return {
        ok: false,
        reason: `The DACL has a conditional or callback entry of type ${ace.type}`,
      };
    }
    if (DENY_TYPES.has(ace.type)) continue;
    if (!ALLOW_TYPES.has(ace.type)) {
      return { ok: false, reason: `The DACL has an entry of unknown type ${ace.type}` };
    }
    if (isTrusted(ace.sid, selfSid)) continue;
    const problem = check(ace);
    if (problem !== undefined) return { ok: false, reason: problem };
  }
  return { ok: true };
}

const hex = (mask: number): string => `0x${mask.toString(16)}`;

/**
 * 実行時ディレクトリ用。許可の ACE がすべて信頼する主体に向いていること。
 * 権利の中身は問わない（読めるだけでもトークンが漏れる）。継承専用の ACE も
 * このディレクトリの中身に効くので数える。
 */
export function privateDirVerdict(sddl: string, selfSid: string): AclVerdict {
  return verdict(
    sddl,
    selfSid,
    (ace) =>
      `The directory grants access (rights ${hex(ace.rights)}) to another principal ${ace.sid}`,
  );
}

/**
 * 親（`%TEMP%` など）用。他人への許可が、作成・削除・権限変更の権利を
 * - このオブジェクト自身に持たないこと（継承専用でない ACE）。親に他人が作れなければ、その下の
 *   実行時ディレクトリを他人が作ったり差し替えたりできない ―― `icacls` が出さない所有者の検査の代わり
 * - 子に継承させないこと（`OI` / `CI`。継承専用も含む）。実行時ディレクトリは作った直後、締める前に
 *   親の継承する ACE を受け取るので、その間に他人が中に置けたり権限を変えたりできる
 *
 * 継承専用の CREATOR OWNER だけは数えない（子を作った本人に置き換わる）。旗が読めなければ、
 * このオブジェクトに効くものとして扱う。
 */
export function noForeignCreateVerdict(sddl: string, selfSid: string): AclVerdict {
  return verdict(sddl, selfSid, (ace) => {
    if ((ace.rights & FOREIGN_CREATE_RIGHTS) === 0) return undefined;
    const flags = parseAceFlags(ace.flags);
    const rights = hex(ace.rights);
    if (flags === undefined || !flags.has("IO")) {
      return `Another principal ${ace.sid} may create, delete or change permissions of entries in the directory (rights ${rights})`;
    }
    if (CREATOR_OWNER.has(ace.sid)) return undefined;
    if (flags.has("OI") || flags.has("CI")) {
      return `Another principal ${ace.sid} is granted create, delete or permission-change rights on new entries in the directory (rights ${rights})`;
    }
    return undefined;
  });
}
