# -------------------------------------------------------------
# Souon AI Micro Store / Japan Inbound & Cross-Border Rules MCP
# Production Dockerfile (Zero npm dependencies, Pure Node.js)
# -------------------------------------------------------------
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Set production environment
ENV NODE_ENV=production
ENV PORT=3456
ENV JP_RULES_ONLY=true
ENV JP_RULES_FREE_BETA=true

# Copy application files
COPY package*.json ./
COPY server.js mcp.js store.js stripe_billing.js usage_stats.js ./
COPY jp_rules/ ./jp_rules/
COPY public/ ./public/

# Create data and products directory and assign ownership to node user
RUN mkdir -p /app/data /app/products && chown -R node:node /app

# Switch to non-root user for security
USER node

# Expose HTTP port
EXPOSE 3456

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3456/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Start server
CMD ["node", "server.js"]
