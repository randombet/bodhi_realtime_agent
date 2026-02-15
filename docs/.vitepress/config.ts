import { defineConfig } from 'vitepress';

export default defineConfig({
	title: 'Bodhi Realtime Agent Framework',
	description: 'TypeScript framework for real-time voice agents using Google Gemini Live API',
	base: '/realtime_agent_framework/',

	themeConfig: {
		nav: [
			{ text: 'Guide', link: '/guide/' },
			{ text: 'Advanced', link: '/advanced/subagents' },
			{ text: 'API Reference', link: '/api/' },
		],

		sidebar: {
			'/guide/': [
				{
					text: 'Getting Started',
					items: [
						{ text: 'Introduction', link: '/guide/' },
						{ text: 'Quick Start', link: '/guide/quickstart' },
						{ text: 'Running Examples', link: '/guide/running-examples' },
					],
				},
				{
					text: 'Core Concepts',
					items: [
						{ text: 'VoiceSession', link: '/guide/voice-session' },
						{ text: 'Agents', link: '/guide/agents' },
						{ text: 'Tools', link: '/guide/tools' },
						{ text: 'Memory', link: '/guide/memory' },
						{ text: 'Events & Hooks', link: '/guide/events' },
						{ text: 'Transport', link: '/guide/transport' },
					],
				},
			],
			'/advanced/': [
				{
					text: 'Advanced Topics',
					items: [
						{ text: 'Subagent Patterns', link: '/advanced/subagents' },
						{ text: 'Persistence', link: '/advanced/persistence' },
						{ text: 'Multimodal Features', link: '/advanced/multimodal' },
						{ text: 'Deployment', link: '/advanced/deployment' },
					],
				},
			],
		},

		socialLinks: [
			{ icon: 'github', link: 'https://github.com/BodhiAgent/realtime_agent_framework' },
		],

		search: {
			provider: 'local',
		},

		footer: {
			message: 'Built with VitePress',
		},
	},
});
