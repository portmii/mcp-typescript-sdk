# Changelog

## 0.1.0 - Unreleased

Initial release.

- `createPortmii({ authType, serverUrl })` with `providerKey` and `baseUrl` defaulting to `PORTMII_PROVIDER_KEY` and `PORTMII_BASE_URL`.
- `portmii.auth` middleware: OAuth protected-resource metadata, `401` discovery challenge, OAuth token verification via Portmii's JWKS and customer API keys.
- `portmii.tool(name, handler)` for the official MCP SDK v1 and v2: reserve usage, run, then commit or release.
- Automatic retries of network errors, timeouts and `5xx` responses with a stable idempotency key.
- `PortmiiError` with stable codes, including `INVALID_CONFIG` for setup errors.
- Node.js `^20.19.0 || >=22.12.0`, ESM and CommonJS.
