# Fase 2: git, sandbox e controlli

Dettaglio della fase 2 di [modalita-autonoma-piano.md](modalita-autonoma-piano.md). Riferimenti
§ a [modalita-autonoma.md](modalita-autonoma.md). Parte dal branch `feature/missioni-fase1`.

**Obiettivo**: dopo l'approvazione, il backend prepara la missione:
1. crea il branch e il worktree della missione;
2. esegue `setup` e i controlli in un sandbox;
3. se tutto passa, porta la missione in `running`; se fallisce, la mette in attesa `baseline`.

In questa fase nascono anche i servizi che la fase 3 userà per i task (`ScopeService`,
`run_checks`, `cwd` nel worktree), già testati ma non ancora collegati a un run.

**Fatto quando**:
- su algo-agent stesso, una missione approvata arriva in `running` con il branch
  `mission/<id>-<slug>` e il worktree in `DATA_DIR/worktrees/...`;
- con un test rotto sul branch base, la missione va in `waiting` (`baseline`), e "Riprova"
  riparte dopo la correzione;
- il sandbox nega la lettura di `~/.ssh`, la scrittura fuori dal worktree e la rete fuori da
  `setup`;
- i test della §10 sono verdi.

`running` in questa fase significa "pronta": nessun task parte fino alla fase 3. La UI lo
dice ("Pronta: i task partiranno con la fase 3").

## 0. Prima del codice: prova del sandbox

È il primo lavoro della fase. Senza questa prova non si scrive il profilo. Su questa macchina
`/usr/bin/sandbox-exec` c'è (macOS 27); `bwrap` non serve qui.

Si scrive a mano un profilo minimo (§3.3) e si esegue con `sandbox-exec -f` su due progetti:
algo-agent stesso e un progetto Node vuoto. Va verificato quanto segue.

| Prova | Atteso |
|---|---|
| `npm ci` con la rete aperta, `HOME` finta e `npm_config_cache` condiviso | passa |
| `npm ci --ignore-scripts`, poi `npm run build` | annotare cosa si rompe (Prisma, esbuild, binari nativi) |
| `npx prisma generate` e `prisma migrate deploy` su SQLite dentro il worktree | passa senza rete |
| `vitest run` con un test che apre un server su `localhost` | passa |
| un test che chiama `https://example.com` | fallisce per la rete |
| `cat ~/.ssh/known_hosts`, `cat ~/.claude.json`, lettura del DB in `DATA_DIR` | negata |
| scrittura in `~/x`, nella cartella del progetto originale e in un altro worktree | negata |
| `git status` e `git log` dentro il worktree, la cui `.git` punta al repository principale | passa |
| node installato via nvm (in `HOME`) | si avvia |

L'esito va in `docs/sandbox-prova.md`: comandi, risultati e profilo finale.

Se `--ignore-scripts` rompe i progetti comuni (Prisma, ad esempio, genera il client nel
`postinstall`), si decide lì. Proposta: tenere gli script, ma eseguire `setup` con la rete
aperta solo sui lockfile già presenti nel branch base. Le dipendenze nuove dei task passano
comunque dal controllo del perimetro (§3.5) prima di qualsiasi `setup`.

## 1. Decisioni

### 1.1 La preparazione è un run: nuovo kind `mission-prepare`

- `approve()` resta veloce: aggiorna la missione e accoda un run `mission-prepare`.
- Il lavoro (git, `setup`, controlli: fino a decine di minuti) gira nell'executor, che dà
  già coda, heartbeat, stop, eventi in diretta e chiusura dei run orfani al riavvio.
- In `limits.ts` il kind non ha un limite per utente e conta per `concurrent`, come
  `mission-orchestrator`. `writes: false`: scrive solo nel worktree.
- **Ripresa**: un `mission-prepare` interrotto da un riavvio o da un heartbeat scaduto finisce
  `interrupted`, come gli altri run. Una riconciliazione in `MissionsService` (all'avvio, dopo
  `RunRecoveryService`, e poi ogni 30 s) riaccoda la preparazione per le missioni in
  `approved` senza un `mission-prepare` attivo. La preparazione è idempotente (§2.3), quindi
  rifarla da capo è sicuro.
