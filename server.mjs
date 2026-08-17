import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import { authenticationConfig, verifyConfiguredPassword } from './lib/auth.mjs';
import {
  cliCommand,
  listExternalSessions,
  normalizeCliEvent,
  providerById,
  providerStatus,
  readOpenCodeRunState,
  readExternalHistory,
} from './lib/providers.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_FILE = path.join(ROOT, 'public', 'index.html');
const STATE_FILE = process.env.STATE_FILE || path.join(ROOT, 'runtime', 'state.json');
const RELOAD_MARKER = process.env.RELOAD_MARKER || path.join(ROOT, 'runtime', 'reload-ready.json');
const CODEX_HOME = path.join(os.homedir(), '.codex');
const SESSIONS_ROOT = path.join(CODEX_HOME, 'sessions');
const CODEX_STATE_DB = path.join(CODEX_HOME, 'state_5.sqlite');
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const CHILD_PATH = [...new Set([
  path.dirname(process.execPath),
  '/Applications/ChatGPT.app/Contents/Resources',
  ...String(process.env.PATH || '').split(path.delimiter),
  '/usr/bin', '/bin', '/usr/sbin', '/sbin',
].filter(Boolean))].join(path.delimiter);
const AGENT_REMOTE_CONSOLE_SOURCE = process.env.AGENT_REMOTE_CONSOLE_SOURCE
  || process.env.SESSIONMUX_SOURCE
  || process.env.REMOTE_LITE_SOURCE
  || ROOT;
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3001);
const APP_VERSION = '0.2.0';
const AUTH_CONFIG = authenticationConfig();
const COOKIE_NAME = 'codex_remote_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 256 * 1024;
const MODEL_OPTIONS = [
  { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'gpt-5.5', name: 'GPT-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'gpt-5.2', name: 'GPT-5.2', efforts: ['low', 'medium', 'high', 'xhigh'] },
];
const DEFAULT_MODEL = 'gpt-5.6-sol';
const DEFAULT_EFFORT = 'high';

const webSessions = new Map();
const loginAttempts = new Map();
const runs = new Map();
let activeRunId = null;
let restartRequested = false;
let restartTimer = null;
let sessionsCache = { at: 0, sessions: [], projects: [] };
let appState = { pinnedSessionId: null, cwdOverrides: {} };

try {
  appState = { ...appState, ...JSON.parse(await readFile(STATE_FILE, 'utf8')) };
} catch {}
appState.cwdOverrides ||= {};

const markedScript = await readFile(path.join(ROOT, 'public', 'vendor', 'marked.umd.js'));
const purifyScript = await readFile(path.join(ROOT, 'public', 'vendor', 'purify.min.js'));

function securityHeaders(contentType = 'application/json; charset=utf-8') {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
  };
}

function json(res, status, value, extra = {}) {
  res.writeHead(status, { ...securityHeaders(), ...extra });
  res.end(JSON.stringify(value));
}

function parseCookies(req) {
  const values = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) values[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return values;
}

function isAuthenticated(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  const session = token ? webSessions.get(token) : null;
  if (!session || session.expiresAt < Date.now()) {
    if (token) webSessions.delete(token);
    return false;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return true;
}

function requestIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function verifyPassword(password) {
  return verifyConfiguredPassword(password, AUTH_CONFIG);
}

async function walkSessionFiles(directory, output = []) {
  let entries = [];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await walkSessionFiles(target, output);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) output.push(target);
  }
  return output;
}

async function readPrefix(filePath, maxBytes = 384 * 1024) {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => item?.text || item?.input_text || '')
    .filter(Boolean)
    .join(' ');
}

