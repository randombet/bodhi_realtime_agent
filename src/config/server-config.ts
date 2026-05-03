/**
 * Server Configuration
 *
 * Configuration management for the multi-user production server.
 */

export type LLMProvider = 'gemini' | 'openai';

export interface ServerConfig {
	/** WebSocket server port */
	port: number;
	/** WebSocket server host */
	host: string;
	/** Which live voice transport to use (default: gemini). */
	llmProvider: LLMProvider;
	/** Gemini API key (required for gemini; also used for image/video subagents when provider is openai). */
	apiKey: string;
	/** OpenAI API key (required when llmProvider is openai). */
	openaiApiKey?: string;
	/** Maximum concurrent sessions per user */
	maxSessionsPerUser: number;
	/** Maximum total concurrent sessions */
	maxTotalSessions: number;
	/** Session idle timeout in milliseconds */
	sessionTimeoutMs: number;
	/** Cleanup interval in milliseconds */
	cleanupIntervalMs: number;
	/** Authentication configuration */
	auth: {
		enabled: boolean;
		method: 'api_key' | 'jwt' | 'oauth' | 'supabase' | 'anonymous';
		apiKey?: string;
		jwtSecret?: string;
		supabase?: {
			url: string;
			anonKey: string;
			/** Service role key for server-side Supabase client (history store, bypass RLS). */
			serviceRoleKey?: string;
		};
		oauth?: {
			clientId: string;
			clientSecret: string;
			tokenEndpoint: string;
		};
	};
	/** Rate limiting configuration */
	rateLimiting: {
		enabled: boolean;
		requestsPerMinute: number;
		connectionsPerMinute: number;
	};
	/** Logging configuration */
	logging: {
		level: 'debug' | 'info' | 'warn' | 'error';
		format: 'json' | 'text';
	};
	/** Twilio inbound phone call bridge (optional — disabled when absent). */
	twilio?: {
		inboundEnabled: boolean;
		/** Public HTTPS URL (nginx/ngrok) used in TwiML so Twilio connects back to us. */
		webhookUrl: string;
		/** Fallback agent profile for inbound calls (default: standard). */
		defaultAgentProfile: string;
		/** Optional E.164 number -> agent profile map (digits only key). */
		numberAgentProfiles: Record<string, string>;
		/**
		 * REST-initiated dial-out to PSTN using the same bidirectional Media Stream as inbound.
		 * Requires `TWILIO_INBOUND_ENABLED` (shared `/twilio/media` path).
		 */
		outboundDial?: TwilioOutboundDialConfig;
	};
}

/** Twilio REST PSTN dial-out — not the human-escalation `TwilioBridge` in `src/telephony/`. */
export interface TwilioOutboundDialConfig {
	accountSid: string;
	authToken: string;
	/** Caller ID (E.164) — must be a Twilio-owned number on this account. */
	defaultFromNumber: string;
	/** When set, `POST /api/telephony/twilio/outbound` must send `X-Bodhi-Telephony-Outbound-Key`. */
	apiKey?: string;
}

function normalizePhoneMapKey(phone: string): string {
	return phone.replace(/[^0-9]/g, '');
}

function buildTwilioOutboundDialConfig(): TwilioOutboundDialConfig | undefined {
	if (process.env.TWILIO_OUTBOUND_ENABLED?.trim() !== 'true') return undefined;
	const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim() ?? '';
	const authToken = process.env.TWILIO_AUTH_TOKEN?.trim() ?? '';
	const defaultFromNumber = (
		process.env.TWILIO_OUTBOUND_FROM?.trim() ||
		process.env.TWILIO_FROM_NUMBER?.trim() ||
		''
	).slice(0, 24);
	const apiKey = process.env.TWILIO_OUTBOUND_API_KEY?.trim() || undefined;
	if (!accountSid || !authToken) {
		throw new Error(
			'TWILIO_OUTBOUND_ENABLED requires TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN for Calls.create',
		);
	}
	if (!defaultFromNumber) {
		throw new Error(
			'TWILIO_OUTBOUND_ENABLED requires TWILIO_OUTBOUND_FROM or TWILIO_FROM_NUMBER (E.164 caller ID)',
		);
	}
	return { accountSid, authToken, defaultFromNumber, apiKey };
}

