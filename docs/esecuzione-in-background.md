# Esecuzione in background

Documento di progetto: come far girare workflow e turni di chat indipendentemente dalla
connessione del browser, con coda, limiti di concorrenza, ripresa dopo un riavvio, una sezione
che mostra le attività in corso e, in una seconda fase, trigger pianificati e webhook.

## 1. Situazione attuale

- `POST /api/projects/:projectId/workflows/:key/runs` esegue il workflow **dentro la richiesta
  HTTP**: `WorkflowsService.run` è un generatore che `sendEvents` (`src/common/sse.ts`) inoltra
  come Server-Sent Events.
- L'interruzione arriva da `closeSignal(res)`: se il client si disconnette, il run viene
  abortito. Il frontend (`WorkflowsPanel.tsx`) chiama `abort()` anche quando il pannello viene
  smontato, quindi **cambiare pagina ferma il workflow**. Anche il pulsante "Ferma" non fa altro
  che chiudere la richiesta.
- `WorkflowRun` salva `status` e `stepsJson`, ma solo a fine passo: gli eventi intermedi
  (testo, tool, deleghe) esistono solo nello stream e non si possono rivedere.
- Un run rimasto `running` per un crash o un riavvio del backend non viene mai chiuso.
- La chat (`POST /api/chat/messages`) segue lo stesso schema: il turno vive finché vive la
  richiesta. L'elenco delle conversazioni (`GET /chat/sessions`, `Sessions.tsx`) viene chiesto ai
  provider e non sa quali conversazioni hanno un turno in corso.
- Non c'è limite al numero di run simultanei, per utente o per provider.

## 2. Obiettivi

1. Un run continua anche se il browser si chiude, la pagina si ricarica o si cambia sezione.
2. Il client può riagganciarsi a un run in corso e ricevere sia gli eventi passati sia quelli
   nuovi, senza perderne o duplicarne.
3. Lo stop è un'azione esplicita dell'utente, non un effetto della disconnessione.
4. I run vanno in coda e partono rispettando limiti di concorrenza, senza impedire di usare più
   conversazioni nello stesso progetto.
5. Dopo un riavvio del backend nessun run resta `running` all'infinito, e si può riprendere dal
   primo passo non completato.
6. L'utente vede in un solo posto tutto ciò che è in corso, in coda o in attesa, e ci torna con
   un clic.
7. Le regole di sicurezza restano quelle di oggi: policy, hook PreToolUse, `canUseTool`, nessuna
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

**Un solo tipo di run per workflow e chat.** Stessa coda, stesso executor, stessi endpoint di
ascolto e di stop (§4.3).

## 4. Modello dati

### 4.1 `Run` (ex `WorkflowRun`)

Il modello Prisma si rinomina in `Run` ma resta sulla stessa tabella con
`@@map("WorkflowRun")`: in SQLite rinominare una tabella con Prisma vuol dire ricrearla, mentre
aggiungere colonne no. I run esistenti diventano `kind = 'workflow'`.

