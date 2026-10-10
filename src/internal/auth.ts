import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import type { ServerResponse } from 'node:http';
import { PortmiiError } from '../portmii-error.js';
import type { PortmiiAuthInfo, PortmiiConfig, PortmiiMiddleware, PortmiiRequest } from '../types.js';
import { safeUrl, type OAuthMetadata, type PortmiiHttpClient } from './http.js';

const CUSTOMER_API_KEY = /^pmcp_ck_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;

export type CustomerAuth = { accessToken: string } | { customerCredential: string };

type OAuthResource = {
	resource: string;
	issuer: string;
	metadataUrl: string;
	metadataPaths: string[];
};

/** HTTP authentication and public OAuth discovery for one MCP endpoint. */
export class PortmiiAuth {
	readonly middleware: PortmiiMiddleware;
	private readonly protectedPath: string | undefined;
	private readonly oauth: OAuthResource | undefined;
	private metadataPromise: Promise<OAuthMetadata> | undefined;
	private jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

	constructor(
		private readonly authType: PortmiiConfig['authType'],
		serverUrl: PortmiiConfig['serverUrl'],
		private readonly http: PortmiiHttpClient
	) {
		const url = serverUrl ? safeUrl(serverUrl) : undefined;
		if (url?.hash) throw new PortmiiError('serverUrl must not contain a fragment', { code: 'INVALID_CONFIG' });
		if (authType !== 'API_KEY' && !url) {
			throw new PortmiiError('serverUrl is required for OAuth', { code: 'INVALID_CONFIG' });
		}
		this.protectedPath = url && (url.pathname.replace(/\/+$/, '') || '/');
		this.oauth = url && authType !== 'API_KEY' ? createOAuthResource(url, http.baseUrl.origin) : undefined;
		this.middleware = (req, res, next) => {
			this.authenticate(req, res).then((pass) => {
				if (pass) next();
			}, next);
		};
	}

	/** Returns true when the request may continue to the next handler. */
	private async authenticate(req: PortmiiRequest, res: ServerResponse): Promise<boolean> {
		const path = new URL(req.originalUrl ?? req.url ?? '/', 'http://localhost').pathname;
		if (this.oauth?.metadataPaths.includes(path) && (req.method === 'GET' || req.method === 'OPTIONS')) {
			sendResourceMetadata(res, req.method, this.oauth);
			return false;
		}
		if (req.method === 'OPTIONS' || (this.protectedPath && (path.replace(/\/+$/, '') || '/') !== this.protectedPath)) {
			return true;
		}

		const authorization = req.headers.authorization;
		const apiKey = req.headers['x-api-key'];
		if (authorization === undefined && apiKey === undefined) {
			this.unauthorized(res, 'Authentication required');
			return false;
		}
		const token = authorization === undefined ? apiKey : authorization.match(/^Bearer +([^\s,]+)$/i)?.[1];
		if (
			typeof token !== 'string' ||
			(authorization !== undefined && apiKey !== undefined) ||
			(apiKey !== undefined && !token.startsWith('pmcp_ck_'))
		) {
			this.unauthorized(res, 'Malformed or ambiguous credentials', true);
			return false;
		}

		if (token.startsWith('pmcp_ck_')) {
			return this.authenticateApiKey(req, res, token);
		}
		if (!this.oauth) {
			this.unauthorized(res, 'OAuth is not enabled', true);
			return false;
		}
		try {
			req.auth = await this.verifyAccessToken(token, this.oauth);
			return true;
		} catch (error) {
			if (!(error instanceof PortmiiError && error.code === 'INVALID_TOKEN')) throw error;
			this.unauthorized(res, 'Access token is invalid or expired', true);
			return false;
		}
	}

	private authenticateApiKey(req: PortmiiRequest, res: ServerResponse, token: string): boolean {
		if (this.authType === 'OAUTH' || !CUSTOMER_API_KEY.test(token)) {
			this.unauthorized(res, 'API key is invalid or not enabled', true);
			return false;
		}
		req.auth = { token, clientId: '', scopes: [] };
		return true;
	}

