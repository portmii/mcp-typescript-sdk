import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	createPortmii,
	type Portmii,
	type PortmiiConfig,
	type PortmiiRequest,
	type PortmiiToolContext
} from '../../src/index.js';
import { sendJson, startTestServer, type RecordedRequest } from '../helpers/http-server.js';

const API_KEY = `pmcp_ck_${'a'.repeat(22)}.${'b'.repeat(43)}`;
const RESERVATION_ID = '11111111-2222-4333-8444-555555555555';

let portmiiApi: Awaited<ReturnType<typeof startTestServer>>;
let privateKey: CryptoKey;
const calls: RecordedRequest[] = [];

beforeAll(async () => {
	const keys = await generateKeyPair('RS256');
	privateKey = keys.privateKey;
	const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'RS256' };
	portmiiApi = await startTestServer((request, response) => {
		calls.push(request);
		if (request.url === '/.well-known/oauth-authorization-server') {
			return sendJson(response, 200, { issuer: portmiiApi.baseUrl, jwks_uri: `${portmiiApi.baseUrl}/jwks` });
		}
		if (request.url === '/jwks') return sendJson(response, 200, { keys: [jwk] });
		if (request.url.endsWith('/reservations')) {
			return sendJson(response, 201, {
				reservationId: RESERVATION_ID,
				status: 'RESERVED',
				expiresAt: new Date(Date.now() + 60_000).toISOString()
			});
		}
		if (request.url.endsWith('/commit')) {
			return sendJson(response, 200, { reservationId: RESERVATION_ID, status: 'COMMITTED' });
		}
		sendJson(response, 200, {});
	});
});

afterAll(() => portmiiApi.close());

function portmii(authType: PortmiiConfig['authType'] = 'OAUTH_OR_API_KEY'): Portmii {
	return createPortmii({
		authType,
		providerKey: 'pmcp_sk_test',
		baseUrl: portmiiApi.baseUrl,
		serverUrl: 'http://localhost:3333/mcp'
	});
}

function accessToken(audience = 'http://localhost:3333/mcp') {
	return new SignJWT({ client_id: 'client-1', scope: 'tools' })
		.setProtectedHeader({ alg: 'RS256', kid: 'k1' })
		.setIssuer(portmiiApi.baseUrl)
		.setAudience(audience)
		.setExpirationTime('5m')
		.sign(privateKey);
}

