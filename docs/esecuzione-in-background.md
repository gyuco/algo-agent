# Esecuzione in background

Documento di progetto: come far girare workflow e turni di chat indipendentemente dalla
connessione del browser, con coda, limiti di concorrenza, ripresa dopo un riavvio e, in una
seconda fase, trigger pianificati e webhook.

## 1. Situazione attuale

- `POST /api/projects/:projectId/workflows/:key/runs` esegue il workflow **dentro la richiesta
  HTTP**: `WorkflowsService.run` è un generatore che `sendEvents` (`src/common/sse.ts`) inoltra
  come Server-Sent Events.
- L'interruzione arriva da `closeSignal(res)`: se il client si disconnette, il run viene
  abortito. Il frontend (`WorkflowsPanel.tsx`) chiama `abort()` anche quando il pannello viene
  smontato, quindi **cambiare pagina ferma il workflow**.
- `WorkflowRun` salva `status` e `stepsJson`, ma solo a fine passo: gli eventi intermedi
  (testo, tool, deleghe) esistono solo nello stream e non si possono rivedere.
- Un run rimasto `running` per un crash o un riavvio del backend non viene mai chiuso.
- La chat (`POST /api/chat/messages`) segue lo stesso schema: il turno vive finché vive la
  richiesta.
- Non c'è limite al numero di run simultanei, per utente o per provider.

## 2. Obiettivi

1. Un run continua anche se il browser si chiude, la pagina si ricarica o si cambia sezione.
2. Il client può riagganciarsi a un run in corso e ricevere sia gli eventi passati sia quelli
   nuovi, senza perderne o duplicarne.
3. Lo stop è un'azione esplicita dell'utente, non un effetto della disconnessione.
4. I run vanno in coda e partono rispettando limiti di concorrenza.
5. Dopo un riavvio del backend nessun run resta `running` all'infinito, e si può riprendere dal
   primo passo non completato.
6. Le regole di sicurezza restano quelle di oggi: policy, hook PreToolUse, `canUseTool`, nessuna
   shell, file confinati al progetto.

Fuori dallo scopo della prima fase: più istanze del backend, Redis o broker esterni, notifiche
via email.

## 3. Scelte di fondo

**Esecuzione nel processo del backend, non tmux né processi esterni.** I provider (Claude via
SDK, OpenCode via il suo server) e i controlli di sicurezza girano già dentro Node. Il cambio
riguarda solo *chi possiede* il generatore di eventi: oggi la richiesta HTTP, domani un
servizio di esecuzione (`RunExecutor`) che vive quanto il processo.

**Il database come coda e come registro eventi.** Con SQLite e una sola istanza una tabella
basta: niente infrastruttura in più. Se un giorno servirà isolare l'esecuzione (§10), un processo
worker separato potrà leggere le stesse tabelle.

**Separare "avvio" e "ascolto".** Avviare un run restituisce subito il suo id; seguirlo è una
richiesta distinta, ripetibile quante volte si vuole.

## 4. Modello dati

### 4.1 `WorkflowRun` (modifiche)

| Campo | Tipo | Note |
|---|---|---|
| `status` | String | Nuovi valori: `queued`, `running`, `done`, `failed`, `aborted`, `interrupted`. |
| `userId` | Int | Utile per i limiti di concorrenza e le query senza join sul progetto. |
| `trigger` | String | `manual`, `schedule` o `webhook` (fase 2). Default `manual`. |
| `startedAt` | DateTime? | Quando lo scheduler lo ha preso dalla coda. |
| `finishedAt` | DateTime? | Quando ha raggiunto uno stato finale. |
| `costUsd` | Float | Somma di `costUsd` degli eventi `done` dei passi. |
| `resumeOf` | Int? | Id del run da cui è stato ripreso, se è una ripresa. |
| `error` | String? | Messaggio dell'errore che ha chiuso il run. |

Nuovo indice `[status, createdAt]` per far scegliere velocemente allo scheduler il prossimo
run in coda.

### 4.2 `RunEvent` (nuova)

