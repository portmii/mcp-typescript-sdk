import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type RecordedRequest = {
	method: string;
	url: string;
	headers: IncomingMessage['headers'];
	body: unknown;
};

export async function startTestServer(
	handler: (request: RecordedRequest, response: ServerResponse) => void | Promise<void>
): Promise<{ baseUrl: string; close(): Promise<void> }> {
	const server = createServer((request, response) => {
		void handleRequest(request, response, handler).catch((error: unknown) => {
			response.destroy(error instanceof Error ? error : new Error('Test server failed'));
		});
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address() as AddressInfo;

	return {
		baseUrl: `http://127.0.0.1:${String(address.port)}`,
		close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
	};
}

async function handleRequest(
	request: IncomingMessage,
	response: ServerResponse,
	handler: (request: RecordedRequest, response: ServerResponse) => void | Promise<void>
): Promise<void> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
	const rawBody = Buffer.concat(chunks).toString('utf8');
	const contentType = request.headers['content-type'] ?? '';
	await handler(
		{
			method: request.method ?? '',
			url: request.url ?? '',
			headers: request.headers,
			body: rawBody
				? contentType.includes('application/json')
					? (JSON.parse(rawBody) as unknown)
					: rawBody
				: undefined
		},
		response
	);
}

export function sendJson(
	response: ServerResponse,
	status: number,
	body: unknown,
	headers: Record<string, string> = {}
): void {
	response.writeHead(status, { 'content-type': 'application/json', ...headers });
	response.end(JSON.stringify(body));
}
