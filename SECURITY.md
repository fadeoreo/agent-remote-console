# Security Policy

## Intended deployment

Agent Remote Console is a single-user tool for loopback, Tailscale, or another trusted private network. It executes coding agents on the host and can optionally grant them broad filesystem access. It is not hardened as a public multi-tenant service.

Do not bind it to a public interface without adding TLS, network-level access control, persistent session storage, CSRF review, and an external authentication layer.

## Reporting a vulnerability

Please report vulnerabilities privately to the repository maintainer instead of opening a public issue. Include affected versions, reproduction steps, impact, and any suggested mitigation. Avoid including real credentials or session content.

## Secrets

Agent Remote Console never needs provider API keys. The Codex, Claude Code, and OpenCode processes inherit the host environment and use their existing CLI authentication. Keep service environment files and `runtime/state.json` readable only by the service user.
