import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const stateDirectory = await mkdtemp(path.join(tmpdir(), 'codex-remote-lite-test-'));
const port = 31991;
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: root,
  env: {
    ...process.env,
    PATH: path.dirname(process.execPath),
    HOST: '127.0.0.1',
    PORT: String(port),
    CODEX_BIN: path.join(root, 'test', 'fake-codex.mjs'),
    STATE_FILE: path.join(stateDirectory, 'state.json'),
    RELOAD_MARKER: path.join(stateDirectory, 'reload-ready.json'),
    REMOTE_PASSWORD: 'qwer12',
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});

try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server start timed out')), 5000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('listening')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once('exit', (code) => reject(new Error(`server exited with ${code}`)));
  });

  const healthResponse = await fetch(`${origin}/api/health`);
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), { status: 'ok', version: '0.2.0' });

  const login = await fetch(`${origin}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'qwer12' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  const headers = { Cookie: cookie, 'Content-Type': 'application/json' };

  const optionsResponse = await fetch(`${origin}/api/options`, { headers });
  const options = await optionsResponse.json();
  assert.equal(options.defaultModel, 'gpt-5.6-sol');
  assert.equal(options.defaultEffort, 'high');
  assert.deepEqual(options.providers.map((provider) => provider.id), ['codex', 'claude', 'opencode']);
  assert.deepEqual(options.providers.map((provider) => provider.installed), [true, false, false]);

  const sessionsResponse = await fetch(`${origin}/api/sessions?refresh=1`, { headers });
  const sessions = await sessionsResponse.json();
  assert.ok(sessions.sessions.every((item) => item.provider === 'codex'));
  const session = sessions.sessions.find((item) => item.provider === 'codex' && item.cwdExists);
  assert.ok(session, 'expected at least one session with a valid workspace');

  const runResponse = await fetch(`${origin}/api/run`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      sessionId: session.id,
      prompt: '测试续接',
      cwd: session.cwd,
      model: 'gpt-5.6-sol',
      effort: 'high',
      fullAccess: true,
    }),
  });
  assert.equal(runResponse.status, 202);
  const { runId } = await runResponse.json();
  const eventsResponse = await fetch(`${origin}/api/events/${runId}`, { headers });
  const steerResponse = await fetch(`${origin}/api/message/${runId}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ prompt: '补充引导' }),
  });
  assert.equal(steerResponse.status, 202);
  const steerItem = (await steerResponse.json()).queueItem;
  const convertResponse = await fetch(`${origin}/api/queue/${runId}/${steerItem.id}/steer`, {
    method: 'POST',
    headers,
  });
  assert.equal(convertResponse.status, 202);
  const queueResponse = await fetch(`${origin}/api/message/${runId}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ prompt: '下一条任务' }),
  });
  assert.equal(queueResponse.status, 202);
  const queueItem = (await queueResponse.json()).queueItem;
  const editResponse = await fetch(`${origin}/api/queue/${runId}/${queueItem.id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ prompt: '编辑后的下一条任务' }),
  });
  assert.equal(editResponse.status, 200);
  const deleteCandidateResponse = await fetch(`${origin}/api/message/${runId}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ prompt: '应被删除' }),
  });
  const deleteCandidate = (await deleteCandidateResponse.json()).queueItem;
  const deleteResponse = await fetch(`${origin}/api/queue/${runId}/${deleteCandidate.id}`, { method: 'DELETE', headers });
  assert.equal(deleteResponse.status, 200);
  const reader = eventsResponse.body.getReader();
  const decoder = new TextDecoder();
  let eventStream = '';
  while (!eventStream.includes('"done":true')) {
    const { value, done } = await reader.read();
    if (done) break;
    eventStream += decoder.decode(value, { stream: true });
  }
  await reader.cancel();

  assert.match(eventStream, /正在创建远程续接任务/);
  assert.match(eventStream, /已切换到远程续接任务/);
  assert.match(eventStream, /续接成功/);
  assert.match(eventStream, /收到引导/);
  assert.match(eventStream, /已加入队列/);
  assert.match(eventStream, /队列成功/);
  assert.match(eventStream, /"kind":"queue","action":"added"/);
  assert.match(eventStream, /"kind":"queue","action":"updated"/);
  assert.match(eventStream, /"kind":"queue","action":"removed"/);
  assert.match(eventStream, /编辑后的下一条任务/);
  assert.doesNotMatch(eventStream, /应被删除.*队列成功/);
  assert.match(eventStream, /01b00000-0000-7000-8000-000000000001/);
  assert.doesNotMatch(eventStream, /active writer/);
  assert.doesNotMatch(eventStream, /temporary persistence error/);
  assert.doesNotMatch(eventStream, /Url is expired/);
  assert.doesNotMatch(eventStream, /Forbidden/);
  assert.match(eventStream, /"done":true/);
  assert.match(eventStream, /^id: 1$/m);

  const replayResponse = await fetch(`${origin}/api/events/${runId}`, {
    headers: { ...headers, 'Last-Event-ID': '2' },
  });
  const replay = await replayResponse.text();
  const replayedIds = [...replay.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
  assert.ok(replayedIds.length > 0);
  assert.ok(replayedIds.every((id) => id > 2));
  console.log('remote fork fallback passed');
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  await rm(stateDirectory, { recursive: true, force: true });
}
