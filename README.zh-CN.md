<div align="center">

# Agent Remote Console

**从任意浏览器控制电脑上的 Codex、Claude Code 和 OpenCode。**

一个移动端优先的自托管控制台：发现已有任务、按工作目录聚合、带上下文继续执行，并实时返回进度。无需云端账户，也不代理 API Key。

[English](README.md) · [安全说明](SECURITY.md) · [参与贡献](CONTRIBUTING.md)

</div>

> [!IMPORTANT]
> Agent Remote Console 是非官方社区项目，与 OpenAI、Anthropic 及 OpenCode 维护者没有隶属关系。请仅在本机、Tailscale 或其他可信私网中运行，不要直接暴露到公网。

![Agent Remote Console 工作目录树](docs/assets/agent-remote-console-workspaces.jpg)

Agent Remote Console 把电脑上的 coding-agent CLI 变成可以远程调度的执行者。任务仍由本机 CLI 使用已有登录状态、文件系统、终端和工具能力完成。

## 本地 Agent 的远程控制平面

| 控制方 | 可以通过 Agent Remote Console 完成什么 |
| --- | --- |
| 手机或浏览器 | 查找会话、恢复任务、发送指令、观察工具调用、追加消息和停止运行 |
| 自动化服务或 Webhook | 发现可用会话、向指定工作目录下发任务并消费结构化事件 |
| 另一个 AI Agent | 将 Agent Remote Console 作为 HTTP 工具，把编码任务委托给电脑上的 Codex、Claude Code 或 OpenCode |

这会形成两级 Agent 系统：第三方 API Agent 在远端负责规划和调度，电脑上的 coding agent 使用本地工具完成仓库工作，再把过程和结果返回。Agent Remote Console 控制的是受支持的 coding-agent 进程，不会自行获得无限制的桌面控制权；文件和命令权限仍由工作目录及显式“完全访问”开关决定。

## 60 秒启动

要求：macOS 或 Linux、Node.js 22.5+，并确保至少一个受支持的 CLI 已经位于 `PATH`。

```bash
git clone https://github.com/fadeoreo/agent-remote-console.git
cd agent-remote-console
corepack enable
pnpm install
REMOTE_PASSWORD='设置一个强密码' pnpm start
```

电脑上打开 `http://127.0.0.1:3001`。需要从可信私网中的手机访问时：

```bash
HOST=100.x.y.z PORT=3001 REMOTE_PASSWORD='设置一个强密码' pnpm start
```

将 `100.x.y.z` 替换为主机的 Tailscale 或私有 VPN 地址，手机也必须连接同一个 tailnet 或 VPN。可以运行 `tailscale ip -4` 查看电脑的 Tailscale IPv4 地址。没有额外安全层时，请勿监听公网地址。

## 推荐方案：搭配 Tailscale

