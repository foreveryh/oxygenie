# ---- Stage 1: Build ----------------------------------------------------------
FROM node:24-bookworm-slim AS builder

# TLS root store for outbound HTTPS
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    procps \
  && rm -rf /var/lib/apt/lists/*

# Allow Vite build to use more memory inside the builder container
# Reduced from 16384 to 8192 (8GB) to prevent OOM on 16GB VPS
ENV NODE_OPTIONS="--max-old-space-size=8192"

# Build-time args for Vite environment variables
ARG VITE_WS_URL
ENV VITE_WS_URL=${VITE_WS_URL}

# OAuth client IDs (optional - for social login)
ARG VITE_GITHUB_CLIENT_ID
ENV VITE_GITHUB_CLIENT_ID=${VITE_GITHUB_CLIENT_ID}

ARG VITE_GOOGLE_CLIENT_ID
ENV VITE_GOOGLE_CLIENT_ID=${VITE_GOOGLE_CLIENT_ID}

# PostHog product analytics
ARG VITE_POSTHOG_KEY
ENV VITE_POSTHOG_KEY=${VITE_POSTHOG_KEY}
ARG VITE_POSTHOG_HOST
ENV VITE_POSTHOG_HOST=${VITE_POSTHOG_HOST}

# Use pnpm
RUN corepack enable && corepack prepare pnpm@10.17.1 --activate

WORKDIR /app

# Install dependencies (with lockfile)
COPY package.json pnpm-lock.yaml ./
RUN echo "=== Memory before pnpm install ===" && free -m && \
    pnpm install --frozen-lockfile && \
    echo "=== Memory after pnpm install ===" && free -m

# Copy source and build
COPY . .
ENV NODE_ENV=production
# Set CLAUDE_SESSIONS_ROOT at build time so Nitro knows about it
ENV CLAUDE_SESSIONS_ROOT=/data/users

# Build with memory monitoring
RUN echo "=== Memory before build ===" && free -m && \
    echo "=== Starting Vite build (client + ssr + nitro) ===" && \
    pnpm run build && \
    echo "=== Memory after build ===" && free -m && \
    echo "=== Build output size ===" && du -sh .output/

# ---- Stage 2: Runtime --------------------------------------------------------
FROM node:24-bookworm-slim AS runner

# LibreOffice (~1GB) and Playwright/chromium (~1.2GB) were REMOVED (2026-06): too heavy
# to run inside the sandbox, and the image no longer ships them. Office-conversion and
# server-side-screenshot Skills degrade accordingly. The lean image is the only image now.

# Core runtime deps: Python data stack + sandbox tools (bubblewrap/socat/ripgrep)
# + lightweight doc tools (qpdf, pandoc). LibreOffice is installed separately below.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    bash \
    git \
    bubblewrap \
    socat \
    ripgrep \
    python3 \
    python3-pip \
    python3-numpy \
    python3-pandas \
    python3-matplotlib \
    python3-pil \
    python3-yaml \
    python3-scipy \
    python3-seaborn \
    python3-bs4 \
    python3-lxml \
    qpdf \
    pandoc \
    ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# Python packages for Skills
# - markitdown-mcp: MCP server for document conversion
# - pypdf, pdfplumber, reportlab: PDF skill dependencies
# - openpyxl: XLSX skill dependencies (pandas already installed)
# - python-docx, defusedxml: DOCX skill dependencies
RUN python3 -m pip install --no-cache-dir --break-system-packages \
    markitdown-mcp \
    pypdf \
    pdfplumber \
    reportlab \
    openpyxl \
    python-docx \
    defusedxml

RUN npm install -g pnpm@10.17.1

WORKDIR /app
ENV PORT=5000

# Install runtime dependencies (keep dev tools for migrations/worker)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

ENV NODE_ENV=production

# Non-root user (Debian adduser/addgroup syntax)
RUN addgroup --gid 1001 nodejs \
  && adduser --uid 1001 --gid 1001 --disabled-password --gecos "" nodejs

# Copy build output and runtime assets
# TanStack Start outputs to .output/
COPY --from=builder /app/.output ./.output
COPY --from=builder /app/public ./public
COPY --from=builder /app/drizzle ./drizzle

# Include source for the worker (runs via tsx in production)
# IMPORTANT: src/skills-store needs to be owned by nodejs for schema writes
COPY --from=builder --chown=nodejs:nodejs /app/src ./src
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/drizzle.config.ts ./drizzle.config.ts

# Copy WebSocket server, worker, and production startup script
COPY --from=builder --chown=nodejs:nodejs /app/ws-server.mjs ./ws-server.mjs
COPY --from=builder --chown=nodejs:nodejs /app/ws-query-worker.mjs ./ws-query-worker.mjs
COPY --from=builder --chown=nodejs:nodejs /app/start-production.mjs ./start-production.mjs
RUN chmod +x ./start-production.mjs

# Create data directories for Claude Agent (skills-store for global Skills, users for sessions)
RUN mkdir -p /data/users /data/skills-store && chown -R nodejs:nodejs /data

USER nodejs

# Expose main app port and WebSocket port
EXPOSE 5000 3001

# Environment variables for WebSocket
ENV WS_PORT=3001
ENV APP_URL=http://localhost:5000

# Claude Agent sessions root directory
ENV CLAUDE_SESSIONS_ROOT=/data/users

# Build identity — the git SHA this image was built from, passed by CI (build.yml).
# Surfaced at runtime via /api/health so the online-updater can report current-vs-latest.
# Placed last so changing it only invalidates this tiny final layer (fast incremental pulls).
ARG BUILD_SHA=dev
ENV BUILD_SHA=${BUILD_SHA}

# Start production script (runs both Nitro and WebSocket servers in same process)
CMD ["node", "start-production.mjs"]
