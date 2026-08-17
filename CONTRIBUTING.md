# Contributing

Thank you for improving Agent Remote Console. Keep changes small enough to review and preserve the build-free deployment model unless a larger toolchain clearly pays for itself.

## Local workflow

1. Use Node.js 22.5 or newer.
2. Enable Corepack and run `pnpm install`.
3. Start with `REMOTE_PASSWORD=dev-password pnpm start`.
4. Run `pnpm check && pnpm test` before opening a pull request.

Do not commit anything under `runtime/`, local session databases, credentials, API keys, or generated password hashes.

## Provider adapters

Provider-specific logic belongs in `lib/providers.mjs`. A provider should expose:

- metadata and capability flags for the UI;
- discovery results using the unified session shape;
- history as `{ role, text, timestamp }` messages;
- a non-interactive command and normalized `{ kind, text, title, status }` events.

Capability flags must describe current behavior. If a CLI cannot steer an active turn, keep `steer: false` and use the common sequential queue.

## Pull requests

Include a short explanation of user-visible behavior, test coverage, and any CLI versions used for validation. UI changes should be checked at both mobile and desktop widths. Security-sensitive changes should include a focused regression test.
