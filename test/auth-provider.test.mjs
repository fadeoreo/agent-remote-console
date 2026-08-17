import assert from 'node:assert/strict';
import test from 'node:test';
import { encodePassword, verifyConfiguredPassword } from '../lib/auth.mjs';
import { normalizeCliEvent, providerById, providerStatus } from '../lib/providers.mjs';

test('password hashes verify without storing plaintext', async () => {
  const encoded = await encodePassword('a useful test password');
  const [salt, hash] = encoded.split(':');
  const config = { salt: Buffer.from(salt, 'hex'), hash: Buffer.from(hash, 'hex') };
  assert.equal(await verifyConfiguredPassword('a useful test password', config), true);
  assert.equal(await verifyConfiguredPassword('wrong password', config), false);
});

test('Claude Code stream events normalize to common events', () => {
  const events = normalizeCliEvent('claude', JSON.stringify({
    type: 'assistant',
    message: { content: [
      { type: 'text', text: 'Finished' },
      { type: 'tool_use', name: 'Edit', input: { file_path: 'README.md' } },
    ] },
  }));
  assert.deepEqual(events.map((event) => event.kind), ['message', 'tool']);
  assert.match(events[1].text, /README\.md/);
});

test('provider capabilities expose graceful queue fallback', () => {
  assert.equal(providerById('codex').capabilities.steer, true);
  assert.equal(providerById('claude').capabilities.steer, false);
  assert.equal(providerById('opencode').capabilities.queue, true);
});

test('provider detection does not advertise missing CLIs', async () => {
  const previousPath = process.env.PATH;
  process.env.PATH = '';
  try {
    const statuses = await providerStatus();
    assert.ok(statuses.every((provider) => provider.installed === false));
  } finally {
    process.env.PATH = previousPath;
  }
});
