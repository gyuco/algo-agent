# Fase 3: task e passo-passo

Dettaglio della fase 3 di [modalita-autonoma-piano.md](modalita-autonoma-piano.md). Riferimenti
§ a [modalita-autonoma.md](modalita-autonoma.md). Presuppone la fase 2 completa: `GitService`,
`ChecksService` nel sandbox, `ScopeService`, `run_checks`, `cwd` fidato e missione `running`
con il worktree pronto.

**Obiettivo**: una missione in passo-passo esegue i task del piano uno alla volta, ognuno come
run a grafo del suo modello di task. A ogni task verificato si ferma e chiede all'utente.
Dopo l'Ok il task viene unito nel branch della missione. Alla fine il branch della missione
contiene tutto il lavoro. La PR arriva in fase 6.

**Fatto quando**:
- su algo-agent stesso, una missione di 3 task in due milestone (un `task-tdd`, un
  `task-docs`, un task che dipende dal primo) arriva a `done` con il branch
  `mission/<id>-<slug>` che contiene 3 commit di merge;
- "Rifai con nota" riparte dalla punta della missione e tiene conto della nota;
- un task che esaurisce i tentativi finisce `blocked`, e "Salta" fa proseguire i dipendenti
  con l'avviso;
- un riavvio del backend a metà task riprende dall'ultimo passo chiuso;
- i test della §11 sono verdi.

## 1. Decisioni

### 1.1 Un motore a grafo condiviso, estratto da `WorkflowsService`

L'esecuzione del grafo vive oggi dentro `WorkflowsService` (`execute`, `runStep`, `runBlock`,
`answer`, `finish`): passi pronti, approvazioni, `repeat`, verdetti, salvataggio di
`stepsJson`. I task ne hanno bisogno quasi tutta, più alcune estensioni.

- **Refactoring prima di tutto**: si estrae `backend/src/runs/graph-engine.ts`, con la stessa
  logica, parametrizzata da una porta:

  ```ts
  interface StepPort {
    /** Una sessione dell'agente del passo; come `invoke` oggi. */
    invoke(step: GraphStep, text: string, sessionId?: string): AsyncGenerator<RunEventData, Answer>;
    /** Passi con `run`: esegue i comandi; null se il motore non li supporta (workflow normali). */
    runCommands?(step: GraphStep): AsyncGenerator<RunEventData, CommandOutcome>;
    /** Prima della verifica: `protect` e perimetro. Un testo = verdetto `problemi` con quel testo. */
    beforeCheck?(check: GraphStep, writer: GraphStep): Promise<string | null>;
    /** Dopo un passo che scrive: punto di ripresa (§1.4). */
    afterWrite?(step: GraphStep): Promise<void>;
    /** Prima di ogni passo: false = fermati in `waiting` (budget, fase 4). */
    mayStart?(step: GraphStep): Promise<boolean>;
  }
  ```

- `WorkflowsService` usa il motore con una porta che fa quello che fa oggi.
- **Prima** di scrivere codice nuovo, tutti i test esistenti dei workflow devono restare verdi
  con il motore estratto. È un commit a sé.
- Si scarta un secondo executor scritto da capo per i task: i due motori divergerebbero, e
  la ripresa, i verdetti e il `repeat` sono già testati.

### 1.2 Estensioni del motore (solo nei modelli di task)

| Estensione | Comportamento |
|---|---|
| **Passo solo `run`** (`red`) | `runCommands`. Con `expect: pass`, un comando che fallisce fa fallire il passo. Con `expect: fail`: se fallisce, il passo è ok; se passa, il passo è ok con `warning: "i test passano già"` (§6.2). L'output del comando va in `outputs[step.id]`. |
| **Verifica composta** (passo con `run` e `agent`) | Nell'ordine: `beforeCheck` (`protect` e perimetro), poi `runCommands`, poi l'agente. Al primo che dice no, il verdetto è `problemi` e l'output è il motivo (l'elenco delle violazioni o l'output dei comandi), senza chiamare l'agente. Nello `StepResult` i due esiti stanno separati: `commands: CommandOutcome`, `review?: { verdict, output }`. |
| **`repeat.stop`** | Se il verdetto della verifica è in `stop`, il blocco finisce subito: il passo è `failed` con `stopVerdict` e il run termina. |
| **Ruoli** | `role:<x>` è già risolto nel grafo da `TaskGraphFactory` (§1.3): per il motore è un agente come gli altri. |

