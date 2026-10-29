# Fase 4: budget

Dettaglio della fase 4 di [modalita-autonoma-piano.md](modalita-autonoma-piano.md). Riferimenti
§ a [modalita-autonoma.md](modalita-autonoma.md) (§9). Presuppone la fase 3: run
`mission-task` sul motore a grafo con la porta `mayStart`, scheduler, attese della missione.

**Obiettivo**: le missioni rispettano la sessione del piano Claude.
- **Finestra di 5 ore**: sotto la soglia nessun task o passo nuovo parte; la missione va in
  `paused` e riparte da sola al reset.
- **Settimana**: ogni missione ha una quota stimata; un tetto globale protegge l'account.
  Alla quota la missione aspetta l'utente.
- **API key**: senza dati di piano vale un tetto in dollari.

Le barre del budget si vedono nella missione e in Attività.

È il prerequisito della modalità automatica (fase 5): senza budget, la fase 5 non si abilita.

**Fatto quando**:
- con la soglia delle 5 ore alzata apposta (ad esempio 0.95), una missione in passo-passo si
  mette in pausa prima del passo successivo, mostra il reset e riparte da sola quando la
  soglia viene riabbassata e la finestra si aggiorna;
- con `weeklyMaxShare` molto basso, la missione si ferma in `weekly_budget`, e "Continua"
  concede un'altra quota;
- con una connessione API key, il tetto `maxUsd` ferma la missione;
- i test della §10 sono verdi.

## 1. Da dove vengono i numeri (stato attuale del codice)

- `rate_limit_event` dell'SDK → `toEvents` (`claude-runtime.ts:427`) emette
  `{ type: 'usage', details: { rateLimits } }`. `ClaudeProvider` lo salva in
  `ProviderConnection.stateJson.rateLimits` (`claude.provider.ts:326`).
- `RateLimitSnapshot` (`rate-limit.ts`) contiene:
  - `windows[name] = { utilization 0-1, resetsAt, status }`, con i nomi `five_hour`,
    `seven_day`, `seven_day_opus` e `seven_day_sonnet` quando la CLI li manda;
  - `observedAt`.
- **Aggiornamento su richiesta**: `ClaudeProvider.refreshUsage(userId)`, esposto da
  `POST /claude/usage/refresh`. Manda un prompt minimo a haiku e consuma un po' di quota. Il
  documento principale parla di "richiesta `/usage` dell'SDK": non esiste. Si usa questo
  metodo e si corregge la §9.1.
- `costUsd` arriva solo a fine sessione (`done.costUsd`). Durante la sessione non c'è un
  costo progressivo.
- La coda rispetta già i limiti esauriti (`status: 'rejected'`) con
  `WaitReason { code: 'rateLimit', until }` (`run-queue.service.ts:180`).

## 2. Decisioni

### 2.1 `BudgetGuard`: un servizio, tre domande

`backend/src/missions/budget-guard.service.ts`:

```ts
/** Si può avviare lavoro Claude per questa missione ora? */
gate(missionId: number, model: string): Promise<BudgetGate>
type BudgetGate =
  | { ok: true }
  | { ok: false; kind: 'five_hour'; until: string }       // pausa automatica
  | { ok: false; kind: 'model_window'; window: string; until: string } // seven_day_opus/sonnet esaurita
  | { ok: false; kind: 'weekly_mission' }                  // quota della missione
  | { ok: false; kind: 'weekly_global'; until: string }   // tetto globale, fino al reset settimanale
  | { ok: false; kind: 'usd' };                            // API key: tetto in dollari

/** Un rate_limit_event arrivato durante una sessione: va interrotta? */
shouldInterrupt(userId: number, snapshot: RateLimitSnapshot): boolean

/** Stato per la UI. */
view(missionId: number): Promise<BudgetView>
```

- Solo i modelli Claude contano (`parseRef(model).provider === 'claude'`). Gli agenti
  OpenCode con altri modelli passano sempre, e il loro costo si vede ma non conta.
- Un dato è **vecchio** dopo `MISSIONS_USAGE_STALE_MS` (default 5 minuti). Con missioni
  attive, `gate` chiama `refreshUsage`, al massimo una volta ogni 5 minuti per utente e con
  un lock contro le chiamate concorrenti. Se fallisce, usa l'ultimo dato e la UI mostra
  "dato di X minuti fa".
- **Senza dati**, cioè con una connessione API key o nessuna `rateLimits` mai vista:
  - con `maxUsd` nel piano si applica quel tetto;
  - senza `maxUsd` si passa, ma la missione mostra l'avviso "budget non controllabile:
    imposta un tetto in dollari".
  - In fase 5 la modalità automatica richiederà `maxUsd` quando mancano i dati.

