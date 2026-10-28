# Modalità autonoma: le missioni

Documento di progetto: dare ad algo-agent un modo per costruire una feature, o un progetto
intero, partendo da un obiettivo. L'utente descrive cosa vuole, un orchestratore Claude lo
intervista e propone un piano con un team di agenti, e dopo l'approvazione il sistema crea i
task, li esegue con TDD, li verifica e apre una PR. Si appoggia a
[esecuzione-in-background.md](esecuzione-in-background.md) (coda, executor, ripresa) e a
[workflow-a-grafo.md](workflow-a-grafo.md) (passi, verdetti, `repeat`, approvazioni).

## 1. Perché un terzo modo

| | Delega in chat | Workflow | Missione |
|---|---|---|---|
| Chi decide i passi | Il modello, a ogni turno | L'utente, una volta, nello YAML | L'orchestratore, nel piano approvato dall'utente |
| Passi | Nascono nella conversazione | Fissi, al massimo 10 | Task generati dal piano, rivisti a ogni milestone |
| Dove scrive | Nella cartella del progetto | Nella cartella del progetto | Su un branch suo, un worktree per task, poi PR |
| Verifica | Quella che chiede l'utente | Quella scritta nel workflow | Sempre: test prima, controlli automatici, review |
| Supervisione | Continua | Approvazioni dichiarate | Passo-passo o automatica, con budget |

Le missioni non sostituiscono gli altri due modi: li usano. Ogni task gira come un run a grafo
dell'executor esistente (§6), e il briefing iniziale è una conversazione di chat (§4).

## 2. Decisioni prese

Fissate con l'utente prima di scrivere questo documento:

1. **Orchestratore**: sempre Claude, Sonnet o Opus. Può far lavorare agenti su altri modelli,
   anche tramite OpenCode, scelti nel piano.
2. **Briefing**: l'orchestratore esplora il progetto e intervista l'utente con una domanda alla
   volta. L'utente può allegare documenti. Il piano si rivede finché l'utente non lo approva.
3. **Team**: si definisce nel briefing, come parte del piano: ruoli base e agenti specializzati,
   con modello e permessi. Durante l'esecuzione non cambia.
4. **Modalità**:
   - *passo-passo*: a ogni task chiusa la missione si ferma e aspetta l'utente;
   - *automatica*: arriva fino alla PR. Si fermano solo task bloccate, budget e cambi fuori
     perimetro.

   Si può passare dall'una all'altra durante la missione.
5. **Budget**: è la sessione del piano Claude.
   - Sotto il 10% rimanente della finestra di 5 ore: pausa e ripresa automatica al reset.
   - Al 30% della finestra settimanale consumato dalla missione: stop finché l'utente non dà
     l'ok.
6. **Codice**: un branch per missione, un worktree per task, un integratore che unisce i task.
   Alla fine una PR verso il branch base, su GitHub o GitLab secondo il remote. Mai merge
   diretto.
7. **Task chiusa**: ogni task segue un modello di task, un workflow del catalogo con un
   contratto (§6). Il default `task-tdd` significa:
   - il tester ha scritto prima i test;
   - l'implementatore li fa passare;
   - build, lint e test eseguiti dal sistema sono verdi;
   - un altro agente ha fatto la review;
   - il tutto in al massimo 3 tentativi. Altrimenti la task è bloccata.
8. **Dubbi in automatico**: l'orchestratore sceglie l'opzione più prudente e registra la
   decisione, che finisce nella PR.
9. **Passo-passo**: per ogni task le azioni sono Ok, Rifai con nota, Rivedi il piano e Passa ad
   automatico.
10. **Notifiche**: solo in-app, nella sezione Attività e con le notifiche locali del sistema.
11. **Progetti nuovi**: algo-agent crea cartella, repository locale e remoto e progetto.
12. **Concorrenza**: nessun limite al numero di missioni, anche sullo stesso progetto.
13. **Dove si inizia**:
    - la scheda Missioni del progetto;
    - "Nuovo progetto con missione" nella pagina Progetti;
    - "Trasforma in missione" dalla chat (§13.1).
14. **Vista dal vivo**:
    - la sezione Attività per tutte le missioni;
    - la pagina della missione con i task in elenco per milestone;
    - il dettaglio del task con gli agenti in diretta (§13.3).

## 3. Concetti

- **Missione**: un obiettivo con il suo piano, il suo team, il suo branch e il suo budget.
- **Piano**: un documento strutturato (JSON validato, §5) che contiene:
  - obiettivo e perimetro;
  - comandi di controllo;
  - team;
  - milestone e task;
  - criteri di accettazione.

  Ha una versione: ogni revisione la incrementa.
- **Milestone**: un gruppo di task. Alla fine di ogni milestone l'orchestratore verifica il
  risultato e può rivedere le milestone successive (§7.3). Divide il lavoro in tappe in cui
  l'orchestratore ragiona, così non deve restare attivo per tutta la missione.
- **Task**: un'unità di lavoro con criteri di accettazione verificabili. Può dipendere da altri
  task (`needs`). Gira come un run di un **modello di task**, cioè un workflow del catalogo con
  un contratto che garantisce la verifica (§6).
- **Orchestratore**: una sessione Claude chiamata solo nei punti di decisione: briefing, fine
  milestone, task bloccata, revisione del piano, PR. Non resta in un ciclo continuo, perché
  costerebbe e sarebbe difficile da riprendere.
- **Registro**: tutto ciò che è successo nella missione, cioè decisioni, attese, riprese, note
  dell'utente e notifiche (§4.3).

## 4. Modello dati

### 4.1 `Mission` (nuova)