async function request(sdk: Portmii, path: string, headers: Record<string, string> = {}) {
	const server = createServer((req: PortmiiRequest, res) => {
		sdk.auth(req, res, (error) => {
			if (error) return sendJson(res, 500, {});
			sendJson(res, 200, { token: req.auth?.token ?? null });
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		const { port } = server.address() as AddressInfo;
		const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, { headers });
		return {
			status: response.status,
			wwwAuthenticate: response.headers.get('www-authenticate'),
			cors: response.headers.get('access-control-allow-origin'),
			body: (await response.json()) as unknown
		};
	} finally {
		server.close();
	}
}

describe('portmii.auth', () => {
	it('serves resource metadata and challenges unauthenticated requests', async () => {
		const metadata = await request(portmii(), '/.well-known/oauth-protected-resource/mcp');
		expect(metadata.cors).toBe('*');
		expect(metadata.body).toEqual({
			resource: 'http://localhost:3333/mcp',
			authorization_servers: [portmiiApi.baseUrl]
		});

		const challenge = await request(portmii(), '/mcp');
		expect(challenge.status).toBe(401);
		expect(challenge.wwwAuthenticate).toBe(
			'Bearer resource_metadata="http://localhost:3333/.well-known/oauth-protected-resource/mcp"'
		);
		expect((await request(portmii(), '/health')).status).toBe(200);
	});

	it('verifies OAuth tokens against the resource audience', async () => {
		const token = await accessToken();
		expect((await request(portmii(), '/mcp', { authorization: `Bearer ${token}` })).body).toEqual({ token });

		const foreign = await request(portmii(), '/mcp', {
			authorization: `Bearer ${await accessToken('https://other/mcp')}`
		});
		expect(foreign.status).toBe(401);
		expect(foreign.wwwAuthenticate).toContain('error="invalid_token"');
	});

	it('reuses discovery and signing keys across requests', async () => {
		const sdk = portmii();
		const token = await accessToken();
		calls.length = 0;
		for (let i = 0; i < 2; i++) {
			expect((await request(sdk, '/mcp', { authorization: `Bearer ${token}` })).status).toBe(200);
		}
		expect(calls.map((call) => call.url)).toEqual(['/.well-known/oauth-authorization-server', '/jwks']);
	});

	it('enforces authType', async () => {
		const token = await accessToken();
		expect((await request(portmii('OAUTH'), '/mcp', { 'x-api-key': API_KEY })).status).toBe(401);
		expect((await request(portmii('API_KEY'), '/mcp', { authorization: `Bearer ${token}` })).status).toBe(401);
		expect((await request(portmii('API_KEY'), '/mcp', { 'x-api-key': API_KEY })).body).toEqual({ token: API_KEY });
		expect((await request(portmii(), '/mcp', { 'x-api-key': API_KEY, authorization: `Bearer ${token}` })).status).toBe(
			401
		);
	});
});

describe('portmii.tool', () => {
	const context = { authInfo: { token: API_KEY }, requestId: 1, signal: new AbortController().signal };

	it('reserves, runs and commits', async () => {
		calls.length = 0;
		const echo = portmii().tool('echo', ({ message }: { message: string }) => message);
		await expect(echo({ message: 'hi' }, context)).resolves.toBe('hi');
		expect(calls.map((call) => call.url)).toEqual([
			'/v1/mcp/runtime/usage/reservations',
			`/v1/mcp/runtime/usage/reservations/${RESERVATION_ID}/commit`
		]);
		expect(calls[0]?.body).toEqual({ customerCredential: API_KEY, tool: 'echo' });
	});

	it('releases usage when the tool fails', async () => {
		calls.length = 0;
		const failing = portmii().tool('echo', () => {
			throw new Error('boom');
		});
		await expect(failing(context)).rejects.toThrow('boom');
		expect(calls[1]?.url).toBe(`/v1/mcp/runtime/usage/reservations/${RESERVATION_ID}/release`);
		expect(calls[1]?.body).toEqual({ outcome: 'tool_error' });
	});

	it('requires the auth middleware', async () => {
		await expect(portmii().tool('echo', () => 'x')({ requestId: 1 })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
	});

	it('passes input and the original v2 context to the handler', async () => {
		const v2Context = { http: { authInfo: { token: API_KEY } }, mcpReq: { id: 1, signal: context.signal } };
		const echo = portmii().tool('echo', (input: string, receivedContext) => {
			expect(receivedContext).toBe(v2Context);
			return input;
		});
		await expect(echo('hi', v2Context)).resolves.toBe('hi');
	});

	it.each([
		['v1', context],
		['v2', { http: { authInfo: { token: API_KEY } }, mcpReq: { id: 1, signal: context.signal } }]
	])('passes the sole context argument to a schema-less %s handler', async (_version, toolContext) => {
		const readContext = portmii().tool('context', (...args: [PortmiiToolContext]) => {
			expect(args).toHaveLength(1);
			expect(args[0]).toBe(toolContext);
			return args[0].signal ?? args[0].mcpReq?.signal;
		});
		await expect(readContext(toolContext)).resolves.toBe(context.signal);
	});

	it('commits completed work after client cancellation', async () => {
		calls.length = 0;
		const controller = new AbortController();
		const echo = portmii().tool('echo', () => {
			controller.abort();
			return 'done';
		});
		await expect(echo({ ...context, signal: controller.signal })).resolves.toBe('done');
		expect(calls[1]?.url).toBe(`/v1/mcp/runtime/usage/reservations/${RESERVATION_ID}/commit`);
	});

	it('uses separate accounting IDs when MCP request IDs repeat', async () => {
		calls.length = 0;
		const echo = portmii().tool('echo', () => 'done');
		await echo(context);
		await echo(context);
		const ids = calls.map((call) => call.headers['idempotency-key']);
		expect(ids[0]).toEqual(expect.any(String));
		expect(ids[1]).toBe(ids[0]);
		expect(ids[2]).not.toBe(ids[0]);
		expect(ids[3]).toBe(ids[2]);
	});
});

describe('errors', () => {
	const context = { authInfo: { token: API_KEY }, requestId: 1 };
	const withFetch = (fetch: typeof globalThis.fetch, authType: PortmiiConfig['authType'] = 'OAUTH_OR_API_KEY') =>
		createPortmii({
			authType,
			providerKey: 'pmcp_sk_test',
			serverUrl: 'http://localhost:3333/mcp',
			fetch,
			timeoutMs: 50
		});

	it('validates configuration', () => {
		const base = { providerKey: 'pmcp_sk_test', serverUrl: 'https://x.example/mcp' };
		expect(() => createPortmii({ ...base, authType: 'NONE' as 'OAUTH' })).toThrow(
			expect.objectContaining({ code: 'INVALID_CONFIG' })
		);
		expect(() => createPortmii({ ...base, authType: 'OAUTH', providerKey: ' ' })).toThrow('provider key');
		expect(() => createPortmii({ ...base, authType: 'OAUTH', serverUrl: 'http://x.example/mcp' })).toThrow('HTTPS');
		expect(() => createPortmii({ ...base, authType: 'OAUTH', serverUrl: 'https://u:p@x.example/mcp' })).toThrow(
			'credentials'
		);
		expect(() => createPortmii({ ...base, authType: 'OAUTH', serverUrl: 'not a url' })).toThrow('invalid');
		expect(() => createPortmii({ ...base, authType: 'OAUTH', serverUrl: 'https://x.example/mcp#a' })).toThrow(
			'fragment'
		);
		expect(() => createPortmii({ authType: 'API_KEY', providerKey: 'k' })).not.toThrow();
		process.env.PORTMII_PROVIDER_KEY = 'pmcp_sk_env';
		try {
			expect(() => createPortmii({ authType: 'API_KEY' })).not.toThrow();
		} finally {
			delete process.env.PORTMII_PROVIDER_KEY;
		}
		expect(() => portmii().tool(' ', () => 1)).toThrow('Tool name');
	});

	it('retries transient failures with the same idempotency key', async () => {
		const keys: (string | null)[] = [];
		let runs = 0;
		const flaky = withFetch(async (url, init) => {
			keys.push(new Headers(init?.headers).get('idempotency-key'));
			if (keys.length === 1) return Response.json({}, { status: 503 });
			if (url instanceof URL && url.pathname.endsWith('/commit'))
				return Response.json({ reservationId: RESERVATION_ID, status: 'COMMITTED' });
			return Response.json({
				reservationId: RESERVATION_ID,
				status: 'RESERVED',
				expiresAt: new Date(Date.now() + 60_000).toISOString()
			});
		});
		await expect(flaky.tool('e', () => ++runs)(context)).resolves.toBe(1);
		expect(keys).toHaveLength(3);
		expect(new Set(keys).size).toBe(1);
	});

	it('maps Portmii denials and failures', { timeout: 10_000 }, async () => {
		const denied = withFetch(async () =>
			Response.json({ reasonCode: 'NO_BUDGET', correlationId: 'c1' }, { status: 403 })
		);
		const error = await denied
			.tool(
				'echo',
				() => 1
			)(context)
			.catch((e: unknown) => e);
		expect(JSON.parse(JSON.stringify(error))).toEqual({
			name: 'PortmiiError',
			message: 'Portmii denied tool execution (NO_BUDGET) [ref: c1]',
			code: 'ACCESS_DENIED',
			status: 403,
			reasonCode: 'NO_BUDGET',
			correlationId: 'c1'
		});

		await expect(
			withFetch(async () =>
				Response.json({ reasonCode: 'usage_limit_exceeded', correlationId: 'c2' }, { status: 429 })
			).tool(
				'e',
				() => 1
			)(context)
		).rejects.toThrow('Usage limit reached for this tool. Upgrade your plan or wait for the next period. [ref: c2]');
		await expect(
			withFetch(async () => Response.json({}, { status: 500 })).tool('e', () => 1)(context)
		).rejects.toMatchObject({
			code: 'HTTP_ERROR'
		});
		await expect(
			withFetch(async () => Response.json({ status: 'RESERVED' })).tool('e', () => 1)(context)
		).rejects.toMatchObject({
			code: 'INVALID_RESPONSE'
		});
		await expect(withFetch(async () => new Response('{')).tool('e', () => 1)(context)).rejects.toMatchObject({
			code: 'INVALID_RESPONSE'
		});
		await expect(
			withFetch(async () => {
				throw new TypeError('offline');
			}).tool(
				'e',
				() => 1
			)(context)
		).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
		await expect(
			withFetch(
				(_url, init) =>
					new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
			).tool(
				'e',
				() => 1
			)(context)
		).rejects.toMatchObject({ code: 'TIMEOUT' });
	});

	it('rejects credentials not enabled or malformed', async () => {
		await expect(withFetch(fetch, 'OAUTH').tool('e', () => 1)(context)).rejects.toMatchObject({
			code: 'ACCESS_DENIED'
		});
		await expect(portmii().tool('e', () => 1)({ authInfo: { token: 'pmcp_ck_bad' } })).rejects.toMatchObject({
			code: 'INVALID_TOKEN'
		});
		await expect(portmii().tool('e', () => 1)({ authInfo: { token: ' ' } })).rejects.toMatchObject({
			code: 'INVALID_TOKEN'
		});
	});

	it('fails the request when OAuth discovery is unavailable', async () => {
		const sdk = withFetch(async () =>
			Response.json({ issuer: 'https://evil.example', jwks_uri: 'https://evil.example/jwks' })
		);
		expect((await request(sdk, '/mcp', { authorization: 'Bearer a.b.c' })).status).toBe(500);
		const down = withFetch(async () => Response.json({}, { status: 503 }));
		expect((await request(down, '/mcp', { authorization: 'Bearer a.b.c' })).status).toBe(500);
		expect((await request(portmii(), '/mcp', { authorization: 'Basic abc' })).status).toBe(401);
		expect((await request(portmii(), '/mcp', { 'x-api-key': 'not-a-key' })).status).toBe(401);
		expect((await request(portmii(), '/mcp', { authorization: `Bearer ${'a'.repeat(9000)}` })).status).toBe(401);
		expect((await request(portmii(), '/mcp', { authorization: 'Bearer pmcp_ck_bad' })).status).toBe(401);
	});
});
