# Decision Log — int26-middleware-payload

Registro cronologico delle decisioni architetturali, errori risolti e deviazioni dalle specifiche.
Aggiornare ad ogni decisione non banale. Vedere `.cursor/rules/001-documentation-policy.mdc`.

---

## Formato voce

```
## [YYYY-MM-DD] Titolo breve
**Problema:** descrizione del problema o della decisione da prendere
**Causa:** causa identificata (per bug) o motivazione (per decisioni)
**Soluzione:** soluzione adottata
**Alternativa scartata:** (opzionale) cosa si è valutato e perché si è scartato
**File aggiornati:** lista file docs/ e .cursor/rules/ modificati
```

---

## [2026-03-02] Setup struttura documentazione e regole Cursor

**Problema:** Il repository aveva PayloadCMS installato ma nessuna documentazione
specifica del progetto né regole Cursor contestualizzate.

**Soluzione:** Creata struttura documentazione a due livelli:
- `docs/project/` per sviluppatori umani (italiano, narrativo, contesto business)
- `.cursor/rules/` per agenti AI (tecnico denso, pattern codice, esempi)
- `DECISIONS.md` come raccordo (questo file)

Policy obbligatoria di aggiornamento in `.cursor/rules/001-documentation-policy.mdc`:
ogni azione dell'agente aggiorna entrambi gli output prima di considerarsi completata.

**Principio sancito:** Estensibilità by design — vincolo architetturale obbligatorio,
non best practice opzionale.

**File creati:**
- `.cursor/rules/000-project-overview.mdc`
- `.cursor/rules/001-documentation-policy.mdc`
- `docs/project/000-architecture.md`
- `DECISIONS.md` (questo file)
- `README.md` (aggiornato)

---

