import os from 'node:os';
import path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { access, open, readdir, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const home = os.homedir();
const claudeRoot = process.env.CLAUDE_HOME || path.join(home, '.claude');
const opencodeRoot = process.env.OPENCODE_DATA_HOME || path.join(home, '.local', 'share', 'opencode');

export const providers = [
  {
    id: 'codex',
    name: 'Codex',
    color: '#176b4d',
    capabilities: { resume: true, fork: true, steer: true, queue: true, effort: true },
    models: [
      { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'gpt-5.5', name: 'GPT-5.5', efforts: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'gpt-5.2', name: 'GPT-5.2', efforts: ['low', 'medium', 'high', 'xhigh'] },
    ],
    defaultModel: 'gpt-5.6-sol',
    defaultEffort: 'high',
  },
  {
    id: 'claude',
    name: 'Claude Code',
    color: '#b35438',
    capabilities: { resume: true, fork: true, steer: false, queue: true, effort: true },
    models: [
      { id: 'sonnet', name: 'Sonnet', efforts: ['low', 'medium', 'high'] },
      { id: 'opus', name: 'Opus', efforts: ['low', 'medium', 'high', 'max'] },
      { id: 'haiku', name: 'Haiku', efforts: ['low', 'medium'] },
    ],
    defaultModel: 'sonnet',
    defaultEffort: 'high',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    color: '#356b91',
    capabilities: { resume: true, fork: true, steer: false, queue: true, effort: false },
    models: [],
    defaultModel: '',
    defaultEffort: '',
  },
];

export function providerById(id) {
  return providers.find((provider) => provider.id === id);
}

async function executableOnPath(name) {
  const override = process.env[`${name.toUpperCase()}_BIN`];
  const candidates = override
    ? [override]
    : String(process.env.PATH || '').split(path.delimiter).map((directory) => path.join(directory, name));
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

export async function providerStatus(includeModels = false) {
  const binaries = await Promise.all(providers.map((provider) => executableOnPath(provider.id)));
  const statuses = providers.map((provider, index) => ({ ...provider, installed: Boolean(binaries[index]), binary: binaries[index] }));
  const opencode = statuses.find((provider) => provider.id === 'opencode');
  if (includeModels && opencode?.installed) {
    try {
      const { stdout } = await execFileAsync(opencode.binary, ['--pure', 'models'], { timeout: 8000, maxBuffer: 1024 * 1024 });
      opencode.models = stdout.split('\n').map((value) => value.trim()).filter(Boolean).map((id) => ({ id, name: id, efforts: [] }));
    } catch {}
  }
  return statuses;
}

async function walk(directory, suffix, output = []) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return output; }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(target, suffix, output);
    else if (entry.isFile() && entry.name.endsWith(suffix)) output.push(target);
  }
  return output;
}

async function readPrefix(filePath, maxBytes = 512 * 1024) {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((item) => item?.type === 'text').map((item) => item.text || '').join('\n');
}

function cleanTitle(value) {
  return String(value || '').replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, '').replace(/\s+/g, ' ').trim().slice(0, 90) || 'Untitled task';
}

async function directoryExists(directory) {
  try { return Boolean(directory) && (await stat(directory)).isDirectory(); } catch { return false; }
}

async function claudeSessions() {
  const files = await walk(path.join(claudeRoot, 'projects'), '.jsonl');
  const ranked = (await Promise.all(files.map(async (filePath) => ({ filePath, info: await stat(filePath) }))))
    .sort((a, b) => b.info.mtimeMs - a.info.mtimeMs).slice(0, 80);
  const sessions = [];
  for (const { filePath, info } of ranked) {
    let id = path.basename(filePath, '.jsonl');
    let cwd = '';
    let title = '';
    let firstPrompt = '';
    for (const line of (await readPrefix(filePath)).split('\n')) {
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      id = record.sessionId || id;
      cwd ||= record.cwd || '';
      if (record.type === 'ai-title') title = record.aiTitle || title;
      if (!firstPrompt && record.type === 'user') firstPrompt = textContent(record.message?.content);
    }
    sessions.push({
      id: `claude:${id}`,
      rawId: id,
      provider: 'claude',
      title: cleanTitle(title || firstPrompt),
      preview: cleanTitle(firstPrompt),
      cwd,
      cwdExists: await directoryExists(cwd),
      source: 'claude-code',
      updatedAt: info.mtime.toISOString(),
      filePath,
    });
  }
  return sessions;
}

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value); } catch { return fallback; }
}

