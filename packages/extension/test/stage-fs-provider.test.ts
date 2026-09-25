import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 映しの FileSystemProvider の、vscode に触る薄い層の判断（設計 D81）。
 *
 * - 別名の綴り（`/src//a.ts`・`/src/./a.ts`・`/src\a.ts`）は、正規化すると同じ相対パスに
 *   なるが**別の URI** である。受け入れると同じ実体が2つの URI になり、D82（所有は URI で
 *   決まる）が崩れる。だから `stageUriPath(rel) === uri.path` の正準形だけを受け、それ以外は
 *   関門で落ちたものと同じ `FileNotFound` にする（mirror に届かせない）
 * - `notifyChanged` は、その scheme と rel の文書が開いているときだけ知らせる
 */

const fake = vi.hoisted(() => {
  const textDocuments: { uri: { scheme: string; authority: string; path: string } }[] = [];
  return { textDocuments };
});

vi.mock("vscode", () => {
  class FileSystemError extends Error {
    constructor(
      message: string,
      readonly code: string,
    ) {
      super(message);
    }
    static FileNotFound(u: unknown) {
      return new FileSystemError(String(u), "FileNotFound");
    }
    static FileExists(u: unknown) {
      return new FileSystemError(String(u), "FileExists");
    }
    static NoPermissions(u: unknown) {
      return new FileSystemError(String(u), "NoPermissions");
    }
    static Unavailable(u: unknown) {
      return new FileSystemError(String(u), "Unavailable");
    }
  }
  class EventEmitter<T> {
    private listeners: ((e: T) => void)[] = [];
    readonly event = (l: (e: T) => void) => {
      this.listeners.push(l);
      return { dispose: () => undefined };
    };
    fire(e: T) {
      for (const l of this.listeners) l(e);
    }
    dispose() {
      this.listeners = [];
    }
  }
  return {
    workspace: {
      get textDocuments() {
        return fake.textDocuments;
      },
    },
    Uri: {
      from: (parts: { scheme: string; path: string }) => ({
        ...parts,
        authority: "",
        toString: () => `${parts.scheme}:${parts.path}`,
      }),
    },
    FileSystemError,
    EventEmitter,
    Disposable: class {
      constructor(readonly dispose: () => void) {}
    },
    FileChangeType: { Changed: 1 },
    FileType: { File: 1 },
    FilePermission: { Readonly: 1 },
  };
});

import type * as vscode from "vscode";
import { StageFileSystemProvider } from "../src/stage-fs-provider.js";
import type { StageMirror } from "../src/stage-mirror.js";

const uriOf = (scheme: string, path: string, authority = ""): vscode.Uri =>
  ({ scheme, authority, path, toString: () => `${scheme}:${path}` }) as unknown as vscode.Uri;

function fakeMirror() {
  return {
    stat: vi.fn(() => ({ ok: true, size: 1, mtime: 1, ctime: 1, readonly: true })),
    read: vi.fn(() => ({ ok: true, bytes: new Uint8Array([1]) })),
    write: vi.fn(() => ({ ok: true })),
    bump: vi.fn(),
  };
}