### 2.2 Dove si controlla

| Punto | Controllo | Se no |
|---|---|---|
| **Coda**, per i kind `mission-orchestrator` e `mission-task` | `gate` prima di avviare il run | il run resta `queued` con `WaitReason { code: 'budget', kind, until? }`, che si aggiunge ai `WaitReason` esistenti |
| **Motore**, `mayStart` prima di ogni passo con agente di un task | `gate` | il run si ferma in `waiting` (§2.3) |
| **Durante una sessione**, a ogni evento `usage` | `shouldInterrupt` | la sessione si interrompe (§2.4) |
| **Scheduler**, prima di avviare un task | `gate` | il task non parte; la missione va in `paused` o `waiting` (§2.5) |

`mission-prepare` non usa Claude, quindi non ha controllo. I run `chat` e `workflow` non sono
toccati: il budget è delle missioni.

### 2.3 Fermarsi tra due passi

- `mayStart` restituisce false: il motore salva `stepsJson`, emette
  `{ type: 'budget_wait', kind, until }` e il run finisce con l'esito `waiting`. Lo stesso
  meccanismo delle approvazioni dei workflow: il run si riprende sullo stesso log.
- Il passo non partito resta `pending`. I passi chiusi e i loro checkpoint (fase 3, §1.4)
  restano.
- **Ripresa**: lo scheduler riporta in `queued` i run `mission-task` in `waiting` per budget
  quando `gate` torna ok. Il motore riparte dal primo passo pronto.

### 2.4 Interrompere una sessione (sotto metà soglia)

- Ogni handler di missione (orchestratore e task) osserva gli eventi `usage` nello stream
  dell'agente. Se `shouldInterrupt` è vero (meno di `fiveHourMinRemaining / 2` rimasto, cioè
  5% con il default), interrompe la sessione con un `AbortController` interno, legato al
  `signal` del run.
- **Nel task**: il passo interrotto torna `pending`, senza contare un'iterazione. Il
  worktree torna all'ultimo checkpoint (`resetTo`) e il run va in `waiting` come in §2.3.
  Il passo ripartirà da capo dopo il reset.
- **Nell'orchestratore**: il turno finisce con un'entry `error` "Turno interrotto per il
  budget". La missione resta in `briefing`, e l'utente rimanda il messaggio dopo il reset;
  il briefing è sempre sorvegliato.
- Gli eventi `usage` arrivano solo quando la CLI li manda: l'interruzione è il meglio che si
  può fare, non una garanzia. La soglia del 10% resta il controllo principale.

### 2.5 Stati della missione

