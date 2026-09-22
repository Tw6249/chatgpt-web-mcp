#!/usr/bin/env node
import { setTimeout as delay } from "node:timers/promises";
import { GeminiBrowser } from "../src/gemini/browser.js";

const command = process.argv[2];
const browser = new GeminiBrowser();
try {
  if (command === "login") {
    console.log(`Open Gemini in its dedicated browser. Sign in manually. Profile: ${browser.config.profile}`);
    await browser.runExclusive(() => browser.page());
    const deadline = Date.now() + 15 * 60000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        ready = await browser.runExclusive(async () => (await browser.status()).signedIn);
      } catch (error) { if (error.code !== "LOGIN_REQUIRED") throw error; }
      if (ready) break;
      await delay(5000);
    }
    if (!ready) throw new Error("Login timed out. Run the login command again when ready.");
    console.log("Gemini login saved. Browser remains open.");
  } else if (command === "status") {
    console.log(JSON.stringify(await browser.runExclusive(() => browser.status()), null, 2));
  } else if (command === "doctor") {
    console.log(JSON.stringify({ provider: "gemini", node: process.version, browser: browser.config.executable, profile: browser.config.profile, dataDir: browser.config.dataDir }, null, 2));
    if (!browser.config.executable) process.exitCode = 1;
  } else throw new Error("Use login, status or doctor with --provider gemini.");
} finally { await browser.close(); }
