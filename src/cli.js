#!/usr/bin/env node

const command = process.argv[2] || "serve";
const management = ['providers', 'doctor', 'tasks', 'result', 'cancel', 'abandon'];
if (management.includes(command)) {
  const { runManagement } = await import('./management.js');
  await runManagement(command, process.argv.slice(3));
} else {
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
  chatgpt-web-mcp providers                 List installed providers
  chatgpt-web-mcp doctor [--provider all]   Redacted local diagnostics (no browser)
  chatgpt-web-mcp tasks [--provider all] [--state uncertain] [--limit 20] [--offset 0]
  chatgpt-web-mcp result TASK_ID [--wait] [--timeout 30000]
  chatgpt-web-mcp cancel TASK_ID             Cancel the verified task generation
  chatgpt-web-mcp abandon TASK_ID --confirm  Release tracking after manual inspection
  chatgpt-web-mcp help     Show this help

Use --provider gemini with login, status or doctor for Gemini.
Management commands print JSON. Exit codes: 0 success, 1 failure/unresolved wait,
2 invalid arguments, 130 interrupted. Ctrl+C stops waiting without resending.
The serve command exposes unified chat_* tools plus chatgpt_* and gemini_* compatibility tools.
web-chat-mcp is an alias for this command.
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
}