| Campo | Tipo | Note |
|---|---|---|
| `id` | Int | |
| `projectId`, `userId` | Int | Il progetto esiste già, o viene creato all'approvazione per un progetto nuovo (§10). |
| `title` | String | Dal piano; prima dell'approvazione è l'inizio dell'input. |
| `status` | String | Vedi §7.1. |
| `mode` | String | `step` o `auto`. |
| `input` | String | La richiesta iniziale. |
| `planJson` | String? | Ultimo piano proposto o approvato (§5). |
| `planVersion` | Int | 0 finché non c'è un piano. |
| `approvedVersion` | Int? | Versione approvata in esecuzione. |
| `orchestratorModel` | String | `claude:opus` o `claude:sonnet`. |
| `sessionId` | String? | Sessione Claude dell'orchestratore, ripresa a ogni punto di decisione. |
| `baseBranch` | String | Destinazione della PR; di default `develop` se esiste, altrimenti il branch di default del remote. |
| `branch` | String? | `mission/<id>-<slug>`, creato all'approvazione. |
| `worktreePath` | String? | Worktree del branch della missione, dove l'integratore unisce i task. |
| `prUrl` | String? | |
| `waitJson` | String? | Perché la missione aspetta: `{ code, taskId?, until?, detail }` (§7.2). |
| `budgetJson` | String | Soglie e consumo (§9). |
| `costUsd` | Float | Somma dei costi di orchestratore e task. |
| `createdAt`, `approvedAt`, `finishedAt`, `seenAt` | DateTime? | `seenAt` come per i run: serve per i non letti. |

### 4.2 `MissionTask` (nuova)

| Campo | Tipo | Note |
|---|---|---|
| `id` | Int | |
| `missionId` | Int | |
| `key` | String | Id del task nel piano, unico nella missione. |
| `milestone` | String | Id della milestone. |
| `status` | String | `pending`, `running`, `review`, `blocked`, `done`, `skipped`, `failed`, `aborted`. |
| `branch`, `worktreePath` | String? | `mission/<id>/<key>`, creati quando il task parte. |
| `runId` | Int? | Run in corso o ultimo run. |
| `attempts` | Int | Volte in cui il task è stato rifatto con una nota dell'utente o dopo un blocco. |
| `notesJson` | String | Note dell'utente da "Rifai con nota", in ordine. |
| `reportJson` | String? | Riepilogo per l'utente e per l'orchestratore: diff (file e righe), esito dei controlli, verdetto e testo della review, iterazioni, costo. |
| `startedAt`, `finishedAt` | DateTime? | |

Le dipendenze e i criteri restano nel piano: il task ne tiene solo lo stato.

### 4.3 `MissionEntry` (nuova)

Registro della missione, in sola aggiunta.

| Campo | Tipo | Note |
|---|---|---|
| `missionId`, `taskId?` | Int | |
| `kind` | String | `status` (cambio di stato della missione o di un task), `decision`, `wait`, `resume`, `note`, `plan`, `budget`, `pr`, `error`. |
| `notify` | Boolean | Se genera una notifica (§11). |
| `dataJson` | String | Ad esempio, per una decisione: `{ question, options, chosen, reason }`. |
| `createdAt` | DateTime | |

### 4.4 `Run`

- Nuovi valori di `kind`:
  - `mission-task`: il grafo di un task (§6);
  - `mission-orchestrator`: un turno dell'orchestratore.
- Nuovi campi `missionId` e `missionTaskId`, facoltativi, con indice.

Il briefing usa run di tipo `mission-orchestrator` con la stessa logica della chat (allegati,
`sessionId`). Così riaggancio, stop e sezione Attività funzionano senza codice nuovo.

## 5. Il piano

Il piano è prodotto dall'orchestratore con il tool `propose_plan` (§8). Il backend lo valida con
zod e lo mostra all'utente come pagina strutturata, non come testo libero.

```yaml
title: Login con OAuth Google
goal: Gli utenti possono entrare con Google oltre che con email e password.
baseBranch: develop
scope:
  dependencies: [passport-google-oauth20]   # dipendenze che i task possono aggiungere
  migrations: true                          # i task possono creare migrazioni Prisma
  paths: [backend/src/auth, frontend/src/auth, backend/prisma]
checks:
  setup: npm ci                 # eseguito una volta per worktree
  build: npm run build
  lint: npm run lint
  test: npm test
  parallel: false               # i controlli non possono girare in parallelo (porte, DB di sviluppo)
  workdir: backend              # facoltativo; ogni comando può avere il suo
team:
  orchestrator: claude:opus
  roles:
    tester: { agent: tester, model: claude:sonnet }
    implementer: { agent: implementer, model: claude:sonnet }
    reviewer: { agent: reviewer, model: opencode:openai/gpt-5 }
    integrator: { agent: integrator, model: claude:sonnet }
  custom:
    - key: prisma-expert
      description: Conosce Prisma 7 e SQLite
      model: claude:sonnet
      permissions: { files: write, skills: [] }
      prompt: |
        ...
budget:
  fiveHourMinRemaining: 0.10
  weeklyMaxShare: 0.30
parallelTasks: 3
milestones:
  - id: backend
    title: Backend OAuth
    tasks:
      - key: oauth-strategy
        title: Strategia Google e callback
        template: task-tdd           # modello di task (§6), default task-tdd
        agents: { implementer: prisma-expert }   # facoltativo: un agente custom al posto di un ruolo
        needs: []
        acceptance:
          - GET /api/auth/google reindirizza a Google con lo state firmato
          - il callback crea l'utente se non esiste e restituisce il JWT
      - key: link-account
        needs: [oauth-strategy]
        ...
  - id: frontend
    ...
```