- Si scarta lo stato `approved` gestito con un heartbeat proprio: duplicherebbe l'executor.

### 1.2 Ciclo della missione in fase 2

```
planned ──(approva)──▶ approved ──(prepare ok)──▶ running
                          │  ▲
              (prepare ko)│  │(Riprova)
                          ▼  │
                        waiting {baseline}

approved / waiting{baseline} ──(Rivedi il piano: pulisce branch e worktree)──▶ briefing
ogni stato attivo ──(Ferma)──▶ aborted   (branch e worktree restano)
```

- `approved` = in preparazione. La missione lo resta anche durante i retry.
- `waitJson` per il fallimento:
  `{ code: 'baseline', runId, step: 'fetch'|'branch'|'worktree'|'setup'|'build'|'lint'|'test', detail }`.
- "Rivedi il piano" da `approved` (senza preparazione attiva) o da `waiting{baseline}`:
  cancella il worktree e il branch della missione, poi torna a `briefing`. Il branch non
  contiene ancora lavoro, quindi non si perde niente.
- Un'approvazione successiva rifà la preparazione da zero.

### 1.3 Campi nuovi del piano

In `plan-schema.ts`, dentro `checks`:

```yaml
checks:
  setup: npm ci
  test: npm test
  testFilter: "-- {{pattern}}"   # facoltativo: come passare un filtro a test (run_checks)
  secrets: [DATABASE_URL]         # facoltativo: segreti del vault esposti ai comandi
```

- **`testFilter`**: una stringa che deve contenere `{{pattern}}`. Viene divisa in argomenti
  (§1.4) e aggiunta in coda al comando `test`; `{{pattern}}` diventa un solo argomento.
  Il pattern di `run_checks` è validato con `^[A-Za-z0-9_./*:@-]{1,200}$`.
- **`secrets`**: nomi di segreti del vault (`VaultService.variables`, utente e progetto).
  - La validazione del piano controlla che esistano.
  - I valori entrano solo nell'ambiente dei comandi, mai nei log né negli eventi.
  - L'output dei comandi viene ripulito: ogni valore trovato diventa `***`.
  - Nel Piano si vedono solo i nomi.
- `checks.e2e` resta fuori (§14).

### 1.4 I comandi non sono shell

`spawn` con `shell: false` richiede un vettore di argomenti. Le stringhe del piano si dividono
con un tokenizer piccolo, in `backend/src/missions/command-line.ts`:
- spazi come separatori;
- virgolette `'…'` e `"…"`;
- `\` come escape dentro le doppie virgolette.

La validazione del piano **rifiuta** gli operatori di shell fuori dalle virgolette: `&&`,
`||`, `;`, `|`, `>`, `<`, `` ` ``, `$(`, `$VAR`, `*` non quotato e `~` iniziale. Il messaggio
di errore suggerisce di usare `workdir` al posto di `cd x && …`, e di mettere le sequenze in
uno script di `package.json`.

`orchestrator-prompt.ts` va aggiornato con questa regola, così l'orchestratore propone
comandi validi.

### 1.5 Sandbox: macOS ora, Linux dopo

- Un'interfaccia `Sandbox` con un'implementazione `MacSandbox` (`sandbox-exec`), che genera
  il profilo per ogni esecuzione.
- Su Linux, o senza `sandbox-exec`, `available()` è `false` e le missioni **non si
  approvano**: 409 "Le missioni richiedono il sandbox, non disponibile su questo sistema".
  Non c'è fallback senza isolamento (§8.2). `bwrap` va nei punti aperti.
- **Autotest** all'avvio e prima di ogni `approve` (con cache di 10 minuti):
  - lettura di un file sonda in `DATA_DIR/sandbox-probe/` → deve fallire;
  - connessione TCP a `1.1.1.1:443` → deve fallire;
  - scrittura nella cartella temporanea → deve riuscire.

  Se l'autotest non passa, il sandbox non è disponibile.
- **Correzione a §8.2**: `sandbox-exec` non sa filtrare la rete per nome host. In `setup` la
  rete è aperta del tutto, non "solo il registry". Va scritto nel documento principale.