function cleanTitle(value) {
  const text = String(value || '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 90) || '未命名任务';
}

async function parseSession(filePath, fileStat) {
  const prefix = await readPrefix(filePath);
  let meta = null;
  let title = '';
  for (const line of prefix.split('\n')) {
    if (!line) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (!meta && record.type === 'session_meta') meta = record.payload || {};
    if (!title && record.type === 'event_msg' && record.payload?.type === 'user_message') {
      title = record.payload.message || record.payload.text || '';
    }
    if (!title && record.type === 'response_item' && record.payload?.role === 'user') {
      title = textFromContent(record.payload.content);
    }
    if (meta && title) break;
  }
  const id = meta?.id || path.basename(filePath, '.jsonl').split('-').slice(-5).join('-');
  const cwd = typeof meta?.cwd === 'string' ? meta.cwd : '';
  let cwdExists = false;
  if (cwd) {
    try { cwdExists = (await stat(cwd)).isDirectory(); } catch {}
  }
  return {
    id,
    rawId: id,
    provider: 'codex',
    title: cleanTitle(title),
    cwd,
    cwdExists,
    source: meta?.source || 'unknown',
    updatedAt: fileStat.mtime.toISOString(),
    filePath,
    pinned: id === appState.pinnedSessionId,
  };
}

function readThreadMetadata() {
  const metadata = new Map();
  let database;
  try {
    database = new DatabaseSync(CODEX_STATE_DB, { readOnly: true });
    const rows = database.prepare(`
      SELECT id, title, name, first_user_message, preview, is_pinned
      FROM threads
      WHERE archived = 0
    `).all();
    for (const row of rows) metadata.set(row.id, row);
  } catch (error) {
    console.error('Unable to read Codex thread metadata:', error.message);
  } finally {
    database?.close();
  }
  return metadata;
}

async function listSessions(force = false) {
  if (!force && Date.now() - sessionsCache.at < 8000) return sessionsCache;
  const statuses = await providerStatus();
  const installedProviders = new Set(statuses.filter((provider) => provider.installed).map((provider) => provider.id));
  const files = installedProviders.has('codex') ? await walkSessionFiles(SESSIONS_ROOT) : [];
  const ranked = (await Promise.all(files.map(async (filePath) => ({ filePath, fileStat: await stat(filePath) }))))
    .sort((a, b) => b.fileStat.mtimeMs - a.fileStat.mtimeMs)
    .slice(0, 80);
  const sessions = [];
  const threadMetadata = readThreadMetadata();
  for (const item of ranked) {
    try {
      const session = await parseSession(item.filePath, item.fileStat);
      const metadata = threadMetadata.get(session.id);
      if (metadata) {
        session.title = cleanTitle(metadata.name || metadata.title || metadata.first_user_message || session.title);
        session.preview = cleanTitle(metadata.preview || metadata.first_user_message || '');
        session.codexPinned = Boolean(metadata.is_pinned);
      }
      const override = appState.cwdOverrides[session.id];
      if (typeof override === 'string' && override) {
        try {
          if ((await stat(override)).isDirectory()) {
            session.recordedCwd = session.cwd;
            session.cwd = override;
            session.cwdExists = true;
            session.cwdOverridden = true;
          }
        } catch {}
      }
      sessions.push(session);
    } catch {}
  }
  const externalSessions = (await listExternalSessions()).filter((session) => installedProviders.has(session.provider));
  for (const session of externalSessions) {
    session.pinned = session.id === appState.pinnedSessionId;
    const override = appState.cwdOverrides[session.id];
    if (typeof override === 'string' && override) {
      try {
        if ((await stat(override)).isDirectory()) {
          session.recordedCwd = session.cwd;
          session.cwd = override;
          session.cwdExists = true;
          session.cwdOverridden = true;
        }
      } catch {}
    }
    sessions.push(session);
  }
  const projects = [...new Set(sessions.filter((item) => item.cwdExists).map((item) => item.cwd))].sort();
  sessions.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  sessionsCache = { at: Date.now(), sessions, projects };
  return sessionsCache;
}

async function readConversation(filePath, limit = 60) {
  const messages = [];
  const lines = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.type !== 'event_msg') continue;
    const type = record.payload?.type;
    if (type !== 'user_message' && type !== 'agent_message') continue;
    const text = String(record.payload?.message || record.payload?.text || '').trim();
    if (!text) continue;
    messages.push({
      role: type === 'user_message' ? 'user' : 'assistant',
      text,
      timestamp: record.timestamp || null,
    });
    if (messages.length > limit) messages.shift();
  }
  return messages;
}

function pushRunEvent(run, event) {
  const wrapped = { id: run.nextEventId++, at: new Date().toISOString(), ...event };
  run.events.push(wrapped);
  if (run.events.length > 1000) run.events.shift();
  const payload = `id: ${wrapped.id}\ndata: ${JSON.stringify(wrapped)}\n\n`;
  for (const client of run.clients) client.write(payload);
}

function displayEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'thread.started') return { kind: 'status', text: '会话已恢复' };
  if (event.type === 'turn.started') return { kind: 'status', text: '开始处理' };
  if (event.type === 'turn.completed') return { kind: 'status', text: '处理完成', usage: event.usage || null };
  if (event.type === 'turn.failed') return { kind: 'error', text: event.error?.message || event.error || '处理失败' };
  if (event.type === 'error') return { kind: 'error', text: event.message || event.error || 'Codex 错误' };
  if (event.type !== 'item.completed') return null;
  const item = event.item || {};
  if (item.type === 'agent_message') return { kind: 'message', text: item.text || item.content || '' };
  if (item.type === 'reasoning') return { kind: 'reasoning', text: item.text || item.summary || '' };
  if (item.type === 'command_execution') {
    return { kind: 'tool', title: item.command || '命令', text: item.aggregated_output || item.output || '', status: item.status };
  }
  if (item.type === 'file_change') return { kind: 'tool', title: '文件修改', text: item.changes?.map?.((change) => change.path).join('\n') || '', status: item.status };
  if (item.type === 'mcp_tool_call') return { kind: 'tool', title: item.tool || item.name || '工具调用', text: item.result?.content || '', status: item.status };
  return null;
}

function displayAppServerItem(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.type === 'agentMessage') return { kind: 'message', text: item.text || '' };
  if (item.type === 'reasoning') {
    return { kind: 'reasoning', text: [...(item.summary || []), ...(item.content || [])].join('\n') };
  }
  if (item.type === 'commandExecution') {
    return { kind: 'tool', title: item.command || '命令', text: item.aggregatedOutput || '', status: item.status };
  }
  if (item.type === 'fileChange') {
    return { kind: 'tool', title: '文件修改', text: item.changes?.map?.((change) => change.path).join('\n') || '', status: item.status };
  }
  if (item.type === 'mcpToolCall') {
    const content = item.result?.content;
    return { kind: 'tool', title: item.tool || '工具调用', text: content ? JSON.stringify(content, null, 2) : '', status: item.status };
  }
  return null;
}

function completeRun(run, success, text, exitCode = success ? 0 : 1) {
  if (run.done) return;
  run.done = true;
  run.exitCode = exitCode;
  if (activeRunId === run.id) activeRunId = null;
  pushRunEvent(run, {
    kind: success ? 'complete' : 'error',
    text,
    done: true,
    sessionId: run.redirectSessionId || undefined,
  });
  for (const client of run.clients) client.end();
  run.clients.clear();
  sessionsCache.at = 0;
  setTimeout(() => runs.delete(run.id), 30 * 60 * 1000).unref();
  if (restartRequested) requestGracefulRestart();
}

function requestGracefulRestart() {
  restartRequested = true;
  if (activeRunId || restartTimer) return;
  restartTimer = setTimeout(() => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  }, 750);
  restartTimer.unref();
}

async function runWorkspaceRoots(cwd) {
  const roots = [cwd];
  if (AGENT_REMOTE_CONSOLE_SOURCE === cwd) return roots;
  try {
    if ((await stat(AGENT_REMOTE_CONSOLE_SOURCE)).isDirectory()) roots.push(AGENT_REMOTE_CONSOLE_SOURCE);
  } catch {}
  return roots;
}

function turnInput(text) {
  return [{ type: 'text', text: text.trim(), text_elements: [] }];
}

function startAppTurn(run, prompt) {
  if (run.done || run.stopRequested) return;
  run.completedTurn = null;
  run.turnActive = false;
  run.currentTurnId = null;
  const requestId = run.nextRequestId++;
  run.pendingTurnStartId = requestId;
  run.send({
    method: 'turn/start',
    id: requestId,
    params: {
      threadId: run.threadId,
      input: turnInput(prompt),
      cwd: run.cwd,
      runtimeWorkspaceRoots: run.workspaceRoots,
      approvalPolicy: 'never',
      model: run.model,
      effort: run.effort,
    },
  });
}

function pushQueueEvent(run, action, queueItem) {
  pushRunEvent(run, { kind: 'queue', action, queueItem });
}

function enqueueRunMessage(run, prompt, existingItem = null) {
  const queueItem = existingItem || { id: crypto.randomUUID(), prompt, createdAt: new Date().toISOString() };
  queueItem.prompt = prompt;
  run.queue.push(queueItem);
  pushQueueEvent(run, 'added', queueItem);
  return queueItem;
}

function takeQueueItem(run, itemId) {
  const index = run.queue.findIndex((item) => item.id === itemId);
  if (index < 0) return null;
  const [queueItem] = run.queue.splice(index, 1);
  pushQueueEvent(run, 'removed', queueItem);
  return queueItem;
}

function sendSteer(run, prompt, queueItem = null) {
  if (run.completedTurn && !run.turnActive) {
    if (queueItem) {
      run.queue.unshift(queueItem);
      pushQueueEvent(run, 'added', queueItem);
    } else {
      enqueueRunMessage(run, prompt);
    }
    maybeAdvanceRun(run);
    return;
  }
  if (!run.turnActive || !run.currentTurnId) {
    run.pendingSteers.push({ prompt, queueItem });
    return;
  }
  const requestId = run.nextRequestId++;
  run.steerRequests.set(requestId, { prompt, queueItem });
  run.send({
    method: 'turn/steer',
    id: requestId,
    params: {
      threadId: run.threadId,
      input: turnInput(prompt),
      expectedTurnId: run.currentTurnId,
    },
  });
}

