# Architettura Generale

## Contesto

Il progetto nasce dall'esigenza di automatizzare due processi manuali ripetitivi:
1. L'approvazione delle assenze dei manager su Furious
2. La registrazione delle fatture passive su Furious dopo che arrivano su Starty

Entrambi i processi richiedevano oggi un'azione manuale su Furious. Il middleware
elimina o riduce questa operatività, mantenendo dove necessario un punto di controllo umano.

## Principio fondamentale: Estensibilità by design

Ogni scelta tecnica in questo progetto viene valutata non solo per il caso d'uso
immediato ma per quanto facilmente permette di aggiungere nuovi flussi, nuove entità
e nuovi sistemi in futuro. Questo è un vincolo architetturale, non una preferenza.

In pratica significa:
- I client API (Furious, Starty) sono isolati in `lib/` e non dipendono dai flussi specifici
- Il pattern worker è generico e replicabile per qualsiasi nuovo flusso
- Le Collection PayloadCMS hanno un design che non richiede modifiche strutturali per aggiungere campi
- Il sistema di code (Cloud Tasks) è configurato per accogliere nuove queue senza cambiare il pattern

## Componenti principali

### PayloadCMS su Cloud Run
È il cuore del sistema. Svolge tre ruoli distinti:
- **Ricevitore webhook**: endpoint HTTP che ricevono le notifiche da Furious e Starty
- **Admin UI**: interfaccia web per l'operatività (revisione fatture, configurazione manager)
- **Orchestratore worker**: riceve i task da Cloud Tasks ed esegue la logica di integrazione

### Google Cloud Tasks
Disaccoppia la ricezione del webhook dall'esecuzione della logica. Quando arriva un webhook,
PayloadCMS risponde immediatamente 200 OK (entro pochi ms) e accoda il lavoro su Cloud Tasks.
Il worker viene invocato in modo asincrono, con retry automatico in caso di errore.

Questo è fondamentale perché le API di Furious e Starty possono essere lente o temporaneamente
non disponibili — non possiamo tenere in attesa il webhook sender.

### Google Cloud SQL (PostgreSQL)
Database principale. Contiene sia i dati operativi (log, code di revisione, regole)
sia i dati di sistema PayloadCMS (utenti, sessioni, media).

### Google Secret Manager
Tutti i segreti (token API, HMAC secrets per verifica webhook, credenziali) vivono qui.
Mai in variabili d'ambiente nel codice. I worker leggono da Secret Manager a runtime,
con caching in memoria per ridurre le chiamate.

## Flusso asincrono — pattern comune

```
Sistema esterno
    → POST webhook → PayloadCMS endpoint
    → PayloadCMS: salva payload in DB, risponde 200 OK
    → PayloadCMS: crea task su Cloud Tasks
    → Cloud Tasks: invoca worker su PayloadCMS
    → Worker: legge dati, chiama API esterne, aggiorna DB
    → Worker: in caso di errore retriable, risponde 5xx → Cloud Tasks riprova
    → Worker: in caso di errore permanente, risponde 200 OK → logga failed_permanent
```

## Gestione errori e retry

Gli errori sono classificati in due categorie:

**Retriable** (Cloud Tasks riprova automaticamente):
- 429 Too Many Requests
- 500, 502, 503, 504 errori server
- Timeout di rete
- 401 Unauthorized (worker rigenera token, poi riprova)

**Non-retriable** (worker risponde 200 OK per bloccare i retry):
- 400 Bad Request — dati malformati, non si risolve riprovando
- 404 Not Found — risorsa inesistente
- Errori di logica business

In caso di esaurimento retry, il task finisce nella Dead Letter Queue
e viene inviata una notifica all'amministratore.

**Configurazione retry (queue-absences):**
- Max tentativi: 5
- Backoff: 30s → 2min → 8min → 30min → 1h (moltiplicatore ×4)

## Sicurezza webhook

Tutti i webhook in ingresso vengono verificati prima di essere processati:

**Starty**: firma HmacSha256
- Header `X-StartyHook-Signature`: firma del payload
- Header `X-StartyHook-Timestamp`: timestamp della chiamata
- Algoritmo: HMAC-SHA256(payload_bytes + timestamp_bytes, secret)
- Secret: letto da GCP Secret Manager

**Furious**: da verificare durante sviluppo (documentazione API v2 non specifica
il meccanismo esatto di firma — vedere `DECISIONS.md` per aggiornamenti)

## Autenticazione API esterne

Entrambe le API richiedono token che scadono. Il pattern è identico per entrambe:

```
getFuriousToken() / getStartyToken()
    → legge token e timestamp da Secret Manager
    → se valido: restituisce token
    → se scaduto o assente: chiama endpoint auth, salva nuovo token
    → se chiamata riceve 401: forza rinnovo token, riprova una volta
```

## Ambienti

| Ambiente | URL | Database |
|----------|-----|----------|
| Locale | localhost:3000 | PostgreSQL locale (Docker) |
| Staging | da definire | Cloud SQL staging |
| Produzione | da definire | Cloud SQL produzione |

## Decisioni documentate

Vedere `DECISIONS.md` per il log completo delle decisioni architetturali prese
durante lo sviluppo e le deviazioni rispetto a questa specifica.