| Campo | Tipo | Note |
|---|---|---|
| `kind` | String | `workflow` o `chat`. Default `workflow`. |
| `status` | String | `queued`, `running`, `waiting`, `done`, `failed`, `aborted`, `interrupted`. `waiting` serve solo ai workflow a grafo (§12). |
| `userId` | Int | Per i limiti di concorrenza e le query senza join sul progetto. |
| `trigger` | String | `manual`, `schedule` o `webhook` (fase 2). Default `manual`. |
| `title` | String | Per i workflow il nome; per la chat il primo messaggio, troncato. Serve alla sezione Attività (§7.3). |
| `workflow` | String? | Chiave del workflow (solo `kind = 'workflow'`). |
| `workflowHash` | String? | Hash della definizione del workflow alla creazione, per la ripresa (§5.6). |
| `sessionId` | String? | Solo chat: riferimento della conversazione (`provider:id`). Vuoto finché il provider non lo assegna con l'evento `session`. |
| `agent` | String? | Solo chat: agente scelto per il turno. |
| `model` | String? | Solo chat: modello scelto per il turno (`provider:modello`). |
| `provider` | String? | Provider che eseguirà il run, per rimandarlo quando il limite del piano è esaurito (§5.4). |
| `writes` | Boolean | Vero se almeno un agente del run ha `files: write`. Calcolato alla creazione; serve al limite per progetto (§5.4). |
| `startedAt` | DateTime? | Quando lo scheduler lo ha preso dalla coda. |
| `heartbeatAt` | DateTime? | Aggiornato dall'executor mentre il run gira (§5.6). |
| `finishedAt` | DateTime? | Quando ha raggiunto uno stato finale. |
| `seenAt` | DateTime? | Ultima volta che l'utente ha aperto il run; un run finito dopo `seenAt` è "non letto". |
| `costUsd` | Float | Somma di `costUsd` degli eventi `done` dei passi. |
| `resumeOf` | Int? | Id del run da cui è stato ripreso, se è una ripresa. |
| `error` | String? | Messaggio dell'errore che ha chiuso il run. |

Indici: `[status, createdAt]` per lo scheduler, `[userId, status]` per la sezione Attività,
`[sessionId]` per unire run e conversazioni.

### 4.2 `RunEvent` (nuova)

Registro, in sola aggiunta, di ogni evento emesso da un run.

| Campo | Tipo | Note |
|---|---|---|
| `id` | Int autoincrement | Chiave interna. |
| `runId` | Int | Relazione verso `Run` con `onDelete: Cascade`. |
| `seq` | Int | Progressivo **per run**, da 1. È il cursore del riaggancio (`after`, `Last-Event-ID`). |
| `dataJson` | String | L'evento così come lo riceve il client (`WorkflowEvent` o evento di chat). |
| `createdAt` | DateTime | |

Vincolo unico `[runId, seq]`. Il `seq` lo assegna l'executor con un contatore in memoria per run,
che parte da 1 per un run nuovo: non dipende dall'autoincrement e non è condiviso tra run.

**Volume.** Gli eventi `text` arrivano a frammenti molto piccoli. L'executor **accorpa i `text`
consecutivi** della stessa delega e chiude il blocco al più ogni ~250 ms o a ogni evento di tipo
diverso. Il blocco chiuso riceve un `seq` e va **sia sul bus sia sul DB**: i client in diretta
ricevono il testo a blocchi di 250 ms invece che a singoli token, ma diretta e storico sono
identici, evento per evento. Così il riaggancio non può duplicare né perdere testo, e il
ritardo resta poco visibile.

**Ordine di scrittura.** Ogni run ha una coda di scrittura nell'executor: un evento si salva
su `RunEvent` e solo dopo si pubblica sul bus. Così tutto ciò che un client vede in diretta è già
nel registro. L'accorpamento dei `text` tiene basso il numero di righe.

**SQLite.** Più run scrivono eventi in parallelo. All'avvio il backend imposta
`PRAGMA journal_mode = WAL`, e l'adapter attende il lock fino a 5 s (`timeout`) invece di
fallire.

**Pulizia.** Un job giornaliero cancella gli eventi dei run finiti da più di N giorni (variabile
`RUN_EVENTS_RETENTION_DAYS`, default 14). `stepsJson` resta, quindi il riepilogo del run non si
perde.

### 4.3 Chat

I turni di chat usano lo stesso `Run` con `kind = 'chat'`. Ogni messaggio inviato è un run: un
turno.

- **Conversazione nuova.** Il run nasce senza `sessionId`. Quando arriva l'evento `session`,
  l'executor lo scrive sul run. Fino ad allora la conversazione è ritrovabile solo tramite il
  run (§7.2).
