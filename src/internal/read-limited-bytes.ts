/** Reads a response body, rejecting bodies over `maxBytes`. Aborting `signal` stops the read. */
export async function readLimitedBytes(
	response: Response,
	maxBytes: number,
	signal?: AbortSignal
): Promise<Uint8Array> {
	if (Number(response.headers.get('content-length')) > maxBytes) {
		await response.body?.cancel();
		throw new Error('Response body too large');
	}
	if (!response.body) return new Uint8Array();
	signal?.throwIfAborted();

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let byteLength = 0;
	// Cancelling settles a pending read; the loop then rethrows the abort reason.
	const abort = () => void reader.cancel(signal?.reason).catch(() => undefined);
	signal?.addEventListener('abort', abort, { once: true });
	try {
		while (true) {
			const { done, value } = await reader.read();
			signal?.throwIfAborted();
			if (done) break;
			byteLength += value.byteLength;
			if (byteLength > maxBytes) {
				await reader.cancel();
				throw new Error('Response body too large');
			}
			chunks.push(value);
		}
	} finally {
		signal?.removeEventListener('abort', abort);
		reader.releaseLock();
	}
	return Buffer.concat(chunks, byteLength);
}
