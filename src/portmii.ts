import { randomUUID } from 'node:crypto';
import { customerAuth, PortmiiAuth, type CustomerAuth } from './internal/auth.js';
import { invalidResponse, isDenial, isRecord, isUnavailable, PortmiiHttpClient } from './internal/http.js';
import { PortmiiError } from './portmii-error.js';
import type { PortmiiConfig, PortmiiMiddleware, PortmiiToolContext } from './types.js';

type ProtectedToolHandler<Input, Output, Context extends PortmiiToolContext> = {
	(input: Input, context: Context): Promise<Output>;
	(context: PortmiiToolContext): Promise<Output>;
};

/** Create with `createPortmii()`. */
export class Portmii {
	/** Node/Express middleware: serves OAuth discovery and authenticates requests to the MCP endpoint. */
	readonly auth: PortmiiMiddleware;
	private readonly config: PortmiiConfig;
	private readonly http: PortmiiHttpClient;

	constructor(config: PortmiiConfig) {
		if (!['OAUTH', 'API_KEY', 'OAUTH_OR_API_KEY'].includes(config.authType)) {
			throw new PortmiiError('authType must be OAUTH, API_KEY or OAUTH_OR_API_KEY', { code: 'INVALID_CONFIG' });
		}
		// No default: the provider, not Portmii, decides whether tools run while Portmii is unreachable.
		if (config.onUnavailable !== 'deny' && config.onUnavailable !== 'allow') {
			throw new PortmiiError("onUnavailable must be 'deny' or 'allow'", { code: 'INVALID_CONFIG' });
		}
		const providerKey = config.providerKey ?? process.env.PORTMII_PROVIDER_KEY;
		if (typeof providerKey !== 'string' || !providerKey.trim()) {
			throw new PortmiiError('Portmii provider key is required (providerKey or PORTMII_PROVIDER_KEY)', {
				code: 'INVALID_CONFIG'
			});
		}
		this.config = config;
		this.http = new PortmiiHttpClient({ ...config, providerKey });
		this.auth = new PortmiiAuth(config.authType, config.serverUrl, this.http).middleware;
	}

	/**
	 * Wraps an MCP tool callback. Each call is authorized and metered by Portmii:
	 * usage is reserved before `handler` runs, committed on success and released on failure.
	 * If Portmii denies or is unavailable, `authorize` or `onUnavailable` decides whether `handler` runs unmetered.
	 */
	tool<Input = PortmiiToolContext, Output = unknown, Context extends PortmiiToolContext = PortmiiToolContext>(
		toolName: string,
		handler: (input: Input, context: Context) => Output | Promise<Output>
	): ProtectedToolHandler<Input, Output, Context> {
		if (!toolName.trim()) throw new PortmiiError('Tool name is required', { code: 'INVALID_CONFIG' });
		return async (...args: [Input, Context] | [PortmiiToolContext]) => {
			const context = args.length === 2 ? args[1] : args[0];
			const token = context.authInfo?.token ?? context.http?.authInfo?.token;
			const signal = context.signal ?? context.mcpReq?.signal;
			// MCP supplies either (input, context) or (context), depending on the tool's schema.
			return this.run(toolName, customerAuth(token), signal, () => handler(...(args as Parameters<typeof handler>)));
		};
	}

	private async run<Output>(
		toolName: string,
		auth: CustomerAuth,
		signal: AbortSignal | undefined,
		execute: () => Output | Promise<Output>
	): Promise<Output> {
		const oauthDisabled = 'accessToken' in auth && this.config.authType === 'API_KEY';
		const apiKeyDisabled = 'customerCredential' in auth && this.config.authType === 'OAUTH';
		if (oauthDisabled || apiKeyDisabled) {
			throw new PortmiiError('Customer authentication method is not enabled', { code: 'ACCESS_DENIED' });
		}
		// Protocol request IDs are client-controlled and may repeat across customers and sessions.
		const requestId = randomUUID();
		signal?.throwIfAborted();

		let reservation: unknown;
		try {
			reservation = await this.http.post(
				'/v1/mcp/runtime/usage/reservations',
				{ ...auth, tool: toolName },
				requestId,
				signal
			);
		} catch (error) {
			if (signal?.aborted) throw error;
			// Portmii's answer is only input; the provider decides whether the tool runs unmetered.
			const unavailable = isUnavailable(error);
			const access = unavailable
				? this.config.onUnavailable
				: isDenial(error)
					? await this.config.authorize?.({
							toolName,
							reasonCode: error.reasonCode,
							...(error.grant ? { grant: error.grant } : {})
						})
					: undefined;
			if (access !== 'allow') throw error;
			await this.config.onUnmetered?.({ toolName, reason: unavailable ? 'unavailable' : 'authorized' });
			return execute();
		}
		if (
			!isRecord(reservation) ||
			typeof reservation.reservationId !== 'string' ||
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reservation.reservationId) ||
			reservation.status !== 'RESERVED' ||
			typeof reservation.expiresAt !== 'string' ||
			!(Date.parse(reservation.expiresAt) > Date.now())
		) {
			throw invalidResponse();
		}
		const reservationPath = `/v1/mcp/runtime/usage/reservations/${encodeURIComponent(reservation.reservationId)}`;

		let result: Output;
		try {
			signal?.throwIfAborted();
			result = await execute();
		} catch (cause) {
			// Release is best effort; preserve the handler's original error.
			await this.http
				.post(`${reservationPath}/release`, { outcome: signal?.aborted ? 'canceled' : 'tool_error' }, requestId)
				.catch(() => undefined);
			throw cause;
		}

		// Completed work must be committed even when the client has disconnected.
		const committed = await this.http.post(`${reservationPath}/commit`, {}, requestId);
		if (
			!isRecord(committed) ||
			committed.status !== 'COMMITTED' ||
			committed.reservationId !== reservation.reservationId
		) {
			throw invalidResponse();
		}
		return result;
	}
}

export function createPortmii(config: PortmiiConfig): Portmii {
	return new Portmii(config);
}
