/**
 * Server Configuration
 *
 * Configuration management for the multi-user production server.
 */

export interface ServerConfig {
	/** WebSocket server port */
	port: number;
	/** WebSocket server host */
	host: string;
	/** Gemini API key */
	apiKey: string;
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
}

/**
 * Load server configuration from environment variables.
 */
export function loadConfig(): ServerConfig {
	const port = Number(process.env.PORT) || 9900;
	const host = process.env.HOST || '0.0.0.0';
	const apiKey = process.env.GEMINI_API_KEY || '';

	if (!apiKey) {
		throw new Error('GEMINI_API_KEY environment variable is required');
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
		apiKey,
		maxSessionsPerUser: Number(process.env.MAX_SESSIONS_PER_USER) || 5,
		maxTotalSessions: Number(process.env.MAX_TOTAL_SESSIONS) || 1000,
		sessionTimeoutMs: Number(process.env.SESSION_TIMEOUT_MS) || 30 * 60 * 1000, // 30 minutes
		cleanupIntervalMs: Number(process.env.CLEANUP_INTERVAL_MS) || 60 * 1000, // 1 minute
		auth: {
			enabled: authEnabled,
			method: authMethod,
			apiKey: process.env.AUTH_API_KEY,
			jwtSecret: process.env.JWT_SECRET,
			supabase: process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
				? {
						url: process.env.SUPABASE_URL,
						anonKey: process.env.SUPABASE_ANON_KEY,
					}
				: undefined,
			oauth: process.env.OAUTH_CLIENT_ID && process.env.OAUTH_CLIENT_SECRET
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
}
