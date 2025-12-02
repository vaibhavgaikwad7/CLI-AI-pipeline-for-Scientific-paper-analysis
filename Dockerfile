# syntax=docker/dockerfile:1

# --- 1) Build stage: install deps & compile TS
FROM node:20-alpine AS build
WORKDIR /app
ENV TZ=UTC

# Install deps from lockfile (reproducible)
COPY package.json package-lock.json ./
RUN npm ci

# Copy TS sources and config, then build
COPY tsconfig.json ./
COPY src ./src
COPY reference-docs ./reference-docs
RUN npm run build

# --- 2) Runtime stage: only prod deps + built files
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV TZ=UTC
# helps DNS on some Windows networks
ENV NODE_OPTIONS=--dns-result-order=ipv4first

# Install only production deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Bring compiled JS + sample docs
COPY --from=build /app/dist ./dist
COPY --from=build /app/reference-docs ./reference-docs

# Minimal entrypoint wrapper
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
