# syntax=docker/dockerfile:1
FROM node:20-alpine AS base

# Install curl for healthcheck
RUN apk add --no-cache curl

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application files
COPY . .

# Set default production environment
ENV NODE_ENV=production
ENV PORT=4000
ENV JWT_SECRET=smart_emergency_resource_jwt_secret_key_2026

# Expose backend REST API & WebSockets & static frontend
EXPOSE 4000

# Container healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:4000/health || exit 1

# Start the unified Express & WebSocket server
CMD ["node", "server/server.js"]
