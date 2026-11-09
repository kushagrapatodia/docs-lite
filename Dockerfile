FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
# SQLite lives on a volume; run as the unprivileged "node" user.
RUN mkdir -p /data && chown -R node:node /data /app
ENV PORT=3000 DATA_DIR=/data NODE_ENV=production
VOLUME ["/data"]
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1
CMD ["node", "--no-warnings", "server.js"]
