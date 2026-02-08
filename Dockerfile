# syntax=docker/dockerfile:1
FROM node:20-alpine

# Create app directory
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN apk add --no-cache ca-certificates

RUN npm install --omit=dev && npm cache clean --force

# Bundle app source
COPY . .

# Security: run as non-root
RUN addgroup -S app && adduser -S app -G app
USER app

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
