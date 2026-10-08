# Browser-Automatisierung für Online-Anzeigeformulare (Frankfurt: ekom21/civento).
# Das offizielle Playwright-Image bringt Chromium samt Systembibliotheken mit;
# die npm-Version muss exakt zur Image-Version passen.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.mjs ekom21.mjs ./

USER pwuser
EXPOSE 8080
CMD ["node", "server.mjs"]
