import type { PortmiiErrorCode } from './types.js';

export class PortmiiError extends Error {
	readonly code: PortmiiErrorCode;
	readonly status: number | undefined;
	readonly reasonCode: string | undefined;
	readonly correlationId: string | undefined;

	constructor(
		message: string,
		options: {
			code: PortmiiErrorCode;
			status?: number;
			reasonCode?: string;
			correlationId?: string;
			cause?: unknown;
		}
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = 'PortmiiError';
		this.code = options.code;
		this.status = options.status;
		this.reasonCode = options.reasonCode;
		this.correlationId = options.correlationId;
	}

	toJSON(): Record<string, unknown> {
		return {
			name: this.name,
			message: this.message,
			code: this.code,
			...(this.status === undefined ? {} : { status: this.status }),
			...(this.reasonCode === undefined ? {} : { reasonCode: this.reasonCode }),
			...(this.correlationId === undefined ? {} : { correlationId: this.correlationId })
		};
	}
}
