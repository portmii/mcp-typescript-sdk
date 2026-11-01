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
	/**
	 * Required. What to do when Portmii cannot answer (network error, timeout, 5xx,
	 * `feature_disabled`, `dependency_unavailable`). `'allow'` runs the tool without metering.
	 * Customer API keys are only checked for format locally, so `'allow'` accepts any well-formed key then.
	 */
	onUnavailable: PortmiiAccess;
	/**
	 * Called when Portmii denies a call. Return `'allow'` to run the tool without metering. Default: `'deny'`.
	 * `reasonCode` can also be an authentication failure such as `invalid_customer_credential`.
	 */
	authorize?: (decision: PortmiiDecision) => PortmiiAccess | Promise<PortmiiAccess>;
	/** Called before a tool runs without a usage reservation. Awaited; a thrown error or rejection fails the call. */
	onUnmetered?: (info: { toolName: string; reason: 'authorized' | 'unavailable' }) => unknown;
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

export type PortmiiAccess = 'allow' | 'deny';

/** Portmii's answer to a denied call. Input for your own access decision. */
export type PortmiiDecision = {
	toolName: string;
	reasonCode: string;
	/** Subscription facts from Portmii (`source`, `planId`, `validTo`), when provided. */
	grant?: Record<string, unknown>;
};

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
