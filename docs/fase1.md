# Fase 1: missione, briefing e piano

Dettaglio della fase 1 di [modalita-autonoma-piano.md](modalita-autonoma-piano.md). Riferimenti
§ a [modalita-autonoma.md](modalita-autonoma.md).

**Obiettivo**: l'utente avvia una missione, l'orchestratore lo intervista e propone un piano,
il backend lo valida, l'utente lo commenta e lo approva. Non si esegue nulla: niente branch,
worktree, comandi o task.

**Fatto quando**: un piano prodotto dall'orchestratore su un progetto reale viene validato,
mostrato e approvato; una missione nata da "Trasforma in missione" riparte dalla
conversazione; i test della §9 sono verdi.

## 1. Decisioni

Risposte ai dubbi emersi rileggendo la fase sul codice attuale.

### 1.1 Dopo l'approvazione: stato `approved`

- Nuovo stato `approved` tra `planned` e `running`. `POST /approve` porta la missione in
  `approved` e salva `approvedVersion`, `approvedAt` e `mode`.
- In fase 1 è uno stato finale di fatto. Dalla fase 2 diventa lo stato di preparazione:
  branch, worktree e controllo di base, poi `running`. Non serve quindi uno stato provvisorio
  da togliere dopo.
- L'approvazione **non** crea righe `MissionTask`. Le crea la fase 2/3 al passaggio a
  `running`, leggendo il piano approvato: in fase 1 non avrebbero stato da tracciare.
- Viste dopo l'ok: il Piano in sola lettura con il badge "Approvato, v3" e la nota
  "L'esecuzione arriverà con la fase 2". Azioni: Rivedi il piano, che riporta in `briefing` e
  tiene `approvedVersion` finché non c'è una nuova approvazione, e Ferma (`aborted`).
- Ciclo della fase 1:

  ```
  briefing ⇄ planned ──(approva)──▶ approved
      ▲                                │
      └──────(Rivedi il piano)─────────┘          ogni stato ──(Ferma)──▶ aborted
  ```

### 1.2 Come `ask_user` e `propose_plan` chiudono il turno

Un tool non può interrompere lo stream del provider, e interrompere la sessione dell'SDK a
metà turno rischia di perdere il risultato del tool nella sessione. Il turno quindi finisce in
modo naturale, ma dopo un tool di chiusura il modello non può fare altro:

1. Il tool scrive sul DB in una transazione condizionata sullo stato atteso:
   - `ask_user`: la missione deve essere `briefing`. Scrive `MissionEntry` di tipo `question`
     (`{ question, options }`) e `waitJson = { code: 'question', entryId }`.
   - `propose_plan`: valida il piano (§4). Se non è valido restituisce gli errori e il turno
     **non** si chiude: l'orchestratore corregge e riprova. Se è valido salva il piano, scrive
     un'entry `plan` e porta la missione in `planned`.
2. Il tool segna il turno come chiuso nello stato del run, una closure creata per ogni run.
   Il suo risultato dice al modello: "Turno chiuso: termina ora senza altro testo".
3. Il hook `PreToolUse` / `canUseTool` di `claude-runtime.ts` nega ogni altro tool del turno
   con "Il turno è chiuso". Quindi:
   - una seconda `ask_user` nello stesso turno è negata;
   - `ask_user` e `propose_plan` nello stesso turno: vince la prima, la seconda è negata.
4. Il run finisce con esito `done`, non `waiting`: nell'executor `waiting` significa "riesegui
   lo stesso run", mentre qui la risposta è un run nuovo. L'attesa sta nella missione, non nel
   run.
5. `POST /missions/:id/messages` crea il run successivo sulla stessa `sessionId`, con la
   risposta come input, e azzera `waitJson`.

Un turno può anche finire senza tool di chiusura (ad esempio con un riepilogo). La missione
resta in `briefing` senza domanda in sospeso e l'utente risponde liberamente, come in chat.