| Gate | Missione | Ripresa |
|---|---|---|
| `five_hour`, `model_window` | `paused`, `waitJson { code: 'five_hour' \| 'model_window', until }`, entry `budget` con `notify: true` | automatica (§2.6) |
| `weekly_mission` | `waiting { code: 'weekly_budget', scope: 'mission' }` | Continua · Ferma (Passa a passo-passo arriva in fase 5, con la modalità automatica) |
| `weekly_global` | `waiting { code: 'weekly_budget', scope: 'global', until }` | si sblocca da sola al reset settimanale; Continua dà 409 fino ad allora |
| `usd` | `waiting { code: 'usd_budget' }` | Continua (alza `maxUsd` di un'altra volta il valore iniziale) · Ferma |

- **Le 5 ore sono dell'account**, quindi la pausa vale per tutte le missioni dell'utente
  insieme. La riga del registro e la notifica sono una per missione.
- `paused` e `waiting` per budget lasciano finire i run in corso fino al loro prossimo
  `mayStart`. Non si interrompe niente, tranne il caso della §2.4.
- **Precedenze**: un'attesa dell'utente già presente (`task_review`, `task_blocked`) resta
  quella mostrata. Il budget si applica quando la missione torna `running`.

### 2.6 Ripresa automatica

`BudgetGuard` ha un timer che parte all'avvio e poi ogni 60 s:
1. per ogni utente con missioni in `paused`, al passare di `until` (+30 s di margine)
   aggiorna il dato (`refreshUsage`);
2. se resta più della soglia: missioni `running`, entry `resume` con `notify: true`, run in
   `waiting` per budget di nuovo `queued`, poi lo scheduler;
3. se resta sotto la soglia, ad esempio perché `resetsAt` è cambiato: nuova `until` e nuova
   attesa, senza notifica.

Lo stesso timer sblocca `weekly_budget` con `scope: 'global'` al reset settimanale.

### 2.7 Quota settimanale: attribuzione

L'SDK dà il costo solo a fine sessione, mentre la finestra settimanale si muove durante.
Serve quindi un peso progressivo per ogni sessione.

- **Peso**: un nuovo evento `tokens` emesso da `toEvents` per ogni messaggio `assistant`
  della sessione principale e delle delegazioni, con l'`usage` del messaggio:
  ```ts
  | { type: 'tokens'; model: string; input: number; output: number; cacheRead: number; cacheWrite: number }
  ```
  Il peso è il costo stimato con una tabella relativa per famiglia di modello
  (`backend/src/missions/model-weights.ts`: opus, sonnet e haiku, prezzi per milione di
  token). Contano i rapporti, non i valori assoluti. A fine sessione il peso si ricalibra sul
  `costUsd` vero di `done`.
- **Raccolta**: `RunExecutorService` vede gli eventi di tutti i run. Per ogni `tokens` di un
  run con provider `claude` chiama `BudgetGuard.record(run, weight)`. Chat e workflow
  contano nel totale anche se non hanno missione: servono a non attribuire la loro parte
  alle missioni.
- **Intervalli**: a ogni nuovo `RateLimitSnapshot` di un utente:
  1. `growth = seven_day.utilization − utilization dell'intervallo precedente` (se il
     `resetsAt` è cambiato, la finestra si è azzerata e `growth = utilization`);
  2. ogni run con peso nell'intervallo riceve `growth × peso_run / peso_totale`;
  3. la parte dei run di una missione si somma in `budgetJson.weekly.used` della missione;
  4. i pesi dell'intervallo si azzerano.
  - Il cursore (`utilization`, `resetsAt`, `observedAt`) sta in
    `ProviderConnection.stateJson.budgetCursor`.
  - I pesi dell'intervallo stanno in memoria, con un'istanza sola. Un riavvio perde il peso
    dell'intervallo in corso: la crescita di quell'intervallo non viene attribuita, ed è un
    errore per difetto limitato a qualche minuto.
- **Uso fuori da algo-agent** (Claude Code nel terminale): fa crescere la finestra senza
  peso, e la sua parte finisce sulle sessioni di algo-agent attive. È una **sovrastima
  prudente**: la missione si ferma prima, non dopo. Va dichiarato nella UI ("stima, può
  essere più alta del reale") e nella §9.3.
- **Finestra usata**: `seven_day`. `seven_day_opus` e `seven_day_sonnet` servono solo per
  `model_window` (§2.5), quando il loro `status` è `rejected` o `utilization ≥ 0.98`.

### 2.8 Quota della missione e tetto globale

`Mission.budgetJson`, con la forma definitiva:

```ts
{
  fiveHourMinRemaining: number;   // dal piano, 0.10
  weeklyMaxShare: number;         // dal piano, 0.30
  maxUsd?: number;                // dal piano, facoltativo
  weekly: {
    used: number;                 // quota attribuita dall'inizio della missione (0-1 della settimana)
    allowance: number;            // weeklyMaxShare × (1 + numero di "Continua")
    week: { resetsAt: string; used: number };  // parte attribuita nella settimana corrente
  };
  usd: { allowance?: number };    // maxUsd × (1 + numero di "Continua")
}
```

- **Quota della missione**: `weekly.used ≥ weekly.allowance` → `weekly_mission`. Il
  conteggio non si azzera con la settimana (§9.3: la quota è della missione).
- **Tetto globale**: la somma di `weekly.week.used` delle missioni dell'utente con lo stesso
  `week.resetsAt` di quello attuale, confrontata con `MISSIONS_WEEKLY_MAX_SHARE` (default
  0.6) → `weekly_global` fino a `resetsAt`.
- **Dollari**: `Mission.costUsd ≥ usd.allowance` → `usd`.

### 2.9 Campi del piano

In `plan-schema.ts`, dentro `budget`:
- `maxUsd`: numero positivo, facoltativo.

Le soglie sono **modificabili prima dell'approvazione**: `POST /approve` accetta
`budget?: { fiveHourMinRemaining, weeklyMaxShare, maxUsd? }`. I valori si validano con lo
stesso schema; quelli mandati vincono su quelli del piano e finiscono in `budgetJson`. Il
piano non cambia versione: è una scelta dell'utente, non dell'orchestratore.

Limiti: `fiveHourMinRemaining` tra 0.05 e 0.5; `weeklyMaxShare` tra 0.05 e 1.

## 3. Stima nel piano

- La stima delle sessioni nel caso peggiore esiste dalla fase 1 (va corretta come
  segnalato nella review: contare solo i passi con agente e il `repeat` solo nel suo
  blocco).
- Si aggiunge una stima della quota: `sessioni × peso medio di una sessione`. Il peso medio
  si ricava dalle missioni chiuse dell'utente; senza storico non si mostra.
- In fase 4 è solo informativa.

## 4. Backend: file

| File | Contenuto |
|---|---|
| `missions/budget-guard.service.ts` | §2.1, §2.6, §2.7, §2.8. |
| `missions/model-weights.ts` | Tabella dei pesi relativi e funzione `weightOf(tokens)`. |
| `claude/claude-runtime.ts` | Evento `tokens` per ogni messaggio `assistant`. |
| `providers/provider.ts` | Tipo dell'evento `tokens`. OpenCode non lo emette: i suoi run non hanno peso. |
| `runs/run-executor.service.ts` | Inoltra `tokens` a `BudgetGuard.record`. Gli eventi `tokens` **non** si salvano in `RunEvent`: sono troppi e non servono ai client. |
| `runs/run-types.ts`, `runs/run-queue.service.ts` | `WaitReason { code: 'budget' }`; il gate per i kind delle missioni. |
| `runs/graph-engine.ts` | `mayStart` già previsto in fase 3: emette `budget_wait` e restituisce `waiting`. |
| `missions/mission-task.handler.ts` | `mayStart` → `gate`; osservazione di `usage` → interruzione (§2.4); reset al checkpoint. |
| `missions/mission-orchestrator.handler.ts` | Osservazione di `usage` → interruzione. |
| `missions/mission-scheduler.service.ts` | `gate` prima di avviare un task; stati `paused` e `waiting` per budget. |
| `missions/missions.service.ts` | `approve` con `budget`; `continue`; `budgetJson` iniziale. |
| `missions/plan-schema.ts` | `budget.maxUsd`. |

## 5. Modello dati

Nessuna migrazione: `budgetJson` e `waitJson` esistono già, e `budgetCursor` va in
`ProviderConnection.stateJson`. Si aggiorna il commento di `Mission.status` con `paused`.

Missioni approvate prima della fase 4: alla prima lettura `budgetJson` si completa con i
default (`weekly.used = 0`).

## 6. API

| Metodo | Percorso | Note |
|---|---|---|
| `POST` | `/missions/:id/approve` | `{ planVersion, mode, budget? }` (§2.9). |
| `POST` | `/missions/:id/continue` | Da `waiting` con `weekly_budget` (scope `mission`) o `usd_budget`. Con scope `global`: 409 fino a `until`. |
| `GET` | `/missions/:id` | Aggiunge `budget: BudgetView`. |
| `GET` | `/missions/budget` | Vista dell'utente: finestre, tetto globale usato, missioni in pausa. Per Attività. |

```ts
interface BudgetView {
  source: 'plan' | 'api_key' | 'none';
  observedAt: string | null;           // per "dato di X minuti fa"
  fiveHour?: { used: number; threshold: number; resetsAt: string };
  week?: { used: number; resetsAt: string; missionUsed: number; missionAllowance: number; globalUsed: number; globalCap: number };
  usd: { spent: number; allowance?: number };
  estimate: true;                       // la quota settimanale è una stima
}
```

`GET /missions/:id/events` riceve anche le entry `budget` e `resume`. La UI aggiorna le barre
da `GET /missions/:id` quando arriva un'entry `budget`, e ogni 60 s mentre la missione è
attiva.

## 7. Frontend

| File | Contenuto |
|---|---|
| `missions/BudgetBars.tsx` | Due barre: 5 ore (uso, linea della soglia, reset) e settimana (quota della missione su allowance, tetto globale). Costo in dollari. Etichetta "stima" e "dato di X minuti fa". Riusa lo stile di `claude/UsagePanel.tsx`. |
| `missions/MissionView.tsx` | `BudgetBars` nell'intestazione con la missione `approved`, `running`, `paused` o `waiting`. Riquadro di `paused` con il conto alla rovescia del reset. Riquadri di `weekly_budget` e `usd_budget` con le azioni. |
| `missions/PlanView.tsx` | Soglie modificabili prima dell'approvazione (input numerici con i limiti della §2.9); `maxUsd`; avviso "budget non controllabile" con API key senza `maxUsd`; stima della quota se disponibile. |
| `runs/ActivityPage.tsx` | Nel gruppo delle missioni: le barre compatte dell'utente (`GET /missions/budget`) e le missioni in `paused` con il reset. |
| `missions/api.ts`, `i18n/messages.ts` | Tipi e testi. |

## 8. Configurazione

| Variabile | Default | Note |
|---|---|---|
| `MISSIONS_WEEKLY_MAX_SHARE` | `0.6` | Tetto globale (§2.8). |
| `MISSIONS_USAGE_STALE_MS` | `300000` | Oltre questo, `gate` aggiorna il dato. |
| `MISSIONS_BUDGET_TICK_MS` | `60000` | Timer della ripresa. |

## 9. Ordine di lavoro

1. **Evento `tokens`** in `claude-runtime.ts`, `model-weights.ts`, inoltro dall'executor
   (senza salvarlo).
2. **`BudgetGuard`**: cursore, intervalli, attribuzione, `gate`, `shouldInterrupt`, con i
   test su dati finti.
3. **Coda**: `WaitReason budget` per i kind delle missioni.
4. **Motore e handler**: `mayStart`, `budget_wait`, interruzione con reset al checkpoint,
   ripresa.
5. **Scheduler e stati**: `paused`, `weekly_budget`, `usd_budget`, timer di ripresa,
   `continue`.
6. **`approve`** con `budget`; `maxUsd` nel piano.
7. **API e frontend**.
8. **Prova reale** sui casi del "Fatto quando". Si confronta la quota attribuita con la
   crescita reale di `seven_day` su una missione lasciata girare da sola, e si annota lo
   scarto in `docs/budget-prova.md` (punto aperto 4 della §14).

## 10. Test

- **`model-weights`**: pesi relativi opus > sonnet > haiku; token di cache contati con il
  loro peso.
- **Attribuzione** (snapshot e pesi finti):
  - una missione sola si prende tutta la crescita;
  - due missioni e una chat si dividono in proporzione;
  - reset settimanale durante l'intervallo;
  - nessun peso nell'intervallo: niente attribuito;
  - ricalibrazione con `done.costUsd`;
  - `week.used` per il tetto globale si azzera al cambio di `resetsAt`, mentre `used`
    della missione no.
- **`gate`**:
  - sopra e sotto la soglia delle 5 ore;
  - `seven_day_opus` esaurita con un passo opus (bloccato) e un passo sonnet (passa);
  - quota della missione;
  - tetto globale;
  - API key con e senza `maxUsd`;
  - modello OpenCode non Claude sempre ok;
  - dato vecchio che chiama `refreshUsage` una sola volta con chiamate concorrenti;
  - `refreshUsage` fallito che usa l'ultimo dato.
- **Coda**: run `mission-task` trattenuto con `WaitReason budget`; chat e workflow non
  toccati.
- **Motore e handler**:
  - `mayStart` false: run `waiting`, passo `pending`, ripresa dal passo giusto;
  - `usage` sotto metà soglia durante un passo: sessione interrotta, worktree al
    checkpoint, nessuna iterazione contata;
  - orchestratore interrotto: entry `error`, missione in `briefing`.
- **Scheduler**:
  - `paused` con `until`;
  - ripresa automatica dopo `until`, con i run di nuovo `queued`;
  - `until` spostato se la finestra resta sotto;
  - `weekly_budget` con `Continua` che raddoppia l'allowance;
  - `global` con 409 su `Continua` e sblocco al reset;
  - `usd_budget`;
  - precedenza di `task_review` sul budget.
- **`approve`**: soglie fuori dai limiti (400), soglie dell'utente che vincono su quelle del
  piano, versione del piano invariata.
- **Frontend**: barre con e senza dati, conto alla rovescia, azioni delle attese, soglie
  modificabili nel Piano.

## 11. Da riportare in modalita-autonoma.md

- §9.1: niente `/usage` dell'SDK, ma `refreshUsage` (prompt minimo a haiku), al massimo ogni
  5 minuti con missioni attive.
- §9.2: interruzione della sessione sotto metà soglia, dove gli eventi lo permettono; il
  passo riparte dall'ultimo checkpoint.
- §9.3: peso progressivo dai token; uso fuori da algo-agent attribuito alle missioni
  (sovrastima prudente); forma di `budgetJson`.
- §7.2: attese `weekly_budget` (scope `mission` o `global`) e `usd_budget`; `paused` con
  `five_hour` o `model_window`.
- §5: `budget.maxUsd`; soglie modificabili all'approvazione.
- §12: `approve` con `budget`; `GET /missions/budget`.
