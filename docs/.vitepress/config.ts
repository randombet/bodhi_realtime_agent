import { defineConfig } from 'vitepress';
import { withMermaid } from 'vitepress-plugin-mermaid';
import typedocSidebar from '../api/typedoc-sidebar.json';

export default withMermaid(
	defineConfig({
		title: 'Bodhi Realtime Agent Framework',
		description:
			'TypeScript framework for real-time voice agents — supports Google Gemini Live and OpenAI Realtime APIs',
		base: '/bodhi_realtime_agent/',
		ignoreDeadLinks: [/^http:\/\/localhost/],

		themeConfig: {
			nav: [
				{ text: 'Guide', link: '/guide/' },
				{ text: 'Advanced', link: '/advanced/subagents' },
				{ text: 'Hosted API', link: '/service/hosted-voice-api' },
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
							{ text: 'Architecture Overview', link: '/guide/architecture' },
							{ text: 'Actor Runtime Pattern', link: '/guide/actor-pattern' },
							{ text: 'VoiceSession', link: '/guide/voice-session' },
							{ text: 'Agents', link: '/guide/agents' },
							{ text: 'Tools', link: '/guide/tools' },
							{ text: 'Behaviors', link: '/guide/behaviors' },
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
							{
								text: 'Persistent Subagent Lifecycle',
								link: '/advanced/persistent-subagent-lifecycle',
							},
							{ text: 'Persistence', link: '/advanced/persistence' },
							{ text: 'Multimodal Features', link: '/advanced/multimodal' },
							{ text: 'Deployment', link: '/advanced/deployment' },
						],
					},
				],
				'/api/': typedocSidebar,
				'/service/': [
					{
						text: 'Bodhi hosted service',
						items: [
							{
								text: 'Voice + REST (external clients)',
								link: '/service/hosted-voice-api',
							},
						],
					},
				],
			},

			socialLinks: [{ icon: 'github', link: 'https://github.com/randombet/bodhi_realtime_agent' }],

			search: {
				provider: 'local',
			},

			footer: {
				message: 'Built with VitePress',
			},
		},
	}),
);
