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
	serverUrl: 'https://mcp.example.com/mcp'
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

| Option        | Required                        | Description                                                              |
| ------------- | ------------------------------- | ------------------------------------------------------------------------ |
| `authType`    | yes                             | `'OAUTH'`, `'API_KEY'` or `'OAUTH_OR_API_KEY'`. Must match your product. |
| `serverUrl`   | for `OAUTH`, `OAUTH_OR_API_KEY` | Exact public URL of your MCP endpoint.                                   |
| `providerKey` | yes                             | Your provider key. Defaults to `process.env.PORTMII_PROVIDER_KEY`.       |
| `timeoutMs`   | no                              | Per Portmii request. Default `30000`.                                    |

With `API_KEY` and no `serverUrl`, mount the middleware on the MCP route only: `app.use('/mcp', portmii.auth)`.

## Production checklist

- `serverUrl` is the HTTPS URL clients use, exactly as registered for your product. OAuth tokens are only accepted for this audience.
- Mount `portmii.auth` at the app root, before the MCP route. It serves `/.well-known/oauth-protected-resource` for OAuth clients. Behind a reverse proxy, forward that path too.
- Keep the provider key (`pmcp_sk_…`) server-side, never in client code or logs.
- Billing: a tool that returns is billed, a tool that throws is not. Throw instead of returning `{ isError: true }` for calls that should be free.
- Long-running tools should stop on `context.signal` (v1) or `context.mcpReq.signal` (v2) and finish within five minutes.

Transient Portmii failures are retried automatically without double billing.

## Errors

Tool calls reject with `PortmiiError` (`code`, optional `status`, `reasonCode`, `correlationId`). MCP clients receive its message as an `isError` result, e.g. `Usage limit reached for this tool. Upgrade your plan or wait for the next period. [ref: <correlationId>]`.

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