	private unauthorized(res: ServerResponse, description: string, invalidToken = false): void {
		const params = [
			...(invalidToken ? ['error="invalid_token"'] : []),
			...(this.oauth ? [`resource_metadata="${this.oauth.metadataUrl}"`] : [])
		];
		sendJson(
			res,
			401,
			{ error: invalidToken ? 'invalid_token' : 'unauthorized', error_description: description },
			{ 'www-authenticate': ['Bearer', params.join(', ')].filter(Boolean).join(' ') }
		);
	}

	private async verifyAccessToken(token: string, oauth: OAuthResource): Promise<PortmiiAuthInfo> {
		if (token.length > 8192) throw new PortmiiError('OAuth access token is malformed', { code: 'INVALID_TOKEN' });
		const metadata = await this.getMetadata(oauth.issuer);
		this.jwks ??= createRemoteJWKSet(new URL(metadata.jwks_uri), {
			timeoutDuration: this.http.timeoutMs,
			[customFetch]: this.http.fetchImplementation
		});
		try {
			const { payload } = await jwtVerify(token, this.jwks, {
				issuer: oauth.issuer,
				audience: oauth.resource,
				requiredClaims: ['exp', 'client_id']
			});
			if (typeof payload.client_id !== 'string' || typeof payload.exp !== 'number') {
				throw new Error('Invalid claims');
			}
			return {
				token,
				clientId: payload.client_id,
				scopes: typeof payload.scope === 'string' ? payload.scope.split(/\s+/).filter(Boolean) : [],
				expiresAt: payload.exp,
				resource: new URL(oauth.resource)
			};
		} catch (cause) {
			throw new PortmiiError('OAuth access token is invalid', { code: 'INVALID_TOKEN', cause });
		}
	}

	private getMetadata(issuer: string): Promise<OAuthMetadata> {
		this.metadataPromise ??= this.http.discoverOAuthMetadata(issuer).catch((cause: unknown) => {
			this.metadataPromise = undefined;
			throw cause;
		});
		return this.metadataPromise;
	}
}

function createOAuthResource(serverUrl: URL, issuer: string): OAuthResource {
	const resourceUrl = new URL(serverUrl);
	resourceUrl.pathname = resourceUrl.pathname.replace(/\/+$/, '');
	// A root resource is advertised and expected as audience without the trailing slash.
	const resource = resourceUrl.href.replace(/\/(?=[?#]|$)/, '');
	const metadataUrl = new URL(
		`/.well-known/oauth-protected-resource${resourceUrl.pathname === '/' ? '' : resourceUrl.pathname}`,
		resourceUrl.origin
	);
	return {
		resource,
		issuer,
		metadataUrl: metadataUrl.href,
		metadataPaths: [...new Set(['/.well-known/oauth-protected-resource', metadataUrl.pathname])]
	};
}

function sendResourceMetadata(res: ServerResponse, method: string, oauth: OAuthResource): void {
	// Public metadata is fetched cross-origin by browser-based MCP clients.
	res.setHeader('access-control-allow-origin', '*');
	if (method === 'OPTIONS') {
		res.writeHead(204, { 'access-control-allow-methods': 'GET', 'access-control-allow-headers': '*' }).end();
		return;
	}
	sendJson(res, 200, { resource: oauth.resource, authorization_servers: [oauth.issuer] });
}

export function customerAuth(token: unknown): CustomerAuth {
	if (token === undefined) {
		throw new PortmiiError('Customer authentication is required. Mount portmii.auth before the MCP endpoint.', {
			code: 'AUTH_REQUIRED'
		});
	}
	if (typeof token !== 'string' || !token.trim() || token.length > 8192) {
		throw new PortmiiError('Customer credential is malformed', { code: 'INVALID_TOKEN' });
	}
	if (!token.startsWith('pmcp_ck_')) return { accessToken: token };
	if (!CUSTOMER_API_KEY.test(token)) {
		throw new PortmiiError('Customer API key is malformed', { code: 'INVALID_TOKEN' });
	}
	return { customerCredential: token };
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
	res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
	res.end(JSON.stringify(body));
}