### 1.6 Worktree fuori da `WORKSPACE_ROOT`

- `DATA_DIR` va risolto con `realpath` all'avvio. Su macOS `/var` è `/private/var`, e
  `pathViolation` confronta percorsi risolti.
- `RunRequest` riceve `cwd?: string`, fidato perché lo imposta il backend, mai un input
  dell'utente. `AgentRunnerService.run` lo usa al posto di `resolveWorkspace(project.path)`,
  dopo aver verificato con `isInside` che stia sotto `DATA_DIR/worktrees/<projectId>/`.
- `pathViolation` non cambia. I test verificano che un agente con `cwd` nel worktree non legga
  il repository principale, gli altri worktree e i symlink che escono.
- In fase 2 nessun run usa ancora `cwd`: lo useranno i task in fase 3 e l'orchestratore in
  fase 5.

### 1.7 Base del branch: `origin` se c'è, altrimenti locale

`GitService.baseRef(path, baseBranch)`:
1. se esiste il remote `origin`: `git fetch origin <baseBranch>`, con timeout di 60 s;
   - se riesce: `refs/remotes/origin/<baseBranch>`;
   - se fallisce (offline, credenziali): entry `error` con avviso, poi
     `refs/remotes/origin/<baseBranch>` se esiste già in locale;
2. altrimenti: `refs/heads/<baseBranch>`;
3. se nessuno dei due esiste: preparazione fallita, `step: 'branch'`.

Il commit di partenza (`baseCommit`) si salva sulla missione: serve al perimetro e alla PR.

Inoltre:
- **Progetto senza git** (`baseBranch` null): da questa fase `approve` risponde 409 "Serve un
  repository git". La fase 8 crea il repository per i progetti nuovi.
- `baseBranch` si valida con `git check-ref-format --branch` sia nella validazione del piano
  sia all'approvazione.

## 2. GitService

`backend/src/missions/git-service.ts`, che assorbe `git-read.ts`: le sue funzioni diventano
metodi, e le chiamate in `missions.service.ts` e `plan-validation.ts` passano a questo
servizio.

### 2.1 Esecuzione

- Sempre `execFile('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args])`, con
  timeout (30 s di default, 60 s per `fetch`) e `maxBuffer` di 10 MB.
- Ambiente:
  - `GIT_TERMINAL_PROMPT=0`;
  - `GIT_CONFIG_NOSYSTEM=1`;
  - per i comandi che creano commit, autore e committer dal `git config user.*` del
    progetto, con fallback a `algo-agent <algo-agent@localhost>`.
- Errori: `GitError { args, code, stderr }`; lo stderr è tagliato a 4 KB.
- Git **non** gira nel sandbox: lo esegue il backend con argomenti fissi, e gli hook sono
  disattivati. I comandi scritti dagli agenti restano solo quelli dei controlli.

### 2.2 Metodi

| Metodo | Uso | Fase |
|---|---|---|
| `isRepository`, `branchExists`, `resolveBaseBranch`, `checkRefFormat` | Da `git-read.ts`. | 1→2 |
| `hasOrigin(path)` | `git remote get-url origin`. | 2 |
| `baseRef(path, branch)` | §1.7. | 2 |
| `createBranch(path, name, startCommit)` | `git branch <name> <commit>`; se esiste già e punta a `startCommit` non fa nulla, altrimenti errore. | 2 |
| `addWorktree(path, dir, branch)` | `git worktree add <dir> <branch>`; se `dir` è già un worktree di quel branch non fa nulla. | 2 |
| `removeWorktree(path, dir)` | `git worktree remove --force <dir>`, poi `git worktree prune`. | 2 |
| `deleteBranch(path, name)` | `git branch -D <name>`. | 2 |
| `resetTo(dir, commit)` | `git reset --hard <commit>` e `git clean -fdx -e node_modules`: per "Riprova" e, in fase 3, per "Rifai con nota". | 2 |
| `aheadOf(dir, base)` | `git rev-list --count <base>..HEAD`. | 2 |
| `diff(dir, base)` | `git diff --name-status -z <base>` più i file non tracciati (`git ls-files --others --exclude-standard -z`). Per `ScopeService`. | 2 |
| `showFile(dir, rev, path)` | `git show <rev>:<path>`, null se manca. Per `ScopeService`. | 2 |
| `commitAll(dir, message, trailers)` | `git add -A`, poi `git commit -m … --trailer Mission:… --trailer Task:…`. | 2 (usato in 3) |
| `merge(dir, branch)`, `abortMerge(dir)`, `conflicts(dir)` | `merge --no-ff --no-edit`, `merge --abort`, `diff --name-only --diff-filter=U`. | 2 (usato in 5) |

