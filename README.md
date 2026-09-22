# ChatGPT & Gemini Web MCP

基于 [Goudu666/chatgpt-web-mcp](https://github.com/Goudu666/chatgpt-web-mcp) 的扩展 fork，新增 Gemini 网页端支持；保留原 MIT 许可证与作者署名。

[English](README.en.md)

## 本地诊断与任务管理（0.5.0）

新增 `chat_doctor`，统一检查两个平台的本地环境、锁和任务状态，报告不包含聊天内容、会话链接或本地路径。任务列表支持状态筛选和分页；任务结果附带具体恢复建议。共有 60 个 MCP 工具。

```bash
node src/cli.js doctor
node src/cli.js tasks --provider all --state uncertain
node src/cli.js result <task_id> --wait --timeout 30000
```

命令行还支持 `providers`、`cancel <task_id>` 和 `abandon <task_id> --confirm`，与 MCP 共用任务核心。诊断不会打开浏览器，也不代表登录或网页控件已验证。完整用法和退出码见 [管理与诊断文档](docs/MANAGEMENT.md)。

## 统一接口与持久化任务（0.4.0）

新增 13 个通用 `chat_*` 工具，保留原有 46 个 `chatgpt_*` / `gemini_*` 工具。用 `provider: "chatgpt"` 或 `"gemini"` 选择平台：`chat_send` 接收稳定的 `request_id`，返回持久化 `task_id`；`chat_result` 可在 MCP 重启后恢复读取。同一请求编号不会重复发送，任务执行期间会阻止同平台旧接口切换页面。

提供任务列表、经身份核对的取消操作和显式异常恢复。通用任务核心、平台适配器、ChatGPT 工具注册与策略已分层；两个平台继续保留各自的浏览器实现与登录目录。新增 `web-chat-mcp` 命令别名，原命令和配置继续可用。

更新后重启 MCP 连接。任务结果默认保存在私有目录 `~/.web-chat-mcp`，可通过 `WEB_CHAT_DATA_DIR` 配置；不要删除记录来重试不确定的发送。完整用法、状态说明和限制见 [统一任务文档](docs/UNIFIED_TASKS.md)。

## Gemini 网页端支持（0.3.0）

同一个 MCP Server 现在同时提供 `chatgpt_*` 和 `gemini_*` 工具。原有 ChatGPT 工具名称与配置保持兼容；Gemini 使用独立的专用浏览器、登录目录、操作锁、限流状态及归档目录。

```bash
npm ci
node src/cli.js doctor --provider gemini
node src/cli.js login --provider gemini
```

在打开的专用窗口中手动登录 Google/Gemini。程序不读取日常 Chrome 的登录资料，不接受密码或 Cookie。已有 MCP 配置仍指向 `src/index.js`；更新代码后重启 MCP 客户端连接，即可发现 Gemini 工具。

典型调用顺序：

1. `gemini_status` 检查登录与当前对话。
2. `gemini_new_chat` 新建对话（已有草稿、附件或未确认的发送会阻止切换）。
3. `gemini_send_message` 发送并等待回答。
4. 如果返回 `pending: true` 或 `timedOut: true`，调用 `gemini_get_latest_response` 并设置 `wait: true` 继续等待，**不要重新发送**。
5. 继续调用 `gemini_send_message` 追问，或者显式调用 `gemini_archive_conversation` 将已加载消息保存为 Markdown。

附件流程：`gemini_write_prompt` → `gemini_upload_files`（仅上传用户授权的绝对路径）→ `gemini_submit_prompt`。原子 `gemini_send_message` 要求空输入框，避免把用户原有草稿或附件一起发出。

| Gemini 工具 | 用途 |
| --- | --- |
| `gemini_status` / `gemini_browser_lifecycle` | 页面状态 / 本地浏览器状态 |
| `gemini_new_chat` | 新建对话 |
| `gemini_write_prompt` / `gemini_upload_files` | 写入草稿 / 上传文件 |
| `gemini_submit_prompt` / `gemini_send_message` | 提交已有草稿 / 原子发送新问题 |
| `gemini_get_latest_response` | 读取回复或恢复等待 |
| `gemini_list_models` / `gemini_select_model` | 列出并选择页面实际可用的模式 |
| `gemini_list_history` / `gemini_select_history` | 列出已加载侧栏记录 / 打开对话 URL |
| `gemini_archive_conversation` | 归档当前已加载消息，明确不保证完整历史 |
| `gemini_circuit_breaker_status` / `gemini_clear_circuit_breaker` | 限流状态 / 人工确认后恢复 |
| `gemini_resolve_pending` | 用户人工核对后解除不确定发送状态，不重发 |
| `gemini_close_browser` | 仅在用户明确要求时关闭专用浏览器 |

Gemini 不复用 ChatGPT 的模型名称、Pro 探针或 40 轮自动轮换策略。模型名直接取自页面菜单。网页布局、语言、账户与地区差异可能导致控件无法识别，此时工具返回错误并停止。Gemini 归档和历史列表只覆盖当前页面已加载的内容；不调用 Gemini 私有接口。

发送与对话/模式切换间隔至少 5 秒。检测到 Gemini HTTP 429 或页面限流提示后停止，不自动重试、不自动切换账号。只有用户人工确认恢复后才可清除限流状态，并继续等待至少 5 分钟。发送意图在点击前落盘，即使进程退出或超时，也会保留待确认标记以防重复发送。

环境变量（均可选）：

| 变量 | 默认值 |
| --- | --- |
| `GEMINI_WEB_DATA_DIR` | `~/.gemini-web-mcp` |
| `GEMINI_WEB_PROFILE` | 数据目录下的 `chrome-profile` |
| `GEMINI_WEB_CHROME` | 自动检测 Chrome/Edge，可复用 `CHATGPT_WEB_CHROME` |
| `GEMINI_WEB_ARCHIVE_DIR` | 数据目录下的 `conversation-context` |
| `GEMINI_WEB_HEADLESS` | `false`，首次登录应使用可见窗口 |
| `GEMINI_WEB_ACTION_TIMEOUT_MS` | `20000` |
| `GEMINI_WEB_RESPONSE_TIMEOUT_MS` | `300000` |
| `GEMINI_WEB_SEND_INTERVAL_MS` | `5000`，不可小于此值 |
| `GEMINI_WEB_CHANGE_INTERVAL_MS` | `5000`，不可小于此值 |
| `GEMINI_WEB_RECOVERY_INTERVAL_MS` | `300000`，不可小于此值 |

验证：`npm test`、`npm run smoke`、`npm run test:browser`、`npm pack --dry-run`。浏览器测试使用本地模拟页面拦截所有网络请求，无需账号，不发送真实消息；真实网页验收需要另行手动登录并低频测试。浏览器测试需安装 Chrome/Edge，或执行 `npx playwright-core install chromium`。

登录后可显式运行 `node scripts/verify-gemini.js --send`：通过 MCP 新建测试对话，发送两个不含私人信息的问题，验证回复完成、重连和上下文追问。不加 `--send` 时只检查状态；此脚本不进入 CI。

增加 `--upload` 参数可验证附件：`node scripts/verify-gemini.js --send --upload`。脚本会创建一个仅含测试标记的临时文本文件，上传后让 Gemini 读出标记；不上传用户文档。实际网页验收结果见 [测试报告](docs/GEMINI_VALIDATION.md)。

## 原有 ChatGPT 功能

一个本地、非官方的 MCP Server，让 Codex 等 MCP 客户端通过独立的持久浏览器配置操作 `chatgpt.com`。它不使用 OpenAI 官方付费 API，也不需要 API Key。消息发送通过网页完成；历史读取可能使用当前网页会话的内部接口。它不读取用户日常浏览器配置，也不会把登录信息写进 MCP 配置。

> [!IMPORTANT]
> 本项目与 OpenAI 无隶属或背书关系。它依赖 ChatGPT 网页界面，页面改版、账号权限、地区或工作区策略都可能影响可用性。请遵守适用于你账号的条款，不要用它绕过访问控制、用量限制或安全机制。

## 主要能力

- 写入提示词、上传文件、发送消息并读取完整回答
- 新建普通或临时对话，选择历史对话
- 动态读取和选择页面实际显示的模型、思考强度与能力档位
- 普通请求默认使用“极高”；临时 Pro 身份探针默认停用，避免额外创建临时对话和发送测试消息
- 浏览器和 ChatGPT 页面默认常驻，工具结束后只断开本地控制连接
- 跨进程串行操作、低频节流、回答完成后的切换静默期
- 遇到页面限流文字或非历史接口 HTTP 429 时熔断；历史接口 429 不触发全局熔断，不自动重试该接口
- 对话达到 40 轮或出现 ChatGPT maximum-length banner 时，发送前先滚动加载完整 transcript（含较早历史），再归档并轮换普通对话；直接 `chatgpt_submit_prompt` 会安全拦截
- 只记录脱敏后的异常请求方法、路径、状态码和资源类型

## 运行要求

- Node.js 20 或更高版本
- Google Chrome、Chromium 或 Microsoft Edge
- 支持本地 stdio MCP 的客户端，例如 Codex
- 可正常访问并手动登录的 ChatGPT 账号

项目会在 macOS、Windows 和 Linux 的常见位置查找浏览器。找不到时可通过 `CHATGPT_WEB_CHROME` 指定可执行文件。

## 安装

```bash
git clone https://github.com/Tw6249/chatgpt-web-mcp.git
cd chatgpt-web-mcp
npm ci
npm run doctor
```

为了在任意目录使用统一命令，可以建立本地全局链接：

```bash
npm link
chatgpt-web-mcp doctor
```

## 首次登录

```bash
chatgpt-web-mcp login
```

未执行 `npm link` 时也可以使用：

```bash
npm run login
```

在打开的专用浏览器窗口中手动登录。登录资料默认保存在 `~/.chatgpt-web-mcp/chrome-profile`，与日常浏览器配置分离。不要复制、提交或分享这个目录，也不要把密码、Cookie、令牌或验证码写进环境变量。

## 添加到 Codex

使用统一命令：

```bash
codex mcp add chatgpt-web -- chatgpt-web-mcp serve
codex mcp get chatgpt-web
```

如果 Codex 找不到全局命令，可以直接使用 Node.js 和项目的绝对路径：

```bash
codex mcp add chatgpt-web -- node /absolute/path/to/chatgpt-web-mcp/src/index.js
```

Codex 的 MCP 配置方式可参考 [OpenAI Docs](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

## CLI

```text
chatgpt-web-mcp serve    启动 stdio MCP Server（默认命令）
chatgpt-web-mcp login    打开专用浏览器并等待手动登录
chatgpt-web-mcp status   读取当前本地状态
chatgpt-web-mcp doctor   检查 Node.js、浏览器和本地数据路径
chatgpt-web-mcp help     显示帮助
```

## MCP 工具

工具按用途分为以下几组：

- 状态：`chatgpt_status`、`chatgpt_capabilities`、`chatgpt_browser_lifecycle`
- 对话：`chatgpt_new_chat`、`chatgpt_set_temporary`、`chatgpt_list_history`、`chatgpt_search_history`、`chatgpt_select_history`
- 设置：`chatgpt_list_modes`、`chatgpt_select_mode`、`chatgpt_list_models`、`chatgpt_select_model`、`chatgpt_list_thinking_levels`、`chatgpt_select_thinking_level`、`chatgpt_answer_tier_status`、`chatgpt_select_answer_tier`
- 输入与输出：`chatgpt_write_prompt`、`chatgpt_upload_files`、`chatgpt_submit_prompt`、`chatgpt_send_message`、`chatgpt_get_latest_response`、`chatgpt_archive_conversation`
- 安全：`chatgpt_circuit_breaker_status`、`chatgpt_clear_circuit_breaker`、`chatgpt_network_diagnostics`
- 策略路由：`chatgpt_probe_pro_identity`、`chatgpt_route_new_chat`

只有用户明确要求关闭专用浏览器时，才应调用 `chatgpt_close_browser`。

## 默认路由策略

普通请求默认新建非临时对话并选择页面可用的“极高”档位，使用 `chatgpt_route_new_chat(requestPro=false)`。

**临时 Pro 身份探针默认停用**（`CHATGPT_WEB_PROBE_ENABLED=false`）。`chatgpt_probe_pro_identity` 或 `requestPro=true` 会明确报错，不新建临时对话，也不发送“你是什么模型？”；`forceProbe=true` 不能绕过停用设置。这样可以避免探针产生额外对话和请求。停用探针不等于禁止手动选择页面实际提供的 Pro 档位，但本工具不保证账号实际路由到哪一个模型。

仅在确实需要实验性身份核对时，才手动设置 `CHATGPT_WEB_PROBE_ENABLED=true` 并重启 MCP。当前实验流程在临时对话的可用档位发送探针，读取网络响应的 `model_slug`：mini 回退默认档位，其他非空标记记为 `network-verified`，缺少标记则停止。**非 mini 不等于 Pro**，该流程不会强制选择 Pro。工具名及 `requestPro` 参数为兼容旧客户端而保留，不能把它们理解为 Pro 保证。

启用探针时，同一浏览器与页面会话持续复用可靠缓存；检测到关闭后保留 3 小时，再次请求时才重验。普通 MCP 调用结束只断开控制连接，不关闭网页，不启动重验计时。默认停用状态下不会因缓存过期自动发起探针，也不会要求重新登录。

相关配置：

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `CHATGPT_WEB_PROBE_ENABLED` | `false` | 是否显式启用实验性临时身份探针 |
| `CHATGPT_WEB_DEFAULT_TIER` | `极高` | 普通请求和回退使用的倒数第二档名称 |
| `CHATGPT_WEB_PRO_TIER` | `Pro` | 滑杆最高档名称 |
| `CHATGPT_WEB_PROBE_PROMPT` | `你是什么模型？` | 临时身份探针提示词 |
| `CHATGPT_WEB_PROBE_ACCEPT_ID` | `gpt-5.6-pro` | 接受分类标识 |
| `CHATGPT_WEB_PROBE_FALLBACK_ID` | `gpt-5.5-mini` | 回退分类标识 |
| `CHATGPT_WEB_PROBE_ACCEPT_PATTERN` | GPT-5.6 Pro 正则 | 接受回答的匹配表达式 |
| `CHATGPT_WEB_PROBE_FALLBACK_PATTERN` | GPT-5.5 mini 正则 | 回退回答的匹配表达式 |
| `CHATGPT_WEB_PRO_RECHECK_AFTER_CLOSE_MS` | `10800000` | 页面或浏览器关闭后，重新验证前继续复用可靠结果的时间 |

参考配置见 [.env.example](.env.example)。项目不会自动读取 `.env`；请通过 MCP 客户端、Shell 或系统环境注入变量。

## 新对话前的可选刷新

`CHATGPT_WEB_REFRESH_BEFORE_NEW_CHAT=false`，默认不额外刷新旧页面。设置为 `true` 并重启 MCP 后，新建对话执行“检查草稿和附件 → 刷新当前页面 → 站内新建”。刷新失败或出现限流时停止，不重试。

这与现有的“发送前刷新”是两个步骤。开启后，一次新建并发送通常会刷新两次，增加请求量和耗时；它用于按需处理旧页面状态，不是防限流功能。已完成的小规模测试只能说明该流程可用，不能证明额外刷新能降低限流。浏览器与网页仍默认常驻。

## 安全节流

| 环境变量 | 默认值 |
| --- | ---: |
| `CHATGPT_WEB_PAGE_INTERACTION_INTERVAL_MS` | 1000 ms |
| `CHATGPT_WEB_SITE_ACTION_INTERVAL_MS` | 5000 ms |
| `CHATGPT_WEB_SEND_INTERVAL_MS` | 5000 ms |
| `CHATGPT_WEB_CONVERSATION_CHANGE_INTERVAL_MS` | 5000 ms |
| `CHATGPT_WEB_POST_RESPONSE_CONVERSATION_COOLDOWN_MS` | 5000 ms |
| `CHATGPT_WEB_PAGE_STARTUP_DELAY_MS` | 6000 ms |
| `CHATGPT_WEB_POST_BREAKER_COOLDOWN_MS` | 300000 ms |
| `CHATGPT_WEB_HISTORY_QUIET_PERIOD_MS` | 300000 ms |

**默认 5 秒是最小间隔，不是每 5 秒必定完成一次操作，也不是免于限流或封禁的保证。** 页面加载、页面交互、生成回答以及其他等待会叠加；完成上一条回答后才开始下一条，不并发发送。已有客户端环境变量会覆盖新默认值；例如原先显式配置了 `30000`，升级后仍使用 30 秒。

新建、临时切换和历史选择受独立的 5 秒对话变更间隔约束，回答完成后至少静默 5 秒才允许切换。首次打开 ChatGPT 页面后仍等待 6 秒。若账号出现请求频繁提示，应停止并增大间隔，例如把上述三个 `5000` 配置改回 `30000`，不要反复重试。

人工确认限流消失并清除本地熔断后，首次站点操作仍等待 5 分钟；页面明确提示历史限流时还有独立的 5 分钟静默截止时间，清除熔断不会绕过它。仅历史接口返回 HTTP 429 不触发全局熔断：浏览器响应保留诊断日志，主动读取失败则沿用页面 transcript 回退，不自动重试该接口。网页明确出现“请求过于频繁”等限流提示时仍停止。缺少现成请求头时不再额外打开页面取认证信息。

保留 PR 的旧进程锁回收逻辑：记录的 MCP 进程已退出时，后续操作会自动清除其生成标记，避免遗留锁阻塞。进程仍存活或标记未记录进程 ID 时，不按此规则清除；这不会同时清除限流熔断，也不会关闭浏览器。

## 其他环境变量

- `CHATGPT_WEB_CHROME`：浏览器可执行文件绝对路径
- `CHATGPT_WEB_PROFILE`：专用浏览器配置目录
- `CHATGPT_WEB_HEADLESS`：是否无界面运行，默认 `false`
- `CHATGPT_WEB_ACTION_TIMEOUT_MS`：单次页面操作超时
- `CHATGPT_WEB_RESPONSE_TIMEOUT_MS`：普通档位回答超时
- `CHATGPT_WEB_RECONNECT_DELAY_MS`：浏览器异常重连间隔
- `CHATGPT_WEB_AUTH_CACHE_MS`：登录状态本地缓存时间
- `CHATGPT_WEB_PRO_RECHECK_AFTER_CLOSE_MS`：页面或浏览器关闭后的探针重验间隔，默认 3 小时
- `CHATGPT_WEB_BROWSER_STATE`、`CHATGPT_WEB_RUNTIME_STATE`：本地状态文件
- `CHATGPT_WEB_OPERATION_LOCK`：跨进程浏览器独占锁
- `CHATGPT_WEB_NETWORK_LOG`：脱敏网络异常日志
- `CHATGPT_WEB_MAX_CONVERSATION_TURNS`：发送前自动轮换阈值，默认 `40`
- `CHATGPT_WEB_CONTEXT_ARCHIVE_DIR`：对话轮换前 Markdown 归档目录

## 隐私与局限

- 登录资料、运行状态和诊断日志默认位于 `~/.chatgpt-web-mcp`，不在仓库中。
- 文件上传只接受调用者明确提供的绝对路径。
- 网络诊断不保存查询参数、Cookie、请求体、响应体或对话 ID。
- 等待回答使用页面内的变更事件，不持续轮询页面。
- 每次发送前只做一次当前对话整页刷新并重新校验；页面、对话 URL、用户草稿或附件状态异常时停止，不自动重试。
- 对话轮换前的完整 transcript（含懒加载的较早消息）由 `chatgpt_archive_conversation` 或原子发送路径以 `0600` Markdown 文件保存；归档目录应按部署需要纳入受控的研究文档路径。
- ChatGPT 网页不是稳定 API；选择器可能随页面更新而需要维护。
- 模型自我说明和网络模型标记都不构成对实际服务模型的独立证明；尤其不能把“非 mini”当作 Pro 保证。

## 开发

```bash
npm ci
npm test
npm run smoke
npm pack --dry-run
```

CI 只运行离线测试和打包检查，不登录 ChatGPT，也不执行真实网页请求。贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)；安全问题请阅读 [SECURITY.md](SECURITY.md)。

## 许可证

[MIT](LICENSE)