Registro, in sola aggiunta, di ogni evento emesso da un run.

| Campo | Tipo | Note |
|---|---|---|
| `id` | Int autoincrement | Fa da cursore per il riaggancio (`Last-Event-ID`). |
| `runId` | Int | Relazione verso `WorkflowRun` con `onDelete: Cascade`. |
| `dataJson` | String | L'evento così come lo riceve oggi il client (`WorkflowEvent`). |
| `createdAt` | DateTime | |

Indice `[runId, id]`.

**Volume.** Gli eventi `text` arrivano a frammenti molto piccoli. Per non scrivere una riga per
ogni token, l'executor **accorpa i `text` consecutivi** della stessa delega e li scrive al più
ogni ~250 ms o a ogni evento di tipo diverso. Ai client già agganciati gli eventi arrivano
comunque subito dalla memoria (§5.3); il DB serve solo per rivederli dopo.

**Pulizia.** Un job giornaliero cancella gli eventi dei run finiti da più di N giorni (variabile
`RUN_EVENTS_RETENTION_DAYS`, default 14). `stepsJson` resta, quindi il riepilogo del run non si
perde.

### 4.3 Chat

I turni di chat sono brevi rispetto ai workflow ma possono durare minuti. Si possono gestire con
lo stesso meccanismo introducendo un tipo di run generico:

- **Opzione A (consigliata):** rinominare concettualmente `WorkflowRun` in un `Run` con campo
  `kind` (`workflow` | `chat`), più `sessionId` e `agent` per la chat. Un solo executor, una sola
  coda, un solo endpoint di ascolto.
- **Opzione B:** tabella `ChatTurn` separata con la stessa struttura. Più semplice da migrare,
  ma duplica la logica.

