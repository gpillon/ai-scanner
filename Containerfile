# The ai-scanner service image: the API plus the web UI it serves under /ui/.
#   podman build -t ai-scanner:dev .        (or: make image)
# Stages share one Debian base: better-sqlite3 and the Typst compiler ship glibc native binaries.
ARG NODE_IMAGE=docker.io/library/node:24-slim

# --- Web UI: Vite build of ui/ ---
FROM ${NODE_IMAGE} AS ui
WORKDIR /build/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY ui/ ./
RUN npm run build

# --- Backend: TypeScript build, then production dependencies only ---
FROM ${NODE_IMAGE} AS backend
# Toolchain for native modules without a prebuilt binary for this platform.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src/ src/
RUN npm run build && npm prune --omit=dev && npm cache clean --force

# --- Runtime ---
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    PORT=3000 \
    SCANNER_DATA_DIR=/data
WORKDIR /app
COPY --from=backend /build/package.json ./
COPY --from=backend /build/node_modules/ node_modules/
COPY --from=backend /build/dist/ dist/
# Read at runtime relative to dist/: Scan Profiles, and the egress proxy the Podman Runner mounts.
COPY profiles/ profiles/
COPY containers/egress-proxy/ containers/egress-proxy/
COPY --from=ui /build/ui/dist/ ui/dist/
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
CMD ["node", "dist/main.js"]
