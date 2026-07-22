-- Tatzeitraum über Mitternacht hinaus: tattag_bis ergänzt tattag, wenn die
-- Tatzeit "bis" auf einen anderen (späteren) Tag fällt, z.B. Dauerparken über
-- Nacht. NULL = Beginn und Ende am selben Tag (tattag).

ALTER TABLE reports ADD COLUMN IF NOT EXISTS tattag_bis DATE NULL;
