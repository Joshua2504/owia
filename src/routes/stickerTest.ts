import { FastifyInstance } from 'fastify'
import mysql from 'mysql2/promise'
import { pool } from '../db/connection'
import { viewData } from '../middleware/auth'
import { appUrl } from '../config/app'
import { entwurfFavoriten, entwurfSvg } from '../services/stickers'
import { ENTWUERFE, entwurf } from '../services/stickerEntwuerfe'

// Galerie der Sticker-Textvorlagen (services/stickerEntwuerfe.ts) – dieselbe
// Vorschau, die /sticker beim Erzeugen zeigt, hier im Referenzformat
// 96 × 50,8 mm. Öffentlich wie /logos, aber per robots.txt („Disallow: /")
// ausgenommen. Angemeldete Nutzer markieren Favoriten (Tabelle
// sticker_entwurf_favoriten); Favoriten stehen hier oben und unter /sticker
// zuerst in der Auswahl.
//
// Beträge: Regelsatz des festen Tatbestands der Vorlage, sonst Beispiel
// Gehweg (112454) – beim Erzeugen gilt der gewählte Verstoß.
const BEISPIEL_TBNR = '112454'

let svgCache: { base: string; svgs: Map<string, string> } | null = null

async function vorschauen(base: string): Promise<Map<string, string>> {
  if (svgCache?.base !== base) {
    const svgs = new Map<string, string>()
    for (const e of ENTWUERFE) svgs.set(e.slug, await entwurfSvg(e, 96, 50.8, BEISPIEL_TBNR, base))
    svgCache = { base, svgs }
  }
  return svgCache.svgs
}

export default async function stickerTestRoutes(app: FastifyInstance) {
  app.get('/sticker-test', async (request, reply) => {
    const userId = request.session.userId
    const favoriten = userId ? await entwurfFavoriten(userId) : new Set<string>()
    const svgs = await vorschauen(appUrl(request))
    const entwuerfe = ENTWUERFE.map((e, i) => ({
      nr: i + 1, slug: e.slug, name: e.name, idee: e.idee, favorit: favoriten.has(e.slug), svg: svgs.get(e.slug),
    }))
    return reply.view('/public/sticker-test.ejs', viewData(request, {
      title: 'Sticker-Vorlagen',
      wide: true,
      angemeldet: Boolean(userId),
      favoriten: entwuerfe.filter((e) => e.favorit),
      andere: entwuerfe.filter((e) => !e.favorit),
    }))
  })

  // Favorit an/aus. Formular ohne JS; zurück zur Karte der Vorlage.
  app.post('/sticker-test/favorit', async (request, reply) => {
    const userId = request.session.userId
    if (!userId) return reply.redirect('/login?weiter=/sticker-test')
    const slug = String((request.body as { slug?: string } | undefined)?.slug || '')
    if (!entwurf(slug)) return reply.status(400).send('Unbekannte Vorlage.')
    const [res] = await pool.execute<mysql.ResultSetHeader>(
      'DELETE FROM sticker_entwurf_favoriten WHERE user_id = ? AND slug = ?', [userId, slug]
    )
    if (res.affectedRows === 0) {
      await pool.execute('INSERT IGNORE INTO sticker_entwurf_favoriten (user_id, slug) VALUES (?, ?)', [userId, slug])
    }
    return reply.redirect(`/sticker-test#${slug}`)
  })
}
