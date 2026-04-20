# Multi-stage build pra imagem final pequena
FROM node:20-alpine AS deps
# git é necessário pq o Baileys (e algumas libs) podem vir de repositórios git
RUN apk add --no-cache git python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Dependências
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src

# Usuário não-root
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001 -G nodejs
USER nodejs

EXPOSE 3000

# Healthcheck (Railway/Render também fazem o seu)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+ (process.env.PORT||3000) +'/health', r => process.exit(r.statusCode===200?0:1)).on('error', () => process.exit(1))"

CMD ["node", "src/server.js"]