async function opencodeSessions() {
  let database;
  try {
    database = new DatabaseSync(path.join(opencodeRoot, 'opencode.db'), { readOnly: true });
    const rows = database.prepare(`
      SELECT id, title, directory, model, time_updated
      FROM session WHERE time_archived IS NULL
      ORDER BY time_updated DESC LIMIT 80
    `).all();
    return await Promise.all(rows.map(async (row) => {
      const model = parseJson(row.model);
      return {
        id: `opencode:${row.id}`,
        rawId: row.id,
        provider: 'opencode',
        title: cleanTitle(row.title),
        preview: '',
        cwd: row.directory || '',
        cwdExists: await directoryExists(row.directory),
        source: 'opencode',
        model: model.providerID && model.id ? `${model.providerID}/${model.id}` : '',
        updatedAt: new Date(Number(row.time_updated)).toISOString(),
      };
    }));
  } catch {
    return [];
  } finally {
    database?.close();
  }
}

export async function listExternalSessions() {
  const [claude, opencode] = await Promise.all([claudeSessions(), opencodeSessions()]);
  return [...claude, ...opencode];
}

async function claudeHistory(session, limit) {
  const messages = [];
  const lines = createInterface({ input: createReadStream(session.filePath), crlfDelay: Infinity });
  for await (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.type !== 'user' && record.type !== 'assistant') continue;
    if (record.isSidechain) continue;
    const text = textContent(record.message?.content).trim();
    if (!text) continue;
    messages.push({ role: record.type === 'user' ? 'user' : 'assistant', text, timestamp: record.timestamp || null });
    if (messages.length > limit) messages.shift();
  }
  return messages;
}

function opencodeHistory(session, limit) {
  let database;
  try {
    database = new DatabaseSync(path.join(opencodeRoot, 'opencode.db'), { readOnly: true });
    const rows = database.prepare(`
      SELECT m.data AS message, p.data AS part, m.time_created
      FROM message m JOIN part p ON p.message_id = m.id
      WHERE m.session_id = ? ORDER BY m.time_created, p.id
    `).all(session.rawId);
    const messages = [];
    for (const row of rows) {
      const message = parseJson(row.message);
      const part = parseJson(row.part);
      if (part.type !== 'text' || !part.text?.trim()) continue;
      const previous = messages.at(-1);
      if (previous?.messageTime === row.time_created && previous.role === message.role) previous.text += `\n${part.text}`;
      else messages.push({ role: message.role === 'user' ? 'user' : 'assistant', text: part.text, timestamp: new Date(Number(row.time_created)).toISOString(), messageTime: row.time_created });
    }
    return messages.slice(-limit).map(({ messageTime, ...message }) => message);
  } catch {
    return [];
  } finally {
    database?.close();
  }
}

export async function readExternalHistory(session, limit = 60) {
  if (session.provider === 'claude') return claudeHistory(session, limit);
  if (session.provider === 'opencode') return opencodeHistory(session, limit);
  return [];
}

export async function cliCommand(session, prompt, options) {
  const binary = await executableOnPath(session.provider);
  if (!binary) throw new Error('PROVIDER_NOT_INSTALLED');
  if (session.provider === 'claude') {
    const args = ['-p', '--resume', session.rawId, '--fork-session', '--output-format', 'stream-json', '--verbose'];
    if (options.model) args.push('--model', options.model);
    if (options.effort) args.push('--effort', options.effort);
    args.push('--permission-mode', options.fullAccess ? 'bypassPermissions' : 'acceptEdits', prompt);
    return { binary, args };
  }
  const args = ['run', '--pure', '--session', session.rawId, '--fork', '--format', 'json'];
  if (options.model) args.push('--model', options.model);
  if (options.fullAccess) args.push('--auto');
  args.push(prompt);
  return { binary, args };
}