function maybeAdvanceRun(run) {
  if (!run.completedTurn || run.steerRequests.size || run.pendingSteers.length) return;
  const turn = run.completedTurn;
  run.completedTurn = null;
  if (run.stopRequested || turn.status === 'interrupted') {
    completeRun(run, false, '已停止');
    run.child.stdin.end();
    return;
  }
  if (run.queue.length) {
    const queueItem = run.queue.shift();
    pushQueueEvent(run, 'removed', queueItem);
    pushRunEvent(run, { kind: 'status', text: `开始处理队列 · 剩余 ${run.queue.length}` });
    startAppTurn(run, queueItem.prompt);
    return;
  }
  if (turn.status === 'completed') completeRun(run, true, '已完成', 0);
  else completeRun(run, false, turn.error?.message || run.appTurnError || 'Codex 运行失败，请稍后重试');
  run.child.stdin.end();
}

async function activateRunThread(run, sourceSession, prompt, threadId, forked) {
  run.threadId = threadId;
  if (forked) {
    run.redirectSessionId = threadId;
    appState.cwdOverrides[threadId] = run.cwd;
    if (appState.pinnedSessionId === sourceSession.id) appState.pinnedSessionId = threadId;
    await saveState();
    sessionsCache.at = 0;
    pushRunEvent(run, { kind: 'status', text: '已切换到远程续接任务', sessionId: threadId });
    run.send({
      method: 'thread/name/set',
      id: run.nextRequestId++,
      params: { threadId, name: `远程续接 · ${sourceSession.title}`.slice(0, 90) },
    });
  } else {
    pushRunEvent(run, { kind: 'status', text: '已连接任务' });
  }
  startAppTurn(run, prompt);
}

