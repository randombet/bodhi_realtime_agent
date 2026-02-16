# Documentation Site

This directory contains the [VitePress](https://vitepress.dev/) documentation site for the Bodhi Realtime Agent Framework. The API reference is auto-generated from TypeScript source via [TypeDoc](https://typedoc.org/).

## Prerequisites

- Node.js 22+
- pnpm

Install dependencies from the project root (if not already done):

```bash
pnpm install
```

## Local Development

Start the dev server with hot reload:

```bash
pnpm docs:dev
```

Open http://localhost:5173/realtime_agent_framework/ in your browser. Edits to any `.md` file in `docs/` are reflected instantly.

## Build

Generate the API reference and build the static site:

```bash
pnpm docs:build
```

This runs two steps:
1. `typedoc` — generates Markdown API docs from `src/` into `docs/api/`
2. `vitepress build docs` — compiles the full site into `docs/.vitepress/dist/`

## Preview the Production Build

After building, preview the output locally:

```bash
pnpm docs:preview
```

Open http://localhost:4173/realtime_agent_framework/ to verify the production build.

## Deployment Options

### GitHub Pages (automated)

The repository includes a GitHub Actions workflow (`.github/workflows/docs.yml`) that automatically builds and deploys on every push to `main`. No manual steps needed.

The site is published at:
```
https://bodhiagent.github.io/realtime_agent_framework/
```

To set up GitHub Pages for the first time:
1. Go to the repo **Settings > Pages**
2. Set **Source** to **GitHub Actions**
3. Push to `main` — the workflow handles the rest

### Self-hosted (static files)

Build the site and serve the output directory with any static file server:

```bash
# Build
pnpm docs:build

# Serve with Node.js (example using sirv-cli)
npx sirv-cli docs/.vitepress/dist --port 8080

# Or with Python
python3 -m http.server 8080 -d docs/.vitepress/dist

# Or copy to your web server
cp -r docs/.vitepress/dist/* /var/www/docs/
```

**Important:** The site is configured with `base: '/realtime_agent_framework/'`. If you serve from a different path, update `base` in `docs/.vitepress/config.ts`:

```typescript
// docs/.vitepress/config.ts
export default defineConfig({
  base: '/',  // change to match your deployment path
  // ...
});
```

### Nginx

```nginx
server {
    listen 80;
    server_name docs.example.com;
    root /var/www/docs;
    index index.html;

    location /realtime_agent_framework/ {
        try_files $uri $uri/ /realtime_agent_framework/index.html;
    }
}
```

### Docker

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm docs:build

FROM nginx:alpine
COPY --from=build /app/docs/.vitepress/dist /usr/share/nginx/html/realtime_agent_framework
EXPOSE 80
```

```bash
docker build -t bodhi-docs .
docker run -p 8080:80 bodhi-docs
```

## Directory Structure

```
docs/
  index.md                  # Landing page (hero + features)
  guide/                    # Getting Started + Core Concepts
    index.md                  # Introduction
    quickstart.md             # 5-minute quick start
    running-examples.md       # Running the demo
    voice-session.md          # VoiceSession config & lifecycle
    agents.md                 # Agent definition & transfers
    tools.md                  # Tool definition & execution modes
    memory.md                 # Memory extraction & persistence
    events.md                 # EventBus & Hooks
    transport.md              # Audio transport & WebSocket protocol
    architecture.md           # Architecture overview with diagrams
  advanced/                 # Advanced topics
    subagents.md              # Background subagent patterns
    persistence.md            # Storage adapters
    multimodal.md             # Image, text, file upload
    deployment.md             # Production deployment
  api/                      # Auto-generated API reference (TypeDoc)
    typedoc-sidebar.json      # Sidebar navigation for API pages
  .vitepress/
    config.ts                 # VitePress + Mermaid configuration
    cache/                    # (gitignored) build cache
    dist/                     # (gitignored) production output
```