function claudeEvents(event) {
  if (event.type === 'system' && event.session_id) return [{ kind: 'session', sessionId: `claude:${event.session_id}` }];
  if (event.type === 'assistant') {
    return (event.message?.content || []).flatMap((item) => {
      if (item.type === 'text' && item.text) return [{ kind: 'message', text: item.text }];
      if (item.type === 'tool_use') return [{ kind: 'tool', title: item.name || 'Tool', text: JSON.stringify(item.input || {}, null, 2) }];
      if (item.type === 'thinking') return [{ kind: 'reasoning', text: item.thinking || '' }];
      return [];
    });
  }
  if (event.type === 'result' && event.is_error) return [{ kind: 'error', text: event.result || 'Claude Code failed' }];
  return [];
}

function opencodeEvents(event) {
  const type = event.type || event.part?.type;
  const part = event.part || event;
  const sessionId = event.sessionID || event.session_id || part.sessionID;
  const output = sessionId ? [{ kind: 'session', sessionId: `opencode:${sessionId}` }] : [];
  if ((type === 'text' || type === 'text-delta') && (part.text || part.delta)) output.push({ kind: 'message', text: part.text || part.delta });
  if (type === 'reasoning' && part.text) output.push({ kind: 'reasoning', text: part.text });
  if (type === 'tool' || type === 'tool_use' || type === 'tool-invocation') {
    output.push({ kind: 'tool', title: part.tool || part.name || 'Tool', text: JSON.stringify(part.input || part.state || {}, null, 2), status: part.status });
  }
  if (type === 'error') output.push({ kind: 'error', text: event.error?.message || event.message || 'OpenCode failed' });
  return output;
}

export function normalizeCliEvent(provider, line) {
  let event;
  try { event = JSON.parse(line); } catch { return line.trim() ? [{ kind: 'status', text: line.trim() }] : []; }
  return provider === 'claude' ? claudeEvents(event) : opencodeEvents(event);
}

export function readOpenCodeRunState(cwd, startedAt, seenPartIds) {
  let database;
  try {
    database = new DatabaseSync(path.join(opencodeRoot, 'opencode.db'), { readOnly: true });
    const session = database.prepare(`
      SELECT id FROM session
      WHERE directory = ? AND time_created >= ?
      ORDER BY time_created DESC LIMIT 1
    `).get(cwd, startedAt);
    if (!session) return { events: [], complete: false };
    const rows = database.prepare(`
      SELECT m.data AS message, p.id AS part_id, p.data AS part
      FROM message m JOIN part p ON p.message_id = m.id
      WHERE m.session_id = ? AND m.time_created >= ?
      ORDER BY m.time_created, p.id
    `).all(session.id, startedAt);
    const events = [];
    let complete = false;
    for (const row of rows) {
      const message = parseJson(row.message);
      const part = parseJson(row.part);
      if (Number(message.time?.created || 0) < startedAt) continue;
      if (part.type === 'step-finish' && message.role === 'assistant') complete = true;
      if (seenPartIds.has(row.part_id)) continue;
      if (message.role !== 'assistant') continue;
      if (part.type === 'text' && part.text) {
        seenPartIds.add(row.part_id);
        events.push({ kind: 'message', text: part.text });
      } else if (part.type === 'reasoning' && part.text) {
        seenPartIds.add(row.part_id);
        events.push({ kind: 'reasoning', text: part.text });
      }
      else if (part.type === 'tool') {
        seenPartIds.add(row.part_id);
        events.push({ kind: 'tool', title: part.tool || 'Tool', text: JSON.stringify(part.state?.input || {}, null, 2), status: part.state?.status });
      }
    }
    const errorRows = database.prepare(`
      SELECT data FROM event
      WHERE aggregate_id = ? AND type = 'message.updated.1'
      ORDER BY seq DESC LIMIT 20
    `).all(session.id);
    let error = '';
    for (const row of errorRows) {
      const info = parseJson(row.data).info;
      if (info?.role !== 'assistant' || Number(info.time?.created || 0) < startedAt || !info.error) continue;
      error = info.error.data?.message || info.error.message || info.error.name || 'OpenCode failed';
      break;
    }
    return { sessionId: `opencode:${session.id}`, events, complete, error };
  } catch {
    return { events: [], complete: false };
  } finally {
    database?.close();
  }
}
