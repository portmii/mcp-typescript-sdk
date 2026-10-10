import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { createPortmii } from '@portmii/mcp';
import express from 'express';
import { z } from 'zod/v4';

// Reads PORTMII_PROVIDER_KEY, MCP_SERVER_URL and optionally PORTMII_BASE_URL from the environment.
const portmii = createPortmii({
	authType: 'OAUTH_OR_API_KEY',
	serverUrl: process.env.MCP_SERVER_URL ?? '' // public HTTPS URL of this endpoint
});

const mcp = createMcpHandler(() => {
	const server = new McpServer({ name: 'reports', version: '1.0.0' });
	server.registerTool(
		'reports.generate',
		{ inputSchema: z.object({ reportId: z.string() }) },
		portmii.tool('reports.generate', ({ reportId }) => ({
			content: [{ type: 'text', text: `Generated report ${reportId}` }]
		}))
	);
	return server;
});

const app = express();
app.use(portmii.auth);
app.all('/mcp', toNodeHandler(mcp));

export const server = app.listen(Number(process.env.PORT ?? 3333));
