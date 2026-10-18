# Generic Node server image. Every host injects PORT; the app must listen on 0.0.0.0:$PORT.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build --if-present && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY --from=build /app ./
EXPOSE 8080
CMD ["npm", "start"]
