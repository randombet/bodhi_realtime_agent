# Multi-User Production Architecture

## Overview

This document outlines the production-ready architecture for supporting multiple concurrent users in the Bodhi Realtime Agent Framework.

## Current State (Single-User)

The current implementation (`app/gemini-realtime-tools.ts`) creates a single `VoiceSession` instance that handles one WebSocket connection. Multiple users would conflict because:

1. **Single Session ID**: One `SESSION_ID` shared across all connections
2. **Single ClientTransport**: Only tracks one WebSocket connection
3. **Shared Conversation Context**: All users would share the same conversation history

## Production Architecture

### Core Components

```
┌─────────────────────────────────────────────────────────────┐
│                    Multi-User Server                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────────┐         ┌──────────────────────┐      │
│  │ SessionManager  │────────▶│  VoiceSession Pool   │      │
│  │  (Singleton)    │         │  Map<sessionId,       │      │
│  │                 │         │   VoiceSession>       │      │
│  └──────────────────┘         └──────────────────────┘      │
│           │                              │                   │
│           │                              │                   │
│  ┌────────▼────────┐         ┌──────────▼──────────┐       │
│  │ Auth Middleware │         │  WebSocket Server   │       │
│  │  (JWT/OAuth)    │         │  (Port 9900)        │       │
│  └─────────────────┘         └──────────────────────┘       │
│           │                              │                   │
│           │                              │                   │
│  ┌────────▼──────────────────────────────▼──────────┐        │
│  │         Connection Handler                      │        │
│  │  - Extract userId from auth token               │        │
│  │  - Create/retrieve VoiceSession                 │        │
│  │  - Route messages to correct session            │        │
│  └──────────────────────────────────────────────────┘        │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

1. **One VoiceSession per User Connection**
   - Each WebSocket connection gets its own `VoiceSession` instance
   - Unique `sessionId` per connection
   - Isolated conversation context

2. **Session Lifecycle Management**
   - Create session on WebSocket connection
   - Cleanup on disconnect (with grace period for reconnection)
   - Session timeout for idle connections

3. **User Identification**
   - Extract `userId` from authentication token (JWT/OAuth)
   - Support anonymous users with temporary IDs
   - Map `userId` → active sessions for user management

4. **Resource Management**
   - Connection limits per user/IP
   - Memory limits per session
   - Automatic cleanup of orphaned sessions

5. **Error Isolation**
   - Errors in one session don't affect others
   - Per-session error logging and metrics
   - Circuit breaker for repeated failures

## Implementation Plan

### Phase 1: Core Multi-User Infrastructure

#### 1.1 Create SessionManager Service

**File**: `src/core/multi-user-session-manager.ts`

```typescript
export class MultiUserSessionManager {
  private sessions = new Map<string, VoiceSession>();
  private sessionMetadata = new Map<string, SessionMetadata>();
  
  async createSession(config: {
    userId: string;
    sessionId: string;
    // ... VoiceSessionConfig
  }): Promise<VoiceSession>;
  
  getSession(sessionId: string): VoiceSession | null;
  getAllSessionsForUser(userId: string): VoiceSession[];
  async closeSession(sessionId: string, reason: string): Promise<void>;
  async cleanupIdleSessions(maxIdleMs: number): Promise<void>;
}
```

**Responsibilities**:
- Track all active sessions
- Generate unique session IDs
- Handle session lifecycle (create, retrieve, close)
- Cleanup idle/disconnected sessions
- Enforce connection limits

#### 1.2 Modify ClientTransport for Multi-Connection

**File**: `src/transport/multi-client-transport.ts`

```typescript
export class MultiClientTransport {
  private connections = new Map<WebSocket, ConnectionContext>();
  
  onConnection(callback: (ws: WebSocket, context: ConnectionContext) => void);
  routeMessage(ws: WebSocket, data: Buffer | string): void;
  sendToSession(sessionId: string, message: Buffer | object): void;
}
```

**Changes from current ClientTransport**:
- Support multiple concurrent WebSocket connections
- Route messages to correct session based on WebSocket
- Track connection → session mapping

#### 1.3 Authentication Middleware

**File**: `src/auth/auth-middleware.ts`

```typescript
export interface AuthResult {
  userId: string;
  isAuthenticated: boolean;
  metadata?: Record<string, unknown>;
}

