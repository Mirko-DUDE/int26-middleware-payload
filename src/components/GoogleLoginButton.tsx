/**
 * Pulsante di login Google OAuth2 per la pagina /admin/login.
 *
 * Server Component (no 'use client'): renderizzato nell'HTML iniziale,
 * appare immediatamente senza attendere l'idratazione React.
 *
 * Registrato in payload.config.ts sotto admin.components.beforeLogin.
 * Il plugin payload-oauth2 registra gli endpoint sulla collection:
 * /api/{authCollection}{authorizePath} → /api/users/oauth/google
 */
export default function GoogleLoginButton() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '16px',
        marginBottom: '24px',
        width: '100%',
      }}
    >
      <a
        href="/api/users/oauth/google"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '12px',
          width: '100%',
          padding: '10px 16px',
          backgroundColor: '#ffffff',
          color: '#3c4043',
          border: '1px solid #dadce0',
          borderRadius: '4px',
          fontSize: '14px',
          fontWeight: 500,
          fontFamily: 'inherit',
          cursor: 'pointer',
          textDecoration: 'none',
          boxSizing: 'border-box',
        }}
      >
        <GoogleIcon />
        Accedi con Google
      </a>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          width: '100%',
          gap: '12px',
          color: '#6b7280',
          fontSize: '12px',
        }}
      >
        <div style={{ flex: 1, height: '1px', backgroundColor: '#e5e7eb' }} />
        <span>oppure</span>
        <div style={{ flex: 1, height: '1px', backgroundColor: '#e5e7eb' }} />
      </div>
    </div>
  )
}

function GoogleIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
        fill="#4285F4"
      />
      <path
        d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.258c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z"
        fill="#34A853"
      />
      <path
        d="M3.964 10.707c-.18-.54-.282-1.117-.282-1.707s.102-1.167.282-1.707V4.961H.957C.347 6.175 0 7.55 0 9s.348 2.825.957 4.039l3.007-2.332z"
        fill="#FBBC05"
      />
      <path
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.961L3.964 7.293C4.672 5.166 6.656 3.58 9 3.58z"
        fill="#EA4335"
      />
    </svg>
  )
}
