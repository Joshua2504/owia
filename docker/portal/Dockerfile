# Browser-Automatisierung für Online-Anzeigeformulare (Frankfurt: ekom21/civento).
# Das offizielle Playwright-Image bringt Chromium samt Systembibliotheken mit;
# die npm-Version muss exakt zur Image-Version passen.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

# pdftotext: die Vorgangs-ID steht nur in der PDF-Zusammenfassung (Fußzeile
# „Vorgang: Anzeige einer Ordnungswidrigkeit / 26.111745"), nicht auf der Seite.
# ffmpeg: Live-Video (H.264) für /versand.
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.mjs lib.mjs ekom21.mjs mainz.mjs ./

USER pwuser
EXPOSE 8080
CMD ["node", "server.mjs"]
