#!/usr/bin/env node

const command = process.argv[2] || "serve";
const providerIndex = process.argv.indexOf("--provider");
const provider = providerIndex < 0 ? "chatgpt" : process.argv[providerIndex + 1];
if (!["chatgpt", "gemini"].includes(provider)) {
  console.error("--provider must be chatgpt or gemini");
  process.exit(2);
}

if (["help", "--help", "-h"].includes(command)) {
  console.log(`chatgpt-web-mcp

Usage:
  chatgpt-web-mcp serve    Start the stdio MCP server (default)
  chatgpt-web-mcp login    Open the dedicated browser for manual login
  chatgpt-web-mcp status   Inspect the current local browser state
  chatgpt-web-mcp doctor   Check Node.js, browser detection, and local paths
  chatgpt-web-mcp help     Show this help

Use --provider gemini with login, status or doctor for Gemini.
The serve command exposes both chatgpt_* and gemini_* tools.
`);
} else if (command === "serve") {
  await import("./index.js");
} else if (provider === "gemini" && ["login", "status", "doctor"].includes(command)) {
  await import("../scripts/gemini.js");
} else if (command === "login") {
  await import("../scripts/login.js");
} else if (command === "status") {
  await import("../scripts/inspect.js");
} else if (command === "doctor") {
  await import("../scripts/doctor.js");
} else {
  console.error(`Unknown command: ${command}`);
  console.error("Run 'chatgpt-web-mcp help' to see available commands.");
  process.exitCode = 2;
}
