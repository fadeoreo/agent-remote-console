#!/usr/bin/env node
import { encodePassword } from '../lib/auth.mjs';

const password = process.argv[2];
if (!password) {
  console.error('Usage: pnpm password -- "your-password"');
  process.exit(1);
}
console.log(await encodePassword(password));
