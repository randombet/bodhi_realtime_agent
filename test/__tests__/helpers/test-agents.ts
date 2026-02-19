// SPDX-License-Identifier: MIT

import { z } from 'zod';
import type { MainAgent } from '../../../src/types/agent.js';

export function createEchoAgent(): MainAgent {
	return {
		name: 'echo',
		instructions:
			'You are an echo agent. Repeat back what the user says. Keep responses very short.',
		tools: [],
	};
}

export function createToolAgent(): MainAgent {
	return {
		name: 'tool-agent',
		instructions: 'You are a helpful agent with tools. Use tools when asked.',
		tools: [
			{
				name: 'get_weather',
				description: 'Get the current weather for a city',
				parameters: z.object({
					city: z.string().describe('The city to get weather for'),
				}),
				execution: 'inline',
				execute: async (args) => ({
					city: (args as { city: string }).city,
					temperature: 72,
					unit: 'F',
					condition: 'sunny',
				}),
			},
		],
	};
}

export function createTransferableAgents(): MainAgent[] {
	return [
		{
			name: 'general',
			instructions:
				'You are a general assistant. If the user asks to book something, use the transfer_to_agent tool.',
			tools: [
				{
					name: 'transfer_to_agent',
					description: 'Transfer to another agent',
					parameters: z.object({
						agent_name: z.string().describe('Name of the agent to transfer to'),
					}),
					execution: 'inline',
					execute: async () => ({ status: 'transferred' }),
				},
			],
			onExit: async () => {},
		},
		{
			name: 'booking',
			instructions: 'You are a booking agent. Help users book things.',
			tools: [],
			onEnter: async () => {},
		},
	];
}
