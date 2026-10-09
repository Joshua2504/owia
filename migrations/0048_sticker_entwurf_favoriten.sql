-- Favoriten auf /sticker-test (Textentwürfe für die Sticker, routes/stickerTest.ts).
-- Je Nutzer und Entwurf eine Zeile; der Slug ist der stabile Schlüssel des
-- Entwurfs (die Nummer ergibt sich aus der Reihenfolge und kann wachsen).
CREATE TABLE IF NOT EXISTS sticker_entwurf_favoriten (
  user_id     INT NOT NULL,
  slug        VARCHAR(40) NOT NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, slug),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
