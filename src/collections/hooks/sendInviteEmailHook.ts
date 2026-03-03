import type { CollectionAfterChangeHook } from 'payload'
import { sendMail } from '../../services/mailer'

export const sendInviteEmailHook: CollectionAfterChangeHook = async ({ doc, operation }) => {
  // Invia solo alla creazione — non ri-invia a ogni update (es. cambio ruolo)
  if (operation !== 'create') return doc

  // Non invia invito al service account sistema
  if ((doc as { role?: string }).role === 'sistema') return doc

  const loginUrl = `${process.env.PAYLOAD_PUBLIC_SERVER_URL}/api/users/oauth/google`

  try {
    await sendMail({
      to: doc.email as string,
      subject: 'Sei stato invitato ad accedere al sistema',
      html: `
        <p>Ciao ${(doc as { name?: string }).name || doc.email},</p>
        <p>
          Un amministratore ti ha assegnato accesso al sistema
          con ruolo <strong>${(doc as { role?: string }).role}</strong>.
        </p>
        <p>
          <a href="${loginUrl}">Accedi con il tuo account Google aziendale</a>
        </p>
        <p>Usa il tuo indirizzo <strong>${doc.email}</strong> per autenticarti.</p>
        <p>Se non ti aspettavi questa mail, ignorala.</p>
      `,
    })
  } catch (err) {
    // Log dell'errore senza bloccare la creazione dell'utente
    console.error('Errore invio mail di invito:', err)
  }

  return doc
}