Gli allegati della chat sono in base64 nella richiesta: per eseguire in background vanno salvati
insieme al run (colonna dedicata o file in una cartella dati dell'app) e cancellati a fine run.

## 5. Backend

### 5.1 Nuovi componenti

| Componente | Responsabilità |
|---|---|
| `RunsModule` | Raggruppa i servizi qui sotto; importato da `WorkflowsModule` e `ChatModule`. |
| `RunQueueService` | Mette in coda (`queued`), sceglie il prossimo run eseguibile, applica i limiti. |
| `RunExecutorService` | Esegue un run: chiama l'attuale logica di `WorkflowsService.run`, salva gli eventi e aggiorna lo stato. Tiene la mappa `runId → AbortController`. |
| `RunEventBus` | Inoltra in memoria gli eventi ai client agganciati (un `EventEmitter` o un Subject per run). |
| `RunRecoveryService` | All'avvio (`onApplicationBootstrap`) chiude i run rimasti a metà. |

`WorkflowsService` mantiene la logica dei passi (template, policy, `AgentRunnerService`), ma il
segnale di abort non arriva più dalla risposta HTTP: lo fornisce l'executor.

### 5.2 Ciclo di vita di un run

```
queued ──(scheduler)──▶ running ──▶ done
   │                      │  ├────▶ failed
   │                      │  └────▶ aborted       (stop dell'utente)
   └──(stop)──▶ aborted   └───────▶ interrupted   (backend riavviato a metà)
                                       │
                                       └──(riprendi)──▶ nuovo run queued con resumeOf
```

1. **Creazione.** La richiesta valida subito tutto ciò che oggi viene controllato all'inizio del
   generatore: workflow abilitato nel progetto, agenti di tutti i passi disponibili
   (`runner.agentFor`), provider connesso. Gli errori tornano come normali errori HTTP 400/403,
   come oggi. Se è tutto valido si crea il run `queued` e si risponde `202 { runId }`.
2. **Scheduling.** Il `RunQueueService` si attiva a ogni inserimento, a ogni fine run e con un
   timer di sicurezza (es. ogni 5 s). Prende il run `queued` più vecchio che rispetta i limiti
   (§5.4) e lo passa a `running` con un update condizionato su `status = 'queued'`, così lo
   stesso run non può essere preso due volte.
3. **Esecuzione.** L'executor scorre il generatore del workflow. Per ogni evento:
   pubblica sul bus, accoda la scrittura su `RunEvent`, aggiorna i totali (costo). A fine passo
   salva `stepsJson` come già avviene.
4. **Chiusura.** In un `finally` scrive lo stato finale, `finishedAt`, `costUsd`, svuota il buffer
   eventi, emette `finished`, chiude i canali del bus e toglie il run dalla mappa degli abort.

### 5.3 Riaggancio senza buchi

Quando un client si collega a `GET …/runs/:id/events?after=<eventId>`:

1. si iscrive **prima** al bus e mette in un buffer gli eventi in arrivo;
2. legge da `RunEvent` tutti gli eventi con `id > after` e li invia;
3. svuota il buffer scartando gli id già inviati, poi inoltra in diretta;
4. se il run è già in stato finale, invia gli eventi salvati e chiude.

Ogni evento SSE porta il proprio `id:`, così il client sa da dove ripartire. Gli eventi in
memoria non ancora scritti sul DB hanno già un id assegnato, con un contatore in memoria
inizializzato dal massimo sul DB, oppure usano un id provvisorio e passano su quello definitivo
dopo il flush. La prima strada è più semplice con una sola istanza.

### 5.4 Limiti di concorrenza

Variabili d'ambiente, con default prudenti:

| Variabile | Default | Significato |
|---|---|---|
| `RUNS_MAX_CONCURRENT` | 4 | Run in esecuzione in tutta l'istanza. |
| `RUNS_MAX_PER_USER` | 2 | Run in esecuzione per utente. |
| `RUNS_MAX_PER_PROJECT` | 1 | Evita due agenti in scrittura sulla stessa cartella nello stesso momento. |
| `RUNS_MAX_QUEUED_PER_USER` | 20 | Oltre questa soglia la creazione risponde 429. |

Il limite per progetto conta più del resto: due run con `files: write` sulla stessa cartella
producono modifiche intrecciate. Lo si può allentare solo per i workflow i cui agenti sono tutti
in sola lettura.

Il rate limit del piano Claude, già salvato in `ProviderConnection.stateJson`, si può usare per
**rimandare** i run di un utente il cui limite è esaurito, invece di farli partire e fallire.

### 5.5 Stop

`POST …/runs/:id/abort`:

- run `queued`: passa direttamente ad `aborted`;
- run `running`: l'executor chiama `abort()` sul suo controller. Il generatore si ferma al
  prossimo punto di controllo, come oggi con la disconnessione, e il run chiude come `aborted`.

Chiudere lo stream di ascolto **non** ferma più nulla.

### 5.6 Riavvio e ripresa

All'avvio, il `RunRecoveryService`:

- porta i run `running` a `interrupted`, con `error = "Backend riavviato durante l'esecuzione"`;
- lascia i run `queued` in coda: lo scheduler li prenderà normalmente.

`POST …/runs/:id/resume` (solo per `interrupted` o `failed`) crea un nuovo run con
`resumeOf = id`. Questo run copia i passi completati senza errori da `stepsJson` e parte dal
primo passo mancante, usando l'output dell'ultimo passo copiato come `{{previous}}`. Il passo
interrotto si rifà da capo: un agente a metà lavoro non si può riprendere in modo affidabile.

Spegnimento ordinato (`onApplicationShutdown`, `enableShutdownHooks()` in `main.ts`): si smette
di prendere run dalla coda, si attendono i run in corso per un tempo massimo
(`RUNS_SHUTDOWN_GRACE_MS`), poi si abortiscono e si segnano `interrupted`.

### 5.7 Sicurezza

- Ogni endpoint verifica che il run appartenga a un progetto dell'utente, tramite
  `ProjectsService.get` come oggi.
- Policy e permessi si ricalcolano **all'avvio del run**, non alla creazione: se nel frattempo
  l'utente ha disattivato un agente nel progetto, il run fallisce con un messaggio chiaro invece
  di usare permessi non più validi.
- Il JWT nell'ascolto SSE resta nell'header `Authorization`, perché il frontend usa già `fetch`
  in streaming (`apiStream`) e non `EventSource`. Non serve passare il token in query string.
- Un run in background usa le credenziali del provider dell'utente anche quando l'utente non è
  collegato. Se la connessione viene rimossa, i run in coda di quel provider vanno annullati.

## 6. API

| Metodo e path | Descrizione | Risposta |
|---|---|---|
| `POST /projects/:projectId/workflows/:key/runs` | Crea il run e lo mette in coda. Corpo invariato (`{ input }`). | `202 { runId, status }` |
| `GET /projects/:projectId/workflows/runs` | Elenco dei run, come oggi, con i nuovi campi. Filtro opzionale `?status=`. | `200 [...]` |
| `GET /projects/:projectId/workflows/runs/:id` | Dettaglio del run con passi, stato e costo. | `200 {...}` |
| `GET /projects/:projectId/workflows/runs/:id/events?after=` | Stream SSE: eventi passati più quelli in diretta. | `text/event-stream` |
| `POST /projects/:projectId/workflows/runs/:id/abort` | Ferma o annulla il run. | `202` |
| `POST /projects/:projectId/workflows/runs/:id/resume` | Crea un nuovo run che riprende dal primo passo non completato. | `202 { runId }` |
| `GET /runs/active` | Run `queued` e `running` dell'utente in tutti i progetti, per un indicatore globale nell'interfaccia. | `200 [...]` |

Per la chat, con l'opzione A del §4.3, `POST /chat/messages` risponde `202 { runId }` e lo
stream si segue con lo stesso endpoint di ascolto, spostato sotto `/runs/:id/events`.

**Compatibilità.** Si può tenere per una versione il comportamento attuale (POST che risponde
direttamente con lo stream) dietro un header o un parametro (`?stream=1`): il POST crea il run e
poi si comporta come l'endpoint di ascolto. Chiudere la connessione però non fa più abortire il
run.

## 7. Frontend

- **`workflowsApi`**: `run` restituisce `{ runId }`; nuove funzioni `follow(runId, after)`,
  `abort(runId)`, `resume(runId)`.
- **`WorkflowsPanel`**:
  - all'apertura carica i run e si **riaggancia automaticamente** a quelli `queued` o `running`;
  - salva l'ultimo `id` ricevuto per riprendere dopo una disconnessione, con riconnessione
    automatica a intervalli crescenti;
  - togliere l'`abort()` allo smontaggio del componente: smontare chiude solo lo stream;
  - il pulsante "Ferma" chiama l'endpoint `abort`;
  - per i run `interrupted` o `failed` mostra il pulsante "Riprendi";
  - mostra la posizione in coda e il motivo dell'attesa ("in attesa: un altro run è attivo in
    questo progetto").
- **Indicatore globale** nella barra superiore: numero di run attivi, con link al progetto.
- **Notifica a fine run** con la Notification API del browser, se l'utente l'ha consentita,
  quando un run termina mentre la scheda non è in primo piano.
- **i18n**: aggiungere in `messages.ts` le etichette dei nuovi stati (`queued`, `interrupted`) e
  delle nuove azioni.

## 8. Fase 2: trigger

Entrambi i trigger si limitano a **creare un run in coda**: tutto il resto è già coperto.

### 8.1 Pianificazioni

Nuova tabella `RunSchedule`: `projectId`, `workflow`, `input`, `cron`, `timeZone`, `enabled`,
`lastRunAt`, `nextRunAt`.

- Un tick ogni minuto (`@nestjs/schedule` o un semplice `setInterval`) crea i run delle
  pianificazioni con `nextRunAt <= now` e calcola il prossimo `nextRunAt`.
- Se il run precedente della stessa pianificazione è ancora in coda o in esecuzione, il nuovo si
  salta: non si accumulano run.
- Dopo un riavvio le esecuzioni perse non si recuperano: parte solo la prossima.
- In interfaccia: una sezione "Pianificazioni" nel pannello workflow del progetto.

### 8.2 Webhook in ingresso

Nuova tabella `RunWebhook`: `projectId`, `workflow`, `secretEncrypted`, un template di input
che può usare campi del payload, `enabled`.

- Endpoint pubblico `POST /hooks/:id`, marcato `@Public()`, con verifica della firma HMAC del
  corpo usando il segreto (compatibile con il formato `X-Hub-Signature-256` di GitHub).
- Limite di frequenza per webhook. Il payload entra nel prompt solo attraverso il template, mai
  per intero, e va trattato come dato non fidato.
- In `PERSONAL_MODE` il backend ascolta solo su `127.0.0.1`: i webhook esterni richiedono un
  tunnel o un reverse proxy. Va scritto chiaramente nell'interfaccia.

### 8.3 Notifiche in uscita

Webhook in uscita opzionale per progetto (es. Slack o un URL generico), chiamato a fine run
con stato, costo e link al run.

## 9. Test

- **Unità**:
  - scheduler e limiti (quale run viene scelto, rispetto dei limiti per utente e progetto);
  - accorpamento degli eventi `text`;
  - unione storico più diretta nel riaggancio, senza buchi né duplicati;
  - recovery all'avvio;
  - calcolo dei passi da riprendere.
- **e2e** (`test/`), con un provider finto che emette eventi a tempo:
  - il run continua dopo la chiusura dello stream;
  - il riaggancio con `after` riceve esattamente gli eventi mancanti;
  - lo stop di un run in coda e di uno in esecuzione;
  - 429 oltre la soglia della coda;
  - un utente non vede né ferma i run di un altro.

## 10. Evoluzioni possibili

- **Processo worker separato.** Si avvia lo stesso codice con un altro entry point, che esegue
  solo l'executor e lo scheduler. L'API e il worker comunicano tramite le tabelle: la coda
  esiste già, gli eventi diretti passano da `RunEvent` con un polling breve, oppure da un canale
  IPC se il worker è un processo figlio. Hook, policy e server MCP `app` continuano a funzionare
  perché girano nello stesso tipo di processo Node.
- **Più istanze.** A quel punto conviene passare a Postgres (`SELECT … FOR UPDATE SKIP LOCKED`)
  o a BullMQ con Redis, e usare un pub/sub per il bus degli eventi.
- **Budget.** `costUsd` per run permette limiti di spesa per progetto o utente, controllati
  dallo scheduler prima di avviare un run.

## 11. Piano di lavoro

1. Migrazione Prisma: nuovi campi di `WorkflowRun` e tabella `RunEvent`.
2. `RunsModule` con executor, bus ed endpoint di ascolto; il POST attuale diventa crea e ascolta
   (compatibile).
3. Abort esplicito e rimozione dell'abort alla disconnessione, sia nel backend sia nel frontend.
4. Coda e limiti di concorrenza; il POST risponde `202`.
5. Recovery all'avvio, spegnimento ordinato e ripresa.
6. Frontend: riaggancio automatico, stati nuovi, indicatore globale, notifiche.
7. Estensione alla chat (§4.3).
8. Fase 2: pianificazioni, webhook in ingresso e notifiche in uscita.

Ogni punto si può rilasciare da solo: dopo il punto 3 il problema principale, cioè il run che
muore quando si chiude la pagina, è già risolto.

## 12. Workflow a grafo

[workflow-a-grafo.md](workflow-a-grafo.md) estende i workflow da sequenza a grafo. Gli effetti
su questo documento:

- lo stato `waiting` (passo in attesa di approvazione) si aggiunge al ciclo di vita del §5.2. Un
  run in attesa non occupa posti di concorrenza e viene ripreso dallo scheduler quando l'utente
  approva;
- l'executor esegue i passi *pronti*, anche in parallelo, invece di quelli in ordine;
- la ripresa del §5.6 riparte da tutti i passi non `done` né `skipped`, non dal "primo passo
  mancante";
- il limite `RUNS_MAX_PER_PROJECT` resta. In aggiunta, all'interno di un run solo i passi in
  sola lettura possono girare in parallelo.