- **Storia di una conversazione.** Viene da due fonti: i turni completati dal provider
  (`GET /chat/sessions/:id`, come oggi) e il turno in corso dagli eventi del suo run. Il turno in
  corso si mostra solo dagli eventi, per non vederlo due volte se il provider lo ha già salvato
  in parte.
- **Allegati.** Oggi sono in base64 nella richiesta. Per eseguire in background si salvano in
  una cartella dati dell'app (`data/run-attachments/<runId>/`), non nel database, e si cancellano
  a fine run.

Scartata l'alternativa di una tabella `ChatTurn` separata: più semplice da migrare, ma
duplicherebbe coda, executor ed endpoint.

## 5. Backend

### 5.1 Nuovi componenti

| Componente | Responsabilità |
|---|---|
| `RunsModule` | Raggruppa i servizi qui sotto; importato da `WorkflowsModule` e `ChatModule`. |
| `RunQueueService` | Mette in coda (`queued`), sceglie il prossimo run eseguibile, applica i limiti. |
| `RunExecutorService` | Esegue un run: chiama la logica di `WorkflowsService.run` o di `ChatService.send`, accorpa e salva gli eventi, aggiorna stato e heartbeat. Tiene la mappa `runId → AbortController`. |
| `RunEventBus` | Inoltra in memoria gli eventi ai client agganciati (un `EventEmitter` per run) e i cambi di stato a chi segue la sezione Attività. |
| `RunRecoveryService` | All'avvio e periodicamente chiude i run rimasti a metà (§5.6). |

`WorkflowsService` e `ChatService` mantengono la loro logica (template, policy,
`AgentRunnerService`, provider), ma il segnale di abort non arriva più dalla risposta HTTP: lo
fornisce l'executor.

### 5.2 Ciclo di vita di un run

```
queued ──(scheduler)──▶ running ──▶ done
   │                      │  ├────▶ failed
   │                      │  ├────▶ aborted       (stop dell'utente)
   │                      │  └────▶ waiting ──(approvazione)──▶ queued   (solo grafo, §12)
   └──(stop)──▶ aborted   └───────▶ interrupted   (backend riavviato a metà)
                                       │
                                       └──(riprendi)──▶ nuovo run queued con resumeOf
```

1. **Creazione.** La richiesta valida subito tutto ciò che oggi viene controllato all'inizio del
   generatore: workflow abilitato nel progetto, agenti di tutti i passi disponibili
   (`runner.agentFor`), provider connesso. Per la chat controlla anche che la conversazione non
   abbia già un turno attivo (§5.4). Gli errori tornano come normali errori HTTP 400/403/409.
   Se è tutto valido si crea il run `queued` e si risponde `202 { runId }`.
2. **Scheduling.** Il `RunQueueService` si attiva a ogni inserimento, a ogni fine run e con un
   timer di sicurezza (es. ogni 5 s). Prende il run `queued` più vecchio che rispetta i limiti
   (§5.4) e lo passa a `running` con un update condizionato su `status = 'queued'`, così lo
   stesso run non può essere preso due volte.
3. **Esecuzione.** L'executor scorre il generatore. Per ogni evento: accorpa i `text`, assegna il
   `seq`, pubblica sul bus, accoda la scrittura su `RunEvent`, aggiorna i totali (costo). Ogni
   10 s aggiorna `heartbeatAt`. A fine passo salva `stepsJson` come già avviene.
4. **Chiusura.** In un `finally` scrive lo stato finale, `finishedAt`, `costUsd`, svuota il buffer
   eventi, emette `finished`, chiude i canali del bus, cancella gli allegati e toglie il run
   dalla mappa degli abort.

### 5.3 Riaggancio senza buchi

Quando un client si collega a `GET /runs/:id/events?after=<seq>`:

1. si iscrive **prima** al bus e mette in un buffer gli eventi in arrivo;
2. legge da `RunEvent` tutti gli eventi con `seq > after` e li invia;
3. svuota il buffer scartando i `seq` già inviati, poi inoltra in diretta;
4. se il run è già in stato finale, invia gli eventi salvati e chiude.

