import * as fs from "node:fs";
import * as path from "node:path";
import Mocha from "mocha";
import * as vscode from "vscode";
import {
  ALPHA_LOCK,
  type BetaCommand,
  type BetaReply,
  type BetaStatus,
  COMMAND_FILE,
  RESULTS_FILE,
  type TwoWindowResults,
  betaStatusPath,
  coordDirFrom,
  readJson,
  replyPath,
  sleep,
  writeJsonAtomic,
} from "../two-window-coord.js";
import {
  activateExtension,
  currentRole,
  readOwnRegistration,
  setRole,
  visibleEditorSnapshot,
} from "./helpers.js";

/**
 * 2窓のテストの入口。**この1つのファイルが2つの役を持つ**。
 *
 * `--extensionTestsPath` は新しく開いた窓にも受け継がれる（スパイクで実測）ので、
 * 2つ目の窓でも同じ `run()` が呼ばれる。先着1つが「測る側」（alpha）になり、
 * 以降は「測られる側」（beta）になる。役は錠ファイルで決める。
 *
 * **測られる側は決して resolve も reject もしない。** 拡張テストの `run()` が
 * 決着するとアプリ全体が終了する（実測）ので、測られる側が決着すると測る側の
 * 実験ごと落ちる。永久に立っていて、指図を待つ。
 */

/** 窓が2つとも立ち、役割を切り替えて往復するのを待つので、長めに取る。 */
const TEST_TIMEOUT_MS = 120_000;

/** 指図を見に行く間隔。 */
const POLL_MS = 200;

function claimAlpha(dir: string): boolean {
  try {
    fs.writeFileSync(path.join(dir, ALPHA_LOCK), String(process.pid), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------- 測られる側 */

/**
 * 測られる側の窓。指図を受けて役割を変え、近況を書き続ける。
 *
 * **失敗しても止まらない。** ここで例外を投げて黙ると、測る側からは
 * 「beta が現れない」としか見えず、原因（2つ目の窓に拡張が入らなかった等）が
 * 消える。捕まえて `failure` に書き、それでも立ち続ける。
 */
async function beta(dir: string): Promise<never> {
  const statusFile = betaStatusPath(dir, process.pid);
  let failure: string | undefined;
  try {
    await activateExtension();
  } catch (e) {
    failure = `activate に失敗: ${String(e)}`;
  }

  const writeStatus = (): void => {
    let windowId: string | undefined;
    let workspacePath: string | undefined;
    let role: string | undefined;
    try {
      const entry = readOwnRegistration();
      windowId = typeof entry.windowId === "string" ? entry.windowId : undefined;
      workspacePath = typeof entry.workspacePath === "string" ? entry.workspacePath : undefined;
      role = typeof entry.role === "string" ? entry.role : undefined;
    } catch (e) {
      if (failure === undefined) failure = `登録ファイルが読めない: ${String(e)}`;
    }
    const status: BetaStatus = {
      pid: process.pid,
      updatedAt: new Date().toISOString(),
      ready: failure === undefined && windowId !== undefined,
      ...(failure === undefined ? {} : { failure }),
      ...(windowId === undefined ? {} : { windowId }),
      ...(workspacePath === undefined ? {} : { workspacePath }),
      ...(role === undefined ? {} : { role }),
      visibleEditors: visibleEditorSnapshot(),
    };
    try {
      writeJsonAtomic(statusFile, status);
    } catch {
      // 書けないなら次の周回で書く。ここで投げると立ち続けられなくなる。
    }
  };

  writeStatus();

  let lastSeq = 0;
  for (;;) {
    const command = readJson<BetaCommand>(path.join(dir, COMMAND_FILE));
    if (command !== undefined && command.seq > lastSeq) {
      lastSeq = command.seq;
      let reply: BetaReply;
      try {
        reply = { seq: command.seq, ok: true, data: await runBetaOp(command) };
      } catch (e) {
        reply = { seq: command.seq, ok: false, error: String(e) };
      }
      try {
        writeJsonAtomic(replyPath(dir, command.seq), reply);
      } catch {
        // 返せなかった分は測る側が時間切れで報告する。
      }
    }
    writeStatus();
    await sleep(POLL_MS);
  }
}

async function runBetaOp(command: BetaCommand): Promise<unknown> {
  switch (command.command.op) {
    case "identity": {
      const entry = readOwnRegistration();
      return {
        pid: process.pid,
        windowId: entry.windowId,
        workspacePath: entry.workspacePath,
        socketPath: entry.socketPath,
        role: currentRole(),
      };
    }
    case "set-role": {
      await setRole(command.command.role);
      return { role: currentRole() };
    }
    case "snapshot": {
      return {
        role: currentRole(),
        visibleEditors: visibleEditorSnapshot(),
        tabGroups: vscode.window.tabGroups.all.length,
        // 測る側は「自分が前面に無い」ことしか見られない。両方 false（＝観測が
        // 壊れている）と区別するために、測られる側の値も返す。
        windowFocused: vscode.window.state.focused,
      };
    }
  }
}

/* ------------------------------------------------------------------ 測る側 */

function alpha(dir: string): Promise<void> {
  const mocha = new Mocha({ ui: "tdd", color: true, timeout: TEST_TIMEOUT_MS });
  mocha.addFile(path.resolve(__dirname, "./two-windows.test.js"));

  return new Promise((resolve, reject) => {
    const notes: string[] = [];
    let runner: Mocha.Runner;
    try {
      runner = mocha.run((failures) => {
        const results: TwoWindowResults = {
          ok: failures === 0,
          failures,
          notes,
          finishedAt: new Date().toISOString(),
        };
        try {
          writeJsonAtomic(path.join(dir, RESULTS_FILE), results);
        } catch (e) {
          console.error(`結果を書けなかった: ${String(e)}`);
        }
        // resolve するとアプリ全体が終わる。測られる側の窓もここで畳まれる。
        if (failures > 0) reject(new Error(`${failures} 件のテストが落ちた`));
        else resolve();
      });
    } catch (e) {
      reject(e);
      return;
    }
    runner.on("pass", (test) => notes.push(`PASS ${test.fullTitle()}`));
    runner.on("fail", (test, err) =>
      notes.push(`FAIL ${test.fullTitle()} :: ${String(err?.message ?? err)}`),
    );
  });
}

/* ---------------------------------------------------------------------- run */

export function run(): Promise<void> {
  const dir = coordDirFrom(process.env);
  // 測られる側は返した Promise を永久に未決着のまま持つ。
  if (!claimAlpha(dir)) return beta(dir);
  return alpha(dir);
}