`CommandOutcome = { ok: boolean; results: CheckResult[] }` (da `ChecksService`).

### 1.3 Il grafo del task si costruisce e si congela alla partenza

`backend/src/missions/task-graph.factory.ts`:

```ts
build(mission, plan, task: PlanTask, template: WorkflowSpec, team): TaskGraph
interface TaskGraph {
  templateKey: string;
  result: string;
  steps: GraphStep[];                          // ordinati, con agent risolto
  agents: Record<string, ResolvedAgent>;       // per id del passo
}
interface ResolvedAgent {
  spec: AgentSpec;          // dal catalogo con model e maxTurns del ruolo, oppure custom del piano
  tools: ('run_checks')[];  // run_checks per gli agenti con files: write
}
```

- **Risoluzione dei ruoli**: si usa `task.agents[ruolo]` (un agente custom del piano), se c'è;
  altrimenti `team.roles[ruolo]` (agente del catalogo con il `model` e il `maxTurns` del
  piano).
- **Agenti custom**: un `AgentSpec` sintetico con `permissions: { files, skills, tools: [],
  mcp: [] }`, il `prompt` e il `model` del piano. Passano da `agentSpec` di
  `AgentRunnerService.run`, già introdotto in fase 1.
- **Congelamento**: il `TaskGraph` si salva nel run, nel nuovo campo `Run.specJson`. Una
  ripresa usa il grafo salvato, non il catalogo attuale: un template modificato a metà
  missione non cambia un task in corso. Il prossimo tentativo ("Rifai") ricostruisce il
  grafo.
- **Controllo alla partenza**: gli agenti risolti devono essere ancora abilitati nel progetto
  e i modelli disponibili. Se manca qualcosa, il task è `blocked` con `reason: 'config'` e il
  dettaglio.

### 1.4 Ripresa: commit di punto dopo ogni passo che scrive

- Dopo ogni passo con un agente in scrittura (`afterWrite`), il backend fa un commit sul
  branch del task, `checkpoint: <step> #<iterazione>`, senza trailer, con `commitAll`.
  Se non ci sono cambi, non fa nulla. Il commit si salva nello `StepResult`
  (`checkpoint: sha`).
- **`protect`**: i file protetti sono quelli cambiati tra il commit base del task e il
  checkpoint del passo protetto (`git diff --name-only <taskBase> <checkpoint tests>`), più i
  file del diff che corrispondono a `scope.tests`. Il controllo confronta il worktree con il
  checkpoint del passo protetto: ogni file protetto cambiato è una violazione.
- **Ripresa dopo un riavvio**: il run `mission-task` interrotto viene riaccodato dallo
  scheduler come ripresa (stesso meccanismo di `WorkflowsService.resume`: si tengono i passi
  `done`). Prima di ripartire, il worktree del task torna all'ultimo checkpoint
  (`resetTo`), così si perdono solo le modifiche del passo interrotto.
- **Alla chiusura** i checkpoint si comprimono in un commit unico:
  `git reset --soft <taskBase>`, poi `commitAll(titolo del task, trailer Mission e Task)`.
  Sul branch della missione arriva un solo commit per task, più il merge.

### 1.5 `{{task}}`

Il testo si costruisce in `TaskGraphFactory` e diventa `run.input`. `fillPrompt` aggiunge la
sostituzione `{{task}}` → `input`; `{{input}}` resta vietato nei modelli di task (lo
controlla il contratto).

```markdown
## Task <key>: <title>
Milestone: <milestone title>

### Acceptance criteria
- …

### User notes                      (solo se ci sono, dalla più vecchia)
1. …

### Previous attempt                (solo dopo "Rifai con nota")
Diff (troncato a 20 KB):
```diff
…
```
Last review: <verdetto e testo della review dell'ultimo tentativo>

### Tasks this one depends on       (per ogni needs già unito)
- <key> — <title>: <summary of its report> (commit <sha breve>)

### Project commands
build: <argv>  lint: <argv>  test: <argv>  (run them with the run_checks tool)
```

Il testo è in inglese come i prompt dei template. Le note dell'utente restano come scritte.

### 1.6 Stati del task e attese

