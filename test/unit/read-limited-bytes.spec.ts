import { describe, expect, it } from 'vitest';
import { readLimitedBytes } from '../../src/internal/read-limited-bytes.js';

describe('readLimitedBytes', () => {
	it('combines streamed response chunks', async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('port'));
				controller.enqueue(new TextEncoder().encode('mii'));
				controller.close();
			}
		});

		const bytes = await readLimitedBytes(new Response(body), 10);

		expect(new TextDecoder().decode(bytes)).toBe('portmii');
	});

	it('returns an empty body', async () => {
		await expect(readLimitedBytes(new Response(null), 10)).resolves.toEqual(new Uint8Array());
	});

	it('rejects a declared oversized body and cancels it', async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			}
		});

		await expect(readLimitedBytes(new Response(body, { headers: { 'content-length': '11' } }), 10)).rejects.toThrow(
			'too large'
		);
		expect(cancelled).toBe(true);
	});

	it('rejects an actual oversized streamed body', async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(11));
			}
		});

		await expect(readLimitedBytes(new Response(body), 10)).rejects.toThrow('too large');
	});

	it('cancels a stalled body on timeout', async () => {
		const body = new ReadableStream<Uint8Array>();

		await expect(readLimitedBytes(new Response(body), 10, AbortSignal.timeout(5))).rejects.toMatchObject({
			name: 'TimeoutError'
		});
	});

	it('cancels the body when the caller aborts', async () => {
		const controller = new AbortController();
		const body = new ReadableStream<Uint8Array>();
		const read = readLimitedBytes(new Response(body), 10, controller.signal);

		controller.abort();

		await expect(read).rejects.toMatchObject({ name: 'AbortError' });
	});
});
