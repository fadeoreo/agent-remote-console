#!/usr/bin/env node
import { createInterface } from 'node:readline';

if (!process.argv.includes('app-server')) process.exit(2);

const forkedId = '01b00000-0000-7000-8000-000000000001';
const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let turnCount = 0;

lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'fake-codex' } });
    return;
  }
  if (message.method === 'thread/fork') {
    if (
      message.params.sandbox !== 'danger-full-access'
      || message.params.model !== 'gpt-5.6-sol'
      || !message.params.runtimeWorkspaceRoots.some((root) => root.endsWith('/codex-remote-lite'))
    ) {
      send({ id: message.id, error: { code: -1, message: 'unexpected fork options' } });
      return;
    }
    send({ id: message.id, result: { thread: { id: forkedId } } });
    return;
  }
  if (message.method === 'thread/resume') {
    if (
      message.params.sandbox !== 'danger-full-access'
      || message.params.model !== 'gpt-5.6-sol'
      || !message.params.runtimeWorkspaceRoots.some((root) => root.endsWith('/codex-remote-lite'))
    ) {
      send({ id: message.id, error: { code: -1, message: 'unexpected resume options' } });
      return;
    }
    send({ id: message.id, error: { code: -32600, message: 'thread already has an active writer' } });
    return;
  }
  if (message.method === 'thread/name/set') {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === 'turn/start') {
    turnCount += 1;
    const turnId = `test-turn-${turnCount}`;
    console.error('worker quit: HTTP 410 Url is expired');
    console.error('worker quit: HTTP 403 Forbidden');
    send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } });
    send({ method: 'turn/started', params: { threadId: forkedId, turn: { id: turnId, status: 'inProgress' } } });
    send({
      method: 'item/completed',
      params: {
        threadId: forkedId,
        turnId,
        item: { type: 'agentMessage', id: `test-message-${turnCount}`, text: turnCount === 1 ? '**续接成功**' : '**队列成功**' },
      },
    });
    setTimeout(() => {
      send({
        method: 'turn/completed',
        params: { threadId: forkedId, turn: { id: turnId, status: 'completed', error: null } },
      });
    }, 150);
    return;
  }
  if (message.method === 'turn/steer') {
    send({ id: message.id, result: { turnId: message.params.expectedTurnId } });
    send({
      method: 'item/completed',
      params: {
        threadId: forkedId,
        turnId: message.params.expectedTurnId,
        item: { type: 'agentMessage', id: 'steer-message', text: '**收到引导**' },
      },
    });
  }
});
