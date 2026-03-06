# Furious API — Integrazione

## Panoramica

Il modulo `src/lib/furious/` gestisce tutta la comunicazione con l'ERP Furious
(`dude.furious-squad.com`), API v2. È composto da due file con responsabilità separate:

- **`auth.ts`** — gestione del ciclo di vita del token di autenticazione
- **`api.ts`** — chiamate alle risorse Furious (assenze, ecc.)

## Autenticazione — `auth.ts`

### Meccanismo

Furious usa un token bearer (`F-Auth-Token`) ottenuto tramite POST su `/api/v2/auth/`
con username e password. Il token ha una durata di 60 minuti; il middleware usa un TTL
conservativo di 55 minuti per evitare race condition.

### Strategia di caching (tre livelli)

```
1. Cache in-memory (TokenCache) — priorità massima, zero latenza
2. Google Secret Manager — solo in produzione, sopravvive ai riavvii
3. Nuovo fetch POST /api/v2/auth/ — fallback finale
```

In ambiente locale (`NODE_ENV !== 'production'`) la cache in-memory è sufficiente:
Secret Manager non viene mai chiamato, evitando errori di credenziali GCP assenti.

### Credenziali

Le credenziali di autenticazione (`FURIOUS_USERNAME`, `FURIOUS_PASSWORD`) vengono
lette da env vars. In produzione queste env vars sono montate da Secret Manager al
deploy. Il token risultante viene scritto su Secret Manager a runtime per condividerlo
tra le istanze Cloud Run.

### Rinnovo automatico su 401

Se una chiamata API riceve HTTP 401, `api.ts` chiama `invalidateFuriousToken()` che
azzera la cache in-memory, poi ritenta l'autenticazione. Se il secondo tentativo
restituisce ancora 401, viene lanciato `FuriousApiError(401, ...)`.

## Client HTTP — `api.ts`

### Base URL configurabile

```typescript
const FURIOUS_BASE_URL = process.env.FURIOUS_BASE_URL ?? 'https://dude.furious-squad.com'
```

La variabile `FURIOUS_BASE_URL` permette di puntare all'ambiente sandbox
(`https://dudesandbox.furious-squad.com`) in sviluppo locale senza modificare il codice.
Se non impostata, il fallback è l'URL di produzione.

### Pattern di chiamata

Tutte le chiamate passano per `furiousRequest<T>()`, che:
1. Ottiene il token tramite `getFuriousToken()`
2. Esegue la richiesta con header `F-Auth-Token`
3. Su 401: invalida il token, rinnova, riprova una volta
4. Su altri errori HTTP: lancia `FuriousApiError(status, message)`

### Endpoint implementati

#### `approveAbsence(absenceId: number)`

Approva un'assenza impostandone lo status a 1 (Confermata).

```
PUT /api/v2/absence/
Body: { "action": "update", "data": { "id": <id>, "status": 1 } }
```

**Attenzione:** l'ID dell'assenza NON va nell'URL ma nel body dentro `data.id`.
Il campo `action: "update"` è obbligatorio — senza di esso Furious ignora la richiesta.

Valori status Furious:
- `1` = Confermata (approvata)
- `2` = Annullata

#### `getAbsence(absenceId: number)`

Recupera i dettagli di un'assenza.

```
GET /api/v2/absence/?id=<id>
```

L'ID viene passato come query string, non come segmento di path.

## Variabili d'ambiente

| Variabile | Obbligatoria | Descrizione |
|---|---|---|
| `FURIOUS_USERNAME` | Sì | Username account API Furious |
| `FURIOUS_PASSWORD` | Sì | Password account API Furious |
| `FURIOUS_BASE_URL` | No | Override URL base (default: produzione). Usare per puntare al sandbox in locale. |

## Ambienti

| Ambiente | URL |
|---|---|
| Produzione | `https://dude.furious-squad.com` |
| Sandbox / sviluppo | `https://dudesandbox.furious-squad.com` |

## Errori comuni

### "Furious auth: token mancante nella risposta"

La chiamata a `/api/v2/auth/` ha restituito HTTP 200 ma il body non contiene `token`.
Cause probabili:
- Credenziali errate (`FURIOUS_USERNAME`/`FURIOUS_PASSWORD` nel `.env`)
- L'account non ha i permessi API abilitati su Furious

### "Could not load the default credentials"

Secret Manager viene chiamato in ambiente locale. Verificare che `NODE_ENV` non sia
impostato a `production` in locale, oppure che `FURIOUS_BASE_URL` punti al sandbox.

## Estensibilità

Per aggiungere nuovi endpoint Furious:
1. Aggiungere la funzione esportata in `api.ts` usando `furiousRequest<T>()`
2. Aggiungere il tipo di risposta come interfaccia nello stesso file
3. Non modificare `auth.ts` — il meccanismo di autenticazione è trasparente
