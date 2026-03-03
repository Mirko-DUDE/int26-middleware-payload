import { SecretManagerServiceClient } from '@google-cloud/secret-manager'

const client = new SecretManagerServiceClient()

function secretPath(secretName: string): string {
  const project = process.env.GCP_PROJECT_ID
  if (!project) throw new Error('GCP_PROJECT_ID non configurato')
  return `projects/${project}/secrets/${secretName}/versions/latest`
}

/**
 * Legge il valore di un secret da GCP Secret Manager.
 * Lancia un errore se il secret non esiste o è vuoto.
 */
export async function getSecret(secretName: string): Promise<string> {
  const [version] = await client.accessSecretVersion({ name: secretPath(secretName) })
  const value = version.payload?.data?.toString()
  if (!value) throw new Error(`Secret "${secretName}" vuoto o non trovato`)
  return value
}

/**
 * Aggiorna il valore di un secret esistente aggiungendo una nuova versione.
 * Il secret deve già esistere in Secret Manager.
 */
export async function setSecret(secretName: string, value: string): Promise<void> {
  const project = process.env.GCP_PROJECT_ID
  if (!project) throw new Error('GCP_PROJECT_ID non configurato')

  await client.addSecretVersion({
    parent: `projects/${project}/secrets/${secretName}`,
    payload: { data: Buffer.from(value) },
  })
}
