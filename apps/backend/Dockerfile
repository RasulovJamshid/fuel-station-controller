FROM node:20-alpine AS builder

WORKDIR /app

RUN apk add --no-cache openssl

COPY package*.json ./
RUN npm install

COPY . .
RUN npx prisma generate
RUN npm run build

# Fail loudly if the build didn't produce output
RUN test -f dist/main.js || (echo "BUILD ERROR: dist/main.js missing — TypeScript compilation failed" && ls -la dist/ 2>/dev/null && exit 1)

FROM node:20-alpine AS runner

WORKDIR /app

RUN apk add --no-cache postgresql-client openssl

COPY package*.json ./
RUN npm install --omit=dev

# Copy schema first so prisma generate can run without a DB connection
COPY prisma ./prisma
COPY scripts ./scripts
RUN npx prisma generate

# Copy compiled app from builder
COPY --from=builder /app/dist ./dist

EXPOSE 4000

COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x entrypoint.sh

CMD ["./entrypoint.sh"]
