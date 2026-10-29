# Missioni: piano delle fasi 4-8

Il lavoro rimasto per completare [modalita-autonoma.md](modalita-autonoma.md), da passare a un
agente coder. Le fasi 1-3 sono sviluppate e unite in `feature/missioni`:
- briefing, piano e approvazione;
- git, sandbox, controlli e preparazione;
- task in passo-passo, merge, controlli finali.

I dettagli delle fasi fatte sono in [fase1.md](fase1.md), [fase2.md](fase2.md) e
[fase3.md](fase3.md). Quelli della fase 4 in [fase4.md](fase4.md), che resta il riferimento
completo; qui se ne riporta solo il riassunto e gli aggiustamenti.

**Regole per chi scrive il codice:**
- Ogni fase si chiude con typecheck di backend e frontend, `vitest` e `oxlint` verdi, più una
  prova reale su algo-agent stesso. Solo dopo si passa alla successiva.
- Ogni cambio di stato di una missione o di un task è un `updateMany` condizionato sullo
  stato atteso: 0 righe significa 409.
- Le azioni dell'utente e lo scheduler passano dal lock della missione
  (`MissionScheduler.withLock`). **Nel lock non si fa nulla di lungo**: niente comandi, niente
  agenti, niente `fetch`. Il lavoro lungo va in un run.
- Il codice segue lo stile esistente: commenti in inglese, testi per l'utente in italiano,
  prompt degli agenti in inglese.
- Si aggiorna `modalita-autonoma.md` quando una decisione qui lo cambia (ogni fase ha la sua
  lista).

## Fase 0: debiti delle fasi 1-3

Da chiudere prima della fase 4: sono piccoli, ma alcuni toccano la sicurezza.

