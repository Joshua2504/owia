FROM node:22-alpine
RUN npm install -g tsx
WORKDIR /app
COPY package*.json ./
RUN npm ci
