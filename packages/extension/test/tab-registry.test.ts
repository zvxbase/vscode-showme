import { describe, expect, it } from "vitest";
import { TabRegistry } from "../src/tab-registry.js";

/**
 * **札は観測をまたいで一意でなければならない**。
 *
 * ハンドラは1回の観測の札を持ったまま `await` を挟む。そのあいだに別の要求が
 * 観測し直したとき、古い札が**別のタブ**（人間が見ているタブかもしれない）に
 * 結び直されると、床1 を競合で抜ける。古い札は引けない、が正しい。
 */
describe("TabRegistry", () => {
  it("同じ観測の札は引ける", () => {
    const registry = new TabRegistry<string>();
    const [a, b] = registry.observe(["A", "B"]);
    expect(a && b).toBeTruthy();
    if (!a || !b) return;
    expect(registry.resolve([a.id, b.id])).toEqual(["A", "B"]);
  });

  it("2回目の観測のあと、1回目の札は別のタブに結び直されない（引けない）", () => {
    const registry = new TabRegistry<string>();
    const first = registry.observe(["own", "human"]);
    const ownId = first[0]?.id;
    expect(ownId).toBeDefined();
    if (ownId === undefined) return;
    // 別の要求が観測し直す。並びが変わっている（人間がタブを閉じた／開いた）。
    const second = registry.observe(["viewing-human", "own"]);
    // **加工が効いたことを主張する。** 2回目の札が1回目と同じ綴りなら、この検査は
    // 「引けない」を何も言っていない（同じ札で同じ位置のタブが引けてしまう）。
    expect(second.map((e) => e.id)).not.toContain(ownId);
    // 古い札で引くと何も返らない。"viewing-human" が返ったら、床1 を競合で抜けている。
    expect(registry.resolve([ownId])).toEqual([]);
  });

  it("知らない札は落とし、順序は引いた順", () => {
    const registry = new TabRegistry<number>();
    const ids = registry.observe([1, 2, 3]).map((e) => e.id);
    expect(registry.resolve([ids[2] ?? "", "nope", ids[0] ?? ""])).toEqual([3, 1]);
  });

  it("札は台帳の寿命の中で重複しない（10回観測しても）", () => {
    const registry = new TabRegistry<number>();
    const seen = new Set<string>();
    for (let round = 0; round < 10; round += 1) {
      for (const { id } of registry.observe([round, round + 1, round + 2])) {
        expect(seen.has(id), `${id} が再利用された（round ${round}）`).toBe(false);
        seen.add(id);
      }
    }
    expect(seen.size).toBe(30);
  });
});
