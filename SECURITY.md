# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately to support@portmii.com. Do not open a public issue containing credentials, tokens, proof-of-concept secrets or customer data.

## Supported versions

Security fixes are provided for the latest stable release. During the pre-1.0 phase, users should upgrade to the latest published prerelease.

## Credential handling

The SDK never intentionally logs provider credentials, OAuth access tokens, tool inputs or tool outputs. Provider credentials must be supplied through a secret manager or injected environment variable and must never be exposed to MCP clients.

OAuth access tokens are verified against the configured Portmii issuer, the exact provider resource URI, their expiry and Portmii's public JWKS. Every tool execution is denied when its validated request context is missing.