Ogni evento SSE porta il proprio `id: <seq>`, così il client sa da dove ripartire. Siccome il
bus riceve solo eventi già accorpati e numerati (§4.2), ogni `seq` visto in diretta corrisponde
a una riga sul DB, anche se la scrittura non è ancora avvenuta.

Alla chiusura della connessione (`res.on('close')`) il client si disiscrive dal bus. Il bus
toglie l'emitter di un run quando il run finisce e non ha più iscritti.

### 5.4 Limiti di concorrenza

Variabili d'ambiente, con default prudenti:

| Variabile | Default | Significato |
|---|---|---|
| `RUNS_MAX_CONCURRENT` | 6 | Run in esecuzione in tutta l'istanza, chat e workflow insieme. |
| `RUNS_MAX_WORKFLOWS_PER_USER` | 2 | Workflow in esecuzione per utente. |
| `RUNS_MAX_CHATS_PER_USER` | 3 | Turni di chat in esecuzione per utente, contati a parte: un workflow lungo non blocca la chat. |
| `RUNS_MAX_WRITERS_PER_PROJECT` | 1 | Run con `writes = true` in esecuzione nello stesso progetto. |
| `RUNS_MAX_QUEUED_PER_USER` | 20 | Oltre questa soglia la creazione risponde 429. |

Regole fisse, non configurabili:

- **Un turno per conversazione.** Una conversazione ha al più un run di chat `queued` o
  `running`. Un secondo messaggio nella stessa conversazione risponde 409. Due conversazioni
  diverse, anche nello stesso progetto, girano in parallelo.
- **Scritture per progetto.** Due workflow con `files: write` sulla stessa cartella producono
  modifiche intrecciate, quindi contano per `RUNS_MAX_WRITERS_PER_PROJECT`. Il limite vale solo
  per i workflow, che girano senza supervisione. La chat diretta può sempre scrivere, ma è
  seguita dall'utente: è lui a decidere se tenere più conversazioni attive nella stessa
  cartella. Le chat quindi non aspettano questo limite e non lo occupano.

Il rate limit del piano Claude, già salvato in `ProviderConnection.stateJson`, si usa per
**rimandare** i run di un utente il cui limite è esaurito, invece di farli partire e fallire.

Per ogni run in coda lo scheduler espone il **motivo dell'attesa**: posizione in coda, "un altro
run sta scrivendo in questo progetto", "limite del piano raggiunto fino alle 15:00", "troppi run
attivi". Lo usano il pannello e la sezione Attività.

### 5.5 Stop

`POST /runs/:id/abort`:

- run `queued` o `waiting`: passa direttamente ad `aborted`;
- run `running`: l'executor chiama `abort()` sul suo controller. Il generatore si ferma al
  prossimo punto di controllo, come oggi con la disconnessione, e il run chiude come `aborted`.

Chiudere lo stream di ascolto **non** ferma più nulla. Per questo il pulsante "Ferma" del
frontend deve passare all'endpoint `abort` nello stesso rilascio in cui il backend smette di
abortire alla disconnessione (§11, punto 2).

### 5.6 Riavvio, heartbeat e ripresa

**Heartbeat.** Mentre un run gira, l'executor aggiorna `heartbeatAt` ogni 10 s. Il
`RunRecoveryService` porta a `interrupted` i run `running` il cui `heartbeatAt` è più vecchio di
`RUNS_LEASE_MS` (default 60 s), con `error = "Esecuzione interrotta"`. Con una sola istanza,
all'avvio tutti i run `running` vengono dal processo precedente e si chiudono subito, con
`error = "Backend riavviato durante l'esecuzione"`. Lo stesso meccanismo regge senza modifiche
il worker separato del §10.

I run `queued` restano in coda: lo scheduler li prenderà normalmente.