Il testo che il modello scrive dopo il tool di chiusura non si blocca, ma si mostra:
è innocuo.

### 1.3 Catalogo: i modelli di task si caricano ma non si avviano

Lo schema `workflowSchema` in `backend/src/catalog/catalog.ts` è `.strict()` e il caricamento
rifiuta agenti assenti (`catalog.agents.has(s.agent)`, riga 216). Quindi la fase 1 estende
catalogo e validazione:

- **Schema**:
  - `task: true` facoltativo e `result: <step id>` a livello di workflow;
  - nel passo: `agent` facoltativo se c'è `run`, `run: string[]`, `expect: 'pass' | 'fail'`,
    `protect: string[]`, `repeat.stop: string[]`;
  - `agent` accetta `role:<chiave>`.
  - Un refine rifiuta tutti questi campi nei workflow senza `task: true`.
- **Caricamento**: il controllo `agents.has` salta gli agenti `role:`. Per i modelli di task,
  i ruoli si verificano contro il team quando si valida il piano.
- **Contratto**: nuovo `backend/src/catalog/task-contract.ts` con le regole 1-6 della §6.2,
  chiamato dopo `graphErrors` per i workflow con `task: true`. Il limite di `repeat` (5 per i
  workflow) scende a 3 per i modelli di task.
- **Visibilità**:
  - Libreria: visibili, con il badge "Modello di task", modificabili e copiabili. La
    validazione mostra cosa manca al contratto.
  - Risorse del progetto: attivabili, perché la §5 richiede che `template` sia abilitato.
  - Scheda Workflow: esclusi dall'elenco.
  - `WorkflowsService.start` li rifiuta con 400: "È un modello di task: si usa solo nelle
    missioni". Il controllo sta nel backend, non solo nell'interfaccia.
- I tre YAML (`task-tdd`, `task-docs`, `task-config`) vanno in `backend/catalog/workflows/`
  con `enabledByDefault: true`.

È la parte più grossa della fase. L'esecuzione dei nuovi campi resta alla fase 3.

### 1.4 Vista Piano senza grafo

Il componente grafo di workflow-a-grafo.md §8.2 non esiste ancora (`WorkflowsPanel.tsx` non
ne ha uno). In fase 1 la vista Piano mostra milestone e task **in elenco**, con le dipendenze
come testo ("dipende da: oauth-strategy"). Il grafo diventa un lavoro a sé dopo la fase 3:
un componente unico per l'anteprima dei workflow e per la vista Piano.

### 1.5 `baseBranch`: lettura git minima ora

- Alla creazione della missione, `resolveBaseBranch(path)` in `backend/src/missions/git-read.ts`
  esegue solo comandi git in lettura, con argomenti in array e senza `fetch`:
  1. `git rev-parse --is-inside-work-tree`;
  2. `develop` se esiste in locale o in `refs/remotes/origin/develop`;
  3. altrimenti `git symbolic-ref refs/remotes/origin/HEAD`;
  4. altrimenti il branch corrente.
- L'orchestratore riceve il valore nel prompt e può proporne un altro nel piano. La
  validazione controlla che esista in locale o su `origin`.
- Progetto senza git: `baseBranch` è null, il piano mostra l'avviso "Senza git la missione
  non potrà partire" e l'approvazione resta possibile. Nella fase 2 `GitService` assorbe
  `git-read.ts`.
- `Mission.baseBranch` è quindi `String?`.

### 1.6 Modalità: vince quella dell'approvazione

- `POST /missions` prende `mode` come valore iniziale.
- Nella vista Piano la scelta è locale finché non si approva.
- `POST /approve` accetta `{ planVersion, mode }` e lo salva.
- `POST /missions/:id/mode` arriva in fase 3, solo per missioni approvate o in corso.

### 1.7 Eventi della missione: sì, in fase 1

- `GET /missions/:id/events?after=` (SSE) è nella fase 1, con cursore `MissionEntry.id` e lo
  stesso meccanismo di `Last-Event-ID` dei run (`common/sse.ts`).