需要在外面访问时，推荐使用 [Tailscale](https://tailscale.com/download) 连接 Agent Remote Console。它让手机、浏览器、自动化服务或另一个可信 Agent 直接访问电脑，同时不需要把控制台暴露到公网。

```text
手机 / 浏览器 / 可信远程 Agent
              |
       加密的 tailnet
              |
电脑上的 Agent Remote Console
              |
  Codex / Claude Code / OpenCode
```

1. 在运行 Agent Remote Console 的电脑和手机或远程控制端上安装 Tailscale。
2. 将设备登录到同一个 tailnet，并确认设备之间可以互相访问。
3. 生成稳定的密码哈希，不要在系统服务配置中保存明文密码：

   ```bash
   pnpm password -- '设置一个足够长且唯一的密码'
   ```

4. 只监听电脑的 Tailscale 地址：

   ```bash
   TAILSCALE_IP="$(tailscale ip -4)"
   HOST="$TAILSCALE_IP" PORT=3001 \
     REMOTE_PASSWORD_HASH='粘贴刚才生成的哈希' \
     pnpm start
   ```

5. 在手机上打开 `http://100.x.y.z:3001`。如果 tailnet 已启用 MagicDNS，也可以用电脑名称代替 IP 地址。

### Tailscale 最佳实践

- 即使进入 tailnet 已经需要身份认证，也应继续设置 `REMOTE_PASSWORD_HASH`。网络身份和应用登录保护的是不同层级。
- 使用 Tailscale Grants 或 ACL，将 TCP `3001` 端口限制为自己的用户、设备或控制端标签。
- 不要为这个服务启用 Tailscale Funnel。Funnel 会让服务可以从公网访问，超出了本项目的安全边界。
- 日常任务保持“完全访问”关闭；只有确实需要访问所选工作目录之外的文件时才临时开启。
- 使用日常开发账户运行服务，或者创建一个只能访问指定代码仓库的独立系统账户。
- Codex、Claude Code 和 OpenCode 的登录信息继续保留在电脑本机，Agent Remote Console 不需要这些 Provider 的 API Key。
- 第三方 Agent 的控制端也应加入同一个 tailnet，通过认证后的 HTTP API 调用，只在内存中保存登录 Cookie，并在控制台重启后重新登录。
- 恢复旧任务前先检查“目录缺失”提示；历史 Session 指向的工作目录可能已经被移动或删除。

## 核心能力

- 自动发现已有的 Codex、Claude Code 和 OpenCode 会话。
- 按工作目录树聚合，或按最近消息时间统一排序。
- 在原目录中恢复任务，并在 Provider 要求时自动 fork。
- 统一输出消息、思考、工具调用、错误和完成事件。
- 支持停止、后续消息队列、模型选择和显式完全访问。
- 只展示主机上真实安装的 Provider。
- 无前端构建步骤，界面支持中英文和手机浏览器。

## 面向 Agent 和自动化的 HTTP API

Web 界面使用的 JSON/SSE 接口也可以由可信的第三方服务调用。下面的示例会登录、选择最近活跃的 Session、向电脑上的 coding agent 下发任务，并持续读取事件流。需要安装 `curl` 和 `jq`。

```bash
AGENT_REMOTE_URL='http://127.0.0.1:3001'
AGENT_REMOTE_PASSWORD='设置一个强密码'
AGENT_REMOTE_COOKIE_JAR="$(mktemp -t agent-remote-console.XXXXXX)"

curl -sS -c "$AGENT_REMOTE_COOKIE_JAR" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg password "$AGENT_REMOTE_PASSWORD" '{password: $password}')" \
  "$AGENT_REMOTE_URL/api/login"

AGENT_REMOTE_SESSIONS="$(curl -sS -b "$AGENT_REMOTE_COOKIE_JAR" "$AGENT_REMOTE_URL/api/sessions?refresh=1")"
AGENT_REMOTE_SESSION_ID="$(jq -r '.sessions[0].id' <<<"$AGENT_REMOTE_SESSIONS")"
AGENT_REMOTE_CWD="$(jq -r '.sessions[0].cwd' <<<"$AGENT_REMOTE_SESSIONS")"

AGENT_REMOTE_RUN_ID="$(curl -sS -b "$AGENT_REMOTE_COOKIE_JAR" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n \
    --arg sessionId "$AGENT_REMOTE_SESSION_ID" \
    --arg cwd "$AGENT_REMOTE_CWD" \
    --arg prompt '检查失败的测试并提出修复方案。' \
    '{sessionId: $sessionId, cwd: $cwd, prompt: $prompt, fullAccess: false}')" \
  "$AGENT_REMOTE_URL/api/run" | jq -r '.runId')"

curl -N -b "$AGENT_REMOTE_COOKIE_JAR" \
  "$AGENT_REMOTE_URL/api/events/$AGENT_REMOTE_RUN_ID"
```

主要接口包括 `GET /api/sessions`、`GET /api/session/:id/history`、`POST /api/run`、`POST /api/message/:runId`、`GET /api/events/:runId` 和 `POST /api/stop/:runId`。目前程序调用使用与浏览器相同的内存 Session Cookie；它适合可信私网集成，但尚未提供独立 API Token 和版本化公共协议。

## Provider 支持

| 能力 | Codex | Claude Code | OpenCode |
| --- | --- | --- | --- |
| 发现本地会话 | 支持 | 支持 | 支持 |
| 读取对话历史 | 支持 | 支持 | 支持 |
| 在原工作目录恢复 | 支持 | 支持 | 支持 |
| 恢复方式 | 复用，忙碌时 fork | fork | fork |
| 流式消息与工具调用 | 支持 | 支持 | 支持 |
| 模型列表 | 内置 | 内置 | `opencode models` |
| 后续消息队列 | 支持 | 支持 | 支持 |
| 当前轮调整方向 | 实时 | 顺序队列 | 顺序队列 |

各 Provider 使用现有 CLI 安装与登录状态。未安装的 CLI 不会出现在 API 和界面中。CLI 列出的模型仍可能因为凭据无效而失败，Agent Remote Console 会把实际错误显示在运行记录中。

### 当前验证状态

| Provider | 验证情况 |
| --- | --- |
| Codex | 已真实验证发现、历史、fork、app-server 执行和 SSE |
| OpenCode 1.17.18 | 已真实验证发现、模型、fork、SQLite 完成/错误和 SSE |
| Claude Code | 已验证发现与事件归一化；真实版本兼容矩阵待补齐 |

Codex app-server、Claude Code JSONL 和 OpenCode SQLite schema 都可能随上游版本变化。提交兼容性问题时请附带 CLI 版本。

## 工作原理

```text
浏览器界面
   |  带认证的 JSON API + Server-Sent Events
Agent Remote Console HTTP 服务
   |-- 登录、限流、队列、事件日志
   |-- 统一 Session 与事件协议
   `-- Provider 集成
         |-- Codex app-server 协议
         |-- Claude Code stream-json CLI + JSONL 历史
         `-- OpenCode JSON CLI + SQLite 历史
```

## 配置

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址 |
| `PORT` | `3001` | HTTP 端口 |
| `REMOTE_PASSWORD` | 启动时生成 | 本地开发用明文登录密码 |
| `REMOTE_PASSWORD_HASH` | 未设置 | `pnpm password` 生成的 scrypt 值 |
| `CODEX_BIN` | 从 `PATH` 解析 | 指定 Codex 可执行文件 |
| `CLAUDE_BIN` | 从 `PATH` 解析 | 指定 Claude Code 可执行文件 |
| `OPENCODE_BIN` | 从 `PATH` 解析 | 指定 OpenCode 可执行文件 |
| `CLAUDE_HOME` | `~/.claude` | Claude Code 数据目录 |
| `OPENCODE_DATA_HOME` | `~/.local/share/opencode` | OpenCode 数据目录 |
| `STATE_FILE` | `runtime/state.json` | 固定任务和目录覆盖 |
| `AGENT_REMOTE_CONSOLE_SOURCE` | 仓库根目录 | 自维护使用的额外工作目录 |

为了兼容已有安装，已弃用的 `SESSIONMUX_SOURCE` 和 `REMOTE_LITE_SOURCE` 仍然可用。

生成稳定密码哈希：

```bash
pnpm password -- '设置一个强密码'
REMOTE_PASSWORD_HASH='命令生成的salt:hash' pnpm start
```

未设置密码变量时，Agent Remote Console 每次启动都会生成一个随机密码并只在终端输出一次，不存在内置默认密码。

## 安全边界

- 只面向一个可信用户和可信私网。
- Cookie 使用 HTTP-only 与 `SameSite=Strict`。
- 登录失败会被限流，稳定密码哈希使用 scrypt。
- Markdown 使用 DOMPurify 清洗并受 CSP 保护。
- 同时只允许一个代理任务运行。
- 完全访问必须显式开启，并始终在输入区可见。

部署前请阅读 [SECURITY.md](SECURITY.md)。

## 开发

```bash
pnpm check
pnpm test
```

前端刻意保持无构建步骤。Provider 行为位于 `lib/providers.mjs`；共享 HTTP、队列、事件处理以及尚未抽离的 Codex app-server 逻辑位于 `server.mjs`。

## 路线图

- 完整的 macOS/Linux 服务安装和卸载流程。
- 三个 CLI 的版本化真实兼容矩阵。
- 将 Codex app-server 逻辑完整移入 Provider 边界。
- 自动化响应式截图和端到端浏览器测试。

## License

[MIT](LICENSE)
