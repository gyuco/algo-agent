# Missioni: piano di lavoro

Sintesi operativa di [modalita-autonoma.md](modalita-autonoma.md). Ogni fase si chiude con
test verdi e qualcosa di usabile; la successiva parte solo dopo.

## Fase 1: missione, briefing e piano

Dettaglio in [fase1.md](fase1.md).

- Prisma: `Mission` (con lo stato `approved`, `baseBranch` facoltativo e `fromSession`),
  `MissionTask`, `MissionEntry`; su `Run` i campi `missionId` e `missionTaskId` e i kind
  `mission-task` e `mission-orchestrator` (§4).
- Limiti dei run per kind: `mission-orchestrator` fuori da `chatsPerUser`, `mission-task` fuori
  dagli scrittori del progetto (§8.5).
- Schema zod del piano e regole di validazione (§5), con `maxTurns` per ruolo e `scope.tests`.
- Catalogo: contratto dei modelli di task (§6.2, regole 1-6) e i tre YAML `task-tdd`,
  `task-docs`, `task-config`, che si caricano ma non si avviano; la scheda Workflow li esclude.
- Tool `ask_user` e `propose_plan`, con la chiusura del turno; run `mission-orchestrator` con un
  handler dedicato per il briefing (§8.3).
- API: creazione, messaggi, approvazione con `planVersion` e `mode`, revisione, stop, eventi SSE
  (§12).
- Frontend: scheda Missioni, "Trasforma in missione" dalla chat, viste Briefing e Piano in
  elenco, senza grafo (§13).

**Fatto quando**: un piano prodotto dall'orchestratore su un progetto reale viene validato,
mostrato e approvato; una missione nata da "Trasforma in missione" riparte dalla conversazione;
i test della fase sono verdi. Nessuna esecuzione.

## Fase 2: git, sandbox e controlli

- `GitService`: branch, worktree, commit con trailer, merge, sempre con `core.hooksPath=/dev/null` (§8.4).
- `ChecksService` nel sandbox (`sandbox-exec` / `bwrap`): `HOME` finta, rete chiusa fuori da `setup`, timeout, output tagliato, lock con `parallel: false` (§8.2).
- Controllo del perimetro prima di `setup` e dei controlli (§7.4).
- Tool `run_checks`.
- Controllo di base nella preparazione dopo l'approvazione (`approved` → `running`), con l'attesa `baseline` e `/baseline/retry`.

**Fatto quando**: dopo l'approvazione nascono il branch e il worktree della missione, il controllo di base passa e la missione va in `running`. Il sandbox nega `~/.ssh` e la rete.

## Fase 3: task e passo-passo

- Executor: passi `run`, verifica composta, `protect` (anche su `scope.tests`), `repeat.stop`, ruoli (§6.2).
- `TaskGraphFactory`: ruoli dal team, `{{task}}` con note, dipendenze e diff precedente.
- `MissionScheduler` con un task alla volta; le dipendenze contano solo quando sono unite.
- Attese `task_review` e `task_blocked`; azioni Ok, Rifai con nota (reset del branch), Salta.
- Vista Task e notifiche in-app di base.

**Fatto quando**: una missione arriva dalla prima all'ultima task in passo-passo, sul suo branch, senza PR.

## Fase 4: budget

- `BudgetGuard`: lettura di `rateLimits` e refresh con `/usage` (§9.1).
- 5 ore: controllo prima di ogni passo, interruzione sotto il 5%, `paused` e ripresa al reset (§9.2).
- Settimana: attribuzione con il delta di `costUsd`, quota per missione, tetto globale `MISSIONS_WEEKLY_MAX_SHARE`, attesa `weekly_budget` (§9.3).
- Barre del budget nelle viste.

**Fatto quando**: una missione si mette in pausa e riparte da sola, e si ferma alla quota. Senza questa fase la modalità automatica non si attiva.

## Fase 5: modalità automatica

- Task in parallelo (`parallelTasks`, `MISSIONS_MAX_RUNNING_TASKS`).
- Merge serializzato; integratore sui conflitti, `merge --abort` se fallisce.
- Attesa `scope` e Accetta perimetro.
- Fine milestone: `update_plan`, `record_decision`, task correttivo; sessione nuova dell'orchestratore con il riepilogo.
- Cambio di modalità durante la missione.

**Fatto quando**: una missione con più milestone arriva al branch finale senza intervento, registrando le decisioni.

## Fase 6: PR

- `ForgeService` per GitHub e GitLab, anche self-hosted; token dal vault.
- Stato `integrating`: controlli completi, push (SSH convertito in HTTPS), PR con le decisioni.
- Progetto senza `origin`: `done` con il branch locale.

**Fatto quando**: la PR o la MR si apre con la descrizione completa.

## Fase 7: notifiche e Attività

- Gruppo Missioni in "Richiedono te" e "In corso"; stream `/runs/active/events` esteso.
- Notification API del browser, non letti.

## Fase 8: progetti nuovi

- Briefing su una cartella temporanea; all'approvazione: cartella, `git init`, repository remoto, `Project`.
- Prima milestone di scaffolding.

## Da decidere strada facendo

- Sandbox: se `sandbox-exec` regge npm, Prisma e le porte locali (dopo la fase 2).
- Cache di `node_modules` tra i worktree (dopo la fase 3).
- Grafo unico per l'anteprima dei workflow e per la vista Piano (dopo la fase 3).
- Notifiche a browser chiuso (dopo la fase 7).
