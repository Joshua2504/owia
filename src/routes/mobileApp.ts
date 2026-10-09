import { FastifyInstance } from 'fastify'
import { appId, iosTeamId, androidCertFingerprints, APP_LINK_PATHS } from '../config/mobileApp'

// Verknüpfung Domain ↔ native App (Universal Links / Android App Links), siehe
// config/mobileApp.ts. Beide Dateien rufen Apple bzw. Google direkt ab: ohne
// Redirect, unter genau diesem Pfad, als JSON. Solange Team-ID bzw.
// Fingerprint fehlen, antworten sie 404 – die App funktioniert dann trotzdem,
// nur öffnen Links aus Mails im Browser statt in der App.
export default async function mobileAppRoutes(app: FastifyInstance) {
  app.get('/.well-known/apple-app-site-association', async (_request, reply) => {
    const team = iosTeamId()
    if (!team) return reply.code(404).send({ error: 'Nicht konfiguriert' })
    return reply
      .header('Cache-Control', 'public, max-age=3600')
      .type('application/json')
      .send({
        applinks: {
          details: [{
            appIDs: [`${team}.${appId()}`],
            components: APP_LINK_PATHS.map((p) => ({ '/': p })),
          }],
        },
      })
  })

  app.get('/.well-known/assetlinks.json', async (_request, reply) => {
    const fingerprints = androidCertFingerprints()
    if (!fingerprints.length) return reply.code(404).send({ error: 'Nicht konfiguriert' })
    return reply
      .header('Cache-Control', 'public, max-age=3600')
      .type('application/json')
      .send([{
        relation: ['delegate_permission/common.handle_all_urls'],
        target: { namespace: 'android_app', package_name: appId(), sha256_cert_fingerprints: fingerprints },
      }])
  })
}
