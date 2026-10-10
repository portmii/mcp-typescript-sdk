import { setTimeout as sleep } from 'node:timers/promises';
import { PortmiiError } from '../portmii-error.js';
import type { PortmiiConfig } from '../types.js';
import { readLimitedBytes } from './read-limited-bytes.js';

const DEFAULT_BASE_URL = 'https://api.portmii.com';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1_048_576;
/** Backoff before each retry. Portmii deduplicates runtime calls by idempotency key, so retries are safe. */
const RETRY_DELAYS_MS = [250, 1000];

export type OAuthMetadata = { issuer: string; jwks_uri: string };

/** Portmii API requests, retries, response limits and HTTP error mapping. */
export class PortmiiHttpClient {
	readonly baseUrl: URL;
	readonly fetchImplementation: typeof globalThis.fetch;
	readonly timeoutMs: number;
	private readonly providerKey: string;

	constructor(config: PortmiiConfig & { providerKey: string }) {
		this.baseUrl = safeUrl(config.baseUrl ?? (process.env.PORTMII_BASE_URL || DEFAULT_BASE_URL));
		this.providerKey = config.providerKey;
		this.fetchImplementation = config.fetch ?? globalThis.fetch;
		this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	/** Retries network errors, timeouts and 5xx responses unless `externalSignal` was aborted. */
	async post(
		path: string,
		body: Record<string, unknown>,
		requestId: string,
		externalSignal?: AbortSignal
	): Promise<unknown> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.postOnce(path, body, requestId, externalSignal);
			} catch (error) {
				const delay = RETRY_DELAYS_MS[attempt];
				if (delay === undefined || externalSignal?.aborted || !isRetryable(error)) throw error;
				await sleep(delay);
			}
		}
	}

	private async postOnce(
		path: string,
		body: Record<string, unknown>,
		requestId: string,
		externalSignal?: AbortSignal
	): Promise<unknown> {
		const timeout = AbortSignal.timeout(this.timeoutMs);
		const signal = externalSignal ? AbortSignal.any([timeout, externalSignal]) : timeout;
		try {
			const response = await this.fetchImplementation(new URL(path, this.baseUrl), {
				method: 'POST',
				redirect: 'manual',
				signal,
				headers: {
					authorization: `Bearer ${this.providerKey}`,
					'content-type': 'application/json',
					'idempotency-key': requestId
				},
				body: JSON.stringify(body)
			});
			const payload = await parseJson(response, signal);
			if (!response.ok) throw responseError(response.status, payload, path.endsWith('/commit'));
			return payload;
		} catch (cause) {
			throw requestError(cause, timeout);
		}
	}

	async discoverOAuthMetadata(issuer: string): Promise<OAuthMetadata> {
		const timeout = AbortSignal.timeout(this.timeoutMs);
		try {
			const response = await this.fetchImplementation(new URL('/.well-known/oauth-authorization-server', issuer), {
				method: 'GET',
				redirect: 'manual',
				signal: timeout,
				headers: { accept: 'application/json' }
			});
			const payload = await parseJson(response, timeout);
			if (!response.ok) {
				throw new PortmiiError('Portmii OAuth discovery failed', { code: 'HTTP_ERROR', status: response.status });
			}
			if (!isRecord(payload) || payload.issuer !== issuer || typeof payload.jwks_uri !== 'string') {
				throw invalidResponse();
			}
			safeUrl(payload.jwks_uri, 'INVALID_RESPONSE');
			return { issuer, jwks_uri: payload.jwks_uri };
		} catch (cause) {
			throw requestError(cause, timeout);
		}
	}
}

async function parseJson(response: Response, signal: AbortSignal): Promise<unknown> {
	try {
		const bytes = await readLimitedBytes(response, MAX_RESPONSE_BYTES, signal);
		return bytes.byteLength === 0 ? {} : (JSON.parse(new TextDecoder().decode(bytes)) as unknown);
	} catch (cause) {
		throw new PortmiiError('Portmii returned an invalid response', { code: 'INVALID_RESPONSE', cause });
	}
}

function requestError(cause: unknown, timeout: AbortSignal): PortmiiError {
	if (timeout.aborted) return new PortmiiError('Portmii request timed out', { code: 'TIMEOUT', cause });
	if (cause instanceof PortmiiError) return cause;
	return new PortmiiError('Portmii request failed', { code: 'NETWORK_ERROR', cause });
}

function isRetryable(error: unknown): boolean {
	return (
		error instanceof PortmiiError &&
		(error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT' || (error.status ?? 0) >= 500)
	);
}

/** Customer-facing texts. MCP SDKs return only `error.message` to the client. */
const DENIAL_MESSAGES: Record<string, string> = {
	usage_limit_exceeded: 'Usage limit reached for this tool. Upgrade your plan or wait for the next period.',
	grant_missing: 'No active subscription for this tool.',
	grant_inactive: 'Your subscription for this tool is inactive.',
	entitlement_missing: 'Your plan does not include this tool.',
	customer_blocked: 'Your account is blocked.',
	token_expired: 'Your session expired. Sign in again.',
	invalid_customer_credential: 'Your credentials are invalid. Sign in again.',
	tool_unknown: 'This tool is currently unavailable.',
	tool_inactive: 'This tool is currently unavailable.'
};

function responseError(status: number, payload: unknown, commit: boolean): PortmiiError {
	const details = isRecord(payload) ? payload : {};
	const reasonCode = typeof details.reasonCode === 'string' ? details.reasonCode : undefined;
	const message = commit
		? 'Portmii usage commit failed'
		: ((reasonCode && DENIAL_MESSAGES[reasonCode]) ??
			`Portmii denied tool execution${reasonCode ? ` (${reasonCode})` : ''}`);
	const ref = typeof details.correlationId === 'string' ? ` [ref: ${details.correlationId}]` : '';
	return new PortmiiError(message + ref, {
		code:
			status === 401 || status === 403 || status === 404 || status === 409 || status === 429
				? 'ACCESS_DENIED'
				: 'HTTP_ERROR',
		status,
		...(typeof details.reasonCode === 'string' ? { reasonCode: details.reasonCode } : {}),
		...(typeof details.correlationId === 'string' ? { correlationId: details.correlationId } : {})
	});
}

/** HTTPS only; plain HTTP is accepted for loopback hosts during local development. */
export function safeUrl(input: string | URL, code: 'INVALID_CONFIG' | 'INVALID_RESPONSE' = 'INVALID_CONFIG'): URL {
	let url: URL;
	try {
		url = new URL(input);
	} catch (cause) {
		throw new PortmiiError('Portmii URL is invalid', { code, cause });
	}
	const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
	if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
		throw new PortmiiError('Portmii URL must use HTTPS', { code });
	}
	if (url.username || url.password) {
		throw new PortmiiError('Portmii URL must not contain credentials', { code });
	}
	return url;
}

export function invalidResponse(): PortmiiError {
	return new PortmiiError('Portmii returned an invalid response', { code: 'INVALID_RESPONSE' });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
