// vsce は拡張フォルダ直下の README.md / CHANGELOG.md / LICENSE しか VSIX に入れない。
// 真実は repo ルートの3つ（重複して持たない）。package の直前にここへ写す。
// 写した先は .gitignore 済み ―― ルートを直せば次の package で追従する。
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(new URL(".", import.meta.url).pathname, "..", "..");
const ext = path.join(root, "packages", "extension");
for (const name of ["README.md", "CHANGELOG.md", "LICENSE"]) {
  fs.copyFileSync(path.join(root, name), path.join(ext, name));
}
console.log("synced README.md / CHANGELOG.md / LICENSE into packages/extension/");
