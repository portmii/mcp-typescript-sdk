import type { IncomingMessage, ServerResponse } from 'node:http';

export type PortmiiErrorCode =
	| 'INVALID_CONFIG'
	| 'AUTH_REQUIRED'
	| 'INVALID_TOKEN'
	| 'ACCESS_DENIED'
	| 'HTTP_ERROR'
	| 'INVALID_RESPONSE'
	| 'NETWORK_ERROR'
	| 'TIMEOUT';

export type PortmiiConfig = {
	/** Server-side provider key. Defaults to `process.env.PORTMII_PROVIDER_KEY`. */
	providerKey?: string;
	/** Portmii API URL. Defaults to `process.env.PORTMII_BASE_URL` or https://api.portmii.com; its origin is the OAuth issuer. */
	baseUrl?: string | URL;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
} & (
	| {
			authType: 'API_KEY';
			/** Optional: limits `portmii.auth` to this path. Without it, every request is checked. */
			serverUrl?: string | URL;
	  }
	| {
			authType: 'OAUTH' | 'OAUTH_OR_API_KEY';
			/** Public MCP endpoint URL. Used as OAuth resource and token audience. */
			serverUrl: string | URL;
	  }
);

/** Authentication result that `portmii.auth` stores on `req.auth`. */
export type PortmiiAuthInfo = {
	token: string;
	clientId: string;
	scopes: string[];
	expiresAt?: number;
	resource?: URL;
};

export type PortmiiRequest = IncomingMessage & { auth?: PortmiiAuthInfo; originalUrl?: string };

export type PortmiiMiddleware = (req: PortmiiRequest, res: ServerResponse, next: (error?: unknown) => void) => void;

/** Tool callback context. Covers the official MCP SDK v1 (`extra`) and v2 (`ctx`) shapes. */
export type PortmiiToolContext = {
	authInfo?: { token: string };
	requestId?: string | number;
	signal?: AbortSignal;
	mcpReq?: { id: string | number; signal: AbortSignal };
	http?: { authInfo?: { token: string } };
};
