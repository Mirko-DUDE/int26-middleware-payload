# DECISIONS — int26-middleware-payload

> Log delle decisioni architetturali significative. Ogni voce documenta il problema,
> la decisione presa, la motivazione e il debito tecnico noto.
> Aggiungere in append. Non modificare voci esistenti.

---

## Formato voce

```
## [DATA] — [Titolo breve]
**Problema:** ...
**Decisione:** ...
**Motivazione:** ...
**Debito tecnico / TODO futuro:** ...
```

---

## [2026-03-02] — Permessi: Livello 1 (statico) con Pattern Adapter

**Problema:**
Il sistema di accesso alle Collection PayloadCMS deve essere definito. Le opzioni sono:
(a) logica inline in ogni Collection, (b) funzioni condivise con permessi statici,
(c) RBAC dinamico in DB configurabile da UI admin.

**Decisione:**
Implementare il **Livello 1**: permessi come oggetto TypeScript statico in
`src/access/permissions.ts`. Le Collection chiamano solo `canRead(resource)` e
`canWrite(resource)` — nessuna logica di accesso inline.

**Motivazione:**
- Sufficiente per il caso d'uso attuale: pochi ruoli fissi, modifiche rare
- Zero complessità aggiuntiva (nessuna Collection `PermissionRules`, nessuna query DB per ogni richiesta)
- Il Pattern Adapter nasconde l'implementazione interna: le Collection non sanno da dove vengono letti i permessi

**Debito tecnico / TODO futuro:**
Migrare a **Livello 2** (RBAC dinamico in Collection PayloadCMS) quando la gestione
dei permessi diventa operativa e richiede modifiche senza deploy.

La migrazione richiede di riscrivere **solo `permissions.ts`** per leggere da DB invece
che dall'oggetto statico. Zero modifiche alle Collection — l'interfaccia
`canRead(resource)` / `canWrite(resource)` rimane identica.

Trigger consigliato per la migrazione: quando un admin non-tecnico necessita di
modificare i permessi più di una volta al mese.
