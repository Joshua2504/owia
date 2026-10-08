FROM node:22-alpine
RUN npm install -g tsx
WORKDIR /app
COPY package*.json ./
RUN npm ci
# Nicht als root: Die Bind-Mounts (src, public, data) gehören dem Host-root;
# gelesen wird alles, geschrieben nur data/uploads und data/pdfs – die müssen
# auf dem Host dem UID 1000 (node) gehören (deploy.sh / DEPLOY.md: chown).
RUN chown -R node:node /app
USER node
