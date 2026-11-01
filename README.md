# Portmii MCP TypeScript SDK

Protect and meter MCP tools with Portmii: one middleware authenticates customers, one wrapper per tool bills each call.

## Install

```bash
npm install @portmii/mcp
```

Requires Node.js `^20.19.0 || >=22.12.0`.

## Quickstart

```ts
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { createPortmii } from '@portmii/mcp';
import express from 'express';
import { z } from 'zod/v4';

const portmii = createPortmii({
	authType: 'OAUTH',
	serverUrl: 'https://mcp.example.com/mcp',
	onUnavailable: 'deny'
});

const mcp = createMcpHandler(() => {
	const server = new McpServer({ name: 'reports', version: '1.0.0' });
	server.registerTool(
		'reports.generate',
		{ inputSchema: z.object({ reportId: z.string() }) },
		portmii.tool('reports.generate', ({ reportId }) => ({
			content: [{ type: 'text', text: `Generated report ${reportId}` }]
		}))
	);
	return server;
});

const app = express();
app.use(portmii.auth);
app.all('/mcp', toNodeHandler(mcp));
app.listen(3333);
```

Set `PORTMII_PROVIDER_KEY` in the environment. Works with the official MCP SDK v1 and v2.

## Configuration

| Option          | Required                        | Description                                                                        |
| --------------- | ------------------------------- | ---------------------------------------------------------------------------------- |
| `authType`      | yes                             | `'OAUTH'`, `'API_KEY'` or `'OAUTH_OR_API_KEY'`. Must match your product.           |
| `serverUrl`     | for `OAUTH`, `OAUTH_OR_API_KEY` | Exact public URL of your MCP endpoint.                                             |
| `providerKey`   | yes                             | Your provider key. Defaults to `process.env.PORTMII_PROVIDER_KEY`.                 |
| `onUnavailable` | yes                             | `'deny'` or `'allow'`: whether tools run while Portmii cannot answer. No default.  |
| `authorize`     | no                              | Hook for denied calls. Return `'allow'` to run the tool anyway. Default: `'deny'`. |
| `onUnmetered`   | no                              | Called with `{ toolName, reason }` before a tool runs without a usage reservation. |
| `timeoutMs`     | no                              | Per Portmii request. Default `30000`.                                              |

With `API_KEY` and no `serverUrl`, mount the middleware on the MCP route only: `app.use('/mcp', portmii.auth)`.

## Who decides access

Your server decides whether a tool runs. Portmii provides customer login, subscription data and usage counters as software; its answer is input for your decision.

- Portmii allows the call: usage is reserved, the tool runs, usage is committed.
- Portmii denies the call (`4xx` with a `reasonCode`): the call fails with a `PortmiiError`. To override a denial, set the optional `authorize({ toolName, reasonCode, grant })` hook and return `'allow'`. `grant` holds the subscription facts Portmii sent (`source`, `planId`, `validTo`), when present. `authorize` is never called when Portmii cannot answer.
- Portmii cannot answer (network error, timeout, `5xx`, `feature_disabled`, `dependency_unavailable`): `onUnavailable` decides. It is the only required hook.

If `onUnavailable` or `authorize` returns `'allow'`, the tool runs without a reservation: nothing is committed or released, so Portmii does not bill the call. The optional `onUnmetered({ toolName, reason })` is called right before such a run, so you can log or count it. `reason` is `'unavailable'` (via `onUnavailable`) or `'authorized'` (via `authorize`). It is awaited, and if it throws, the call fails and the tool does not run; catch errors inside it if logging is best-effort. With `onUnavailable: 'deny'` and no `authorize`, no call ever runs unmetered.

Choose carefully:

- `reasonCode` can be an authentication failure (`invalid_customer_credential`, `token_expired`). Returning `'allow'` for it lets unknown callers run the tool.
- Portmii verifies customer API keys; `portmii.auth` only checks their format. With `onUnavailable: 'allow'`, any well-formed API key runs tools while Portmii is unreachable. OAuth tokens are still verified locally.

```ts
const portmii = createPortmii({
	authType: 'OAUTH',
	serverUrl: 'https://mcp.example.com/mcp',
	onUnavailable: 'allow',
	authorize: ({ reasonCode }) => (reasonCode === 'usage_limit_exceeded' ? 'allow' : 'deny'),
	onUnmetered: ({ toolName, reason }) => console.warn(`${toolName} ran unmetered (${reason})`)
});
```

## Production checklist

- `serverUrl` is the HTTPS URL clients use, exactly as registered for your product. OAuth tokens are only accepted for this audience.
- Mount `portmii.auth` at the app root, before the MCP route. It serves `/.well-known/oauth-protected-resource` for OAuth clients. Behind a reverse proxy, forward that path too.
- Keep the provider key (`pmcp_sk_…`) server-side, never in client code or logs.
- Billing: a tool that returns is billed, a tool that throws is not. Throw instead of returning `{ isError: true }` for calls that should be free.
- Long-running tools should stop on `context.signal` (v1) or `context.mcpReq.signal` (v2) and finish within five minutes.

Transient Portmii failures are retried automatically without double billing. `onUnavailable` applies after the retries.

## Errors

Tool calls reject with `PortmiiError` (`code`, optional `status`, `reasonCode`, `correlationId`, `grant`) unless `authorize` or `onUnavailable` allows the call. MCP clients receive its message as an `isError` result, e.g. `Usage limit reached for this tool. Upgrade your plan or wait for the next period. [ref: <correlationId>]`.

| Code               | Meaning                                                |
| ------------------ | ------------------------------------------------------ |
| `INVALID_CONFIG`   | Invalid `createPortmii()` options or tool name.        |
| `AUTH_REQUIRED`    | No customer credential: `portmii.auth` is not mounted. |
| `INVALID_TOKEN`    | Malformed customer credential.                         |
| `ACCESS_DENIED`    | Customer has no access or budget for this tool.        |
| `HTTP_ERROR`       | Unexpected Portmii HTTP status.                        |
| `INVALID_RESPONSE` | Invalid Portmii response.                              |
| `NETWORK_ERROR`    | Portmii unreachable.                                   |
| `TIMEOUT`          | Portmii request exceeded `timeoutMs`.                  |