| # | Problema | Correzione | File |
|---|---|---|---|
| 0.1 | Il sandbox lascia leggere tutta la `.git` del progetto, compresa `.git/config`. Un token nell'URL del remote (`https://<token>@github.com/…`) è leggibile dai test e può finire in un file del worktree, quindi nella PR. | All'approvazione, `GitService.remoteHasCredentials(path)` (`git remote -v`, userinfo nell'URL) → 409 "Il remote contiene credenziali: rimuovile dall'URL e usa il vault". Lo stesso controllo nella preparazione, con fallimento `baseline`. | `git-service.ts`, `missions.service.ts`, `mission-prepare.handler.ts` |
| 0.2 | Gli allegati delle chat restano in `session-attachments/` per sempre. | Pulizia giornaliera in `RunRecoveryService.cleanUp`: si cancellano i file più vecchi di `RUN_EVENTS_RETENTION_DAYS`. Si cancellano anche quando si cancella la sessione. | `run-files.ts`, `run-recovery.service.ts` |
| 0.3 | La stima delle sessioni conta anche i passi con solo `run` e moltiplica tutti i passi per il `repeat`: `task-tdd` dà 12 invece di 7. | Si contano solo i passi con `agent`. Il `repeat.max` moltiplica solo il passo che ripete e la sua verifica. | `plan-validation.ts` |
| 0.4 | Nel passo `red` (`expect: fail`) una violazione del perimetro passa per il fallimento atteso dei test. | `runCommands` restituisce `{ ok: false, violation: true }`. Il motore tratta la violazione come fallimento del passo anche con `expect: fail`. | `graph-engine.ts`, `mission-task.handler.ts` |
| 0.5 | I controlli finali girano nello scheduler, dentro il lock della missione, con un segnale che non si può fermare. | Si spostano nel run `mission-checks` (§5.2). Da fare insieme alla fase 5, ma va tenuto presente. | `mission-scheduler.service.ts` |

Test per ogni punto: 0.1 con un remote finto `https://u:p@host/r.git`; 0.2 con file datati;
0.3 con il valore atteso di 7 per `task-tdd`; 0.4 con una violazione in `red`.

---

## Fase 4: budget

**Riferimento completo: [fase4.md](fase4.md).** Riassunto:
- `BudgetGuard.gate(missionId, model)` si controlla in quattro punti:
  - nella coda, per i kind `mission-orchestrator` e `mission-task`;
  - in `mayStart` prima di ogni passo con agente (oggi `mission-task.handler.ts:332`
    restituisce sempre `true`);
  - nello scheduler, prima di avviare un task;
  - durante la sessione, dagli eventi `usage`.
- **Stati**:
  - `paused` con `five_hour` o `model_window`: ripresa automatica con un timer di 60 s e
    `refreshUsage`;
  - `waiting` con `weekly_budget` (scope `mission` o `global`) o `usd_budget`.
- **Attribuzione della settimana**: nuovo evento `tokens` per ogni messaggio `assistant`
  (non salvato in `RunEvent`), peso per famiglia di modello, ricalibrato su `done.costUsd`.
  La crescita di `seven_day` viene divisa per peso a ogni snapshot.
- **`budgetJson`** con `weekly.used`, `weekly.allowance` e `week`; tetto globale
  `MISSIONS_WEEKLY_MAX_SHARE`; `budget.maxUsd` per le connessioni API key.
- **`approve`** accetta `budget?` (soglie modificabili); `POST /continue`;
  `GET /missions/budget`.
- **Frontend**: `BudgetBars`, riquadri di `paused` e `weekly_budget`, soglie nel Piano, barre
  in Attività.

**Aggiustamenti rispetto a fase4.md, dopo la fase 3:**
1. **Fermarsi tra due passi**: `runGraph` supporta già `mayStart`. Quando restituisce false,
   il motore deve salvare `stepsJson` e finire con `waiting` (fase4 §2.3). Va verificato che
   `mission-task.handler.ts` non tratti `waiting` come fine del task: oggi `finish()` gira
   per ogni esito. Con `outcome === 'waiting'` l'handler esce senza report e senza cambiare
   lo stato del task.
2. **Ripresa dopo un budget**: lo scheduler riporta in `queued` i run `mission-task` in
   `waiting`. Lo scheduler oggi considera "task senza run attivo" solo `interrupted`, `done`,
   `failed` e `aborted`. `waiting` è uno stato attivo (`ACTIVE_STATUSES`), quindi il task non
   viene toccato. Serve solo il punto di ripresa nel timer di `BudgetGuard`.
3. **Interruzione sotto metà soglia**: il passo torna `pending` e il worktree torna
   all'ultimo checkpoint. È la stessa funzione già usata da `requeue` nello scheduler: va
   estratta in `task-checkpoints.ts` (`resetToLastCheckpoint(steps, taskBase)`) e usata da
   tutti e due.
4. `approve` con `mode: 'auto'` resta 409 fino alla fase 5.

**Fatto quando**: i casi del "Fatto quando" di fase4.md e i test della sua §10.

---

## Fase 5: modalità automatica

**Obiettivo**: con `mode: 'auto'` la missione arriva da sola fino al branch finale:
- task in parallelo;
- merge automatici, con l'integratore sui conflitti;
- revisione dell'orchestratore a ogni fine milestone.

Si ferma solo per task bloccati, perimetro, budget e revisioni del piano che richiedono
l'utente. Si può passare da una modalità all'altra durante la missione.

**Fatto quando**:
- su algo-agent, una missione `auto` di 2 milestone con 4 task (due indipendenti in
  parallelo) arriva a `done` senza interventi, con le decisioni registrate;
- un conflitto creato apposta tra due task viene risolto dall'integratore, oppure blocca
  solo quel task;
- un controllo rosso a fine milestone produce un task correttivo che lo sistema;
- il passaggio `auto → step` a metà prende effetto dal task successivo che si chiude;
- i test della §5.9 sono verdi.

### 5.1 Scheduler in automatico

`mission-scheduler.service.ts`, funzione `pass`:

- **Task avviabili**: `pending`, con tutti i `needs` in `done` (uniti) o `skipped`, e
  **appartenenti alla milestone corrente**. La milestone corrente è la prima che ha task non
  chiusi e che non è ancora stata rivista.
- **Le milestone sono barriere**: i task della milestone successiva partono solo dopo la
  revisione (§5.4), perché la revisione può cambiarli.
- **Parallelismo**: avvia task finché quelli in `running` della missione sono meno di
  `plan.parallelTasks`, e in tutta l'istanza meno di `MISSIONS_MAX_RUNNING_TASKS`
  (`limits.ts`). Ogni avvio passa da `BudgetGuard.gate`.
- **Un `blocked` o uno `scope`** ferma solo i suoi dipendenti. La missione va in `waiting`
  solo quando nessun task è in `running` o in coda di merge e nessuno è avviabile. Il motivo
  è quello del primo task fermo nell'ordine del piano.
- **Passo-passo**: invariato, un task alla volta.
- **Cambio di modalità** (`POST /missions/:id/mode`, sotto il lock):
  - **`auto → step`**: cambia `mode`; i task in corso finiscono; il prossimo che si chiude va
    in `task_review`. Quelli già in coda di merge vengono uniti.
  - **`step → auto`**: cambia `mode`. Se la missione è in `waiting { task_review }`, vale come
    Ok per quel task e lo scheduler riparte.
  - Un'entry `decision` registra il cambio.
- **`approve` con `auto`**: permesso. Serve `BudgetGuard` con dati di piano, oppure un
  `budget.maxUsd`; altrimenti 409 "Imposta un tetto in dollari per la modalità automatica".

### 5.2 Run `mission-checks`

Un nuovo kind, `mission-checks`, per i controlli completi sul worktree della missione, fuori
dal lock dello scheduler (debito 0.5). Si usa in tre punti:

| `input.purpose` | Quando | Dopo |
|---|---|---|
| `milestone` | Tutti i task della milestone corrente sono `done` o `skipped`. | Turno di revisione dell'orchestratore (§5.4), con l'esito. |
| `final` | Tutti i task chiusi, nessuna milestone da rivedere. | Fase 6: `integrating`. Fino alla fase 6, `done` o `waiting { final_checks }` come oggi. |
| `integration` | Dopo che l'integratore ha risolto un conflitto (§5.3). | Commit del merge oppure `merge --abort`. |

- **Handler**: `mission-checks.handler.ts`. Riusa `ChecksService.run`, con il segnale del
  run e gli eventi `check_output`, come `mission-prepare`. Il risultato va in un'entry
  `checks { purpose, ok, results }` e poi alla funzione di proseguimento (tabella sopra).
- `input` è JSON: `{ purpose, milestone?, taskId? }`.
- In `limits.ts`: nessun limite per utente, conta per `concurrent`.
- La riconciliazione dello scheduler riaccoda un `mission-checks` interrotto, come fa
  `MissionsService.reconcile` per `mission-prepare`.

### 5.3 Merge automatico e integratore

- **In automatico**, un task con `result` ok non va in `review`: va in coda di merge, cioè
  nello stato `ready`, nuovo. Lo scheduler unisce un task `ready` alla volta, in ordine di
  `finishedAt`, sotto il lock: `merging`, poi `GitService.merge`.
  - **Merge pulito**: task `done`, worktree cancellato, scheduler.
  - **Conflitto**: il merge resta aperto nel worktree della missione (niente
    `abortMerge`). Il task resta in `merging`, e si accoda un run `mission-integrate`.
- **Run `mission-integrate`**: nuovo kind, `mission-integrate.handler.ts`.
  - Agente: il ruolo `integrator` del piano, risolto come i ruoli dei task
    (`TaskGraphFactory`).
  - `cwd`: il worktree della missione, fidato; permessi `files: write`; tool `run_checks`.
  - Prompt (in inglese):
    - i file in conflitto (`GitService.conflicts`);
    - il diff del task (`taskBase..branch`) e quello della missione dal `taskBase`
      (`taskBase..HEAD`);
    - i criteri di accettazione del task e dei task uniti dopo il suo `taskBase`;
    - l'istruzione di risolvere solo i conflitti, senza altre modifiche.
  - Dopo l'agente:
    1. nessun marcatore di conflitto rimasto
       (`git diff --check` e `GitService.conflicts` vuoto);
    2. `ScopeService.check` sul diff del task;
    3. run `mission-checks` con `purpose: integration`.
  - **Esito ok**: `git add -A`, poi `git commit --no-edit` (commit del merge), task `done`.
  - **Esito ko** (agente fallito, marcatori rimasti, perimetro o controlli rossi):
    `abortMerge`, task `blocked` con il motivo `merge` e il dettaglio.
- **Mentre un merge è in corso** nessun altro merge parte. I task continuano a girare nei loro
  worktree.
- **Ferma** durante l'integrazione: `abortMerge` nel handler quando il segnale scatta.
- Nuovo `GitService.continueMerge(dir)`: `git -c core.hooksPath=/dev/null commit --no-edit`
  con l'autore del progetto.

### 5.4 Fine milestone e orchestratore in esecuzione

**Quando**: tutti i task della milestone corrente sono `done` o `skipped`, e la coda di merge
è vuota. Lo scheduler accoda `mission-checks { purpose: 'milestone', milestone }`. Al termine
accoda un turno `mission-orchestrator` di revisione.

**Il turno di revisione:**
- **Sessione nuova** (§8.3): `sessionId` vuoto. Il backend costruisce il primo messaggio:
  - piano approvato con la versione;
  - milestone chiusa: per ogni task, il report sintetico (`summary`, verdetto, avvisi, costo);
  - esito dei controlli;
  - decisioni già registrate;
  - milestone successive;
  - regole: cosa si può cambiare senza l'utente (§5.5).
- **Il run** ha il campo `purpose`, salvato in `Run.input` come prefisso o in un nuovo campo
  `Run.purposeJson`. Si sceglie `purposeJson String?`: più pulito.
  `mission-orchestrator.handler.ts` sceglie tool e `cwd` in base a `purpose`:

  | `purpose` | Tool | `cwd` |
  |---|---|---|
  | `briefing` (com'è oggi) | `ask_user`, `propose_plan` | cartella del progetto |
  | `milestone` | `update_plan`, `record_decision`, `task_report`, `close_milestone` | worktree della missione (fidato) |
  | `revision` (§5.6) | `update_plan`, `record_decision`, `task_report` | worktree della missione |
  | `final` (fase 6) | come `milestone` | worktree della missione |

- **Tool nuovi** (in `mission-tools.ts`, con la chiusura del turno come quelli del briefing):
  - **`task_report({ key })`**: il report completo di un task, con il diff tagliato a 20 KB.
    Non chiude il turno.
  - **`record_decision({ question, options, chosen, reason })`**: entry `decision` (senza
    notifica), che finisce nella PR. Non chiude il turno.
  - **`update_plan({ plan, reason })`**: valida e applica secondo la §5.5. Chiude il turno se
    valido.
  - **`close_milestone({ summary })`**: conferma la milestone. Chiude il turno.
  - Un turno che finisce senza `update_plan` né `close_milestone` vale come conferma, con
    un'entry che lo dice.
- **Controlli rossi senza correzione**: se i controlli della milestone sono rossi e il turno
  non aggiunge un task correttivo, la missione va in `waiting { code: 'milestone', detail }`.
- **Dopo la conferma**: entry `milestone { id, summary }`, milestone aggiunta a
  `Mission.progressJson.reviewedMilestones` (§5.8), poi lo scheduler.

### 5.5 `update_plan`: cosa può cambiare

`backend/src/missions/plan-diff.ts`, funzione `planChanges(approved, proposed, tasks)`:

- **Mai** cambiare task in `running`, `ready`, `merging`, `done` o `skipped`: chiavi, criteri e
  template restano uguali. Le milestone già riviste non cambiano, tranne per l'aggiunta di
  task correttivi a quella appena chiusa.
- **Ammesso**:
  - aggiungere, togliere, riordinare o modificare task `pending` delle milestone non
    iniziate;
  - aggiungere task alla milestone appena chiusa (correttivi);
  - aggiungere milestone dopo l'ultima.
- **Il nuovo piano** passa la stessa validazione di `propose_plan` (`PlanValidationService`).
- **Applicazione automatica** se la modalità è `auto` e:
  - `scope`, `checks`, `team` e `budget` sono identici a quelli approvati;
  - non c'è nessun template nuovo non ancora usato nel piano.

  Allora: `planJson` nuovo, `planVersion` e `approvedVersion` incrementati, entry `plan` ed
  entry `decision` con `reason`. Le righe `MissionTask` si aggiungono o si cancellano (solo
  le `pending`).
- **Altrimenti** (modalità `step`, oppure cambi a perimetro, comandi, team o budget):
  `planVersion` sale ma `approvedVersion` no, e la missione va in
  `waiting { code: 'milestone', planVersion }`. L'utente fa Approva (`POST /approve` con la
  nuova versione: deve funzionare anche da `waiting { milestone }` e da `waiting { revision }`,
  oltre che da `planned`) oppure Commenta (`POST /messages` → turno `revision`).

### 5.6 "Rivedi il piano" durante l'esecuzione

- **`POST /missions/:id/messages`** è ammesso anche da `waiting` con `task_review`,
  `task_blocked`, `scope`, `milestone` o `final_checks`. Porta la missione in
  `waiting { code: 'revision' }` e accoda un turno `mission-orchestrator` con
  `purpose: 'revision'`. È la stessa sessione dell'ultimo turno di esecuzione, se c'è,
  altrimenti una nuova con il riepilogo.
- **I task in corso continuano**: in `revision` lo scheduler non avvia task nuovi.
- **Esito del turno**:
  - `update_plan` valido: §5.5. Se richiede l'utente, `waiting { milestone }`.
  - Nessun `update_plan`: si torna all'attesa precedente, salvata in
    `waitJson.previous`.
- **UI**: nelle attese `task_review`, `task_blocked`, `scope` e `milestone` compare
  "Rivedi il piano", che apre un riquadro di messaggio.

### 5.7 Perimetro: attesa `scope`

Oggi ogni violazione del perimetro fa fallire la verifica. Si distinguono due tipi.

| Violazione | Durante il task | Alla chiusura |
|---|---|---|
| `dependency` | **Blocca l'esecuzione**: `run_checks` e la verifica non eseguono comandi, come oggi (le dipendenze nuove non si installano) | ai tentativi esauriti, attesa `scope` invece di `task_blocked` |
| `path`, `deleted`, `migration` | **Non blocca**: i comandi girano, la violazione si annota nel report | attesa `scope` invece di `task_review` o del merge automatico |

- **Attesa** `waiting { code: 'scope', taskId, violations }`, in tutte e due le modalità
  (decisione 8). Il task resta sul suo branch, nello stato nuovo `scope`.
- **Accetta** (`POST /missions/:id/scope/accept`, sotto il lock):
  1. allarga `scope` nel piano approvato: aggiunge le dipendenze, i percorsi (il file
     esatto), le migrazioni permesse e i file cancellati in un nuovo elenco
     `scope.deletions`;
  2. nuova versione approvata, entry `decision`;
  3. poi:
     - violazioni di soli `path`/`deleted`/`migration`: il task prosegue come se fosse
       verificato (`review` in passo-passo, `ready` in automatico);
     - c'era una `dependency`: il task si riaccoda dall'ultimo checkpoint (stesso meccanismo
       di `requeue`) con il blocco di `repeat` che riparte. Ora `setup` installa la
       dipendenza.
- **Rifai con nota** e **Rivedi il piano**: come nelle altre attese.
- `plan-schema.ts`: `scope.deletions: string[]` (default `[]`). `ScopeService` non segnala la
  cancellazione dei file che ci sono dentro.

### 5.8 Modello dati e API

**Migrazione `missions_phase5`:**
- `Mission.progressJson String @default("{}")`:
  `{ reviewedMilestones: string[], mergeQueue?: number[] }`;
- `Run.purposeJson String?`;
- `MissionTask.status`: nuovi valori `ready` e `scope`.

**API:**

| Metodo | Percorso | Note |
|---|---|---|
| `POST` | `/missions/:id/mode` | `{ mode }`, sotto il lock (§5.1). |
| `POST` | `/missions/:id/approve` | Anche da `waiting { milestone }` e `waiting { revision }` con la nuova `planVersion`. |
| `POST` | `/missions/:id/messages` | Anche dalle attese di esecuzione (§5.6). |
| `POST` | `/missions/:id/scope/accept` | §5.7. |
| `GET` | `/missions/:id` | Aggiunge `progress` (milestone corrente, milestone riviste, coda di merge). |

**Frontend:**
- `MissionView`: interruttore della modalità nell'intestazione.
- `TaskList`: stati `ready`, `merging` e `scope`; la milestone corrente evidenziata; le
  milestone riviste con il riepilogo.
- `ScopeWait.tsx`: violazioni raggruppate per tipo, con Accetta · Rifai con nota · Rivedi il
  piano.
- `MilestoneWait.tsx`: confronto tra il piano approvato e quello proposto, per task (aggiunti,
  tolti, cambiati) e per sezione (perimetro, comandi, team). Azioni Approva e Commenta.
- `RevisionPanel.tsx`: il turno dell'orchestratore in diretta, riusando `AgentTurn` di
  `BriefingView`.
- Registro: le entry `decision` e `milestone` in evidenza.

### 5.9 Test

- **Scheduler `auto`**:
  - due task indipendenti partono insieme fino a `parallelTasks`;
  - il limite globale `MISSIONS_MAX_RUNNING_TASKS`;
  - barriera tra milestone;
  - un blocco ferma solo i dipendenti;
  - `waiting` solo quando non resta niente;
  - `auto → step` e `step → auto` a metà, con l'Ok implicito.
- **Merge**: coda in ordine di `finishedAt`; merge pulito; conflitto → `mission-integrate`.
- **Integratore** (agente finto):
  - risolve, controlli verdi, commit del merge;
  - lascia marcatori: `abortMerge` e `blocked`;
  - controlli rossi: `abortMerge` e `blocked`;
  - Ferma durante l'integrazione: `abortMerge`.
- **`mission-checks`**: tre `purpose`; interrotto e riaccodato; stop.
- **Revisione della milestone**:
  - conferma esplicita e implicita;
  - `update_plan` applicato in automatico entro le regole;
  - `update_plan` con un cambio di perimetro → `waiting { milestone }`;
  - task correttivo nella milestone chiusa;
  - controlli rossi senza correzione → `waiting { milestone }`.
- **`plan-diff`**: ogni regola della §5.5 con un caso ammesso e uno rifiutato.
- **Revisione su richiesta**: da ogni attesa ammessa; ritorno all'attesa precedente senza
  cambi; 409 dalle altre.
- **Perimetro**:
  - `path` non blocca i comandi ma porta all'attesa `scope`;
  - `dependency` blocca i comandi;
  - Accetta allarga il piano e fa proseguire il task;
  - Accetta con `dependency` riaccoda dal checkpoint;
  - `scope.deletions`.
- **Frontend**: interruttore della modalità, `ScopeWait`, `MilestoneWait` con il confronto,
  `RevisionPanel`.

### 5.10 Da riportare in modalita-autonoma.md

- §4.2: stati `ready` e `scope`.
- §4.1: `progressJson`.
- §4.4: `purposeJson` e i kind `mission-checks` e `mission-integrate`.
- §5: `scope.deletions`.
- §7.2: attesa `revision`; perimetro con violazioni che bloccano (`dependency`) e no.
- §7.3: milestone come barriere; tool `close_milestone`.
- §8.3: tool per `purpose`.
- §8.4: integratore in un run separato, con il merge lasciato aperto durante l'integrazione.

---

## Fase 6: PR

**Obiettivo**: alla fine la missione pubblica il branch e apre una PR su GitHub o una MR su
GitLab verso `baseBranch`, con una descrizione completa. Senza `origin` finisce con il branch
locale, come oggi.

**Fatto quando**:
- una missione su un repository GitHub di prova finisce con la PR aperta, il link nella
  missione e la descrizione con le decisioni;
- lo stesso su GitLab, anche self-hosted con `GITLAB_URL`;
- un token mancante o sbagliato porta a un'attesa con Riprova, non a un fallimento;
- i test della §6.6 sono verdi.

### 6.1 `ForgeService`

`backend/src/missions/forge.service.ts`. Usa `fetch` di Node, nessuna libreria nuova.

```ts
interface Forge {
  kind: 'github' | 'gitlab';
  host: string;            // github.com, gitlab.com o l'host di GITLAB_URL
  apiBase: string;         // https://api.github.com | <GITLAB_URL o https://gitlab.com>/api/v4
  owner: string;           // namespace
  repo: string;
}
detect(remoteUrl: string, gitlabUrl?: string): Forge | null
httpsUrl(remoteUrl: string): string   // git@host:ns/repo.git → https://host/ns/repo.git
findOpenPr(forge, token, head, base): Promise<{ url: string; number: number } | null>
createPr(forge, token, { head, base, title, body }): Promise<{ url: string; number: number }>
createRepo(kind, token, { name, namespace, visibility }): Promise<{ httpsUrl: string; defaultBranch: string }> // fase 8
```

- **Riconoscimento del forge**: `github.com`, l'host di `GITLAB_URL` o `gitlab.com`. Un
  remote SSH si converte solo per il push.
- **Token** dal vault (`VaultService.variables(userId, projectId)`): `GITHUB_TOKEN`,
  `GITLAB_TOKEN`, `GITLAB_URL`. Quelli del progetto vincono, come fa già `variables`.
- **Endpoint**:
  - GitHub: `GET /repos/{o}/{r}/pulls?head={o}:{branch}&base={base}&state=open`, poi
    `POST /repos/{o}/{r}/pulls`;
  - GitLab: `GET /projects/{id}/merge_requests?source_branch=…&target_branch=…&state=opened`,
    poi `POST /projects/{id}/merge_requests`, con `{id}` = `encodeURIComponent('ns/repo')`.
- **Idempotenza**: prima si cerca una PR aperta per quella coppia di branch, e la si riusa.
- **Errori**: `ForgeError { status, message }` con un testo per l'utente:
  - 401/403: "token non valido o senza permessi";
  - 404: "repository non trovato o token senza accesso";
  - 422: "la PR esiste già o il branch non è stato pubblicato".

### 6.2 Push senza esporre il token

`GitService.push(dir, remoteHttpsUrl, branch, auth)`:
- `git push <httpsUrl> refs/heads/<branch>:refs/heads/<branch>`, senza `--force`.
- **Il token non va mai negli argomenti**, che si vedono nell'elenco dei processi. Si passa
  dall'ambiente:
  - `GIT_CONFIG_COUNT=1`;
  - `GIT_CONFIG_KEY_0=http.extraHeader`;
  - `GIT_CONFIG_VALUE_0=Authorization: Basic <base64>`, con `x-access-token:<token>` per
    GitHub e `oauth2:<token>` per GitLab.
- `GIT_TERMINAL_PROMPT=0` c'è già.
- Gli errori di git passano da una funzione che cancella il token e la sua codifica base64
  da `stderr` prima di creare il `GitError`.

### 6.3 Stato `integrating`

Il flusso dopo l'ultimo task si sposta dalla fine della fase 3 a quella di fase 6:
1. **Controlli finali**: `mission-checks { purpose: 'final' }` (fase 5).
   - **Rossi in automatico**: turno dell'orchestratore con `purpose: 'final'` (task
     correttivo, come a fine milestone).
   - **Rossi in passo-passo**: `waiting { final_checks }`, con Riprova · Rivedi il piano.