Il push e la conversione dei remote SSH sono della fase 6.

### 2.3 Percorsi e nomi

- Branch della missione: `mission/<id>-<slug>`. Lo slug viene dal titolo del piano:
  minuscole, `[a-z0-9-]`, al massimo 40 caratteri. Si salva in `Mission.branch`.
- Worktree della missione: `<DATA_DIR>/worktrees/<projectId>/<missionId>/main`, salvato in
  `Mission.worktreePath`.
- La preparazione è idempotente: branch e worktree già presenti e coerenti si riusano.
  Se il branch esiste ma punta a un altro commit e `aheadOf` è 0, si sposta; se `aheadOf` è
  maggiore di 0 è un errore (non può succedere in fase 2).

## 3. Controlli

### 3.1 ChecksService

`backend/src/missions/checks.service.ts`.

```ts
type CheckName = 'setup' | 'build' | 'lint' | 'test';

interface CheckRequest {
  projectId: number;
  worktree: string;              // assoluto, risolto, sotto DATA_DIR/worktrees
  plan: Plan;
  names: CheckName[];            // in ordine; quelli non definiti nel piano si saltano
  testPattern?: string;          // solo con plan.checks.testFilter
  secrets: Record<string, string>;
  signal: AbortSignal;
  onEvent?: (e: CheckEvent) => void;
}

interface CheckResult {
  name: CheckName;
  argv: string[];
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  output: string;                // stdout+stderr intercalati, ultimi N KB, segreti mascherati
}
```

- Per ogni comando:
  - `argv` dal tokenizer (§1.4);
  - `cwd` = worktree + `workdir`, con `isInside` dopo `realpath`;
  - `spawn(sandbox.wrap(argv, profile))` con `shell: false` e `detached: true`, per poter
    terminare l'intero gruppo di processi.
- Timeout: `MISSION_CHECK_TIMEOUT_MS`, default 600000. Allo scadere `SIGTERM` al gruppo, poi
  `SIGKILL` dopo 5 s. Lo stesso succede con `signal`.
- Output: buffer circolare degli ultimi `MISSION_CHECK_OUTPUT_KB` (default 64) per comando.
  `onEvent` riceve l'output in diretta, già mascherato.
- **`expect`** non sta qui: il servizio dice solo `ok`. Interpretare `expect: fail` è compito
  dell'executor in fase 3.
- I comandi si fermano al primo che fallisce. Il risultato dice quale.

### 3.2 Ambiente

| Variabile | Valore |
|---|---|
| `PATH` | quello del backend |
| `HOME`, `TMPDIR` | `<DATA_DIR>/sandbox-tmp/<runId>-<n>/`, creata vuota e cancellata alla fine |
| `CI` | `1` |
| `npm_config_cache` | `<DATA_DIR>/sandbox-cache/npm`, condivisa tra le missioni |
| `LANG` | `en_US.UTF-8` |
| segreti di `checks.secrets` | dal vault |

Nient'altro: nessuna variabile del backend passa.

### 3.3 Profilo del sandbox (macOS)

Generato per ogni esecuzione. Va confermato dalla prova della §0. Schema di partenza:

