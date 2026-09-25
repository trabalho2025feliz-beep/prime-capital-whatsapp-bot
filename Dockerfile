FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV AUTH_DIR=/data/whatsapp-auth

EXPOSE 3000

CMD ["npm", "start"]