**Ripresa.** `POST /runs/:id/resume` (solo per `interrupted` o `failed`, solo workflow) crea un
nuovo run con `resumeOf = id`:

- se l'hash della definizione attuale del workflow è diverso da `workflowHash`, risponde 409
  ("Il workflow è cambiato dopo questo run: avvialo di nuovo"). Copiare passi di una definizione
  diversa darebbe un risultato incoerente;
- altrimenti copia i passi completati senza errori da `stepsJson` e parte dal primo passo
  mancante, usando l'output dell'ultimo passo copiato come `{{previous}}`;
- il passo interrotto si rifà da capo: un agente a metà lavoro non si può riprendere in modo
  affidabile. Se quel passo poteva scrivere, l'interfaccia lo dice prima di confermare: la
  cartella può contenere modifiche parziali del tentativo precedente.

Un turno di chat interrotto non si riprende: la conversazione resta e l'utente può rimandare il
messaggio.

**Spegnimento ordinato.** In `onApplicationShutdown`, con `enableShutdownHooks()` in `main.ts`:
si smette di prendere run dalla coda, si attendono i run in corso per un tempo massimo
(`RUNS_SHUTDOWN_GRACE_MS`, default 30 s), poi si abortiscono e si segnano `interrupted`.

**Sviluppo.** Con `nest start --watch` ogni salvataggio riavvia il backend e interrompe i run in
corso. È il comportamento atteso; per provare run lunghi conviene il backend senza watch.

### 5.7 Sicurezza

- Ogni endpoint `/runs/:id/...` verifica che `run.userId` sia l'utente della richiesta e che il
  progetto sia suo, tramite `ProjectsService.get` come oggi. Un run di un altro utente risponde
  404, non 403, per non rivelarne l'esistenza.
- Policy e permessi si ricalcolano **all'avvio del run**, non alla creazione: se nel frattempo
  l'utente ha disattivato un agente nel progetto, il run fallisce con un messaggio chiaro invece
  di usare permessi non più validi. All'avvio si ricalcola anche `writes`.
- Il JWT nell'ascolto SSE resta nell'header `Authorization`, perché il frontend usa già `fetch`
  in streaming (`apiStream`) e non `EventSource`. Non serve passare il token in query string.
- Un run in background usa le credenziali del provider dell'utente anche quando l'utente non è
  collegato:
  - se la connessione viene rimossa, i run in coda di quel provider passano ad `aborted`;
  - se le credenziali sono scadute o il rinnovo del token fallisce, all'avvio o durante il run,
    il run chiude come `failed` con l'errore del provider. *Da fare:* riconoscere la scadenza
    e trattenere in coda gli altri run di quel provider, con il motivo "connessione scaduta".

## 6. API

Creazione ed elenchi restano sotto il progetto o la chat. Le operazioni su un singolo run sono
comuni a workflow e chat e stanno sotto `/runs`.

| Metodo e path | Descrizione | Risposta |
|---|---|---|
| `POST /projects/:projectId/workflows/:key/runs` | Crea il run del workflow e lo mette in coda. Corpo invariato (`{ input }`). | `202 { runId, status }` |
| `GET /projects/:projectId/workflows/runs` | Elenco dei run di workflow, come oggi, con i nuovi campi. Filtro opzionale `?status=`. | `200 [...]` |
| `POST /chat/messages` | Crea il turno di chat e lo mette in coda. Corpo invariato. 409 se la conversazione ha già un turno attivo. | `202 { runId, status }` |
| `GET /chat/sessions?projectId=` | Come oggi, più per ogni conversazione `activeRun` (`{ runId, status, reason }`) e `unread`. In testa le conversazioni nuove ancora senza `sessionId`. | `200 [...]` |
| `GET /runs/:id` | Dettaglio del run: stato, motivo dell'attesa, passi, costo. | `200 {...}` |
| `GET /runs/:id/events?after=` | Stream SSE: eventi passati più quelli in diretta. | `text/event-stream` |
| `POST /runs/:id/abort` | Ferma o annulla il run. | `202` |
| `POST /runs/:id/resume` | Nuovo run che riprende dal primo passo non completato. 409 se il workflow è cambiato. | `202 { runId }` |
| `POST /runs/:id/seen` | Segna il run come visto (`seenAt = now`). | `204` |
| `GET /runs/active` | Run dell'utente in tutti i progetti: `queued`, `running`, `waiting`, più quelli finiti e non letti delle ultime 24 ore. | `200 [...]` |
| `GET /runs/active/events` | Stream SSE dei **cambi di stato** dei run dell'utente (nuovo, avviato, in attesa, finito, motivo cambiato). Niente testo. | `text/event-stream` |