Regole di validazione:
- chiavi uniche, `needs` aciclici e solo verso task della stessa milestone o di milestone
  precedenti;
- ogni task ha almeno un criterio di accettazione;
- `integrator` è sempre obbligatorio; gli altri ruoli lo sono se un modello di task usato nel
  piano li richiede (`role:<ruolo>`);
- `template` è un modello di task valido (§6.2) e abilitato nel progetto;
- il modello di ogni agente deve essere disponibile tra i provider connessi;
- in ogni task, l'agente che giudica `result` è diverso da quelli che scrivono, anche dopo le
  sostituzioni di `agents`;
- `checks.test` è obbligatorio.

**I comandi sono nel piano, non negli agenti.** Oggi gli agenti non hanno shell, ed è una scelta
di sicurezza (`policy.ts`: un comando non si può confinare in una cartella). Restano senza
shell. I comandi del piano li approva l'utente e li esegue il backend (§8.2). Per un progetto
nuovo, i comandi della prima milestone (scaffolding) si confermano nella revisione di fine
milestone (§7.3).

## 6. Il task come run a grafo

Ogni task gira come un run `mission-task` dell'executor dei workflow: la coda, gli eventi, la
ripresa dopo un riavvio, i verdetti e il `repeat` ci sono già. Il grafo viene da un **modello
di task**: un workflow del catalogo che rispetta un contratto (§6.2). Il piano sceglie il modello
per ogni task (`template`, default `task-tdd`) e l'utente lo vede in approvazione.

### 6.1 Modelli inclusi

| Modello | Per cosa | Passi |
|---|---|---|
| `task-tdd` | Codice con comportamento verificabile. È il default. | `tests` (tester) → `red` (sistema) → `implement` (implementatore) ⟲ `verify` (sistema + reviewer) |
| `task-docs` | Documentazione, README, commenti. | `write` (implementatore) ⟲ `verify` (`build` e `lint` se definiti, poi reviewer) |
| `task-config` | CI, configurazione, script di build, dipendenze. | `change` (implementatore) ⟲ `verify` (tutti i controlli, poi reviewer) |

Esempio, `catalog/workflows/task-tdd.yaml`:

```yaml
description: Test prima, poi implementazione, controlli e review.
task: true
steps:
  - id: tests
    agent: role:tester
    prompt: |
      Write tests for this task. Don't touch application code.
      {{task}}
  - id: red
    run: [test]
    expect: fail          # i test nuovi devono fallire; se passano è un avviso, non un errore
  - id: implement
    agent: role:implementer
    protect: [tests]      # non può modificare i file scritti dal passo tests
    prompt: |
      Make these tests pass: {{steps.tests}}
      {{task}}
      Last verification: {{steps.verify}}
    repeat: { with: verify, until: ok, max: 3, onMax: fail }
  - id: verify
    run: [build, lint, test]
    agent: role:reviewer
    verdict: [ok, problemi]
    prompt: |
      Check the diff against the acceptance criteria.
      {{task}}
result: verify
```

### 6.2 Contratto di un modello di task

Un workflow con `task: true` è un modello di task. Rispetto a un workflow normale:

- **Variabili.**
  - `{{task}}` contiene il titolo, i criteri di accettazione, le note dell'utente da "Rifai con
    nota" e i report dei task da cui dipende.
  - `{{input}}` non c'è: un modello di task si avvia solo da una missione.
- **Ruoli invece di agenti.** `agent: role:<ruolo>` si risolve con il team del piano
  (`team.roles`), oppure con un agente custom se il task lo indica. Lo stesso modello funziona
  quindi con team diversi.
- **Passi di sistema.**
  - `run: [build, lint, test]` esegue i comandi del piano con `ChecksService` (§8.2).
  - `expect: pass` (default) dà `problemi` al primo comando che fallisce; `expect: fail` è
    per i test rossi.
  - Un passo con `run` e `agent` è una **verifica composta**: prima i comandi, poi, solo se
    passano, l'agente. Nel report i due esiti si vedono separati.
- **`protect`.** Elenca i passi i cui file questo passo non può modificare. Il controllo è sul
  diff, prima della verifica: se viene violato, il verdetto è `problemi` senza chiamare
  l'agente.
- **`result`.** Indica il passo il cui verdetto chiude il task: `ok` vuol dire task
  verificato.

Regole di validazione, in aggiunta a quelle del §5 di
[workflow-a-grafo.md](workflow-a-grafo.md):

1. `result` è un passo con `verdict` che contiene `ok`, e non ha successori.
2. `result` è una verifica composta: esegue almeno un comando ed è giudicata da un agente.
3. Ogni passo con un agente in scrittura è antenato di `result`, o è nel suo `repeat`. Nessuna
   scrittura può avvenire dopo la verifica.
4. L'agente di `result` ha un ruolo diverso da quello di ogni passo in scrittura: chi scrive
   non si giudica da solo.
5. `repeat` al massimo 3: è il limite di tentativi della decisione 7.

Queste regole garantiscono la decisione 7 per qualsiasi modello: un task chiuso è sempre
verificato dai comandi e da un altro agente. Un workflow del catalogo senza `task: true` non
può essere usato come modello. Si può copiare e adattare, e la validazione dice cosa manca.

Le estensioni dell'executor (`run`, verifica composta, `protect`, ruoli) valgono solo nei
modelli di task. `run` e `protect` potranno passare ai workflow normali in un secondo momento,
dopo aver deciso da dove prendono i comandi: oggi un workflow non ha un piano.

### 6.3 Esiti

