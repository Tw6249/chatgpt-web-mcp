import os from "node:os";
import path from "node:path";
import { resolveChromeExecutable } from "../config.js";

function duration(env, key, fallback, minimum) {
  const value = Number(env[key] ?? fallback);
  if (!Number.isFinite(value) || value < minimum) throw new Error(`${key} must be >= ${minimum}`);
  return value;
}

export function geminiConfig(env = process.env) {
  const dataDir = path.resolve(env.GEMINI_WEB_DATA_DIR || path.join(os.homedir(), ".gemini-web-mcp"));
  return {
    url: "https://gemini.google.com/app",
    dataDir,
    profile: path.resolve(env.GEMINI_WEB_PROFILE || path.join(dataDir, "chrome-profile")),
    browserState: path.join(dataDir, "browser-state.json"),
    runtimeState: path.join(dataDir, "runtime-state.json"),
    operationLock: path.join(dataDir, "browser-operation.lock"),
    archiveDir: path.resolve(env.GEMINI_WEB_ARCHIVE_DIR || path.join(dataDir, "conversation-context")),
    executable: env.GEMINI_WEB_CHROME ? path.resolve(env.GEMINI_WEB_CHROME) : resolveChromeExecutable({ env }),
    headless: /^(1|true|yes)$/i.test(env.GEMINI_WEB_HEADLESS || "false"),
    actionTimeout: duration(env, "GEMINI_WEB_ACTION_TIMEOUT_MS", 20000, 1000),
    responseTimeout: duration(env, "GEMINI_WEB_RESPONSE_TIMEOUT_MS", 300000, 1000),
    sendInterval: duration(env, "GEMINI_WEB_SEND_INTERVAL_MS", 5000, 5000),
    changeInterval: duration(env, "GEMINI_WEB_CHANGE_INTERVAL_MS", 5000, 5000),
    recoveryInterval: duration(env, "GEMINI_WEB_RECOVERY_INTERVAL_MS", 300000, 300000),
  };
}
