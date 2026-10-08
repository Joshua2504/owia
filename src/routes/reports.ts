// Einstieg der Anzeigen-Routen. Die Handler liegen thematisch aufgeteilt unter
// src/routes/reports/ (editor, images, submit, bulk; gemeinsame Helfer in
// shared). Diese Datei registriert die Teilrouten und re-exportiert alles, was
// andere Module (admin, review, portalDispatch, pdf, split-multi-vehicle,
// Tests) weiterhin aus 'routes/reports' beziehen – Importpfade bleiben stabil.
import { FastifyInstance } from 'fastify'
import editorRoutes from './reports/editor'
import imageRoutes from './reports/images'
import submitRoutes from './reports/submit'
import bulkRoutes from './reports/bulk'

export {
  VERSTOSS_ARTEN,
  ensureMailVariant,
  strukturFelder,
  normalizePlate,
  mostUsedVerstoesse,
  isProfileComplete,
  regeneratePdf,
  enqueuePdf,
} from './reports/shared'
export type { ReportImage } from './reports/shared'
export { submitDraft, submitProblems, drittProblem } from './reports/submit'
export type { SubmitOutcome } from './reports/submit'
export { moveImages } from './reports/images'

export default async function reportsRoutes(app: FastifyInstance) {
  await app.register(bulkRoutes)
  await app.register(editorRoutes)
  await app.register(imageRoutes)
  await app.register(submitRoutes)
}