async function startAppServerRun(run, sourceSession, prompt) {
  const child = spawn(CODEX_BIN, ['app-server', '--stdio'], {
    cwd: run.cwd,
    env: { ...process.env, PATH: CHILD_PATH },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  run.child = child;
  run.send = (message) => {
    if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const threadParams = {
    threadId: sourceSession.id,
    cwd: run.cwd,
    runtimeWorkspaceRoots: run.workspaceRoots,
    approvalPolicy: 'never',
    sandbox: run.sandboxMode,
    model: run.model,
    excludeTurns: true,
  };
  const stdout = createInterface({ input: child.stdout });
  stdout.on('line', async (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    try {
      if (message.id === 1 && message.result) {
        run.send({ method: 'initialized', params: {} });
        run.send({ method: 'thread/resume', id: 2, params: threadParams });
        return;
      }
      if (message.id === 2) {
        if (message.result?.thread?.id) {
          await activateRunThread(run, sourceSession, prompt, message.result.thread.id, false);
          return;
        }
        if (/active writer/i.test(message.error?.message || '')) {
          pushRunEvent(run, { kind: 'status', text: '原任务正在桌面使用，正在创建远程续接任务' });
          run.send({
            method: 'thread/fork',
            id: 3,
            params: { ...threadParams, deferGoalContinuation: true },
          });
          return;
        }
        run.appTurnError = message.error?.message || '无法恢复任务';
        child.stdin.end();
        return;
      }
      if (message.id === 3) {
        if (message.result?.thread?.id) {
          await activateRunThread(run, sourceSession, prompt, message.result.thread.id, true);
          return;
        }
        run.appTurnError = message.error?.message || '无法创建远程续接任务';
        child.stdin.end();
        return;
      }
      if (message.id === run.pendingTurnStartId) {
        run.pendingTurnStartId = null;
        if (message.error) {
          run.appTurnError = message.error.message;
          child.stdin.end();
          return;
        }
        run.currentTurnId = message.result?.turn?.id || run.currentTurnId;
        run.turnActive = message.result?.turn?.status === 'inProgress';
        if (run.turnActive) {
          const pending = run.pendingSteers.splice(0);
          for (const pendingSteer of pending) sendSteer(run, pendingSteer.prompt, pendingSteer.queueItem);
        }
        return;
      }
      if (run.steerRequests.has(message.id)) {
        const steer = run.steerRequests.get(message.id);
        run.steerRequests.delete(message.id);
        if (message.error) {
          enqueueRunMessage(run, steer.prompt, steer.queueItem);
          pushRunEvent(run, { kind: 'status', text: `当前轮次已结束，已转入队列 · ${run.queue.length}` });
        } else {
          pushRunEvent(run, { kind: 'status', text: '已引导当前轮次' });
        }
        maybeAdvanceRun(run);
        return;
      }
      if (message.method === 'turn/started') {
        run.currentTurnId = message.params?.turn?.id || run.currentTurnId;
        run.turnActive = true;
        pushRunEvent(run, { kind: 'status', text: '开始处理' });
        const pending = run.pendingSteers.splice(0);
        for (const pendingSteer of pending) sendSteer(run, pendingSteer.prompt, pendingSteer.queueItem);
        return;
      }
      if (message.method === 'item/completed') {
        const shown = displayAppServerItem(message.params?.item);
        if (shown && (shown.text || shown.title)) pushRunEvent(run, shown);
        return;
      }
      if (message.method === 'turn/completed') {
        run.turnActive = false;
        run.completedTurn = message.params?.turn || { status: 'failed' };
        run.appTurnError = message.params?.turn?.error?.message || run.appTurnError;
        maybeAdvanceRun(run);
      }
    } catch (error) {
      run.appTurnError = error.message;
      child.stdin.end();
    }
  });
  createInterface({ input: child.stderr }).on('line', () => {});
  child.on('error', (error) => { run.appTurnError = error.message; });
  child.on('close', (code, signal) => {
    if (run.done) return;
    if (run.stopRequested || signal) return completeRun(run, false, '已停止', code ?? 1);
    completeRun(run, false, run.appTurnError || 'Codex 连接中断，请稍后重试', code ?? 1);
  });
  run.send({
    method: 'initialize',
    id: 1,
    params: {
      clientInfo: { name: 'agent-remote-console', title: 'Agent Remote Console', version: APP_VERSION },
      capabilities: { experimentalApi: true, requestAttestation: false },
    },
  });
}

async function startCliTurn(run, prompt) {
  if (run.done || run.stopRequested) return;
  const command = await cliCommand(run.activeSession, prompt, {
    model: run.model,
    effort: run.effort,
    fullAccess: run.fullAccess,
  });
  const child = spawn(command.binary, command.args, {
    cwd: run.cwd,
    env: { ...process.env, PATH: CHILD_PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  run.child = child;
  run.turnActive = true;
  run.turnStartedAt = Date.now();
  run.providerCompleteSeenAt = null;
  pushRunEvent(run, { kind: 'status', text: `正在连接 ${providerById(run.provider).name}` });

  const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
  stdout.on('line', (line) => {
    for (const event of normalizeCliEvent(run.provider, line)) {
      if (event.kind === 'session' && event.sessionId) {
        if (event.sessionId !== run.activeSession.id) {
          run.redirectSessionId = event.sessionId;
          run.activeSession = { ...run.activeSession, id: event.sessionId, rawId: event.sessionId.split(':').slice(1).join(':') };
        }
        continue;
      }
      if (event.text || event.title) pushRunEvent(run, event);
    }
  });
  createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', (line) => {
    if (line.trim()) run.lastStderr = line.trim();
  });
  child.on('error', (error) => { run.lastStderr = error.message; });
  if (run.provider === 'opencode') {
    const seenPartIds = new Set();
    run.providerPoll = setInterval(() => {
      if (run.done || run.stopRequested) return clearInterval(run.providerPoll);
      const state = readOpenCodeRunState(run.cwd, run.turnStartedAt, seenPartIds);
      if (state.sessionId && state.sessionId !== run.activeSession.id) {
        run.redirectSessionId = state.sessionId;
        run.activeSession = { ...run.activeSession, id: state.sessionId, rawId: state.sessionId.slice('opencode:'.length) };
      }
      for (const event of state.events) pushRunEvent(run, event);
      if (state.error) {
        clearInterval(run.providerPoll);
        run.providerPoll = null;
        run.providerError = state.error;
        child.kill('SIGTERM');
        return;
      }
      if (!state.complete) return;
      if (!run.providerCompleteSeenAt) {
        run.providerCompleteSeenAt = Date.now();
        return;
      }
      if (Date.now() - run.providerCompleteSeenAt < 1000) return;
      clearInterval(run.providerPoll);
      run.providerPoll = null;
      run.providerCompleted = true;
      child.kill('SIGTERM');
    }, 500);
    run.providerPoll.unref();
  }
  child.on('close', async (code, signal) => {
    run.turnActive = false;
    if (run.providerPoll) {
      clearInterval(run.providerPoll);
      run.providerPoll = null;
    }
    if (run.done) return;
    if (run.providerError) {
      const error = run.providerError;
      run.providerError = null;
      return completeRun(run, false, error, code ?? 1);
    }
    if (run.providerCompleted) {
      run.providerCompleted = false;
      if (run.queue.length) {
        const queueItem = run.queue.shift();
        pushQueueEvent(run, 'removed', queueItem);
        pushRunEvent(run, { kind: 'status', text: `开始处理队列 · 剩余 ${run.queue.length}` });
        try { await startCliTurn(run, queueItem.prompt); }
        catch (error) { completeRun(run, false, error.message); }
        return;
      }
      return completeRun(run, true, '已完成', 0);
    }
    if (run.stopRequested || signal) return completeRun(run, false, '已停止', code ?? 1);
    if (code !== 0) return completeRun(run, false, run.lastStderr || `${providerById(run.provider).name} 运行失败`, code ?? 1);
    if (run.queue.length) {
      const queueItem = run.queue.shift();
      pushQueueEvent(run, 'removed', queueItem);
      pushRunEvent(run, { kind: 'status', text: `开始处理队列 · 剩余 ${run.queue.length}` });
      try { await startCliTurn(run, queueItem.prompt); }
      catch (error) { completeRun(run, false, error.message); }
      return;
    }
    completeRun(run, true, '已完成', 0);
  });
}

function addRunMessage(run, prompt) {
  const queueItem = enqueueRunMessage(run, prompt);
  pushRunEvent(run, { kind: 'status', text: `已加入队列 · ${run.queue.length}` });
  return queueItem;
}

async function resolveRunDirectory(session, requestedCwd) {
  const candidate = requestedCwd || session.cwd;
  if (!candidate) throw new Error('WORKSPACE_REQUIRED');
  let resolved;
  try { resolved = await realpath(candidate); } catch { throw new Error('WORKSPACE_MISSING'); }
  if (!(await stat(resolved)).isDirectory()) throw new Error('WORKSPACE_MISSING');
  return resolved;
}

async function startRun(sessionId, prompt, requestedCwd, requestedOptions = {}) {
  if (activeRunId) throw new Error('RUN_ACTIVE');
  const data = await listSessions(true);
  const session = data.sessions.find((item) => item.id === sessionId);
  if (!session) throw new Error('SESSION_NOT_FOUND');
  const cwd = await resolveRunDirectory(session, requestedCwd);
  const provider = providerById(session.provider || 'codex');
  if (!provider) throw new Error('PROVIDER_NOT_FOUND');
  const modelOption = provider.models.find((item) => item.id === requestedOptions.model);
  const model = modelOption?.id || requestedOptions.model || session.model || provider.defaultModel;
  const efforts = modelOption?.efforts || ['low', 'medium', 'high', 'xhigh', 'max'];
  const effort = efforts.includes(requestedOptions.effort) ? requestedOptions.effort : provider.defaultEffort;
  const fullAccess = requestedOptions.fullAccess === true;
  const sandboxMode = fullAccess ? 'danger-full-access' : 'workspace-write';
  const workspaceRoots = await runWorkspaceRoots(cwd);
  if (requestedCwd && requestedCwd !== appState.cwdOverrides[sessionId]) {
    appState.cwdOverrides[sessionId] = cwd;
    await saveState();
  }
  const runId = crypto.randomUUID();
  const run = {
    id: runId,
    sessionId,
    provider: provider.id,
    activeSession: session,
    cwd,
    child: null,
    clients: new Set(),
    events: [],
    done: false,
    exitCode: null,
    startedAt: Date.now(),
    mode: 'app-server',
    stopRequested: false,
    redirectSessionId: null,
    appTurnError: null,
    model,
    effort,
    fullAccess,
    sandboxMode,
    workspaceRoots,
    nextEventId: 1,
    nextRequestId: 10,
    threadId: null,
    currentTurnId: null,
    pendingTurnStartId: null,
    turnActive: false,
    completedTurn: null,
    queue: [],
    pendingSteers: [],
    steerRequests: new Map(),
  };
  runs.set(runId, run);
  activeRunId = runId;
  if (provider.id === 'codex') {
    pushRunEvent(run, { kind: 'status', text: '正在连接 Codex' });
    await startAppServerRun(run, session, prompt);
  } else {
    await startCliTurn(run, prompt);
  }
  return run;
}

async function saveState() {
  await mkdir(path.dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, `${JSON.stringify(appState, null, 2)}\n`, { mode: 0o600 });
}

function routeNotFound(res) {
  json(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || HOST}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, securityHeaders('text/html; charset=utf-8'));
      return res.end(await readFile(PUBLIC_FILE, 'utf8'));
    }
    if (req.method === 'GET' && url.pathname === '/vendor/marked.umd.js') {
      res.writeHead(200, securityHeaders('application/javascript; charset=utf-8'));
      return res.end(markedScript);
    }
    if (req.method === 'GET' && url.pathname === '/vendor/purify.min.js') {
      res.writeHead(200, securityHeaders('application/javascript; charset=utf-8'));
      return res.end(purifyScript);
    }
    if (req.method === 'GET' && url.pathname === '/api/auth') {
      return json(res, 200, { authenticated: isAuthenticated(req) });
    }
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, { status: 'ok', version: APP_VERSION });
    }
    if (req.method === 'POST' && url.pathname === '/api/login') {
      const ip = requestIp(req);
      const attempt = loginAttempts.get(ip) || { failures: 0, blockedUntil: 0 };
      if (attempt.blockedUntil > Date.now()) return json(res, 429, { error: '请稍后再试' });
      const body = await readJsonBody(req);
      if (!(await verifyPassword(body.password))) {
        attempt.failures += 1;
        if (attempt.failures >= 5) attempt.blockedUntil = Date.now() + 5 * 60 * 1000;
        loginAttempts.set(ip, attempt);
        return json(res, 401, { error: '密码错误' });
      }
      loginAttempts.delete(ip);
      const token = crypto.randomBytes(32).toString('base64url');
      webSessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
      return json(res, 200, { success: true }, {
        'Set-Cookie': `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
      });
    }
    if (!isAuthenticated(req)) return json(res, 401, { error: 'Unauthorized' });
    if (req.method === 'POST' && url.pathname === '/api/logout') {
      const token = parseCookies(req)[COOKIE_NAME];
      if (token) webSessions.delete(token);
      return json(res, 200, { success: true }, { 'Set-Cookie': `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
    }
    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      const data = await listSessions(url.searchParams.get('refresh') === '1');
      const activeRun = activeRunId ? runs.get(activeRunId) : null;
      return json(res, 200, {
        sessions: data.sessions,
        projects: data.projects,
        activeRunId,
        activeRun: activeRun ? {
          id: activeRun.id,
          sessionId: activeRun.sessionId,
          provider: activeRun.provider,
          redirectSessionId: activeRun.redirectSessionId,
          queueLength: activeRun.queue.length,
          queue: activeRun.queue,
        } : null,
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/options') {
      const availableProviders = await providerStatus(true);
      return json(res, 200, {
        models: MODEL_OPTIONS,
        defaultModel: DEFAULT_MODEL,
        defaultEffort: DEFAULT_EFFORT,
        providers: availableProviders,
        agentRemoteConsoleSource: AGENT_REMOTE_CONSOLE_SOURCE,
        sessionMuxSource: AGENT_REMOTE_CONSOLE_SOURCE,
        remoteLiteSource: AGENT_REMOTE_CONSOLE_SOURCE,
      });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/session/') && url.pathname.endsWith('/history')) {
      const sessionId = url.pathname.split('/')[3];
      const data = await listSessions(true);
      const session = data.sessions.find((item) => item.id === sessionId);
      if (!session) return json(res, 404, { error: '找不到任务' });
      const messages = session.provider === 'codex'
        ? await readConversation(session.filePath)
        : await readExternalHistory(session);
      return json(res, 200, { session, messages });
    }
    if (req.method === 'POST' && url.pathname === '/api/pin') {
      const body = await readJsonBody(req);
      appState.pinnedSessionId = typeof body.sessionId === 'string' ? body.sessionId : null;
      await saveState();
      sessionsCache.at = 0;
      return json(res, 200, { success: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/workspace') {
      const body = await readJsonBody(req);
      const data = await listSessions(true);
      const session = data.sessions.find((item) => item.id === body.sessionId);
      if (!session) return json(res, 404, { error: '找不到任务' });
      let workspace;
      try { workspace = await resolveRunDirectory(session, body.cwd); }
      catch { return json(res, 409, { error: '工作目录不存在' }); }
      appState.cwdOverrides[session.id] = workspace;
      await saveState();
      sessionsCache.at = 0;
      return json(res, 200, { success: true, cwd: workspace });
    }
    if (req.method === 'POST' && url.pathname === '/api/run') {
      const body = await readJsonBody(req);
      if (!body.sessionId || !String(body.prompt || '').trim()) return json(res, 400, { error: '请选择任务并输入指令' });
      try {
        const run = await startRun(body.sessionId, body.prompt, body.cwd, {
          model: body.model,
          effort: body.effort,
          fullAccess: body.fullAccess,
        });
        return json(res, 202, { runId: run.id });
      } catch (error) {
        const messages = {
          RUN_ACTIVE: '已有任务正在运行',
          SESSION_NOT_FOUND: '找不到任务',
          WORKSPACE_REQUIRED: '请选择工作目录',
          WORKSPACE_MISSING: '工作目录不存在，请重新选择',
        };
        return json(res, 409, { error: messages[error.message] || error.message });
      }
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/message/')) {
      const runId = url.pathname.split('/').pop();
      const run = runs.get(runId);
      if (!run || run.done) return json(res, 404, { error: '没有正在运行的任务' });
      const body = await readJsonBody(req);
      const prompt = String(body.prompt || '').trim();
      if (!prompt) return json(res, 400, { error: '请输入指令' });
      const queueItem = addRunMessage(run, prompt);
      return json(res, 202, { success: true, queueItem, queueLength: run.queue.length });
    }
    if (url.pathname.startsWith('/api/queue/')) {
      const parts = url.pathname.split('/');
      const run = runs.get(parts[3]);
      const itemId = parts[4];
      if (!run || run.done) return json(res, 404, { error: '没有正在运行的任务' });
      const queueItem = run.queue.find((item) => item.id === itemId);
      if (!queueItem) return json(res, 404, { error: '消息已开始处理或不存在' });
      if (req.method === 'POST' && parts[5] === 'steer') {
        if (run.provider !== 'codex') return json(res, 409, { error: '当前工具不支持运行中调整；消息会按队列顺序处理' });
        takeQueueItem(run, itemId);
        sendSteer(run, queueItem.prompt, queueItem);
        pushRunEvent(run, { kind: 'status', text: run.turnActive ? '正在调整当前方向' : '连接后将调整方向' });
        return json(res, 202, { success: true });
      }
      if (req.method === 'DELETE') {
        takeQueueItem(run, itemId);
        return json(res, 200, { success: true });
      }
      if (req.method === 'PATCH') {
        const body = await readJsonBody(req);
        const prompt = String(body.prompt || '').trim();
        if (!prompt) return json(res, 400, { error: '请输入指令' });
        queueItem.prompt = prompt;
        pushQueueEvent(run, 'updated', queueItem);
        return json(res, 200, { success: true, queueItem });
      }
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/events/')) {
      const runId = url.pathname.split('/').pop();
      const run = runs.get(runId);
      if (!run) return json(res, 404, { error: '运行记录不存在' });
      res.writeHead(200, {
        ...securityHeaders('text/event-stream; charset=utf-8'),
        Connection: 'keep-alive',
      });
      const lastEventId = Number(req.headers['last-event-id'] || url.searchParams.get('after') || 0);
      res.write('retry: 2000\n\n');
      for (const event of run.events) {
        if (event.id > lastEventId) res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      if (run.done) return res.end();
      run.clients.add(res);
      const keepAlive = setInterval(() => res.write(': keepalive\n\n'), 15000);
      req.on('close', () => {
        clearInterval(keepAlive);
        run.clients.delete(res);
      });
      return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/stop/')) {
      const runId = url.pathname.split('/').pop();
      const run = runs.get(runId);
      if (!run || run.done) return json(res, 404, { error: '没有正在运行的任务' });
      run.stopRequested = true;
      run.queue.length = 0;
      run.pendingSteers.length = 0;
      run.child?.kill('SIGINT');
      setTimeout(() => { if (!run.done) run.child?.kill('SIGTERM'); }, 5000).unref();
      return json(res, 200, { success: true });
    }
    routeNotFound(res);
  } catch (error) {
    const status = error.message === 'BODY_TOO_LARGE' ? 413 : 500;
    json(res, status, { error: status === 500 ? '服务错误' : '请求过大' });
    console.error(error);
  }
});

server.listen(PORT, HOST, async () => {
  await mkdir(path.dirname(RELOAD_MARKER), { recursive: true });
  await writeFile(RELOAD_MARKER, `${JSON.stringify({ pid: process.pid, protocol: 1 })}\n`);
  console.log(`Agent Remote Console listening on http://${HOST}:${PORT}`);
  if (AUTH_CONFIG.source === 'generated') {
    console.log(`One-time startup password: ${AUTH_CONFIG.password}`);
    console.log('Set REMOTE_PASSWORD_HASH for a stable password. See README.md.');
  }
});

function shutdown() {
  if (activeRunId) runs.get(activeRunId)?.child?.kill('SIGINT');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', requestGracefulRestart);