```
pending ──(scheduler)──▶ running ──(result ok)──▶ review ──(Ok)──▶ merging ──▶ done
                            │                       │
                            │                       └─(Rifai con nota)──▶ pending (attempts+1)
                            ├─(tentativi esauriti / test_errati / errore)──▶ blocked
                            │                                                 ├─(Rifai con nota)──▶ pending
                            │                                                 └─(Salta)──▶ skipped
                            └─(Ferma la missione)──▶ aborted
```

- `merging` è nuovo rispetto alla §4.2: copre il tempo del merge, con il lock della missione.
- **`blocked`** ha un motivo in `reportJson.blocked`:
  `{ reason: 'attempts'|'test_errati'|'error'|'config'|'merge', detail }`.
  - Un errore tecnico (provider, verdetto mancante due volte, eccezione) è `blocked` con
    `error`, non `failed`: l'utente può rifarlo. `failed` resta inutilizzato.
- **Attese della missione** in fase 3:
  - `task_review`, con le azioni Ok · Rifai con nota;
  - `task_blocked`, con le azioni Rifai con nota · Salta.
  - "Rivedi il piano" e "Passa ad automatico" arrivano in fase 5, perché richiedono
    `update_plan` e il budget.

### 1.7 Scheduler: un task alla volta

`backend/src/missions/mission-scheduler.service.ts`. In fase 3 gestisce solo il passo-passo.

- **Eventi che lo svegliano**: missione diventata `running`, task chiuso, azione
  dell'utente, ripresa, timer di sicurezza ogni 30 s.
- **Sotto un lock per missione**:
  1. se la missione non è `running`, o c'è un task in `running`, `review` o `merging`: non
     fa nulla;
  2. sceglie il primo task `pending` nell'ordine del piano (milestone, poi posizione) i cui
     `needs` sono tutti `done` (uniti) o `skipped`;
  3. se non ce n'è nessuno:
     - tutti `done` o `skipped`: missione `done` (§1.10);
     - altrimenti ci sono task `blocked`, oppure task che dipendono solo da task `blocked`:
       missione `waiting` con il primo `task_blocked`;
  4. altrimenti avvia il task (§2).
- **Righe `MissionTask`**: si creano alla transizione `approved → running` (fine della
  preparazione di fase 2), una per task del piano approvato, nella stessa transazione. Le
  missioni già `running` senza righe (create in fase 2) le ricevono alla prima passata.