```scheme
(version 1)
(allow default)

; scrittura: solo worktree, tmp e cache
(deny file-write*)
(allow file-write*
  (subpath (param "WORKTREE"))
  (subpath (param "TMP"))
  (subpath (param "CACHE"))
  (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/tty")
  (regex #"^/dev/fd/"))

; lettura: niente credenziali, niente dati del backend, niente altri progetti
(deny file-read*
  (subpath (string-append (param "HOME") "/.ssh"))
  (subpath (string-append (param "HOME") "/.aws"))
  (subpath (string-append (param "HOME") "/.gnupg"))
  (subpath (string-append (param "HOME") "/.config"))
  (subpath (string-append (param "HOME") "/.claude"))
  (literal (string-append (param "HOME") "/.claude.json"))
  (literal (string-append (param "HOME") "/.npmrc"))
  (literal (string-append (param "HOME") "/.netrc"))
  (literal (string-append (param "HOME") "/.git-credentials"))
  (subpath (string-append (param "HOME") "/.docker"))
  (subpath (string-append (param "HOME") "/.kube"))
  (subpath (string-append (param "HOME") "/Library/Keychains"))
  (subpath (param "DATA_DIR"))
  ; + una riga per ogni Project.path dell'istanza, generata
  )
; le regole dopo vincono: il worktree, la cache e la .git del progetto restano leggibili
(allow file-read*
  (subpath (param "WORKTREE"))
  (subpath (param "TMP"))
  (subpath (param "CACHE"))
  (subpath (param "PROJECT_GIT")))

; rete: solo localhost, tranne in setup
(deny network-outbound)
(allow network-outbound (remote ip "localhost:*"))
(allow network-bind (local ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))
; in setup si aggiunge: (allow network-outbound)
```

- I parametri si passano con `-D NOME=valore`, mai interpolati nel testo del profilo.
- `HOME` qui è la home **reale** dell'utente, usata solo per le regole di negazione.
- La lista dei `Project.path` copre "gli altri progetti". Per il progetto corrente si nega la
  cartella e si riapre solo `PROJECT_GIT` (la sua `.git`), di cui il worktree ha bisogno.
- Le negazioni in lettura sono una lista, non un'allowlist, perché node, nvm e Homebrew
  vivono in `HOME` e in `/opt`. È un limite dichiarato: va nella §14 del documento principale.
- La prova della §0 ha aggiunto due regole, altrimenti `npm ci` e `git status` falliscono:
  `(allow file-read-metadata (subpath (param "DATA_DIR")))` (npm e Prisma risolvono il path
  reale di `TMPDIR`, che sta sotto `DATA_DIR`) e
  `(allow file-read-metadata (subpath (param "PROJECT_n")))` (git deve stat la cartella del
  progetto). Esito e comandi in [sandbox-prova.md](sandbox-prova.md).

### 3.4 Lock e setup

