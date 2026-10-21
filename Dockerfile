# Etapa 1: compilar TypeScript
FROM node:22-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src src
COPY test test
RUN npx tsc

# Etapa 2: ejecutar solo con las dependencias de producción
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/dist/src dist/src
USER node
EXPOSE 8000
CMD ["node", "dist/src/server.js"]
