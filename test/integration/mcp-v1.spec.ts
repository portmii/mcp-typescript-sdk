import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { z } from 'zod/v4';
import { createPortmii, type PortmiiRequest } from '../../src/index.js';
import { sendJson, startTestServer, type RecordedRequest } from '../helpers/http-server.js';

it('meters official MCP v1 HTTP callbacks with and without input schemas', async () => {
	const key = `pmcp_ck_${'a'.repeat(22)}.${'b'.repeat(43)}`;
	const reservationId = '11111111-2222-4333-8444-555555555555';
	const calls: RecordedRequest[] = [];
	const api = await startTestServer((request, response) => {
		calls.push(request);
		sendJson(response, 200, {
			reservationId,
			status: request.url.endsWith('/commit') ? 'COMMITTED' : 'RESERVED',
			expiresAt: new Date(Date.now() + 300_000).toISOString()
		});
	});
	const sdk = createPortmii({ authType: 'API_KEY', providerKey: 'pmcp_sk_test', baseUrl: api.baseUrl });
	const server = createServer((req: PortmiiRequest, res) => {
		sdk.auth(req, res, (error) => {
			if (error) return sendJson(res, 500, {});
			void serve(req, res).catch(() => res.destroy());
		});
	});
	const serve = async (req: PortmiiRequest, res: Parameters<typeof sendJson>[0]) => {
		const mcp = new McpServer({ name: 'v1-compatibility', version: '1.0.0' });
		mcp.registerTool(
			'echo',
			{ inputSchema: { message: z.string() } },
			sdk.tool('echo', ({ message }) => ({
				content: [{ type: 'text', text: message }]
			}))
		);
		mcp.registerTool(
			'context',
			{},
			sdk.tool('context', (context) => ({
				content: [{ type: 'text', text: context.signal?.aborted === false ? 'Context forwarded' : 'Context missing' }]
			}))
		);
		const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
		try {
			// v1's Transport interface omits explicit undefined on its optional callbacks.
			await mcp.connect(transport as Parameters<typeof mcp.connect>[0]);
			await transport.handleRequest(req, res);
		} finally {
			await mcp.close();
		}
	};
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`;
		for (const [name, input, expected] of [
			['echo', { message: 'Hello v1' }, 'Hello v1'],
			['context', undefined, 'Context forwarded']
		] as const) {
			const response = await fetch(url, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, text/event-stream',
					'mcp-protocol-version': '2025-06-18',
					'x-api-key': key
				},
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: input } })
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ result: { content: [{ type: 'text', text: expected }] } });
		}
		expect(calls.map((call) => call.url)).toEqual([
			'/v1/mcp/runtime/usage/reservations',
			`/v1/mcp/runtime/usage/reservations/${reservationId}/commit`,
			'/v1/mcp/runtime/usage/reservations',
			`/v1/mcp/runtime/usage/reservations/${reservationId}/commit`
		]);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		await api.close();
	}
});