2. **Verdi**: la missione va in `integrating` e si accoda un run `mission-publish` (nuovo
   kind, `mission-publish.handler.ts`):
   1. senza `origin` o forge non riconosciuto: `done` con il branch locale, entry `final`
      (comportamento di oggi);
   2. senza token: `waiting { code: 'publish', step: 'token', detail }`;
   3. `push` (§6.2), con evento `prepare_step`-like `{ type: 'publish_step', step: 'push'|'pr', status }`;
   4. `findOpenPr`, altrimenti `createPr`, con titolo e corpo (§6.4);
   5. `prUrl` sulla missione, missione `done`, entry `pr { url }` con `notify: true`;
   6. a missione `done`, i worktree dei task si cancellano (i branch locali restano, §8.4).
3. **Errori di push o forge**: `waiting { code: 'publish', step, detail }`, con
   Riprova (`POST /missions/:id/publish/retry`) · Ferma.

### 6.4 Descrizione della PR

`backend/src/missions/pr-body.ts`, funzione pura `prBody(mission, plan, tasks, entries)`.
Markdown in inglese, dato che il resto del repository è in inglese (testi per l'utente in
italiano solo nell'app):

```markdown
## Goal
<plan.goal>

## Tasks
- [x] **<key>** <title> — <criteria in a nested list>
- [ ] ~~<key>~~ <title> — skipped: <reason>

## Checks
| Command | Result |
|---|---|
| build | ✅ 42 s |

## Decisions taken automatically
- **<question>** → <chosen>. <reason>

## Scope changes accepted
- <entry decision di scope/accept>

## Usage
Agent sessions: N · Cost: $X.XX · Weekly share used (estimate): Y%

---
Mission #<id> · plan v<approvedVersion> · generated by algo-agent
```

- Lunghezza massima: 60.000 caratteri. Oltre, le sezioni si tagliano dalla fine con
  "(truncated)".
- I titoli dei task e i criteri si escapano per il Markdown.

### 6.5 Modello dati, API, frontend

- **Nessuna migrazione**: `prUrl` c'è già. Stati: `integrating`; nuovi `waitJson.code`:
  `publish`.
- **API**:
  - `POST /missions/:id/publish/retry`;
  - `GET /missions/:id` mostra `prUrl`.
- **Frontend**:
  - `MissionView`: link alla PR in evidenza a missione `done`;
  - `PublishWait.tsx`, con il passo fallito, il dettaglio e il collegamento al vault quando
    manca il token;
  - `PlanView` prima dell'approvazione: avviso "Senza origin la missione finisce con un
    branch locale" oppure "Manca GITHUB_TOKEN nel vault".

### 6.6 Test

- **`ForgeService`** (fetch finto):
  - `detect` per github.com, gitlab.com, GitLab self-hosted, SSH e HTTPS, forge
    sconosciuto;
  - `httpsUrl`;
  - PR trovata e riusata, PR creata;
  - ogni errore mappato sul suo testo.
- **`push`** su un remote bare locale servito via `file://`: il token non compare negli
  argomenti (si registra l'`argv`) e un errore con il token in `stderr` arriva ripulito.
  Per l'header si usa un finto `http.extraHeader` letto con `git config --get`, su un
  remote locale.
- **`prBody`**: tutte le sezioni; troncamento; escape.
- **`mission-publish`**:
  - senza `origin`;
  - senza token → `publish/token`;
  - push fallito → `publish/push` e Riprova;
  - PR esistente;
  - percorso verde fino a `done` con `prUrl`.
- **Fine missione**: controlli rossi in `auto` (turno `final`) e in `step`
  (`final_checks`).

### 6.7 Da riportare in modalita-autonoma.md

- §7.1: `integrating` → `done`; attesa `publish`.
- §10.1: token negli header via ambiente, mai negli argomenti.
- §10.2: run `mission-publish`, idempotenza della PR.
- §12: `publish/retry`.

---

## Fase 7: notifiche e Attività

**Obiettivo**: le missioni hanno il loro posto in Attività ("Richiedono te" e "In corso"),
le notifiche di sistema arrivano a ogni entry con `notify`, e i non letti sono contati.

Stato attuale: `ActivityPage.tsx` mostra già le missioni in attesa (fase 3) e chiede il
permesso per le notifiche, ma solo per i run. Non c'è uno stream delle missioni per l'utente.

**Fatto quando**:
- con due missioni attive e la scheda in secondo piano, ogni attesa genera una notifica di
  sistema;
- al clic si apre la missione sul task giusto;
- riaprendo l'app dopo averla chiusa, le attese arrivate nel frattempo risultano non lette;
- i test della §7.5 sono verdi.

### 7.1 Backend

- **Stream dell'utente**: `GET /missions/active/events?after=` (SSE) con tutte le entry delle
  missioni dell'utente. Il cursore è `MissionEntry.id`. Riusa `MissionEventBus`, con una
  sottoscrizione per utente: `subscribeUser(userId, …)`. Al `publish` serve lo `userId`
  della missione: lo si legge con una cache `missionId → userId` nel bus.
  - Si sceglie uno stream separato, invece di estendere `GET /runs/active/events`: le entry
    hanno un cursore loro, e mischiarle ai run complicherebbe il riaggancio.
- **Non letti**: `Mission.seenAt` esiste già, e la logica è come per i run. Una missione è
  non letta se ha entry con `notify: true` più recenti di `seenAt`.
  - `GET /missions?unread=true`;
  - `POST /missions/:id/seen`, che il frontend chiama all'apertura della missione.
- **Riepilogo per Attività**: `GET /missions/activity` →
  `{ waiting: MissionCard[], running: MissionCard[], unread: number }`:
  ```ts
  interface MissionCard {
    id; title; projectId; projectName; status; mode;
    wait?: { code; taskKey?; detail? };
    milestone?: { id; title; done: number; total: number };
    activeTasks: { key; step?: string; last?: string }[];   // ultima attività dal run, come RunActivity
    budget?: BudgetView;                                      // fase 4, compatto
    unread: boolean;
  }
  ```
  L'ultima attività di un task riusa la funzione che oggi calcola `RunActivity` per i run.

### 7.2 Frontend

- **`runs/ActivityPage.tsx`**: due gruppi Missioni.
  - "Richiedono te": le `waiting`, ordinate per età dell'attesa, con il motivo leggibile e
    il pulsante che apre il punto giusto (task, piano o riquadro dell'attesa).
  - "In corso": `running`, `paused` e `integrating`, con la milestone, i task attivi e le
    loro ultime attività, e le barre compatte.
- **`missions/useMissionNotifications.ts`**: un solo hook montato in `App.tsx`. Segue
  `GET /missions/active/events` con `reconnecting` (già in `runs/api.ts`). Per ogni entry
  con `notify`:
  - se `document.visibilityState !== 'visible'` e il permesso è `granted`:
    `new Notification(title, { body, tag: 'mission-<id>' })`;
  - `onclick`: `window.focus()` e navigazione a `/projects/<projectId>/missions/<id>?task=<key>`
    (verificare le rotte in `App.tsx` e adeguarle);
  - aggiorna il contatore dei non letti.
- **Permesso**: chiesto al primo accesso alla scheda Missioni, oltre al pulsante già presente
  in Attività. Se è negato, un avviso in Attività.
- **Badge**: `ActivityBadge.tsx` somma i run non letti e le missioni non lette o in attesa.
- **Testi**: una funzione `notificationText(entry)` per ogni `kind`/`code` della tabella §11
  del documento principale.

### 7.3 Modello dati

Nessuna migrazione: `seenAt` e `notify` esistono già.

### 7.4 Da riportare in modalita-autonoma.md

- §11: stream `GET /missions/active/events` separato da quello dei run; riepilogo
  `GET /missions/activity`.
- §12: le nuove rotte.

### 7.5 Test

- **Backend**:
  - lo stream dell'utente riceve le entry di tutte le sue missioni e nessuna di un altro
    utente;
  - riaggancio con `after`;
  - non letti dopo `seen`;
  - `activity` con missioni in ogni stato.
- **Frontend**:
  - notifica solo con la scheda nascosta e il permesso concesso;
  - testo per ogni codice;
  - clic che naviga;
  - badge;
  - permesso negato.

---

## Fase 8: progetti nuovi

**Obiettivo**: "Nuovo progetto con missione" nella pagina Progetti. Il briefing parte su una
cartella temporanea. All'approvazione si creano la cartella in `WORKSPACE_ROOT`, il
repository locale con un commit iniziale, il repository remoto e il `Project`. La prima
milestone fa lo scaffolding.

**Fatto quando**:
- da zero, una missione "API Express con un endpoint /health e i test" crea il repository
  privato su GitHub, esegue lo scaffolding e apre la PR verso `main`;
- una missione abbandonata nel briefing non lascia cartelle né repository;
- i test della §8.6 sono verdi.

### 8.1 Modello dati

**Migrazione `missions_phase8`:**
- `Mission.projectId Int?`, nullable fino all'approvazione. Va rivisto ogni punto che dà
  per scontato `projectId`:
  - `find` e `list`;
  - i run: `Run.projectId` è obbligatorio. I turni del briefing di un progetto nuovo non
    hanno un progetto. Decisione: **`Run.projectId` diventa nullable** solo per i run
    `mission-orchestrator`. In `limits.ts`, `blockedBy` tratta `projectId` null come "nessun
    progetto" (solo `concurrent`). Va verificato ogni uso di `run.projectId`
    (`grep -rn "projectId" src/runs`).
- `Mission.newProjectJson String?`:
  `{ name, forge: 'github'|'gitlab', namespace, visibility: 'private'|'internal'|'public', briefingDir }`.

### 8.2 Briefing su una cartella temporanea

- **`POST /missions/new-project`**:
  `{ input, mode, orchestratorModel, attachments, name, forge, namespace, visibility }`.
  - `name`: `^[a-z0-9][a-z0-9-_.]{0,99}$`. La cartella `WORKSPACE_ROOT/<name>` non deve
    esistere, e il controllo si ripete all'approvazione.
  - Si crea `<DATA_DIR>/briefing/<missionId>/` vuota.
  - Missione in `briefing` con `projectId: null`.
- **Il turno dell'orchestratore** usa la cartella del briefing come `cwd`. Serve una variante
  di `trustedWorktreeCwd` per `DATA_DIR/briefing/<missionId>`
  (`trustedBriefingCwd`). `AgentRunnerService.run` accetta `project: { id: null, path }`;
  va controllato dove `project.id` viene usato (catalogo, risorse abilitate).
  - **Risorse**: senza progetto vale il catalogo dell'utente con i default `enabledByDefault`.
    `ProjectResourcesService.isEnabled` con `projectId` null deve restituire i default.
- **Prompt del briefing**: dice che il progetto è nuovo e vuoto, che la prima milestone deve
  essere lo scaffolding con template `task-config`, e che i comandi dei controlli saranno
  verificati a fine della prima milestone (§5 del documento principale).
- **Validazione del piano**: `baseBranch` libero (default `main`), senza il controllo di
  esistenza; i comandi validati solo come sintassi.
- **Abbandono**: `DELETE` o `abort` di una missione senza progetto cancella la cartella del
  briefing. La pulizia giornaliera cancella le cartelle del briefing di missioni `aborted`
  più vecchie di 7 giorni.

### 8.3 Creazione all'approvazione

`approve` per una missione con `newProjectJson`, in un run `mission-prepare` esteso: la
creazione dura secondi o minuti e può fallire a metà. Passi aggiuntivi prima del branch, con
gli eventi `prepare_step` (`create_folder`, `git_init`, `create_repo`, `push_base`,
`register_project`):

1. `mkdir WORKSPACE_ROOT/<name>`. Se esiste già e non è vuota: fallimento
   `baseline { step: 'create_folder' }`.
2. `git init -b <baseBranch>`, poi un commit iniziale vuoto
   (`commit --allow-empty -m "Initial commit"`, con l'autore dal git config globale o il
   fallback).
3. `ForgeService.createRepo(forge, token, { name, namespace, visibility })`. Se il
   repository esiste già e appartiene all'utente, si riusa solo se è vuoto. Poi
   `git remote add origin <httpsUrl>`.
4. Push di `baseBranch` (§6.2).
5. `Project.create` con `path` risolto; `Mission.projectId` aggiornato nella stessa
   transazione; i run della missione ricevono il `projectId`.
6. Si prosegue con la preparazione normale: branch, worktree, poi il controllo di base,
   **saltato** se il branch base contiene solo il commit iniziale (non c'è niente da
   verificare). Entry che lo dice.

**Idempotenza**: ogni passo controlla se è già fatto (cartella, `.git`, remote, ref remoto,
`Project` con quel path), così la riconciliazione può riprendere da metà.

**Fallimento**: `waiting { baseline, step }` con Riprova. "Rivedi il piano" in questo caso
**non** cancella cartella e repository remoto: lo dice l'avviso nella UI.

### 8.4 Primi controlli

- Nella prima milestone (scaffolding) i comandi del piano possono non esistere ancora:
  - `red` di `task-tdd` non va usato (il prompt lo vieta e la validazione lo rifiuta per i
    progetti nuovi nella prima milestone, che deve essere `task-config` o `task-docs`);
  - la verifica di `task-config` esegue tutti i controlli definiti: lo scaffolding deve
    renderli verdi.
- A fine della prima milestone, la revisione (§5.4) controlla i comandi. Se l'orchestratore
  propone comandi diversi, è un cambio a `checks`, quindi serve l'utente (§5.5).

### 8.5 Frontend

- **`projects/ProjectsPage.tsx`**: pulsante "Nuovo progetto con missione". Il dialogo
  chiede:
  - nome, con il controllo che la cartella non esista (`GET /projects/folder-available?name=`);
  - forge, tra quelli con token nel vault (`GET /vault/forges`: solo i nomi, mai i valori);
  - namespace;
  - visibilità;
  - richiesta, allegati, orchestratore e modalità.
- **Le missioni senza progetto** compaiono in Attività e in una sezione "Progetti in
  preparazione" della pagina Progetti. Il progetto vero compare dopo l'approvazione.
- **Vista Preparazione**: i passi in più della §8.3.

### 8.6 Test

- `new-project`: nome non valido, cartella esistente, forge senza token.
- Briefing con `projectId` null: `cwd` nella cartella del briefing, risorse di default,
  sessioni non elencate in nessuna chat.
- `Run.projectId` null: limiti e liste dei run.
- Creazione (forge finto, remote bare locale):
  - percorso completo;
  - ripresa dopo un fallimento a metà, per ogni passo;
  - repository remoto già esistente e non vuoto: errore;
  - controllo di base saltato.
- Validazione: prima milestone con `task-tdd` rifiutata per i progetti nuovi.
- Abbandono: cartella del briefing cancellata; pulizia dopo 7 giorni.
- Frontend: dialogo, controllo del nome, "Progetti in preparazione".

### 8.7 Da riportare in modalita-autonoma.md

- §4.1: `projectId` nullable, `newProjectJson`.
- §4.4: `Run.projectId` nullable per i turni del briefing di un progetto nuovo.
- §10.3: passi idempotenti nella preparazione e controllo di base saltato sul commit
  iniziale.
- §12: `/missions/new-project` e le rotte di supporto.

---

## Riepilogo: ordine e dipendenze

| Fase | Dipende da | Contenuto principale | Dimensione |
|---|---|---|---|
| 0 | — | 5 debiti, di cui 0.1 sulla sicurezza | piccola |
| 4 | 0 | `BudgetGuard`, `paused`, quota settimanale, evento `tokens` | media |
| 5 | 4 | scheduler `auto`, `mission-checks`, `mission-integrate`, revisione delle milestone, `update_plan`, perimetro con `scope` | grande |
| 6 | 5 (`mission-checks`, turno `final`) | `ForgeService`, push sicuro, `mission-publish`, PR | media |
| 7 | 4-6 per i contenuti, ma si può iniziare dopo la 5 | stream dell'utente, notifiche, non letti, Attività | piccola-media |
| 8 | 6 (`ForgeService`), 5 (revisione delle milestone) | progetti nuovi, `projectId` nullable | media |

Ogni fase è un commit (o più commit) su `feature/missioni`, con il messaggio nello stile dei
precedenti e gli aggiornamenti a `modalita-autonoma.md` nella stessa serie.
