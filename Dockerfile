FROM node:22-bookworm-slim

WORKDIR /app

# Reuse the existing repository dependencies; do not include secrets or /data.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Reuse the existing pairing web server.
COPY src ./src

# Isolated test application. The official src/index.js is not started.
COPY prime-test-runtime.mjs start-test.mjs workflow.test.mjs ./
RUN node --check prime-test-runtime.mjs && node --check start-test.mjs && node --test workflow.test.mjs

ENV NODE_ENV=production
ENV AUTH_DIR=/data/whatsapp-auth
ENV TZ=America/Sao_Paulo

EXPOSE 3000

CMD ["node", "start-test.mjs"]
