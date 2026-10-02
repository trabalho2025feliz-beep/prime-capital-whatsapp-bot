FROM node:22-bookworm-slim

WORKDIR /app

# Reuse the existing repository dependencies; do not include secrets or /data.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Reuse the existing pairing web server.
COPY src ./src

# Isolated test application. The official src/index.js is not started.
COPY prime-test-*.mjs start-test.mjs workflow.test.mjs ./
RUN node --check prime-test-runtime.mjs && node --check start-test.mjs && node --test workflow.test.mjs

COPY prime-live*.mjs start-live.mjs ./
RUN node --check start-live.mjs && node --check prime-live-transport.mjs && node prime-live.mjs --self-test && node --test prime-live.extended.test.mjs && node prime-live-sandbox.mjs --sandbox-self-test && node prime-live-quickcheck.mjs --quickcheck-self-test

ENV NODE_ENV=production
ENV AUTH_DIR=/data/whatsapp-auth
ENV TZ=America/Sao_Paulo

EXPOSE 3000

CMD ["node", "start-live.mjs"]