function parseTwilioNumberAgentProfiles(raw: string): Record<string, string> {
	if (!raw.trim()) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`TWILIO_NUMBER_AGENT_PROFILES must be valid JSON object: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('TWILIO_NUMBER_AGENT_PROFILES must be a JSON object of number->profile');
	}

	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		const phoneKey = normalizePhoneMapKey(key);
		if (!phoneKey) {
			throw new Error(`TWILIO_NUMBER_AGENT_PROFILES has invalid phone key: "${key}"`);
		}
		if (typeof value !== 'string' || value.trim().length === 0) {
			throw new Error(`TWILIO_NUMBER_AGENT_PROFILES value for "${key}" must be a non-empty string`);
		}
		out[phoneKey] = value.trim().slice(0, 64);
	}
	return out;
}

/**
 * Load server configuration from environment variables.
 */
export function loadConfig(): ServerConfig {
	const port = Number(process.env.PORT) || 9900;
	const host = process.env.HOST || '0.0.0.0';
	const llmProvider: LLMProvider = process.env.LLM_PROVIDER === 'openai' ? 'openai' : 'gemini';
	const apiKey = process.env.GEMINI_API_KEY || '';
	const openaiApiKey = process.env.OPENAI_API_KEY || '';

	if (!apiKey) {
		throw new Error('GEMINI_API_KEY environment variable is required');
	}
	if (llmProvider === 'openai' && !openaiApiKey) {
		throw new Error('OPENAI_API_KEY environment variable is required when LLM_PROVIDER=openai');
	}

	// Authentication config (disabled by default - enable when ready for Supabase/auth)
	const authEnabled = process.env.AUTH_ENABLED === 'true';
	const authMethod = (process.env.AUTH_METHOD || 'anonymous') as
		| 'api_key'
		| 'jwt'
		| 'oauth'
		| 'supabase'
		| 'anonymous';

	const config: ServerConfig = {
		port,
		host,
		llmProvider,
		apiKey,
		/** Keep when set so per-profile OpenAI sessions work while global default stays Gemini. */
		openaiApiKey: openaiApiKey.trim() ? openaiApiKey : undefined,
		maxSessionsPerUser: Number(process.env.MAX_SESSIONS_PER_USER) || 5,
		maxTotalSessions: Number(process.env.MAX_TOTAL_SESSIONS) || 1000,
		sessionTimeoutMs: Number(process.env.SESSION_TIMEOUT_MS) || 30 * 60 * 1000, // 30 minutes
		cleanupIntervalMs: Number(process.env.CLEANUP_INTERVAL_MS) || 60 * 1000, // 1 minute
		auth: {
			enabled: authEnabled,
			method: authMethod,
			apiKey: process.env.AUTH_API_KEY,
			jwtSecret: process.env.JWT_SECRET,
			supabase:
				process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
					? {
							url: process.env.SUPABASE_URL,
							anonKey: process.env.SUPABASE_ANON_KEY,
							serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
						}
					: undefined,
			oauth:
				process.env.OAUTH_CLIENT_ID && process.env.OAUTH_CLIENT_SECRET
					? {
							clientId: process.env.OAUTH_CLIENT_ID,
							clientSecret: process.env.OAUTH_CLIENT_SECRET,
							tokenEndpoint: process.env.OAUTH_TOKEN_ENDPOINT || '',
						}
					: undefined,
		},
		rateLimiting: {
			enabled: process.env.RATE_LIMITING_ENABLED !== 'false',
			requestsPerMinute: Number(process.env.RATE_LIMIT_REQUESTS_PER_MIN) || 60,
			connectionsPerMinute: Number(process.env.RATE_LIMIT_CONNECTIONS_PER_MIN) || 10,
		},
		logging: {
			level: (process.env.LOG_LEVEL || 'info') as 'debug' | 'info' | 'warn' | 'error',
			format: (process.env.LOG_FORMAT || 'text') as 'json' | 'text',
		},
		twilio:
			process.env.TWILIO_INBOUND_ENABLED === 'true' && process.env.TWILIO_WEBHOOK_URL
				? {
						inboundEnabled: true,
						webhookUrl: process.env.TWILIO_WEBHOOK_URL,
						defaultAgentProfile:
							process.env.TWILIO_DEFAULT_AGENT_PROFILE?.trim().slice(0, 64) || 'standard',
						numberAgentProfiles: parseTwilioNumberAgentProfiles(
							process.env.TWILIO_NUMBER_AGENT_PROFILES || '',
						),
						outboundDial: buildTwilioOutboundDialConfig(),
					}
				: undefined,
	};

	// Validate auth config
	if (config.auth.enabled) {
		if (config.auth.method === 'api_key' && !config.auth.apiKey) {
			throw new Error('AUTH_API_KEY required when AUTH_METHOD=api_key');
		}
		if (config.auth.method === 'jwt' && !config.auth.jwtSecret) {
			throw new Error('JWT_SECRET required when AUTH_METHOD=jwt');
		}
		if (config.auth.method === 'oauth' && !config.auth.oauth) {
			throw new Error('OAuth config required when AUTH_METHOD=oauth');
		}
		if (config.auth.method === 'supabase' && !config.auth.supabase) {
			throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY required when AUTH_METHOD=supabase');
		}
	}

	return config;
}

/**
 * Validate server configuration.
 */
export function validateConfig(config: ServerConfig): void {
	if (config.port < 1 || config.port > 65535) {
		throw new Error(`Invalid port: ${config.port}`);
	}

	if (config.maxSessionsPerUser < 1) {
		throw new Error('MAX_SESSIONS_PER_USER must be at least 1');
	}

	if (config.maxTotalSessions < 1) {
		throw new Error('MAX_TOTAL_SESSIONS must be at least 1');
	}

	if (config.sessionTimeoutMs < 0) {
		throw new Error('SESSION_TIMEOUT_MS must be non-negative');
	}

	if (config.cleanupIntervalMs < 1000) {
		throw new Error('CLEANUP_INTERVAL_MS must be at least 1000ms');
	}

	if (config.twilio?.outboundDial && !config.twilio.inboundEnabled) {
		throw new Error(
			'TWILIO_OUTBOUND_ENABLED requires TWILIO_INBOUND_ENABLED (shared Media Stream server)',
		);
	}
}
