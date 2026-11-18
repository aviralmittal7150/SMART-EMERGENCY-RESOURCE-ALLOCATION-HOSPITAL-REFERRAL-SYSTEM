# syntax=docker/dockerfile:1
FROM node:22-alpine AS base

# Install curl for healthcheck
RUN apk add --no-cache curl

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application files (.dockerignore keeps every .env* file except .env.example out of the image)
COPY . .

# Set default production environment
ENV NODE_ENV=production
ENV PORT=4000
# JWT_SECRET is intentionally not baked into the image; supply it at runtime (at least 32 characters).

# Run as the unprivileged "node" user that the official image provides, never as root (X10).
# The application only reads its files; nothing under /app needs to be writable.
USER node

# Expose backend REST API & WebSockets & static frontend
EXPOSE 4000

# Container healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:4000/health || exit 1

# Start the unified Express & WebSocket server
CMD ["node", "server/server.js"]