- Un `MissionEventBus` in memoria, come `RunEventBus`: chi scrive un'entry la pubblica dopo
  il commit.
- Tipi di entry usati in fase 1: `status`, `turn` (`{ runId }`: il client si aggancia a
  `/runs/:id/events` per il testo che scorre), `question`, `plan`, `note` (i messaggi
  dell'utente), `error`.
- Niente polling.

### 1.8 Nuovi kind e limiti, fissati ora

- `RunKind = 'workflow' | 'chat' | 'mission-orchestrator' | 'mission-task'`, in
  `run-types.ts`.
- `limits.ts`: `blockedBy` smette di usare "tutto ciò che non è chat è un workflow" e passa a
  una tabella per kind:

  | Kind | Limite per utente | Scrittore del progetto | Altro |
  |---|---|---|---|
  | `chat` | `chatsPerUser` | no | |
  | `workflow` | `workflowsPerUser` | se `writes` | |
  | `mission-orchestrator` | nessuno: un solo turno per missione, garantito dallo stato | no (legge) | |
  | `mission-task` | nessuno | no: scrive nel worktree (§8.5) | `MISSIONS_MAX_RUNNING_TASKS` |

- Tutti contano per `concurrent`. `writer()` resta `workflow && writes`: per la §8.5
  `mission-task` non è uno scrittore del progetto, perché non tocca la cartella del progetto.
  La concorrenza tra task la governano `parallelTasks` e `MISSIONS_MAX_RUNNING_TASKS`.
- `mission-task` non viene creato in fase 1, ma il limite e i suoi test sì: costano poco ed
  evitano di toccare di nuovo `limits.ts` in fase 3.

### 1.9 Handler separato, ChatService quasi intatto

- Nuovo `MissionOrchestratorHandler`, registrato su `mission-orchestrator`. Riusa:
  - `AgentRunnerService.run`, che è il vero nucleo della chat;
  - `RunFiles`, per gli allegati;
  - l'executor, per lo stop e il riaggancio.
- `ChatService` non si generalizza: il suo codice specifico per la chat (`activeTurn`,
  `sessions`, `history` filtrati su `kind: 'chat'`) resta com'è. L'unica modifica è il punto
  seguente.
- **Sessioni dell'orchestratore nell'elenco chat.** `ChatService.sessions` elenca le sessioni
  del provider per la cartella, e il briefing lavora nella cartella del progetto: senza filtro,
  le sessioni dell'orchestratore comparirebbero tra le chat. Si escludono le `sessionId`
  presenti in `Mission.sessionId`.
- `AgentRunnerService.run` si estende con:
  - `agentSpec?: AgentSpec`, per un agente sintetico fuori catalogo come `DIRECT_CHAT`;
  - `toolContext?: { mission: { id, runId } }`.
- L'orchestratore è un agente sintetico:
  - `files: read`;
  - tool `ask_user` e `propose_plan`;
  - modello `claude:opus` o `claude:sonnet`;
  - `maxTurns: 60`.
- I tool della missione stanno in un registro a parte (`backend/src/missions/mission-tools.ts`),
  non in `APP_TOOLS`: non devono comparire tra le risorse attivabili del progetto.
  `capabilities()` li aggiunge al server `app` solo quando `toolContext.mission` c'è.
  `ToolContext` passa da `{ cwd }` a `{ cwd, mission? }`.

### 1.10 Modello dati: dettagli

- **`MissionTask` si crea già in fase 1**, vuota, con `@@unique([missionId, key])`. Così
  `MissionEntry.taskId` ha da subito la sua relazione e la fase 3 non deve ricostruire la
  tabella in SQLite.
- **Relazioni e `onDelete`**:
  - `Mission → Project`, `Mission → User`, `MissionEntry → Mission`, `MissionTask → Mission`:
    `Cascade`, come `Run`;
  - `Run.missionId` e `Run.missionTaskId`: `Cascade` e `SetNull`.
  - In fase 1 cancellare un progetto cancella le sue missioni. Dalla fase 2
    `ProjectsService.delete` rifiuterà i progetti con missioni attive, per via dei worktree.
- **`projectId` obbligatorio** in fase 1. Diventa nullable in fase 8, con i progetti nuovi.
- **`planVersion`**: aumenta solo se il piano canonico (JSON con le chiavi ordinate) cambia.
  Un `propose_plan` identico non crea versioni e risponde "Piano identico alla versione N".
  Ogni versione si conserva nell'entry `plan`, così si può mostrare il diff tra versioni.

## 2. Modello dati (Prisma)

```prisma
model Mission {
  id                Int       @id @default(autoincrement())
  projectId         Int
  project           Project   @relation(fields: [projectId], references: [id], onDelete: Cascade)
  userId            Int
  user              User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  title             String
  /// "briefing", "planned", "approved", "aborted"; dalla fase 2 anche gli stati di esecuzione (§7.1)
  status            String
  /// "step" o "auto"
  mode              String
  input             String
  planJson          String?
  planVersion       Int       @default(0)
  approvedVersion   Int?
  orchestratorModel String
  sessionId         String?
  baseBranch        String?
  branch            String?
  worktreePath      String?
  prUrl             String?
  waitJson          String?
  budgetJson        String    @default("{}")
  costUsd           Float     @default(0)
  /// Conversazione di chat da cui è nata (`<provider>:<id>`).
  fromSession       String?
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt
  approvedAt        DateTime?
  finishedAt        DateTime?
  seenAt            DateTime?

  tasks   MissionTask[]
  entries MissionEntry[]
  runs    Run[]

  @@index([projectId])
  @@index([userId, status])
  @@index([sessionId])
}
```

`MissionTask` e `MissionEntry` seguono le §4.2 e §4.3, con le relazioni della §1.10. Su `Run`:
`missionId Int?` e `missionTaskId Int?`, con indice.

## 3. Backend

Nuovo modulo `backend/src/missions/`:

| File | Contenuto |
|---|---|
| `missions.module.ts` | Modulo. |
| `missions.service.ts` | Creazione, messaggi, approvazione, Rivedi il piano, Ferma. Ogni cambio è un `updateMany` condizionato su `status` (e `planVersion` per approve); 0 righe → 409. |
| `missions.controller.ts` | API della §5. |
| `mission-orchestrator.handler.ts` | `RunHandler` per `mission-orchestrator` (§1.9). |
| `mission-tools.ts` | `ask_user`, `propose_plan`, chiusura del turno (§1.2). |
| `plan-schema.ts` | Schema zod del piano (§5 del documento, con `maxTurns` e `scope.tests`). |
| `plan-validation.ts` | Regole della §5: chiavi uniche, `needs` aciclici e verso milestone non successive, criteri presenti, ruoli richiesti dai template, template abilitati e conformi, modelli disponibili, chi giudica `result` diverso da chi scrive, `checks.test`, `baseBranch` esistente. Errori come elenco di stringhe in italiano, con il percorso (`milestones[1].tasks[0].needs`). |
| `orchestrator-prompt.ts` | Prompt di sistema e primo messaggio. Il primo messaggio contiene: richiesta, `baseBranch`, modelli e agenti disponibili, modelli di task abilitati, ed eventualmente la trascrizione di `fromSession`. |
| `git-read.ts` | `resolveBaseBranch`, `branchExists` (§1.5). |
| `mission-event-bus.ts` | Pubblicazione delle entry (§1.7). |

Modifiche al codice esistente:

| File | Modifica |
|---|---|
| `catalog/catalog.ts` | Schema dei modelli di task, caricamento con `role:` (§1.3). |
| `catalog/task-contract.ts` | Nuovo: regole 1-6 della §6.2. |
| `catalog/workflow-graph.ts` | `normalizeSteps` porta i nuovi campi; i passi `run` senza agente. |
| `workflows/workflows.service.ts` | Elenco senza `task: true`; `start` li rifiuta. |
| `catalog/app-tools.ts` | `ToolContext` con `mission?`. |
| `claude/claude-runtime.ts` | Tool della missione nel server `app`; negazione dopo la chiusura del turno. |
| `agents/agent-runner.service.ts` | `agentSpec` e `toolContext` in `RunRequest`. |
| `runs/run-types.ts`, `runs/limits.ts` | Kind e tabella dei limiti (§1.8). |
| `chat/chat.service.ts` | Esclusione delle sessioni delle missioni. |
| `runs/runs.service.ts` | Elenco attività: i run `mission-orchestrator` mostrano il titolo della missione. |

## 4. Piano: validazione

La validazione si chiama in due punti:
- in `propose_plan`: gli errori tornano all'orchestratore;
- in `approve`: rivalida contro lo stato attuale del catalogo e dei provider, perché un
  template può essere stato disattivato e un provider scollegato. Gli errori qui sono un 409
  con l'elenco.

La stima delle sessioni nel caso peggiore (§9.4) si calcola dalla validazione: per ogni task,
passi del template × `repeat.max`. Si mostra nel Piano.

## 5. API della fase 1

| Metodo | Percorso | Note |
|---|---|---|
| `POST` | `/projects/:projectId/missions` | `{ input, mode, orchestratorModel, attachments, fromSession? }` → missione in `briefing` e primo run. |
| `GET` | `/missions?status=&projectId=` | |
| `GET` | `/missions/:id` | Missione e piano, più gli errori di validazione se il piano non è più valido. |
| `GET` | `/missions/:id/entries` | |
| `GET` | `/missions/:id/events?after=` | SSE (§1.7). |
| `POST` | `/missions/:id/messages` | `{ text, attachments }`. Da `briefing` o `planned` (un commento riporta a `briefing`). 409 con un turno in corso. |
| `POST` | `/missions/:id/approve` | `{ planVersion, mode }`. 409 se la versione è superata o la missione non è `planned`. |
| `POST` | `/missions/:id/revise` | Da `approved`: torna a `briefing`. |
| `POST` | `/missions/:id/abort` | Ferma il turno in corso; `aborted`. |
| `DELETE` | `/missions/:id` | Solo `aborted` o `approved`. Cancella anche gli allegati. |

`/tasks/*`, `/scope/*`, `/continue`, `/baseline/retry`, `/mode` e `/missions/new-project`
arrivano nelle fasi successive.

## 6. Frontend

| File | Contenuto |
|---|---|
| `src/missions/api.ts` | Client e tipi. |
| `src/missions/useMissionEvents.ts` | SSE con riaggancio, come `useActiveRuns`. |
| `src/missions/MissionsPanel.tsx` | Scheda Missioni: riquadro "Nuova missione" (richiesta, allegati, Opus/Sonnet, modalità) ed elenco con stato e versione del piano. |
| `src/missions/MissionView.tsx` | Contenitore: Briefing a sinistra, Piano a destra quando c'è. |
| `src/missions/BriefingView.tsx` | Riusa i componenti di messaggio di `ChatPanel` (`MessageText`, allegati). Le domande di `ask_user` con opzioni diventano pulsanti, più la risposta libera. |
| `src/missions/PlanView.tsx` | Obiettivo, perimetro, comandi, team (agente, modello, permessi, `maxTurns`), budget, milestone e task in elenco con criteri e dipendenze, stima delle sessioni, avvisi (`baseBranch` assente). Azioni: modalità, Commenta, Approva; dopo l'ok, badge e Rivedi il piano. |
| `projects/ProjectWorkspace.tsx` | Scheda Missioni tra Chat e Workflow. |
| `chat/ChatPanel.tsx` | "Trasforma in missione" nell'intestazione, solo con una conversazione in un progetto e senza turno in corso. Apre un dialogo con modalità e orchestratore. |
| `library/*` | Badge "Modello di task" ed errori del contratto. |
| `i18n/messages.ts` | Testi. |

La conversazione da cui nasce una missione mostra il collegamento alla missione: il backend
lo trova con `Mission.fromSession`.

## 7. "Trasforma in missione"

- `fromSession` passa da `parseRef`, che ne verifica la proprietà come
  `GET /chat/sessions/:id`.
- La storia viene da `provider.history` e diventa una trascrizione testuale ("Utente: … /
  Assistente: …"), tagliata ai messaggi più recenti entro 60k caratteri, con una nota se è
  stata tagliata.
- Gli allegati della conversazione si copiano negli allegati del primo run.
- Il prompt la presenta come materiale di partenza, non come istruzioni (§13.2).

## 8. Ordine di lavoro

1. Prisma e migrazione; kind e tabella dei limiti con i loro test.
2. Catalogo: schema, `task-contract.ts`, i tre YAML, esclusione dalla scheda Workflow, start
   rifiutato.
3. `plan-schema.ts`, `plan-validation.ts`, `git-read.ts`, con i test.
4. Tool della missione, chiusura del turno, `agentSpec` e `toolContext` nel runner.
5. `MissionOrchestratorHandler`, `MissionsService`, controller, event bus; filtro delle sessioni
   in `ChatService`.
6. Frontend: scheda, Briefing, Piano, approvazione.
7. "Trasforma in missione".
8. Prova reale: tre missioni su algo-agent stesso (una feature backend, un cambio solo
   frontend, una documentazione) e lettura critica dei piani prodotti. Si aggiustano prompt e
   validazione prima della fase 2.

## 9. Test

- **Limiti**: tabella per kind; `mission-orchestrator` non consuma `chatsPerUser`;
  `mission-task` non conta tra gli scrittori del progetto e rispetta il suo limite.
- **Catalogo**:
  - i tre YAML passano;
  - per ogni regola della §6.2, un caso che la viola;
  - i campi da modello di task sono rifiutati nei workflow normali;
  - `role:` non fa fallire il caricamento;
  - `start` di un modello di task restituisce 400.
- **Piano**: ogni regola della §5 con un caso valido e uno no; `needs` ciclici e verso una
  milestone successiva; sostituzione con `agents` che rende uguali chi scrive e chi giudica.
- **`planVersion`**: un piano identico non incrementa; uno diverso sì.
- **`git-read`** su repository temporanei: `develop` locale, `develop` remoto, `origin/HEAD`,
  nessun remote, cartella senza git.
- **Turno**:
  - `ask_user` scrive la domanda e chiude il turno;
  - un secondo tool dopo la chiusura è negato;
  - `propose_plan` non valido non chiude il turno;
  - `propose_plan` valido porta la missione in `planned`;
  - il run finisce `done`.
- **Stati**: 409 con lo stato sbagliato, `approve` con una versione superata, due `approve`
  in parallelo (solo uno passa), rivalidazione all'approvazione.
- **Sessioni**: quelle dell'orchestratore non compaiono in `GET /chat/sessions`.
- **Eventi**: riaggancio con `after` e `Last-Event-ID`.
- **Frontend**: pulsanti delle opzioni, Piano che compare all'arrivo dell'entry `plan`, 409
  mostrato come "piano cambiato, ricarica".

## 10. Da riportare in modalita-autonoma.md

- §4.1: `baseBranch` nullable; campo `fromSession`; stato `approved`.
- §4.3: tipi di entry `question` e `turn`.
- §6.2: il campo `agent` è facoltativo nei passi `run`.
- §7.1: stato `approved` tra `planned` e `running`.
- §7.2: motivo `question`, solo nel briefing.
- §8.3: meccanismo di chiusura del turno.
- §12: `approve` accetta `{ planVersion, mode }`; nuovo endpoint `/revise`.
- §13.3: il grafo nella vista Piano arriva dopo la fase 3.
