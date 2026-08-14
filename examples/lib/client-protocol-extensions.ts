/**
 * Example-owned frame registrations for the client-plane contract
 * (dev_docs/framework/client-protocol-audit.md — "example-owned" rows).
 *
 * The examples emit a handful of demo frames (`session_end`,
 * `dictation_transcript`, `speech_speed`, `agent.human_transfer`, legacy
 * `image`) that are not core protocol and not app-server frames. Registering
 * them here keeps every example type-checking against
 * `AnyServerToClientMessage` without widening the core package. The file is
 * included in the examples program via the `examples` include glob, which
 * makes the augmentation program-wide.
 */

import type {} from '@bodhi/client-protocol';

declare module '@bodhi/client-protocol' {
	interface ClientProtocolServerExtensions {
		exampleSessionEnd: { type: 'session_end'; reason?: string };
		exampleDictationTranscript: {
			type: 'dictation_transcript';
			text?: string;
			partial?: boolean;
			[key: string]: unknown;
		};
		exampleSpeechSpeed: { type: 'speech_speed'; speed?: string };
		exampleHumanTransfer: { type: 'agent.human_transfer'; [key: string]: unknown };
		exampleLegacyImage: { type: 'image'; [key: string]: unknown };
	}
}
