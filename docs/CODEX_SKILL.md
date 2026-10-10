# Codex: MCP + web-chat Skill

本仓库同时提供网页操作工具和专家咨询工作流：

```text
src/                              MCP 服务：网页、附件、任务与结果
skills/web-chat/SKILL.md           Agent 专家咨询工作流
skills/web-chat/agents/openai.yaml Skill 名称、提示词与 MCP 依赖
```

Skill 不包含浏览器登录信息、任务日志或个人聊天内容。安装 Skill 不会自动注册 MCP，也不会自动向网页发送资料。

Gemini 的默认偏好为 **3.8 Flash + 最高思考强度**，用户指定其他设置时覆盖此偏好。`chat_select_model` 的 Gemini 参数 `extended_thinking:true` 在新版 Low/Medium/High 菜单中选择并核验 High，在旧版菜单中开启并核验 Extended thinking；false 对应 Low 或关闭旧开关。返回的 `thinkingLevel` 记录实际核验的档位。模型不可用、指定档位缺失或无法确认时停止提交，不自动降级。升级后重新连接 MCP，才能加载新实现。

MCP 0.7.5+ 还提供 `chat_retry({task_id})`：Skill 判断 Gemini 的完整回答是拒答时，在原回答上点击一次 Redo／重试，再以原任务编号等待新回答。每个任务最多一次，重连或重复调用不会重复点击；原回复保存在 `previous_response`。再次拒答时报告结果，不循环重试或新发同一问题。该接口当前不支持 ChatGPT，也不重试状态不明、限流或仍在运行的任务。

## 1. 获取代码 / Get the repository

需要 Node.js 20+、npm、Git、Chrome 或 Edge，以及支持本地 MCP 和 Skill 的 Codex 客户端。

```sh
git clone https://github.com/Tw6249/chatgpt-web-mcp.git
cd chatgpt-web-mcp
npm ci
```

已有源码时在合适的分支更新代码；已有可用 MCP 时直接跳到第 3 步。

## 2. 注册 MCP / Register the MCP

推荐使用 [托管安装](COMPARISONS_AND_INSTALL.md#setup-and-the-stable-mcp-entry-point)：

```sh
node src/cli.js setup
```

将输出的 `command` 和 `args` 注册为 **`web-chat`**，对应 Skill 的 MCP 依赖名称。默认固定入口是 `~/.web-chat-mcp/install/launch.mjs`；自定义安装目录时以 setup 的输出为准。setup 不会自动改写 Codex 配置。

例如在 Windows PowerShell 中，使用默认安装目录和 PATH 中的 Node：

```powershell
$launcher = Join-Path $HOME '.web-chat-mcp/install/launch.mjs'
codex mcp add web-chat -- node $launcher serve
codex mcp get web-chat
```

macOS / Linux：

```sh
codex mcp add web-chat -- node "$HOME/.web-chat-mcp/install/launch.mjs" serve
codex mcp get web-chat
```

如果桌面客户端不能从 PATH 找到 Node，将 `node` 替换为 Node 可执行文件的绝对路径。也可以将相同的 `command`、`args` 写入 Codex 配置的 `[mcp_servers.web-chat]`。已有该条目时检查并沿用，不重复添加。

使用固定入口完成所需平台的登录，例如 Windows PowerShell：

```powershell
node $launcher login --provider chatgpt
# 使用 Gemini 时：
node $launcher login --provider gemini
```

macOS / Linux 将 `$launcher` 替换为 `"$HOME/.web-chat-mcp/install/launch.mjs"`。按浏览器提示手动登录；不要将密码或 Cookie 写入配置。新连接需要重新加载 MCP。源代码、托管安装和正在运行的 MCP 可能是不同版本，更新代码本身不会切换已运行的服务。

## 3. 安装 Skill / Install the skill

将本仓库的 **整个 `skills/web-chat` 目录**复制到 Codex 的技能目录。默认是 `~/.codex/skills`；设置了 `CODEX_HOME` 时使用 `$CODEX_HOME/skills`。下面命令都从仓库根目录执行，目标已存在时先备份。

Windows PowerShell：

```powershell
$codexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$skillsDir = Join-Path $codexDir 'skills'
$destination = Join-Path $skillsDir 'web-chat'
New-Item -ItemType Directory -Path $skillsDir -Force | Out-Null
if (Test-Path -LiteralPath $destination) {
    $backupDir = Join-Path $codexDir ('skill-backups/web-chat-' + [guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    Copy-Item -LiteralPath $destination -Destination $backupDir -Recurse
    Copy-Item -Path './skills/web-chat/*' -Destination $destination -Recurse -Force
} else {
    Copy-Item -LiteralPath './skills/web-chat' -Destination $destination -Recurse
}
```

macOS / Linux：

```sh
codex_dir="${CODEX_HOME:-$HOME/.codex}"
skills_dir="$codex_dir/skills"
mkdir -p "$skills_dir"
if [ -e "$skills_dir/web-chat" ]; then
  mkdir -p "$codex_dir/skill-backups"
  backup_dir="$(mktemp -d "$codex_dir/skill-backups/web-chat.XXXXXX")"
  cp -R "$skills_dir/web-chat" "$backup_dir/"
fi
mkdir -p "$skills_dir/web-chat"
cp -R ./skills/web-chat/. "$skills_dir/web-chat/"
```

备份位于技能发现目录之外，避免出现同名 Skill。更新时先检查自己的定制；上述复制会替换仓库提供的同名文件。MCP 的 `upgrade`/`rollback` 不会自动更新或回滚已复制的 Skill，更新 Skill 时需再次复制。

重新打开聊天；如果技能列表未刷新，再重启客户端。可在支持的技能选择菜单中搜索 **web-chat 网页专家**，或直接输入 `$web-chat`。菜单展示取决于客户端，MCP 工具可用和 Skill 入口可见是两项独立检查。

## 4. 使用 / Use

```text
使用 $web-chat，把当前问题和相关背景交给 ChatGPT 专家，等待完整回答后继续处理。

使用 $web-chat，请 Gemini 审阅我为本次咨询提供的文件，取得完整意见后改进方案。
```

The skill defaults to ChatGPT unless the user selects Gemini or has already chosen a provider for the task. It collects relevant context and authorized attachments, submits once with a stable request ID, waits with `chat_result`, and uses the complete expert answer to continue the original task. A timeout resumes the existing task instead of sending again. File access alone is not upload authorization, and the skill never silently switches providers.

本仓库版本支持 `session_id`，不同任务可隔离标签页；旧版 MCP 则使用原会话接口。Skill 按运行时工具声明选择参数。网页登录、验证码、限流、不可读取的附件或不确定发送状态仍可能需要用户处理，Skill 不会冒称已成功完成。

验证时分别检查：`codex mcp get web-chat` 能读取配置；新聊天能发现 Skill 和 MCP 工具；`chat_providers` 能列出平台。只有一次实际授权的网页咨询完成后，才说明端到端网页流程已验证。