**Compatibilità.** Frontend e backend si rilasciano insieme, quindi i POST non mantengono la
vecchia risposta in streaming: rispondono sempre `202`.

Lo stream `GET /runs/active/events` manda per primo `{ type: 'ready' }`, a ogni connessione: il
client ricarica l'elenco e da lì in poi riceve solo i cambiamenti.

## 7. Frontend

### 7.1 Workflow

- **`workflowsApi`**: `run` restituisce `{ runId }`. Nuovo `runsApi` comune con
  `follow(runId, after)`, `abort(runId)`, `resume(runId)`, `seen(runId)`, `active()`,
  `followActive()`.
- **`WorkflowsPanel`**:
  - all'apertura carica i run e si **riaggancia automaticamente** a quelli `queued` o `running`;
  - salva l'ultimo `seq` ricevuto per riprendere dopo una disconnessione, con riconnessione
    automatica a intervalli crescenti;
  - togliere l'`abort()` allo smontaggio del componente: smontare chiude solo lo stream;
  - il pulsante "Ferma" chiama `runsApi.abort`;
  - per i run `interrupted` o `failed` mostra il pulsante "Riprendi", con l'avviso sulle
    modifiche parziali se il passo interrotto poteva scrivere;
  - per i run in coda mostra il motivo dell'attesa ricevuto dal backend.

### 7.2 Chat

- **Elenco conversazioni (`Sessions.tsx`)**: ogni voce mostra un badge "in corso", "in coda" o
  "in attesa" se ha un `activeRun`, e un pallino se `unread`. Le conversazioni nuove senza
  `sessionId` compaiono in testa con il primo messaggio come titolo.
- **Aprire una conversazione con un turno attivo**:
  1. il pannello carica dal provider la storia dei turni completati;
  2. si riaggancia al turno in corso con `follow(runId, 0)`;
  3. mostra il turno in corso solo dagli eventi del run, così non compare due volte.
- **Cambiare conversazione** chiude solo lo stream: il turno continua e la conversazione resta
  segnata come attiva nell'elenco. Tornandoci, il pannello si riaggancia.
- `ChatPanel` toglie l'`abort()` allo smontaggio (`ChatPanel.tsx`, `useEffect` di pulizia); il
  pulsante di stop chiama `runsApi.abort`.
- Durante un turno attivo il campo di invio della stessa conversazione resta disabilitato,
  coerente con il 409 del backend.

### 7.3 Sezione Attività

Nuova voce di navigazione **Attività** (`#/activity`), accanto a Home, Progetti, Risorse e
Connessioni in `App.tsx`. Mostra tutti i run dell'utente in tutti i progetti, chat e workflow
insieme, raggruppati così:

| Gruppo | Contenuto |
|---|---|
| **Richiedono te** | Run `waiting` (approvazione di un passo, §12) e run `interrupted` o `failed` non letti. |
| **In corso** | Run `running`. |
| **In coda** | Run `queued`, con il motivo dell'attesa. |
| **Finiti di recente** | Run finiti nelle ultime 24 ore; i non letti in evidenza. |

Ogni riga mostra:

- tipo (chat o workflow), progetto e titolo (`run.title`);
- agente o passo corrente (es. "passo 2 di 4 · reviewer");
- stato, durata e costo fin qui;
- l'ultima attività in una riga, presa dall'ultimo evento non testuale (es. "usa Edit su
  `src/app.ts`", "delega a tester").

Azioni sulla riga:

- **Apri**: porta al progetto, nella chat con la conversazione caricata o nel pannello workflow
  con il run selezionato, e segna il run come visto;
- **Ferma** per i run in coda, in attesa o in corso;
- **Riprendi** per i workflow `interrupted` o `failed`;
- **Approva** per i run `waiting`: arriva con i workflow a grafo (§12).

**Aggiornamento in diretta.** La sezione carica `GET /runs/active` e poi segue
`GET /runs/active/events`: un solo stream con i cambi di stato, non uno per run. L'ultima
attività di ogni riga arriva nello stesso stream, al più una volta ogni 2 s per run.

**Indicatore globale.** Nella barra superiore, un contatore dei run in corso più quelli che
richiedono l'utente. Un clic apre la sezione Attività. Usa lo stesso stream della sezione.

**Notifica a fine run.** Con la Notification API del browser, se l'utente l'ha consentita,
quando un run termina o passa a `waiting` mentre la scheda non è in primo piano. Un clic sulla
notifica apre il run.

**i18n**: in `messages.ts` le etichette di stati (`queued`, `waiting`, `interrupted`), gruppi,
motivi dell'attesa e azioni.

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
- **Replay.** Ogni consegna ha un id (`X-GitHub-Delivery` o un header `X-Hook-Delivery` per i
  mittenti generici). Gli id visti si tengono per 24 ore in una tabella `RunWebhookDelivery`: una
  consegna ripetuta risponde 200 senza creare un run. Per i mittenti generici la firma copre
  anche un timestamp (`X-Hook-Timestamp`), rifiutato se più vecchio di 5 minuti.
- Limite di frequenza per webhook. Il payload entra nel prompt solo attraverso il template, mai
  per intero, e va trattato come dato non fidato.
- **Scritture.** Un webhook può avviare solo workflow i cui agenti sono tutti in sola lettura,
  oppure workflow a grafo che hanno un passo di approvazione prima di ogni passo con
  `files: write` (§12). Un payload esterno non deve poter far scrivere un agente nella cartella
  senza che l'utente lo veda.
- In `PERSONAL_MODE` il backend ascolta solo su `127.0.0.1`: i webhook esterni richiedono un
  tunnel o un reverse proxy. Va scritto chiaramente nell'interfaccia.

### 8.3 Notifiche in uscita

Webhook in uscita opzionale per progetto (es. Slack o un URL generico), chiamato a fine run
con stato, costo e link al run.

## 9. Test

- **Unità**:
  - scheduler e limiti: quale run viene scelto, limiti separati per chat e workflow, un turno per
    conversazione, solo i run con `writes` contano per il progetto;
  - accorpamento degli eventi `text`, con gli stessi eventi e `seq` sul bus e sul DB;
  - unione storico più diretta nel riaggancio, senza buchi né duplicati;
  - recovery all'avvio e per heartbeat scaduto;
  - calcolo dei passi da riprendere e rifiuto con `workflowHash` diverso;
  - disiscrizione dal bus alla chiusura della connessione.
- **e2e** (`test/`), con un provider finto che emette eventi a tempo:
  - il run continua dopo la chiusura dello stream;
  - il riaggancio con `after` riceve esattamente gli eventi mancanti, anche a metà di un testo;
  - lo stop di un run in coda e di uno in esecuzione;
  - due conversazioni dello stesso progetto girano in parallelo; un secondo messaggio nella stessa
    risponde 409;
  - 429 oltre la soglia della coda;
  - `GET /runs/active/events` notifica avvio e fine di un run;
  - un utente non vede né ferma i run di un altro (404);
  - un webhook ripetuto con lo stesso delivery id non crea un secondo run.

## 10. Evoluzioni possibili

- **Processo worker separato.** Si avvia lo stesso codice con un altro entry point, che esegue
  solo l'executor e lo scheduler. L'API e il worker comunicano tramite le tabelle: la coda
  esiste già, gli eventi diretti passano da `RunEvent` con un polling breve, oppure da un canale
  IPC se il worker è un processo figlio. L'heartbeat del §5.6 copre già un worker che muore.
  Hook, policy e server MCP `app` continuano a funzionare perché girano nello stesso tipo di
  processo Node.
- **Più istanze.** A quel punto conviene passare a Postgres (`SELECT … FOR UPDATE SKIP LOCKED`)
  o a BullMQ con Redis, e usare un pub/sub per il bus degli eventi.
- **Budget.** `costUsd` per run permette limiti di spesa per progetto o utente, controllati
  dallo scheduler prima di avviare un run.
- **Snapshot prima delle scritture.** Se la cartella del progetto è un repository git, salvare
  lo stato prima di ogni passo con `files: write`, per poter annullare un passo interrotto.

## 11. Piano di lavoro

1. Migrazione Prisma: `Run` (su `WorkflowRun` con `@@map`) con i nuovi campi, tabella
   `RunEvent`, WAL e `busy_timeout` all'avvio.
2. `RunsModule` con executor, bus ed endpoint di ascolto, **insieme** all'abort esplicito: il
   POST dei workflow diventa crea e ascolta (compatibile), la disconnessione non ferma più il
   run, il pulsante "Ferma" chiama `abort` e il pannello non abortisce più allo smontaggio. Le
   due metà non si possono rilasciare separate, altrimenti il pulsante "Ferma" smette di
   funzionare.
3. Coda e limiti di concorrenza; il POST risponde `202`.
4. Heartbeat, recovery, spegnimento ordinato e ripresa.
5. Frontend workflow: riaggancio automatico, stati nuovi, motivo dell'attesa.
6. Estensione alla chat (§4.3, §7.2): turni come run, un turno per conversazione, elenco
   conversazioni con badge.
7. Sezione Attività, indicatore globale e notifiche (§7.3).
8. Fase 2: pianificazioni, webhook in ingresso e notifiche in uscita.

Ogni punto si può rilasciare da solo: dopo il punto 2 il problema principale, cioè il run che
muore quando si chiude la pagina, è già risolto per i workflow.

## 12. Workflow a grafo

[workflow-a-grafo.md](workflow-a-grafo.md) estende i workflow da sequenza a grafo. Gli effetti
su questo documento:

- lo stato `waiting` è già nel modello (§4.1) e nel ciclo di vita (§5.2). Un run è `waiting`
  solo quando nessun passo è in corso o pronto e almeno uno attende l'approvazione: finché un
  altro ramo del grafo gira, il run resta `running` con il suo heartbeat. Un run `waiting` non
  occupa posti di concorrenza e torna in coda quando l'utente approva, anche dalla sezione
  Attività; l'executor ricostruisce allora lo stato da `stepsJson` e continua lo stesso run;
- l'approvazione ricontrolla `workflowHash` come la ripresa del §5.6, e risponde 409 se il
  workflow è cambiato durante l'attesa;
- l'executor esegue i passi *pronti*, anche in parallelo (`RUNS_MAX_PARALLEL_STEPS`), invece di
  quelli in ordine. I limiti del §5.4 continuano a contare i run, non i passi;
- la ripresa del §5.6 riparte da tutti i passi non `done` né `skipped`, non dal "primo passo
  mancante", e non usa più `{{previous}}` dell'ultimo passo copiato ma gli output per `id`;
- il limite `RUNS_MAX_WRITERS_PER_PROJECT` resta. In aggiunta, all'interno di un run solo i
  passi in sola lettura possono girare in parallelo.
