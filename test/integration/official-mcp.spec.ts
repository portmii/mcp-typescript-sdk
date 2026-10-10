import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sendJson, startTestServer, type RecordedRequest } from '../helpers/http-server.js';

const API_KEY = `pmcp_ck_${'a'.repeat(22)}.${'b'.repeat(43)}`;
const RESERVATION_ID = '11111111-2222-4333-8444-555555555555';
const calls: RecordedRequest[] = [];
let api: Awaited<ReturnType<typeof startTestServer>>;
let server: Server;
let endpoint: string;
let privateKey: CryptoKey;

beforeAll(async () => {
	const keys = await generateKeyPair('RS256');
	privateKey = keys.privateKey;
	const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'release-test', alg: 'RS256' };
	api = await startTestServer((request, response) => {
		calls.push(request);
		if (request.url === '/.well-known/oauth-authorization-server') {
			return sendJson(response, 200, { issuer: api.baseUrl, jwks_uri: `${api.baseUrl}/jwks` });
		}
		if (request.url === '/jwks') return sendJson(response, 200, { keys: [jwk] });
		if (request.url.endsWith('/reservations')) {
			return sendJson(response, 200, {
				reservationId: RESERVATION_ID,
				status: 'RESERVED',
				expiresAt: new Date(Date.now() + 300_000).toISOString()
			});
		}
		return sendJson(response, 200, { reservationId: RESERVATION_ID, status: 'COMMITTED' });
	});
	vi.stubEnv('PORT', '0');
	vi.stubEnv('PORTMII_PROVIDER_KEY', 'pmcp_sk_test');
	vi.stubEnv('PORTMII_BASE_URL', api.baseUrl);
	vi.stubEnv('MCP_SERVER_URL', 'http://localhost:3333/mcp');
	try {
		({ server } = await import('../../examples/official-mcp-server/main.js'));
		if (!server.listening) await once(server, 'listening');
	} finally {
		vi.unstubAllEnvs();
	}
	endpoint = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`;
});

afterAll(async () => {
	if (server)
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	if (api) await api.close();
});

async function callTool(name: string, credential: Record<string, string>, input?: Record<string, unknown>) {
	const response = await fetch(endpoint, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream',
			'mcp-protocol-version': '2025-06-18',
			...credential
		},
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: input } })
	});
	const body = await response.text();
	return { status: response.status, body };
}

describe('runnable MCP v2 HTTP example', () => {
	it('rejects unauthenticated calls before reserving usage', async () => {
		calls.length = 0;
		expect((await callTool('reports.generate', {}, { reportId: 'monthly' })).status).toBe(401);
		expect(calls).toHaveLength(0);
	});

	it('forwards API-key authentication and input through the official Node adapter', async () => {
		calls.length = 0;
		const result = await callTool('reports.generate', { 'x-api-key': API_KEY }, { reportId: 'monthly' });
		expect(result.status).toBe(200);
		expect(result.body).toContain('Generated report monthly');
		expect(calls.map((call) => call.url)).toEqual([
			'/v1/mcp/runtime/usage/reservations',
			`/v1/mcp/runtime/usage/reservations/${RESERVATION_ID}/commit`
		]);
		expect(calls[0]?.body).toEqual({ customerCredential: API_KEY, tool: 'reports.generate' });
	});

	it('forwards verified OAuth through the official Node adapter', async () => {
		const token = await new SignJWT({ client_id: 'test-client', scope: 'tools' })
			.setProtectedHeader({ alg: 'RS256', kid: 'release-test' })
			.setIssuer(api.baseUrl)
			.setAudience('http://localhost:3333/mcp')
			.setExpirationTime('5m')
			.sign(privateKey);
		calls.length = 0;
		const result = await callTool('reports.generate', { authorization: `Bearer ${token}` }, { reportId: 'monthly' });
		expect(result.status).toBe(200);
		expect(result.body).toContain('Generated report monthly');
		expect(calls.find((call) => call.url.endsWith('/reservations'))?.body).toEqual({
			accessToken: token,
			tool: 'reports.generate'
		});
		expect(calls.at(-1)?.url).toBe(`/v1/mcp/runtime/usage/reservations/${RESERVATION_ID}/commit`);
	});

	it('serves public OAuth metadata', async () => {
		const metadata = await fetch(new URL('/.well-known/oauth-protected-resource/mcp', endpoint));
		expect(metadata.status).toBe(200);
		expect(await metadata.json()).toEqual({
			resource: 'http://localhost:3333/mcp',
			authorization_servers: [api.baseUrl]
		});
	});
});
