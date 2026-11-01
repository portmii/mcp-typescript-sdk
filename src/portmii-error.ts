import type { PortmiiErrorCode } from './types.js';

export class PortmiiError extends Error {
	readonly code: PortmiiErrorCode;
	readonly status: number | undefined;
	readonly reasonCode: string | undefined;
	readonly correlationId: string | undefined;
	/** Subscription facts Portmii sent with a denial. */
	readonly grant: Record<string, unknown> | undefined;

	constructor(
		message: string,
		options: {
			code: PortmiiErrorCode;
			status?: number;
			reasonCode?: string;
			correlationId?: string;
			grant?: Record<string, unknown>;
			cause?: unknown;
		}
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = 'PortmiiError';
		this.code = options.code;
		this.status = options.status;
		this.reasonCode = options.reasonCode;
		this.correlationId = options.correlationId;
		this.grant = options.grant;
	}

	toJSON(): Record<string, unknown> {
		return {
			name: this.name,
			message: this.message,
			code: this.code,
			...(this.status === undefined ? {} : { status: this.status }),
			...(this.reasonCode === undefined ? {} : { reasonCode: this.reasonCode }),
			...(this.correlationId === undefined ? {} : { correlationId: this.correlationId }),
			...(this.grant === undefined ? {} : { grant: this.grant })
		};
	}
}
