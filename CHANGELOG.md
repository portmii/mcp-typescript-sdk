# Changelog

## 0.2.1 - 01.11.2026

- Updated ci workflow and dependencies.

## 0.2.0 - 01.11.2026

Your server now decides access; Portmii's answer is input.

- **Breaking:** `onUnavailable: 'deny' | 'allow'` is required. It applies when Portmii cannot answer (network error, timeout, `5xx`, `feature_disabled`, `dependency_unavailable`). A missing or invalid value throws `INVALID_CONFIG`.
- `authorize(decision)` hook for calls Portmii denies. `decision` has `toolName`, `reasonCode` and, when sent, `grant`. Without the hook, denied calls fail as before.
- `onUnmetered({ toolName, reason })` is called before a tool runs without a usage reservation.
- `PortmiiError.grant` carries the subscription facts of a denial.

## 0.1.0 - Unreleased

Initial release.

- `createPortmii({ authType, serverUrl })` with `providerKey` and `baseUrl` defaulting to `PORTMII_PROVIDER_KEY` and `PORTMII_BASE_URL`.
- `portmii.auth` middleware: OAuth protected-resource metadata, `401` discovery challenge, OAuth token verification via Portmii's JWKS and customer API keys.
- `portmii.tool(name, handler)` for the official MCP SDK v1 and v2: reserve usage, run, then commit or release.
- Automatic retries of network errors, timeouts and `5xx` responses with a stable idempotency key.
- `PortmiiError` with stable codes, including `INVALID_CONFIG` for setup errors.
- Node.js `^20.19.0 || >=22.12.0`, ESM and CommonJS.
