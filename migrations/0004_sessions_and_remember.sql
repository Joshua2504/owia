-- Persistenter Session-Store: Sessions liegen in der DB statt im Arbeitsspeicher,
-- damit ein App-/Stack-Neustart die Anmeldung nicht verwirft.
CREATE TABLE IF NOT EXISTS sessions (
  sid        VARCHAR(128) PRIMARY KEY,
  data       TEXT NOT NULL,
  expires_at DATETIME NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- "Angemeldet bleiben (30 Tage)": Wunsch wird am Login-Token gemerkt und beim
-- Abschluss (Code/Link) in die Cookie-Lebensdauer übernommen.
ALTER TABLE login_tokens ADD COLUMN IF NOT EXISTS remember TINYINT(1) NOT NULL DEFAULT 0;
