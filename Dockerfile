FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

# Settings and adhaan audio live outside the image
VOLUME ["/app/data", "/app/media"]

EXPOSE 8090
CMD ["node", "src/index.js"]