- **Lock per worktree**: sempre. Due controlli sullo stesso worktree non girano mai insieme.
- **Lock per progetto**: solo con `checks.parallel: false`, e vale anche tra missioni diverse.
- Tutti e due sono mutex in memoria (un'istanza, come l'event bus).
- **`setup` una volta per worktree**: dopo un `setup` riuscito si scrive il marcatore
  `<worktree>.setup.json` (fuori dal worktree) con l'hash del comando e dei lockfile
  presenti (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`). Se il marcatore manca o gli
  hash cambiano, `setup` rigira.
- **`--ignore-scripts`** (regola della §8.2): si aggiunge quando il comando è un'installazione
  (`npm ci|install|i`, `pnpm install|i`, `yarn install`) e `scope.dependencies` non è vuoto.
  Confermato dalla §0: con Prisma 7 anche senza script `prisma generate` passa, quindi la regola
  resta; il `setup` della base tiene gli script.

### 3.5 ScopeService (perimetro, §7.4)

`backend/src/missions/scope.service.ts`, deterministico, senza agenti.

```ts
check(worktree: string, base: string, scope: Plan['scope']): Promise<ScopeViolation[]>
type ScopeViolation =
  | { kind: 'dependency'; file: string; name: string }
  | { kind: 'migration'; file: string }
  | { kind: 'deleted'; file: string }
  | { kind: 'path'; file: string };
```

- File cambiati: `GitService.diff(worktree, base)`, compresi i non tracciati.
- **Dipendenze**: per ogni `package.json` cambiato si confrontano
  `dependencies`, `devDependencies`, `optionalDependencies` e `peerDependencies` tra `base`
  e il worktree. Ogni nome nuovo che non è in `scope.dependencies` è una violazione. Gli
  altri ecosistemi (`requirements.txt`, `go.mod`, `Cargo.toml`) vanno nei punti aperti.
- **Migrazioni**: file aggiunti sotto una cartella `migrations/`, con `scope.migrations`
  false.
- **Cancellati**: ogni `D`.
- **Percorsi**: se `scope.paths` non è vuoto, ogni file cambiato deve corrispondere ad
  almeno un glob, con `picomatch` (da aggiungere alle dipendenze dirette, oggi c'è solo come
  transitiva). `scope.tests` è incluso nei percorsi ammessi.
- In fase 2 è usato da `run_checks` (§3.6) e dai test. In fase 3 si aggiunge prima del merge.

### 3.6 Tool `run_checks`

In `backend/src/missions/mission-tools.ts`, accanto agli altri tool della missione, non in
`APP_TOOLS`. Si crea solo per i run `mission-task` (fase 3).

```ts
run_checks({ names: ('build'|'lint'|'test')[], pattern?: string })
```

1. `setup` non è richiamabile dall'agente: gira da solo se il marcatore manca.
2. Prima di tutto `ScopeService.check(worktree, taskBase, scope)`. Se ci sono violazioni,
   risponde con l'elenco e non esegue niente.
3. `pattern` è accettato solo se il piano ha `testFilter`, ed è validato (§1.3).
4. Restituisce per ogni comando: `ok`, `exitCode`, `timedOut` e l'output tagliato a 16 KB,
   la parte finale.

`ToolContext.mission` si estende con `{ taskId?, worktree?, taskBase? }`. In fase 2 il tool si
testa chiamando l'handler direttamente.

## 4. Preparazione

`backend/src/missions/mission-prepare.handler.ts`, che implementa `RunHandler` per
`mission-prepare`. Eventi nuovi in `RunEventData`:

```ts
| { type: 'prepare_step'; step: 'fetch'|'branch'|'worktree'|'setup'|'build'|'lint'|'test'; status: 'started'|'done'|'failed'|'skipped'; detail?: string }
| { type: 'check_output'; name: CheckName; text: string }   // passa dal TextCoalescer
```

Passi:

1. Rilegge la missione. Se non è `approved` si chiude con esito `done`, perché
   un'interruzione o una revisione è arrivata nel frattempo.
2. `fetch` e `branch`: `baseRef` (§1.7) e `createBranch`; salva `baseCommit` e `branch`.
3. `worktree`: `addWorktree` e salva `worktreePath`.
4. `setup`: secondo il marcatore (§3.4).
5. Controlli di base: `build`, `lint`, `test`, quelli definiti, in quest'ordine.
6. Esito:
   - **ok**: update condizionato `approved → running`, entry `status`;
   - **fallimento**: update condizionato `approved → waiting`, con
     `waitJson { code: 'baseline', runId, step, detail }` ed entry `wait` con `notify: true`.
     `detail` contiene le prime righe utili dell'output.

Il run finisce sempre `done`, anche quando la baseline fallisce: l'esito sta nella missione.
Finisce `failed` solo per errori inattesi (eccezioni), e la riconciliazione lo riaccoda come
un run interrotto.

`MissionsService`:
- **`approve`**:
  - controlla `sandbox.available()` e che `baseBranch` sia presente e valido;
  - aggiorna come oggi, accoda `mission-prepare` e scrive l'entry `prepare { runId }`.
- **`retryBaseline`**:
  - stato `waiting` con `code: 'baseline'`, altrimenti 409;
  - ricalcola `baseRef`; se il commit è cambiato, usa `resetTo` sul worktree (sicuro: con
    `aheadOf` uguale a 0 non c'è lavoro da perdere);
  - porta lo stato a `approved` e accoda una nuova preparazione;
  - rifà `setup` solo se i lockfile sono cambiati.
- **`revise`** da `approved` o `waiting{baseline}`:
  - interrompe la preparazione attiva;
  - `removeWorktree`, `deleteBranch`;
  - azzera `branch`, `worktreePath` e `baseCommit`;
  - torna a `briefing`.
- **`remove`**: pulisce worktree, branch e marcatore anche per le missioni `aborted`.
- **Riconciliazione**: §1.1.

`ProjectsService.delete`: risponde 409 se il progetto ha missioni in `approved`, `running` o
`waiting`. Per le altre, prima di cancellare il progetto, pulisce i loro worktree.

## 5. Modello dati

Migrazione `missions_phase2`:
- `Mission.baseCommit String?`;
- la riga `/// status` aggiornata con `running` e `waiting`.

Niente tabelle nuove. Il kind `mission-prepare` e i nuovi tipi di entry (`prepare`, `wait`)
sono solo stringhe.

## 6. API

| Metodo | Percorso | Note |
|---|---|---|
| `POST` | `/missions/:id/approve` | Come in fase 1. Nuovi 409: sandbox non disponibile, progetto senza git, `baseBranch` non valido. |
| `POST` | `/missions/:id/baseline/retry` | Da `waiting{baseline}`. |
| `POST` | `/missions/:id/revise` | Ora anche da `waiting{baseline}`; pulisce branch e worktree. |
| `GET` | `/missions/:id` | Aggiunge `baseCommit` e, se c'è, `preparation: { runId }` (ultimo `mission-prepare`). |
| `GET` | `/system/sandbox` | `{ available, reason? }`, per mostrare un avviso prima dell'approvazione. |

## 7. Frontend

| File | Contenuto |
|---|---|
| `missions/PreparationView.tsx` | Passi della preparazione (fetch, branch, worktree, setup, build, lint, test) con stato e output in diretta, dagli eventi del run `mission-prepare`. Riusa lo stile dell'output dei passi in `WorkflowsPanel.tsx`. |
| `missions/BaselineWait.tsx` | Riquadro dell'attesa `baseline`: passo fallito, `detail`, output espandibile, azioni Riprova · Rivedi il piano · Ferma. |
| `missions/MissionView.tsx` | Nella colonna destra mostra: Piano se `planned`; Preparazione se `approved`; BaselineWait se `waiting{baseline}`; "Pronta" (branch, worktree, commit base) se `running`. |
| `missions/PlanView.tsx` | Avviso dal `GET /system/sandbox`; Approva disattivato se il sandbox non c'è o manca git. Mostra `testFilter` e i nomi di `secrets`. |
| `missions/api.ts`, `i18n/messages.ts` | Rotte, tipi, stati `running` e `waiting`, testi. |

## 8. Configurazione

| Variabile | Default | Note |
|---|---|---|
| `MISSION_CHECK_TIMEOUT_MS` | `600000` | Per comando. |
| `MISSION_CHECK_OUTPUT_KB` | `64` | Coda di output tenuta per comando. |
| `MISSION_GIT_FETCH_TIMEOUT_MS` | `60000` | |

Nessuna variabile per disattivare il sandbox.

## 9. Ordine di lavoro

1. **Prova del sandbox** (§0) → `docs/sandbox-prova.md`. Si decide su `--ignore-scripts`
   e si conferma il profilo.
2. **Piano**:
   - `command-line.ts` (tokenizer e rifiuto degli operatori);
   - `testFilter`, `secrets`, `check-ref-format`;
   - aggiornamento del prompt dell'orchestratore.
3. **`GitService`**, che sostituisce `git-read.ts`.
4. **`Sandbox`** (`MacSandbox`, autotest) e **`ChecksService`** (ambiente, timeout,
   output, lock, marcatore di `setup`, mascheramento dei segreti).
5. **`ScopeService`** e **`run_checks`**, non ancora collegato a un run.
6. **`cwd` fidato** in `AgentRunnerService` e `realpath` di `DATA_DIR`.
7. **Preparazione**:
   - kind `mission-prepare` e limiti;
   - handler ed eventi;
   - `approve`, `retryBaseline`, `revise` e `remove` con pulizia;
   - riconciliazione;
   - `ProjectsService.delete`.
8. **Frontend**.
9. **Prova reale**: su algo-agent, una missione verde fino a `running`, una con un test rotto
   sul branch base fino a `waiting{baseline}`, poi Riprova dopo la correzione. Infine un
   riavvio del backend a metà `setup`.

## 10. Test

I test con il sandbox vero girano solo su macOS (`it.runIf(process.platform === 'darwin')`).
Gli altri usano un `FakeSandbox` che non isola niente, ma registra `argv`, `env` e profilo.

- **`command-line`**:
  - virgolette, escape, argomenti vuoti;
  - rifiuto di `&&`, `|`, `;`, `>`, `$(`, `$VAR`, `` ` `` e glob non quotati;
  - `testFilter` senza `{{pattern}}`;
  - pattern non valido.
- **Piano**: segreto inesistente nel vault; `baseBranch` con un nome di ref non valido.
- **`GitService`** su repository temporanei (`mkdtemp` con `git init`):
  - `baseRef` con `origin` (un remote bare locale), senza `origin`, con `fetch` fallito e il
    ref già presente, e con nessun ref;
  - branch e worktree creati due volte (idempotenza);
  - `commitAll` con i trailer;
  - merge pulito, conflitto rilevato da `conflicts`, conflitto annullato con `abortMerge`;
  - un hook `pre-commit` nel repository **non** eseguito: l'hook scrive un file sonda, che
    non deve comparire;
  - `resetTo` e `aheadOf`.
- **`ChecksService`**:
  - `argv` senza shell (`echo '$HOME && x'` stampa il testo letterale);
  - timeout che termina anche i processi figli;
  - output tagliato agli ultimi N KB;
  - stop al primo fallimento;
  - lock per worktree sempre, lock per progetto solo con `parallel: false`;
  - `env` senza variabili del backend e con la `HOME` finta;
  - segreti presenti nell'ambiente e mascherati nell'output;
  - marcatore di `setup` (rigira se cambia un lockfile);
  - `--ignore-scripts` aggiunto solo nei casi previsti.
- **Sandbox** (solo macOS):
  - lettura negata di `~/.ssh` (file sonda creato in una `HOME` di test passata come
    parametro), di `DATA_DIR` e di un altro progetto;
  - scrittura negata fuori dal worktree;
  - rete negata fuori da `setup` e permessa in `setup`;
  - server su `localhost` permesso;
  - `git status` nel worktree permesso;
  - autotest che fallisce con un profilo volutamente sbagliato, e missione rifiutata
    (`approve` 409).
- **`ScopeService`**: dipendenza nuova fuori elenco e in elenco, `devDependencies`,
  migrazione con `migrations: false`, file cancellato, file fuori da `paths`, file non
  tracciato, `scope.tests` ammesso.
- **`run_checks`**: perimetro violato prima di `setup` (non esegue niente), pattern senza
  `testFilter`, pattern non valido, output tagliato.
- **`cwd` fidato**: rifiutato fuori da `DATA_DIR/worktrees/<projectId>`; `pathViolation` con
  un symlink che esce dal worktree.
- **Preparazione**:
  - percorso verde fino a `running`;
  - `test` rosso che porta a `waiting{baseline}` con `step: 'test'`;
  - `retryBaseline` con il base aggiornato (reset) e senza cambi;
  - `revise` che pulisce branch e worktree;
  - preparazione interrotta e riaccodata dalla riconciliazione;
  - missione fermata durante `setup` (processo terminato, stato `aborted`, worktree
    presente);
  - 409 senza sandbox, senza git e con un'azione nello stato sbagliato.
- **Progetti**: cancellazione rifiutata con una missione attiva.
- **Frontend**: azioni di `BaselineWait`, output in diretta della preparazione, Approva
  disattivato senza sandbox.

## 11. Da riportare in modalita-autonoma.md

- §4.1: campo `baseCommit`.
- §4.4: kind `mission-prepare`.
- §5: `checks.testFilter`, `checks.secrets`, comandi senza operatori di shell.
- §7.1: `approved` come stato di preparazione; transizioni `approved ⇄ waiting{baseline}`.
- §8.2: in `setup` la rete è aperta del tutto (§1.5); le negazioni in lettura sono una lista
  (§3.3); `--ignore-scripts` secondo l'esito della §0.
- §8.4: la base è `origin/<baseBranch>` se c'è, altrimenti il branch locale; git gira fuori
  dal sandbox, con gli hook disattivati.
- §14: Linux (`bwrap`), ecosistemi diversi da npm nel perimetro, limiti della lista di
  negazioni.