- **Modalità `auto`**: in fase 3 `approve` con `mode: 'auto'` risponde 409 ("La modalità
  automatica arriva con il budget"). Le missioni già approvate in `auto` si eseguono in
  passo-passo, con un'entry che lo dice.
- **Limite**: `MISSIONS_MAX_RUNNING_TASKS` (default 6) entra in `limits.ts` per il kind
  `mission-task`. In passo-passo non si raggiunge, ma serve dalla fase 5.

### 1.8 Dipendenze saltate

Un task che dipende da un task `skipped` parte con l'avviso nel `{{task}}`: "Task <key> was
skipped: its work is not in the branch." Nel report appare `warning`. È quanto dice §12
(`skip`).

### 1.9 Chiusura di un task

Quando il run del task finisce, l'handler scrive il report e decide:

| Esito del run | Task | Missione |
|---|---|---|
| `result` con verdetto `ok` | squash dei checkpoint, poi `review` | `waiting { code: 'task_review', taskId }`, entry `notify: true` |
| blocco esaurito (`onMax: fail`) | `blocked`, `attempts` | `waiting { code: 'task_blocked', taskId }` |
| verdetto in `repeat.stop` | `blocked`, `test_errati` | come sopra |
| errore, verdetto mancante, eccezione | `blocked`, `error` | come sopra |
| run fermato perché la missione è stata fermata | `aborted` | nessun cambio |

**Ok** (`POST /tasks/:key/ok`, sotto il lock della missione):
1. task in `merging`;
2. `merge --no-ff` del branch del task nel worktree della missione, con messaggio
   `Merge task <key>: <title>`;
3. task `done`; il worktree del task si cancella, il branch resta;
4. missione di nuovo `running` e lo scheduler riparte.

In passo-passo il task parte dalla punta della missione e nessuno la muove nel frattempo,
quindi un conflitto non è atteso. Se capita, si fa `abortMerge` e il task è `blocked` con
`merge`. L'integratore arriva in fase 5.

**Report** (`MissionTask.reportJson`):

```ts
{
  attempt: number;
  diff: { files: { path, status, added, removed }[]; added: number; removed: number };
  checks: CheckResult[];                 // dell'ultima verifica, output già tagliato
  review: { verdict: string; output: string } | null;
  iterations: number;
  warnings: string[];                    // red già verde, dipendenze saltate
  costUsd: number;
  blocked?: { reason, detail };
  summary: string;                        // prime righe dell'output dell'implementatore
}
```

### 1.10 Fine della missione in fase 3

Quando tutti i task sono `done` o `skipped`:
- si eseguono i controlli completi sul worktree della missione;
- se passano: missione `done`, `finishedAt`, entry "Branch pronto: `mission/…`" con
  `notify: true`;
- se falliscono: `waiting { code: 'final_checks', detail }`, con le azioni Riprova · Ferma.
  Il task correttivo dell'orchestratore arriva in fase 5.

La fase 6 inserirà `integrating` (push e PR) prima di `done`.

### 1.11 "Rifai con nota"

`POST /tasks/:key/redo { note }`, da `review` o `blocked`:
1. aggiunge la nota a `notesJson` e incrementa `attempts`;
2. salva il diff del tentativo (`git diff <taskBase>..<branch del task>`, troncato a 20 KB)
   e l'ultima review in `reportJson.previous`;
3. riporta il branch del task alla punta attuale della missione: `resetTo` nel worktree del
   task, oppure lo ricrea se il worktree è stato cancellato. `taskBase` diventa la nuova
   punta;
4. task `pending`, missione `running`, poi lo scheduler.

Il nuovo run ricostruisce il grafo (§1.3) e il `{{task}}` con nota e tentativo precedente.

## 2. Avvio di un task

`MissionScheduler.start(task)`:
1. `taskBase` = punta del branch della missione.
2. Branch `mission/<id>/<key>` da `taskBase`. Se esiste già (un "Rifai"), `resetTo`.
3. Worktree in `<DATA_DIR>/worktrees/<projectId>/<missionId>/<key>`.
4. `setup` nel worktree del task, tramite il marcatore di fase 2. Un task nuovo rifà `setup`:
   è il costo previsto (§14, cache delle dipendenze).
5. Grafo e `{{task}}` (§1.3, §1.5).
6. Run `mission-task` con `missionId`, `missionTaskId`, `input` = `{{task}}`,
   `specJson` = grafo, `projectId`, `writes: false` (scrive nel worktree, §8.5). Il titolo è
   `<missione> · <key>`.
7. Task `running`, `runId`, `startedAt`; entry `status`.

Se un passo fallisce prima del run (git, `setup`), il task è `blocked` con `error` e il
dettaglio.

## 3. Handler del run `mission-task`

`backend/src/missions/mission-task.handler.ts`, che implementa `RunHandler`.

- Legge la missione, il task e il grafo da `run.specJson`. Se la missione non è `running`,
  chiude con `done` senza fare nulla.
- Crea la `StepPort`:
  - **`invoke`**: `AgentRunnerService.run` con:
    - `agentSpec` = agente risolto;
    - `cwd` = worktree del task (fidato, fase 2);
    - `appTools` = `run_checks` legato a worktree, task, `taskBase` e piano, se l'agente
      scrive;
    - `signal` del run.
  - **`runCommands`**: `ScopeService.check`, poi `ChecksService.run` con i comandi del
    passo. Gli eventi `check_output` sono quelli di fase 2. Una violazione del perimetro dà
    `ok: false` con l'elenco.
  - **`beforeCheck`**: `protect` (§1.4) e `ScopeService.check`.
  - **`afterWrite`**: checkpoint (§1.4).
  - **`mayStart`**: sempre `true` in fase 3; la fase 4 lo collega al budget.
- Esegue il motore. Alla fine scrive il report e applica la §1.9 in una transazione
  condizionata sullo stato del task (`running`).
- `Mission.costUsd` e il costo del task si aggiornano con il `costUsd` del run, anche per i
  run dell'orchestratore, che in fase 1 non lo sommavano.

**Le sessioni degli agenti dei task non devono comparire nell'elenco chat**: girano nel
worktree, non nella cartella del progetto, quindi il provider non le elenca per quella
cartella. Va verificato con un test.

## 4. Modello dati

Migrazione `missions_phase3`:
- `Run.specJson String?`: il grafo congelato dei run `mission-task`;
- `MissionTask.taskBase String?`: il commit da cui è partito il tentativo corrente;
- `MissionTask.status`: il commento si aggiorna con `merging`.

`StepResult` (in `run-steps.ts`) riceve campi facoltativi:
- `commands?: CommandOutcome`;
- `review?: { verdict, output }`;
- `checkpoint?: string`;
- `stopVerdict?: string`.

## 5. API

| Metodo | Percorso | Note |
|---|---|---|
| `GET` | `/missions/:id` | Aggiunge `tasks`: `{ key, milestone, title, status, attempts, runId, startedAt, finishedAt, report (senza diff completo), waitingOn: string[] }`. |
| `GET` | `/missions/:id/tasks/:key` | Task con il report completo e lo storico dei run (tutti i tentativi). |
| `GET` | `/missions/:id/tasks/:key/diff` | Diff unificato del tentativo corrente (`taskBase..branch`), al massimo 1 MB, come `text/plain`. |
| `POST` | `/missions/:id/tasks/:key/ok` | Da `review` con missione `waiting{task_review}` per quel task. |
| `POST` | `/missions/:id/tasks/:key/redo` | `{ note }` (1-4000 caratteri). Da `review` o `blocked`. |
| `POST` | `/missions/:id/tasks/:key/skip` | Da `blocked`. |
| `POST` | `/missions/:id/final-checks/retry` | Da `waiting{final_checks}`. |
| `POST` | `/missions/:id/abort` | Ferma anche il run del task in corso; i worktree restano. |

Tutte le azioni passano dal lock della missione e rispondono 409 se lo stato non è quello
atteso. `DELETE /missions/:id` cancella anche i worktree e i branch dei task.

## 6. Eventi

- Gli eventi del run del task sono quelli dei workflow (`step_started`, `iteration_started`,
  `text`, `tool`, `step_finished`), più `check_output` di fase 2 e:
  ```ts
  | { type: 'commands_finished'; id: string; ok: boolean; results: { name, ok, exitCode, timedOut, durationMs }[] }
  | { type: 'protect_violation'; id: string; files: string[] }
  | { type: 'scope_violation'; id: string; violations: ScopeViolation[] }
  ```
- Ogni cambio di stato di un task scrive un'entry `status` con `taskId`, così la vista della
  missione si aggiorna dallo stream della missione.

## 7. Frontend

| File | Contenuto |
|---|---|
| `missions/TaskList.tsx` | Elenco per milestone (§13.3). Ogni riga mostra: stato, passo corrente, tentativo "2/3", ultima attività (dall'ultimo evento non testuale del run, come in Attività) e "aspetta: x, y". Clic sulla riga: vista Task. |
| `missions/TaskView.tsx` | Passi del run in diretta. Riusa la vista dei passi dei workflow, estratta da `WorkflowsPanel.tsx` in `runs/RunSteps.tsx` (testo, tool, iterazioni espandibili). Aggiunge l'output dei comandi, le violazioni e il diff. Mostra i tentativi precedenti. |
| `missions/DiffView.tsx` | Diff unificato con file espandibili. Niente librerie: si colorano le righe `+`, `-` e `@@`. |
| `missions/TaskReviewWait.tsx` | `task_review`: riepilogo del report, diff, Ok, Rifai con nota. |
| `missions/TaskBlockedWait.tsx` | `task_blocked`: motivo, ultima review, Rifai con nota, Salta. |
| `missions/MissionView.tsx` | Con la missione `running`, `waiting` o `done`: TaskList a sinistra (al posto del Briefing, che resta in una scheda), attesa in evidenza, registro. |
| `runs/ActivityPage.tsx` | Notifiche in-app di base: le missioni `waiting` in "Richiedono te", con il motivo e il link al task. Il gruppo completo arriva in fase 7. |
| `missions/api.ts`, `i18n/messages.ts` | Rotte, tipi, stati. |

L'estrazione di `RunSteps.tsx` è un commit a sé, con la scheda Workflow che deve continuare
a funzionare uguale.

## 8. Configurazione

| Variabile | Default | Note |
|---|---|---|
| `MISSIONS_MAX_RUNNING_TASKS` | `6` | §8.5. |
| `MISSION_TASK_DIFF_PROMPT_KB` | `20` | Diff del tentativo precedente nel `{{task}}`. |

## 9. Ordine di lavoro

1. **Estrazione di `graph-engine.ts`** da `WorkflowsService`, senza cambi di comportamento.
   Test dei workflow verdi.
2. **Estensioni del motore**: passo `run`, `expect`, verifica composta, `repeat.stop`. Test
   con una porta finta.
3. **`TaskGraphFactory`** e `{{task}}`.
4. **Handler `mission-task`**: porta reale, checkpoint, `protect`, report, chiusura.
5. **`MissionScheduler`** (passo-passo), creazione delle righe `MissionTask`, ripresa.
6. **Azioni**: Ok con merge, Rifai con nota, Salta, controlli finali, fine missione.
7. **API ed eventi**.
8. **Frontend**: estrazione di `RunSteps.tsx`, poi TaskList, TaskView, DiffView, attese,
   Attività.
9. **Prova reale** sui casi del "Fatto quando".

## 10. Rischi da tenere d'occhio

- **Costo del `setup` per task** (`npm ci` a ogni worktree): misurarlo nella prova reale. Se
  supera qualche minuto, anticipare la cache della §14.
- **Prompt dei template**: la prima missione vera dirà se tester e implementatore si
  comportano bene. Le modifiche ai tre YAML sono previste e non cambiano il codice.
- **`maxTurns` 80 per l'implementatore**: verificare quanti turni servono su task reali.

## 11. Test

- **Motore** (porta finta):
  - i test esistenti dei workflow invariati;
  - passo `run` con `expect: pass`/`fail`, e `fail` che passa (avviso);
  - verifica composta: comandi rossi senza chiamare l'agente, `beforeCheck` con violazione
    senza comandi, tutto verde fino all'agente;
  - `repeat.stop`;
  - ripresa che tiene i passi `done`.
- **`TaskGraphFactory`**:
  - ruolo dal team con model e maxTurns;
  - sostituzione con un agente custom;
  - `run_checks` solo agli agenti che scrivono;
  - `{{task}}` con note, tentativo precedente, dipendenze unite e saltate;
  - agente disabilitato nel frattempo: `blocked` con `config`.
- **Checkpoint e `protect`** su repository temporanei:
  - il commit di punto;
  - i file del passo `tests` protetti e quelli di `scope.tests` protetti;
  - modifica di un file protetto: `problemi` senza comandi;
  - squash finale con i trailer;
  - ripresa dopo un'interruzione che riporta al checkpoint.
- **Scheduler**:
  - un task alla volta;
  - ordine per milestone e `needs`;
  - dipendenza da un task saltato (avviso);
  - nessun task eseguibile con un `blocked`: `waiting`;
  - tutti chiusi: controlli finali;
  - righe create alla transizione a `running`;
  - `auto` rifiutato in `approve`.
- **Azioni**:
  - Ok con merge pulito;
  - Ok con conflitto forzato: `blocked` con `merge` e `abortMerge`;
  - Rifai con nota: branch riportato alla punta, diff nel `{{task}}`, `attempts`;
  - Salta;
  - 409 negli stati sbagliati e con due Ok in parallelo.
- **Fine**: controlli finali verdi (`done`) e rossi (`final_checks`), poi Riprova.
- **Stop**: missione fermata durante un task (run fermato, task `aborted`, worktree
  presente).
- **Sessioni**: quelle dei task non compaiono in `GET /chat/sessions`.
- **Frontend**:
  - TaskList con gli stati;
  - azioni delle due attese;
  - DiffView su un diff con file aggiunti, cancellati e rinominati;
  - scheda Workflow invariata dopo l'estrazione di `RunSteps`.

## 12. Da riportare in modalita-autonoma.md

- §4.2: stato `merging`; `taskBase`; `failed` inutilizzato, al suo posto `blocked` con il
  motivo; forma del `reportJson`.
- §4.4: `Run.specJson`.
- §6.2: commit di punto e `protect` calcolato sui checkpoint.
- §7.2: in fase 3 le azioni sono solo Ok, Rifai con nota e Salta; nuova attesa
  `final_checks`.
- §8.1: `graph-engine.ts` condiviso con i workflow.
- §8.4: un commit per task (squash dei checkpoint), poi il merge.
