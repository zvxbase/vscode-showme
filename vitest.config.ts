import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "test/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    // 拡張の統合テストは @vscode/test-electron が別プロセスで動かすので除外
    exclude: ["**/node_modules/**", "**/dist/**", "packages/extension/test/integration/**"],
  },
});