- **`result` ok**:
  1. il backend fa il commit sul branch del task;
  2. controlla il perimetro (§7.4);
  3. a seconda della modalità, unisce il task subito o chiede l'ok (§7.2).
- **Tentativi esauriti** (`onMax: fail`): il task è `blocked`. Le task che non dipendono da lui
  vanno avanti.
- **Implementatore in disaccordo con i test** (ad esempio un test sbagliato): lo dice nella sua
  risposta. Se il reviewer gli dà ragione, il task finisce bloccato con il motivo, pronto per
  l'utente o per l'orchestratore.

## 7. Ciclo di vita

### 7.1 Stati della missione

```
briefing ──(propose_plan)──▶ planned ──(approva)──▶ running ──▶ integrating ──▶ done (PR aperta)
   ▲                            │                      │  ▲
   └────(commenti al piano)─────┘                      ▼  │
                                                   waiting ┘   paused (5 ore)  ──(reset)──▶ running
                                                      │
                                                      └──▶ aborted / failed
```

| Stato | Significato |
|---|---|
| `briefing` | Intervista in corso: l'utente e l'orchestratore si scambiano messaggi. |
| `planned` | C'è un piano proposto che aspetta l'approvazione. Un commento riporta la missione in `briefing`. |
| `running` | Task in corso o pronti. |
| `waiting` | Serve l'utente; il motivo è in `waitJson` (§7.2). I task già in corso finiscono. |
| `paused` | Finestra delle 5 ore sotto soglia; riparte da sola dopo `until` (§9). |
| `integrating` | Tutti i task sono chiusi: verifica finale, push e PR (§10). |
| `done` | PR aperta. |
| `failed`, `aborted` | Errore non recuperabile oppure stop dell'utente. Branch e worktree restano finché l'utente non li cancella. |

### 7.2 Motivi di attesa

