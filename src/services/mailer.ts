import { google } from 'googleapis'

export interface FailedTaskEmailParams {
  collection: string
  recordId: string
  furiousAbsenceId: number
  pseudo: string
  attempts: number
  lastError: string
}

/**
 * Invia una mail tramite Gmail API usando domain-wide delegation.
 * Il Service Account impersona GMAIL_DELEGATED_USER per inviare
 * a nome di noreply@azienda.it.
 */
export async function sendMail({
  to,
  subject,
  html,
}: {
  to: string
  subject: string
  html: string
}): Promise<void> {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON
  if (!keyJson) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY_JSON non configurato')
  }

  const serviceAccountKey = JSON.parse(keyJson) as {
    client_email: string
    private_key: string
  }

  const auth = new google.auth.JWT({
    email: serviceAccountKey.client_email,
    key: serviceAccountKey.private_key,
    scopes: ['https://www.googleapis.com/auth/gmail.send'],
    subject: process.env.GMAIL_DELEGATED_USER,
  })

  const gmail = google.gmail({ version: 'v1', auth })

  // Gmail API richiede il messaggio in formato RFC 2822 codificato base64url
  const message = [
    `From: ${process.env.GMAIL_SENDER_ADDRESS}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    html,
  ].join('\n')

  const encodedMessage = Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encodedMessage },
  })
}

export async function sendFailedTaskEmail(params: FailedTaskEmailParams): Promise<void> {
  const { collection, recordId, furiousAbsenceId, pseudo, attempts, lastError } = params
  const adminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL
  if (!adminEmail) throw new Error('BOOTSTRAP_ADMIN_EMAIL non configurato')

  const adminUrl = process.env.SERVER_URL ?? ''
  const recordUrl = `${adminUrl}/admin/collections/${collection}/${recordId}`

  await sendMail({
    to: adminEmail,
    subject: `[Middleware] Task fallito definitivamente — ${collection} #${recordId}`,
    html: `
      <h2>Task fallito definitivamente</h2>
      <p><strong>Collection:</strong> ${collection}</p>
      <p><strong>Record:</strong> <a href="${recordUrl}">${recordId}</a></p>
      <p><strong>Furious Absence ID:</strong> ${furiousAbsenceId}</p>
      <p><strong>Pseudo:</strong> ${pseudo}</p>
      <p><strong>Tentativi effettuati:</strong> ${attempts}</p>
      <p><strong>Ultimo errore:</strong> ${lastError}</p>
    `,
  })
}