export class AuthMiddleware {
  async authenticate(token: string): Promise<AuthResult>;
  async extractUserId(ws: WebSocket): Promise<string | null>;
}
```

**Options**:
- JWT tokens in WebSocket upgrade request
- OAuth2 bearer tokens
- API keys for service-to-service
- Anonymous users (temporary userId)

### Phase 2: Production Server Implementation

#### 2.1 Main Server Entry Point

**File**: `app/multi-user-server.ts`

```typescript
class ProductionServer {
  private sessionManager: MultiUserSessionManager;
  private authMiddleware: AuthMiddleware;
  private wss: WebSocketServer;
  
  async start(): Promise<void> {
    // Initialize session manager
    // Set up WebSocket server with auth
    // Handle connections
    // Set up health checks
    // Set up metrics
  }
  
  private async handleConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
    // 1. Authenticate user
    // 2. Generate session ID
    // 3. Create VoiceSession
    // 4. Route messages
    // 5. Handle cleanup
  }
}
```

#### 2.2 Configuration Management

**File**: `src/config/server-config.ts`

```typescript
export interface ServerConfig {
  port: number;
  host: string;
  maxConnectionsPerUser: number;
  maxConnectionsTotal: number;
  sessionTimeoutMs: number;
  cleanupIntervalMs: number;
  auth: {
    enabled: boolean;
    type: 'jwt' | 'oauth' | 'api_key' | 'none';
    // ... auth-specific config
  };
  rateLimiting: {
    enabled: boolean;
    requestsPerMinute: number;
  };
}
```

### Phase 3: Production Features

#### 3.1 Rate Limiting

- Per-user rate limits
- Per-IP rate limits
- Tool call rate limits
- Connection rate limits

#### 3.2 Monitoring & Observability

- Session metrics (active sessions, connections per user)
- Error tracking per session
- Performance metrics (latency, tool execution time)
- Health check endpoint

#### 3.3 Session Persistence

- Optional session checkpointing to database
- Session resumption after disconnect
- Cross-server session sharing (for horizontal scaling)

#### 3.4 Security Hardening

- Input validation
- Output sanitization
- Resource limits (memory, CPU per session)
- DDoS protection
- WebSocket frame size limits

### Phase 4: Scalability & Reliability

#### 4.1 Horizontal Scaling

- Session store in Redis/PostgreSQL
- Load balancer support
- Sticky sessions or session migration
- Health checks for session servers

#### 4.2 Graceful Shutdown

- Drain existing connections
- Save session state
- Wait for in-flight operations
- Close WebSocket connections cleanly

#### 4.3 Error Recovery

- Automatic reconnection handling
- Session state recovery
- Circuit breaker for external services
- Retry logic with exponential backoff

## File Structure

```
app/
  multi-user-server.ts          # Main production server
  gemini-realtime-tools.ts      # Original single-user demo (keep for reference)

src/
  core/
    multi-user-session-manager.ts  # Session pool management
    server-config.ts               # Configuration management
  
  transport/
    multi-client-transport.ts      # Multi-connection WebSocket handler
  
  auth/
    auth-middleware.ts             # Authentication logic
    jwt-auth.ts                    # JWT implementation
    oauth-auth.ts                  # OAuth implementation
  
  monitoring/
    metrics.ts                     # Metrics collection
    health-check.ts                # Health check endpoint
  
  utils/
    rate-limiter.ts                # Rate limiting
    resource-limits.ts             # Resource management
```

## Migration Path

1. **Keep existing code**: `gemini-realtime-tools.ts` remains as single-user demo
2. **Create new server**: `multi-user-server.ts` for production
3. **Gradual rollout**: Test with limited users, then scale up
4. **Feature parity**: Ensure all tools/agents work in multi-user mode

## Testing Strategy

1. **Unit Tests**: Session manager, auth middleware, rate limiter
2. **Integration Tests**: Multiple concurrent connections, session lifecycle
3. **Load Tests**: 100+ concurrent users, connection churn
4. **Chaos Tests**: Network failures, server restarts, resource exhaustion

## Performance Targets

- **Connection establishment**: < 500ms
- **Message routing**: < 10ms overhead
- **Session cleanup**: < 100ms per session
- **Memory per session**: < 50MB
- **Max concurrent sessions**: 1000+ per server instance

## Security Considerations

1. **Authentication**: All connections must be authenticated (or explicitly allow anonymous)
2. **Authorization**: Users can only access their own sessions
3. **Input validation**: All user input validated before processing
4. **Rate limiting**: Prevent abuse and DoS attacks
5. **Resource limits**: Prevent resource exhaustion attacks
6. **Audit logging**: Log all session operations for security auditing
