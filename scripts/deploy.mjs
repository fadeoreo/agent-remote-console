#!/usr/bin/env node
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtimeRoot = path.join(process.env.HOME, '.local', 'share', 'codex-remote-lite');
const label = `gui/${process.getuid()}/ai.codex.remote-lite`;

function launchctl(...args) {
  return execFileSync('/bin/launchctl', args, { encoding: 'utf8' });
}

function servicePid() {
  try {
    const output = launchctl('print', label);
    const match = output.match(/^\s*pid = (\d+)$/m);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function hasActiveChild(pid) {
  try {
    const output = execFileSync('/usr/bin/pgrep', ['-P', String(pid)], { encoding: 'utf8' });
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

await mkdir(path.join(runtimeRoot, 'public', 'vendor'), { recursive: true });
await mkdir(path.join(runtimeRoot, 'lib'), { recursive: true });
await Promise.all([
  copyFile(path.join(sourceRoot, 'server.mjs'), path.join(runtimeRoot, 'server.mjs')),
  copyFile(path.join(sourceRoot, 'lib', 'auth.mjs'), path.join(runtimeRoot, 'lib', 'auth.mjs')),
  copyFile(path.join(sourceRoot, 'lib', 'providers.mjs'), path.join(runtimeRoot, 'lib', 'providers.mjs')),
  copyFile(path.join(sourceRoot, 'public', 'index.html'), path.join(runtimeRoot, 'public', 'index.html')),
  copyFile(path.join(sourceRoot, 'public', 'vendor', 'marked.umd.js'), path.join(runtimeRoot, 'public', 'vendor', 'marked.umd.js')),
  copyFile(path.join(sourceRoot, 'public', 'vendor', 'purify.min.js'), path.join(runtimeRoot, 'public', 'vendor', 'purify.min.js')),
]);

const pid = servicePid();
if (!pid) {
  try {
    launchctl('kickstart', label);
    console.log('Files deployed and service started.');
  } catch {
    console.log('Files deployed. No registered LaunchAgent was found; start the service manually or install one first.');
  }
  process.exit(0);
}

let marker = null;
try {
  marker = JSON.parse(await readFile(path.join(runtimeRoot, 'runtime', 'reload-ready.json'), 'utf8'));
} catch {}

if (marker?.protocol === 1 && marker.pid === pid) {
  process.kill(pid, 'SIGHUP');
  console.log('Files deployed; the service will reload once after the active run finishes.');
  process.exit(0);
}

if (hasActiveChild(pid)) {
  console.log('Files deployed without restart because a run is active. No restart was queued.');
  process.exit(2);
}

launchctl('kickstart', '-k', label);
console.log('Files deployed and service restarted once.');