describe("StageFileSystemProvider", () => {
  beforeEach(() => {
    fake.textDocuments.length = 0;
  });

  describe("正準形の綴りだけを受ける（別名を作らない）", () => {
    const aliases = ["/src//a.ts", "/src/./a.ts", "/./src/a.ts", "/src\\a.ts", "/src/b/../a.ts"];

    for (const scheme of ["showme-ro", "showme-rw"] as const) {
      for (const alias of aliases) {
        it(`${scheme}:${alias} は FileNotFound で、mirror に届かない`, () => {
          const mirror = fakeMirror();
          const p = new StageFileSystemProvider(
            scheme,
            mirror as unknown as StageMirror,
            () => undefined,
          );
          const uri = uriOf(scheme, alias);
          expect(() => p.stat(uri)).toThrow(expect.objectContaining({ code: "FileNotFound" }));
          expect(() => p.readFile(uri)).toThrow(expect.objectContaining({ code: "FileNotFound" }));
          if (scheme === "showme-rw") {
            expect(() =>
              p.writeFile(uri, new Uint8Array([1]), { create: false, overwrite: true }),
            ).toThrow(expect.objectContaining({ code: "FileNotFound" }));
          }
          expect(mirror.stat).not.toHaveBeenCalled();
          expect(mirror.read).not.toHaveBeenCalled();
          expect(mirror.write).not.toHaveBeenCalled();
        });
      }
    }

    it("正準形は mirror に正規化済みの rel で届く（両方向の検査）", () => {
      const mirror = fakeMirror();
      const p = new StageFileSystemProvider(
        "showme-ro",
        mirror as unknown as StageMirror,
        () => undefined,
      );
      p.stat(uriOf("showme-ro", "/src/a.ts"));
      expect(mirror.stat).toHaveBeenCalledWith("showme-ro", "src/a.ts", undefined);
    });
  });

  describe("書けない映しは読み取り専用と報告し、保存の拒否は NoPermissions", () => {
    const rwProvider = (mirror: ReturnType<typeof fakeMirror>) =>
      new StageFileSystemProvider("showme-rw", mirror as unknown as StageMirror, () => undefined);

    it("mirror が readonly と答えた showme-rw の stat は Readonly", () => {
      const mirror = fakeMirror();
      expect(rwProvider(mirror).stat(uriOf("showme-rw", "/src/a.ts")).permissions).toBe(1);
    });

    it("mirror が書けると答えた showme-rw の stat は permissions を持たない", () => {
      const mirror = fakeMirror();
      mirror.stat.mockReturnValue({ ok: true, size: 1, mtime: 1, ctime: 1, readonly: false });
      expect(rwProvider(mirror).stat(uriOf("showme-rw", "/src/a.ts")).permissions).toBeUndefined();
    });

    it("write の not-writable は NoPermissions（not-found は FileNotFound のまま）", () => {
      const mirror = fakeMirror();
      const p = rwProvider(mirror);
      const uri = uriOf("showme-rw", "/src/a.ts");
      const opts = { create: false, overwrite: true };
      mirror.write.mockReturnValue({ ok: false, reason: "not-writable" } as never);
      expect(() => p.writeFile(uri, new Uint8Array([1]), opts)).toThrow(
        expect.objectContaining({ code: "NoPermissions" }),
      );
      mirror.write.mockReturnValue({ ok: false, reason: "not-found" } as never);
      expect(() => p.writeFile(uri, new Uint8Array([1]), opts)).toThrow(
        expect.objectContaining({ code: "FileNotFound" }),
      );
    });
  });

  describe("notifyChanged は、その映しが開いているときだけ知らせる", () => {
    const setup = (scheme: "showme-ro" | "showme-rw") => {
      const p = new StageFileSystemProvider(
        scheme,
        fakeMirror() as unknown as StageMirror,
        () => undefined,
      );
      const fired: unknown[] = [];
      p.onDidChangeFile((e) => fired.push(...e));
      return { p, fired };
    };

    it("何も開いていなければ知らせない", () => {
      const { p, fired } = setup("showme-ro");
      p.notifyChanged("src/a.ts");
      expect(fired).toEqual([]);
    });

    it("同じファイルの file: やもう一方の映しが開いていても知らせない", () => {
      fake.textDocuments.push(
        { uri: { scheme: "file", authority: "", path: "/root/src/a.ts" } },
        { uri: { scheme: "showme-rw", authority: "", path: "/src/a.ts" } },
        { uri: { scheme: "showme-ro", authority: "", path: "/src/b.ts" } },
      );
      const { p, fired } = setup("showme-ro");
      p.notifyChanged("src/a.ts");
      expect(fired).toEqual([]);
    });

    it("その scheme と rel の文書が開いていれば1回知らせる", () => {
      fake.textDocuments.push({ uri: { scheme: "showme-ro", authority: "", path: "/src/a.ts" } });
      const { p, fired } = setup("showme-ro");
      p.notifyChanged("src/a.ts");
      expect(fired).toHaveLength(1);
      expect(fired[0]).toMatchObject({ type: 1, uri: { scheme: "showme-ro", path: "/src/a.ts" } });
    });
  });
});
