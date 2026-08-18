# Agent Remote Console Launch Kit

This is the copy deck for the first public launch. Adapt the opening sentence to each community; do not cross-post the same block verbatim.

## Positioning

**One-line:** Your coding agents stay local. Your browser becomes the private control surface.

**中文一句话：** Coding Agent 继续在自己的电脑上运行，手机和浏览器只是私有控制面板。

**What we are:** A provider-neutral control plane for existing local Codex, Claude Code, and OpenCode sessions.

**What we are not:** An official OpenAI, Anthropic, or OpenCode client; a public remote desktop; a cloud API-key proxy; or a multi-tenant service.

## X Launch Thread

### Post 1

Your coding agent is already running on your computer.

Agent Remote Console gives it a private browser control surface: find a local session, resume it, watch tools, queue the next instruction, and stop a run from your phone.

Self-hosted. Provider-neutral. No API-key proxy.

https://github.com/fadeoreo/agent-remote-console

### Post 2

The useful part is the control plane, not another chat UI:

- existing Codex, Claude Code, and OpenCode sessions
- workspace-based session discovery
- live JSON/SSE events for agents and automation
- Tailscale-friendly private networking
- unavailable providers stay out of the UI

The work still runs with the CLI's local credentials and filesystem permissions.

### Post 3

This is intentionally a focused single-user tool, not a public SaaS.

Keep it on loopback or a trusted private network. Keep full-access mode explicit. Treat the HTTP API as a private integration surface.

Feedback on CLI versions, WSL2, Tailscale, and provider compatibility is welcome.

## XHS 图文发布

### 标题

我给本机 Coding Agent 做了一个手机控制台

### 正文

离开电脑以后，Codex、Claude Code、OpenCode 正在跑的任务怎么办？

我做了 Agent Remote Console：

1. 发现电脑上已有的 Agent Session
2. 按工作目录整理任务
3. 从手机继续上下文
4. 查看实时工具调用和执行进度
5. 追加指令、排队或停止任务

任务仍然运行在自己的电脑上，继续使用本机 CLI 的登录状态、文件权限和工具链。手机只是通过 Tailscale 等私网连接控制台，不把 API Key 搬到云端。

目前支持 Codex、Claude Code、OpenCode。它不是官方客户端，也不是公网远程桌面，更适合独立开发者、家庭服务器和需要调度本地 Agent 的开发者。

项目地址：
https://github.com/fadeoreo/agent-remote-console

建议配图：一张桌面工作目录树、一张 1080×1920 手机执行中页面、一张“手机 → Tailscale → 本机 Agent”的架构图。

## Reddit / Hacker News

### Title

I built a self-hosted browser control plane for local coding-agent sessions

### Body

I wanted to continue a coding-agent task after leaving my desk without moving the repository, credentials, or execution environment to a cloud service.

Agent Remote Console is a small self-hosted HTTP/SSE console for existing Codex, Claude Code, and OpenCode sessions. It discovers sessions by workspace, resumes them in context, streams tool activity, queues follow-ups, and exposes the same private API to another trusted agent or automation service.

The provider CLI still runs on the local computer with its existing authentication and filesystem permissions. The console is intended for loopback or a private network such as Tailscale; it is not a public remote desktop or a multi-tenant service.

Current verification is strongest for Codex and OpenCode. Claude Code discovery and event normalization are covered, while the live compatibility matrix is still being expanded. Native Windows is not supported yet; Windows users should use WSL2.

Repository: https://github.com/fadeoreo/agent-remote-console

I would especially value reports with the provider CLI version, operating system, and whether the session was discovered, resumed, and completed successfully.

## Short Descriptions

### GitHub

Self-hosted, mobile-first control plane for local Codex, Claude Code, and OpenCode sessions. Resume work by workspace, stream tools, and dispatch tasks over a private HTTP/SSE API.

### X Bio / Profile Blurb

Private control plane for local coding agents. Codex · Claude Code · OpenCode · Tailscale · HTTP/SSE.

## Posting Rules

- Link to GitHub as the source of truth; do not use a link shortener for the first launch.
- Mention the private-network boundary in every platform-specific version.
- Never claim official affiliation or unrestricted desktop control.
- Include the tested CLI version when showing a live run.
- Redact usernames, absolute paths, session IDs, prompts, repository names, and credentials from screenshots.
- Reply to installation and compatibility questions with facts and links, not hype.
