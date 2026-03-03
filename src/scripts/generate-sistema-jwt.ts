/**
 * Script one-shot: genera il JWT del service account 'sistema'.
 *
 * Eseguire una sola volta dopo il deploy iniziale.
 * Salvare il token in GCP Secret Manager come 'sistema-jwt'.
 *
 * Uso:
 *   SISTEMA_EMAIL=sistema@azienda.it npx tsx src/scripts/generate-sistema-jwt.ts
 */

import 'dotenv/config'
import { getPayload } from 'payload'
import config from '../payload.config'

async function generateSistemaJWT() {
  const payload = await getPayload({ config })

  const sistemaEmail = process.env.SISTEMA_EMAIL
  if (!sistemaEmail) {
    console.error('SISTEMA_EMAIL non configurato')
    process.exit(1)
  }

  const result = await payload.login({
    collection: 'users',
    data: { email: sistemaEmail, password: '' },
    overrideAccess: true,
  })

  if (!result.token) {
    console.error('Impossibile generare il JWT: login fallito')
    process.exit(1)
  }

  console.log('\n=== JWT Service Account Sistema ===')
  console.log(result.token)
  console.log('\nSalva questo token in GCP Secret Manager come: sistema-jwt')
  console.log('Poi aggiungilo come env var SISTEMA_JWT al deploy Cloud Run.\n')

  process.exit(0)
}

generateSistemaJWT().catch((err) => {
  console.error(err)
  process.exit(1)
})
