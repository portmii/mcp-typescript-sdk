import { McpServer as McpServerV1, type ToolCallback as ToolCallbackV1 } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpServer as McpServerV2, type ToolCallback as ToolCallbackV2 } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';
import type { Portmii } from '../../src/index.js';

/** Compiled by npm run typecheck: wrappers must retain the full official callback types. */
export function verifyCallbackTypes(sdk: Portmii): void {
	const v1 = new McpServerV1({ name: 'types-v1', version: '1.0.0' });
	const v1Schema = { message: z.string() };
	const v1Callback: ToolCallbackV1<typeof v1Schema> = (input, context) => ({
		content: [{ type: 'text', text: `${input.message}:${String(context.sendNotification !== undefined)}` }]
	});
	v1.registerTool('existing', { inputSchema: v1Schema }, sdk.tool('existing', v1Callback));
	v1.registerTool(
		'inline',
		{ inputSchema: v1Schema },
		sdk.tool('inline', (input, context) => ({
			content: [{ type: 'text', text: `${input.message}:${String(context.sendNotification !== undefined)}` }]
		}))
	);
	const v1NoInput: ToolCallbackV1 = (context) => ({
		content: [{ type: 'text', text: String(context.sendNotification !== undefined) }]
	});
	v1.registerTool('no-input', {}, sdk.tool('no-input', v1NoInput));

	const v2 = new McpServerV2({ name: 'types-v2', version: '1.0.0' });
	const v2Schema = z.object({ message: z.string() });
	const v2Callback: ToolCallbackV2<typeof v2Schema> = (input, context) => ({
		content: [{ type: 'text', text: `${input.message}:${context.mcpReq.method}` }]
	});
	v2.registerTool('existing', { inputSchema: v2Schema }, sdk.tool('existing', v2Callback));
	v2.registerTool(
		'inline',
		{ inputSchema: v2Schema },
		sdk.tool('inline', (input, context) => ({
			content: [{ type: 'text', text: `${input.message}:${context.mcpReq.method}` }]
		}))
	);
	const v2NoInput: ToolCallbackV2 = (context) => ({
		content: [{ type: 'text', text: context.mcpReq.method }]
	});
	v2.registerTool('no-input', {}, sdk.tool('no-input', v2NoInput));
}