| `code` | Quando | Azioni dell'utente |
|---|---|---|
| `task_review` | Passo-passo: un task ha superato la verifica. | Ok · Rifai con nota · Rivedi il piano · Passa ad automatico |
| `task_blocked` | Un task ha esaurito i tentativi. | Rifai con nota · Salta il task · Rivedi il piano |
| `scope` | Il diff di un task esce dal perimetro (§7.4). | Accetta (il perimetro si allarga e la decisione si registra) · Rifai con nota · Rivedi il piano |
| `weekly_budget` | La missione ha consumato la sua quota settimanale (§9). | Continua (concede un'altra quota) · Passa a passo-passo · Ferma |
| `milestone` | Solo se la revisione di fine milestone propone cambi che richiedono l'utente (§7.3). | Approva il piano rivisto · Commenta |

- **Passo-passo**: i task girano uno alla volta. Quando uno si chiude, non ne parte un altro
  finché l'utente non risponde. Fino all'Ok il task resta sul suo branch e non viene unito,
  così "Rifai con nota" riparte dallo stesso branch senza annullare niente.
- **Automatica**: fino a `parallelTasks` task in parallelo. Un `task_blocked` o uno `scope`
  ferma solo i task che dipendono da quello, gli altri continuano. La missione è `waiting`
  solo quando non resta niente da eseguire senza l'utente.
- **Passa ad automatico / a passo-passo**: cambia `mode`. Il passaggio a passo-passo vale dal
  prossimo task che si chiude; i task già in corso finiscono.
- **Rifai con nota**: aggiunge la nota a `notesJson` e crea un nuovo run del task. Ripartono
  da capo tutti i passi, tester compreso, perché la nota può cambiare i test.

### 7.3 Fine milestone

Quando tutti i task di una milestone sono `done` o `skipped`, l'orchestratore viene chiamato
con i report dei task e l'esito dei controlli sul branch della missione. Può fare tre cose:

- **confermare**: si passa alla milestone successiva;
- **rivedere le milestone successive** con `update_plan`: aggiungere, togliere o riordinare
  task, cambiare criteri. In automatico lo fa da solo e registra la decisione, se resta nel
  perimetro e nel team approvati. Altrimenti la missione va in `waiting` con il motivo
  `milestone`;
- **aggiungere un task correttivo** alla milestone appena chiusa, se i controlli sul branch
  unito falliscono. È il caso tipico: due task verdi da soli che insieme rompono qualcosa.

### 7.4 Perimetro

Prima di unire un task, il backend confronta il diff con `scope`. Il controllo è
deterministico, senza agenti:

- dipendenze aggiunte in `package.json` (o nei file equivalenti) che non sono in
  `scope.dependencies`;
- nuove migrazioni con `migrations: false`;
- file cancellati, o file fuori da `scope.paths` se l'elenco è definito.

Se il controllo fallisce, l'attesa è `scope` sia in passo-passo sia in automatico. È il "cambio
fuori perimetro" della decisione 8.

## 8. Backend

### 8.1 Nuovi componenti

| Componente | Responsabilità |
|---|---|
| `MissionsModule` | Raggruppa i servizi qui sotto. |
| `MissionsService` | Creazione, briefing, approvazione, azioni dell'utente, cambi di stato. Ogni cambio è un update condizionato sullo stato atteso, come per i run. |
| `MissionScheduler` | A ogni evento rilevante (task finito, approvazione, ripresa, timer di sicurezza) decide quali task far partire: dipendenze soddisfatte, modalità, `parallelTasks`, budget. Crea i run `mission-task`. |
| `TaskGraphFactory` | Dal modello di task, dal task e dal team costruisce il grafo del run (§6): risolve i ruoli e compila `{{task}}`. |
| `GitService` | Branch, worktree, commit, merge, push. Usa `git` con argomenti in array, mai una stringa di shell. |
| `ChecksService` | Esegue i comandi del piano in un worktree (§8.2). |
| `BudgetGuard` | Legge l'uso del piano e decide pause e attese (§9). |
| `ForgeService` | Crea repository e PR su GitHub o GitLab (§10). |
| `MissionTools` | I tool dell'orchestratore e quelli dei task, serviti dal server MCP `app` (§8.3). |

### 8.2 Controlli

- I comandi vengono solo dal piano approvato: non li sceglie un agente durante l'esecuzione.
  Partono con `spawn` (`shell: false`), con il comando diviso in argomenti, `cwd` dentro il
  worktree e un timeout (`MISSION_CHECK_TIMEOUT_MS`, default 10 minuti).
- L'ambiente è minimo: `PATH`, `HOME` e `CI=1`. Le variabili del backend e i segreti non
  passano, a meno che il piano non nomini segreti del vault da esporre.
- L'output viene tagliato agli ultimi N KB per comando, che sono la parte utile nei fallimenti.
- `checks.setup` gira una volta per worktree, prima del primo controllo.
- `checks.parallel: false` attiva un lock per progetto: i controlli di due task dello stesso
  progetto, anche di missioni diverse, non girano insieme. Serve quando i test usano porte fisse
  o un database di sviluppo condiviso.
- Agli agenti del task è disponibile il tool `run_checks`. Esegue solo i comandi del piano,
  scelti per nome (`test`, `lint`, `build`), con un filtro facoltativo passato a `test` se il
  piano lo dichiara (`testFilter: "-- {{pattern}}"`). Serve al tester per vedere i test rossi e
  all'implementatore per iterare senza aspettare la verifica.

### 8.3 Tool della missione

| Tool | Chi | Cosa fa |
|---|---|---|
| `ask_user` | Orchestratore, solo nel briefing | Fa una domanda, con opzioni facoltative; il turno finisce e la risposta arriva come messaggio successivo. |
| `propose_plan` | Orchestratore | Salva un piano validato (§5) e porta la missione in `planned`. Gli errori di validazione tornano all'orchestratore, che corregge. |
| `update_plan` | Orchestratore, fine milestone o "Rivedi il piano" | Modifica le milestone non ancora iniziate; incrementa `planVersion`. |
| `record_decision` | Orchestratore | Registra domanda, opzioni, scelta e motivo nel registro e nella PR. |
| `task_report` | Orchestratore | Legge il report di un task. |
| `run_checks` | Agenti dei task | §8.2. |

L'orchestratore legge i file del progetto (`files: read`) ma non scrive. Nel briefing lavora
sulla cartella del progetto, durante l'esecuzione sul worktree della missione.

### 8.4 Git

- **Approvazione**:
  - `git fetch`;
  - branch `mission/<id>-<slug>` da `origin/<baseBranch>`;
  - worktree della missione in `DATA_DIR/worktrees/<projectId>/<missionId>/main`.
- **Partenza di un task**: branch `mission/<id>/<key>` dalla punta attuale del branch della
  missione e worktree in `.../<missionId>/<key>`. Il `cwd` degli agenti è il worktree: la
  confinazione di `pathViolation` resta la stessa.
- **Chiusura di un task**: commit con messaggio dal titolo del task e trailer
  `Mission: <id>`, `Task: <key>`.
- **Unione**: `git merge --no-ff` nel worktree della missione.
  - In caso di conflitto, il backend lascia i file in conflitto e chiama l'**integratore** con i
    due diff e i criteri dei task coinvolti. Poi rifà i controlli completi.
  - Se l'integratore non riesce, o i controlli falliscono, il merge si annulla
    (`git merge --abort`) e il task torna `blocked` con il motivo.
- **Unione e parallelismo**: i merge nella missione sono serializzati (un lock per missione).
  I task in parallelo partono da punte diverse; i conflitti si risolvono al merge.
- **Pulizia**: a missione `done` i worktree dei task si cancellano, i branch dei task restano
  in locale fino alla cancellazione della missione. Il branch della missione viene pubblicato
  con il push.
- I worktree sono fuori dalla cartella del progetto, quindi l'IDE e `git status` dell'utente non
  li vedono. `git worktree list` sì.

### 8.5 Concorrenza con gli altri run

I run `mission-task` hanno un limite loro (`MISSIONS_MAX_RUNNING_TASKS`, default 6). Non contano
per `RUNS_MAX_WORKFLOWS_PER_USER` né per `RUNS_MAX_WRITERS_PER_PROJECT`: scrivono nei worktree,
non nella cartella del progetto. Restano soggetti a `RUNS_MAX_CONCURRENT`, che conviene alzare
quando si usano le missioni. Il numero di missioni non ha limiti (decisione 12).

## 9. Budget

### 9.1 Da dove vengono i numeri

Il provider Claude salva già l'ultimo `rate_limit_event` in `ProviderConnection.stateJson`
(`rateLimits`, `src/claude/rate-limit.ts`). Contiene la percentuale usata e il reset di ogni
finestra: `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`.

- Ogni sessione Claude aggiorna il dato. Mentre ci sono missioni attive, `BudgetGuard` lo
  considera vecchio dopo 5 minuti e lo aggiorna con la richiesta `/usage` dell'SDK, che è
  sperimentale; se fallisce, usa l'ultimo dato con l'avviso "dato di X minuti fa".
- Senza abbonamento (API key) i dati non ci sono: la missione mostra un avviso e usa solo un
  tetto in dollari, facoltativo nel piano (`budget.maxUsd`).
- Gli agenti su OpenCode con modelli non Claude non consumano la sessione Claude: il loro costo
  si vede, ma non conta per le soglie.

### 9.2 Finestra di 5 ore: pausa automatica

- Prima di far partire un task **e prima di ogni passo** di un task, lo scheduler controlla che
  resti più di `fiveHourMinRemaining` (10%). La finestra è dell'account, quindi la soglia vale
  per tutte le missioni insieme.
- Sotto soglia, non partono né task né passi nuovi. Le sessioni in corso finiscono. I run dei
  task si fermano in `waiting` con il motivo `budget`, come per un'approvazione. Le missioni
  vanno in `paused` con `until = resetsAt`, ricevi una notifica e viene scritta una riga nel
  registro.
- Dopo `until` lo scheduler riprende il dato. Se la finestra è sotto soglia, le missioni
  tornano `running` e i run ripartono dal passo successivo. Non serve nessuna azione.
- Anche il briefing e l'orchestratore rispettano la soglia: un turno dell'orchestratore aspetta
  il reset come un task.

### 9.3 Finestra settimanale: quota per missione

La finestra settimanale è condivisa, mentre la soglia è per missione. Per questo serve
attribuire a ogni missione la sua parte:

1. a ogni aggiornamento del dato, `BudgetGuard` calcola quanto è cresciuta la finestra
   settimanale dall'aggiornamento precedente;
2. divide la crescita tra le sessioni Claude finite nell'intervallo, in proporzione al loro
   `costUsd`, che l'SDK riporta anche con l'abbonamento;
3. la parte delle sessioni di una missione si somma in `budgetJson.weeklyUsed`. Il resto
   (chat, workflow, uso di Claude Code fuori da algo-agent) non conta per nessuna missione.

Quando `weeklyUsed` raggiunge `weeklyMaxShare` (30% della settimana), la missione va in
`waiting` con il motivo `weekly_budget`. "Continua" concede un'altra quota uguale. Se la finestra
settimanale si azzera durante la missione, il conteggio continua: la quota è della missione, non
della settimana.

È una stima, ed è dichiarata come tale nell'interfaccia. Il dato più affidabile, la percentuale
della finestra, è sempre visibile accanto.

### 9.4 Cosa vede l'utente

Nella pagina della missione e nella sezione Attività compaiono:
- la barra delle 5 ore, con la soglia e il reset;
- la barra della settimana, con la quota della missione;
- il costo in dollari, solo informativo.

Nel piano compaiono la stima delle sessioni di agente nel caso peggiore (come le "esecuzioni
massime" dei workflow) e le soglie, modificabili prima dell'approvazione.

## 10. Repository, PR e progetti nuovi

### 10.1 Credenziali

- I token stanno nel vault come segreti dell'utente: `GITHUB_TOKEN`, `GITLAB_TOKEN` e
  `GITLAB_URL` per le istanze self-hosted. Un progetto può avere i suoi, che prevalgono, come
  per gli MCP.
- Li usa solo il backend (`ForgeService`, `GitService` per il push via HTTPS con header di
  autorizzazione). Gli agenti non li vedono mai.
- Il forge si riconosce dall'URL del remote `origin`: `github.com`, l'host di `GITLAB_URL`
  oppure `gitlab.com`.

### 10.2 PR finale

Quando tutti i task sono chiusi, la missione è `integrating`:

1. esegue i controlli completi sul branch della missione. Se falliscono, chiama l'orchestratore
   come a fine milestone (task correttivo);
2. fa il push del branch;
3. apre una PR (GitHub) o una MR (GitLab) verso `baseBranch`. Titolo dal piano; descrizione
   con:
   - obiettivo;
   - task con i criteri;
   - esito dei controlli;
   - **decisioni prese in automatico**;
   - task saltati;
   - consumo di sessione e costo;
4. la missione è `done` e ricevi una notifica con il link.

Sui progetti GitLab di Zafirus la MR fa partire la pipeline con il security gate: il suo esito
non è parte della missione, si segue su GitLab.

### 10.3 Progetto nuovo

Dal pulsante "Nuova missione" si sceglie "Progetto nuovo" e si indicano nome, forge,
namespace (utente o gruppo) e visibilità. Il repository non si crea subito:

- il **briefing** lavora su una cartella temporanea vuota, così una missione abbandonata non
  lascia repository orfani;
- all'**approvazione** del piano:
  1. si crea la cartella in `WORKSPACE_ROOT`;
  2. `git init`, con un commit iniziale vuoto sul branch base;
  3. si crea il repository remoto via API e si fa il push;
  4. si registra il `Project`.

  Poi la missione parte come le altre: la prima milestone è lo scaffolding.
- La PR finale va dal branch della missione al branch base, che contiene solo il commit
  iniziale.

## 11. Notifiche

Solo in-app (decisione 10). Le genera il registro: ogni `MissionEntry` con `notify: true`.

| Evento | Notifica |
|---|---|
| Piano pronto da approvare | sì |
| Task chiusa in passo-passo | sì |
| Task bloccata, fuori perimetro | sì |
| Pausa per le 5 ore e ripresa | sì, entrambe |
| Quota settimanale raggiunta | sì |
| Revisione del piano che richiede l'utente | sì |
| PR aperta, missione fallita | sì |
| Decisione presa in automatico | no, solo nel registro |

- **Sezione Attività**: le missioni hanno un gruppo loro in "Richiedono te" (le `waiting`, con
  il motivo) e in "In corso" (con la milestone, i task attivi, le barre del budget e l'ultima
  attività di ogni task attivo, ad esempio "implementer su csv-writer: usa Edit su
  `backend/src/export.ts`", presa dall'ultimo evento non testuale come per i run). Lo stream
  `GET /runs/active/events` si estende con gli eventi delle missioni.
- **Notifiche di sistema**: il frontend chiede il permesso al primo accesso alla sezione
  Missioni e, a ogni evento con `notify`, usa la Notification API del browser. Funziona con la
  scheda in secondo piano o con la finestra ridotta, purché una scheda di algo-agent sia
  aperta. Al clic si apre la missione nel punto giusto.
- **Con nessuna scheda aperta**: le notifiche si accumulano come non lette e compaiono
  all'apertura. Una notifica di sistema anche a browser chiuso richiede Web Push (passa dai
  server del browser) o una notifica nativa inviata dal backend. È tra i punti aperti (§14).

## 12. API

| Metodo | Percorso | Note |
|---|---|---|
| `POST` | `/projects/:projectId/missions` | `{ input, mode, orchestratorModel, attachments, fromSession? }`. Crea la missione in `briefing` e il primo turno. Con `fromSession` la conversazione di chat diventa l'inizio del briefing (§13.2). |
| `POST` | `/missions/new-project` | Come sopra, più `{ name, forge, namespace, visibility }`. |
| `GET` | `/missions?status=` | Missioni dell'utente. |
| `GET` | `/missions/:id` | Missione, piano, task, budget. |
| `GET` | `/missions/:id/entries` | Registro. |
| `GET` | `/missions/:id/events?after=` | SSE: cambi di stato della missione e dei task, nuove righe del registro, budget. Il cursore è l'id di `MissionEntry`; i cambi di stato sono a loro volta righe del registro, senza notifica. Il dettaglio dei task si segue sui loro run (`/runs/:id/events`). |
| `POST` | `/missions/:id/messages` | Risposta nel briefing o in "Rivedi il piano", con allegati. Crea un run `mission-orchestrator`. |
| `POST` | `/missions/:id/approve` | `{ planVersion }`: 409 se nel frattempo è arrivata una versione nuova. |
| `POST` | `/missions/:id/tasks/:key/ok` | |
| `POST` | `/missions/:id/tasks/:key/redo` | `{ note }` |
| `POST` | `/missions/:id/tasks/:key/skip` | Solo per i task `blocked`; i task che dipendono da lui partono con l'avviso, come i passi saltati. |
| `POST` | `/missions/:id/scope/accept` | Allarga il perimetro e registra la decisione. |
| `POST` | `/missions/:id/continue` | Dopo `weekly_budget`. |
| `POST` | `/missions/:id/mode` | `{ mode }` |
| `POST` | `/missions/:id/abort` | Ferma i run in corso; branch e worktree restano. |
| `DELETE` | `/missions/:id` | Solo missioni finite: cancella worktree e branch locali dei task. |

Ogni azione controlla `waitJson.code` e lo stato, e risponde 409 se la missione non è più nello
stato atteso: due schede aperte non devono poter approvare due volte.

## 13. Frontend

### 13.1 Dove si inizia una missione

| Punto d'ingresso | Per cosa |
|---|---|
| Scheda **Missioni** del progetto, tra Chat e Workflow (`ProjectWorkspace.tsx`) | Feature su un progetto esistente. In alto il riquadro "Nuova missione": richiesta, allegati, orchestratore (Opus o Sonnet), modalità e il pulsante Inizia. Sotto, l'elenco delle missioni del progetto con stato, task chiusi su totali e budget. |
| Pagina **Progetti** → "Nuovo progetto con missione" (`ProjectsPage.tsx`) | Progetto da zero (§10.3). Chiede nome, forge, namespace e visibilità, poi apre lo stesso briefing. Il progetto compare nell'elenco solo dopo l'approvazione del piano. |
| **Chat** → "Trasforma in missione" (`ChatPanel.tsx`) | Un'idea nata discutendo in chat. La conversazione diventa l'inizio del briefing (§13.2). |

La sezione **Attività** non serve per iniziare: è dove le missioni chiedono qualcosa ("Richiedono
te") e da dove ci si rientra.

### 13.2 Da una conversazione a una missione

- Il pulsante è nell'intestazione della conversazione e c'è solo se la conversazione è in un
  progetto e non ha un turno in corso.
- La missione nasce con `fromSession: "<provider>:<id>"`. Il backend legge la storia della
  conversazione dal provider, come fa già `GET /chat/sessions/:id`, e la passa all'orchestratore
  come trascrizione nel primo turno, insieme agli allegati della conversazione.
- La sessione della chat non si riprende: l'orchestratore ha un suo prompt e i suoi tool, e la
  conversazione può essere stata fatta con un altro agente o con OpenCode. La trascrizione è
  materiale di partenza, non istruzioni: l'orchestratore riassume ciò che ha capito e chiede
  solo ciò che manca.
- La conversazione resta com'è. Nel suo elenco compare un collegamento alla missione nata da
  lei.

### 13.3 Le viste della missione

1. **Briefing**: la chat esistente (`ChatPanel`, con gli allegati), con accanto il piano
   quando c'è. Le domande di `ask_user` con opzioni si mostrano come pulsanti, più una risposta
   libera.
2. **Piano**: milestone e task con criteri e dipendenze, team (agente, modello, permessi),
   comandi di controllo, perimetro, soglie del budget. Contiene il grafo dei task (il
   componente SVG di [workflow-a-grafo.md](workflow-a-grafo.md) §8.2, riusato) e i pulsanti
   Approva, Commenta e scelta della modalità.
3. **Missione in corso**:
   - in alto: modalità, azioni (cambio di modalità, Ferma), barre del budget e costo;
   - sotto: i task in un **elenco raggruppato per milestone**, non in un grafo, perché si legge
     anche con molti task e su schermi stretti. Ogni riga mostra stato, passo corrente,
     tentativo ("2/3") e l'ultima attività ("esegue test…", "tester scrive test…"). I task in
     attesa di dipendenze dicono quali ("aspetta: export-endpoint"). Il grafo resta nella
     vista Piano;
   - il motivo dell'attesa in evidenza, con le azioni del §7.2;
   - il registro (decisioni, milestone chiuse, pause) e il link alla PR.
4. **Task**: i passi del run, in diretta. Riusa la vista del run del workflow
   (`WorkflowsPanel.tsx`):
   - il testo dell'agente che scorre;
   - i tool usati uno per uno;
   - l'output dei passi di sistema;
   - le iterazioni precedenti del `repeat`, espandibili;
   - il diff del task.

   Nell'attesa `task_review` mostra Ok, Rifai con nota, Rivedi il piano e Passa ad
   automatico.

Tutte le viste si aggiornano dagli eventi dei run e si riagganciano dopo una disconnessione
(§5.3 di [esecuzione-in-background.md](esecuzione-in-background.md)). Gli eventi della missione
(cambi di stato, registro, budget) arrivano su `GET /missions/:id/events`, con lo stesso
meccanismo di `seq`.

## 14. Punti aperti

1. **Notifiche a browser chiuso**: Web Push con service worker (richiede che il backend
   raggiunga i server del browser) oppure notifica nativa di macOS dal backend in
   `PERSONAL_MODE`. Da decidere dopo la fase 7, vedendo quanto serve davvero.
2. **Dipendenze nei worktree**: `checks.setup` con `npm ci` per ogni worktree costa tempo e
   disco. Si potrà valutare una cache condivisa o il riuso di `node_modules` dal worktree della
   missione.
3. **`maxTurns`**: oggi il default è 20, poco per un implementatore. Il piano dovrà indicarlo
   per ruolo, con un default più alto per i task (es. 80).
4. **Attribuzione della quota settimanale** (§9.3): da verificare sul campo quanto la stima si
   discosta dal reale con più missioni in parallelo.
5. **Test end-to-end** nel browser: esclusi per ora (decisione 7); si possono aggiungere come
   comando `checks.e2e` senza cambiare il modello.

## 15. Test

- **Backend**:
  - validazione del piano: dipendenze, ruoli obbligatori, modelli disponibili, reviewer diverso
    dall'implementatore, comandi;
  - contratto dei modelli di task: ogni regola del §6.2, con un caso valido e uno che la viola;
  - `TaskGraphFactory`: ruoli risolti dal team e dagli `agents` del task, `{{task}}` con note e
    dipendenze;
  - passi di sistema: `red` con test già verdi (avviso), verifica composta che non chiama il
    reviewer se i controlli falliscono, `protect` violato;
  - i tre modelli inclusi passano la validazione;
  - scheduler: passo-passo un task alla volta, automatica con `parallelTasks`, blocco che ferma
    solo i dipendenti, cambio di modalità a metà;
  - perimetro: dipendenze, migrazioni, file cancellati e fuori percorso;
  - `GitService` su repository temporanei: worktree, commit, merge pulito, conflitto risolto,
    conflitto non risolto con `merge --abort`;
  - `ChecksService`: niente shell, timeout, output tagliato, lock con `parallel: false`,
    ambiente senza segreti;
  - budget: pausa sotto il 10% prima di un passo, ripresa al reset, attribuzione della quota
    settimanale con più missioni, attesa al 30% e nuova quota con "Continua", assenza di dati
    con API key;
  - azioni dell'utente con lo stato sbagliato (409), approvazione di una versione superata;
  - ripresa dopo un riavvio a metà task, a metà merge e in pausa;
  - `ForgeService` con API finte: repository e PR su GitHub e GitLab, host self-hosted.
- **Frontend**: azioni per ogni motivo di attesa, aggiornamento del grafo dagli eventi,
  notifiche (permesso negato, clic che apre la missione).

## 16. Piano di lavoro

1. **Missione, briefing e piano**: modello dati, `ask_user`, `propose_plan`, validazione,
   scheda Missioni, "Trasforma in missione" dalla chat, viste Briefing e Piano, approvazione.
   Ancora senza esecuzione: si verifica che i piani
   prodotti siano buoni prima di costruirci sopra.
2. **Git e controlli**: `GitService`, `ChecksService`, `run_checks`, worktree della missione e
   dei task.
3. **Task e passo-passo**: modelli di task (contratto, `task-tdd`, `task-docs`,
   `task-config`), passi di sistema, verifica composta e `protect` nell'executor,
   `TaskGraphFactory`, `MissionScheduler` con un task alla volta, attese `task_review` e
   `task_blocked`, vista Task, notifiche in-app di base. A questo punto una missione funziona
   dall'inizio alla fine in passo-passo, con il branch e senza PR.
4. **Budget**: `BudgetGuard`, pausa e ripresa per le 5 ore, quota settimanale, barre nelle
   viste. Va fatto prima della modalità automatica, che senza budget non deve esistere.
5. **Modalità automatica**: task in parallelo, integratore e conflitti, perimetro, fine
   milestone con `update_plan` e `record_decision`, cambio di modalità.
6. **PR**: `ForgeService` per GitHub e GitLab, fase `integrating`, descrizione con le
   decisioni.
7. **Notifiche e Attività**: gruppo Missioni, notifiche di sistema, non letti.
8. **Progetti nuovi**: creazione del repository all'approvazione, scaffolding come prima
   milestone.
