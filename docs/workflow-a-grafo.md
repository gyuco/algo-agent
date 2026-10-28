# Workflow a grafo

Documento di progetto: estendere i workflow da sequenza di passi a grafo aciclico con un ciclo
limitato, e definire come si creano nel frontend. Si integra con
[esecuzione-in-background.md](esecuzione-in-background.md), che descrive la coda e l'executor
che li eseguono.

## 1. Perché i workflow

La chat può già delegare agli agenti del progetto. In quel caso decide il modello, a ogni
turno, chi chiamare e quando. I workflow coprono un caso diverso:

| | Delega in chat | Workflow |
|---|---|---|
| Chi decide la sequenza | Il modello, a ogni turno | L'utente, una volta sola |
| Ripetibilità | Variabile | Stessi passi ogni volta |
| Costo | Più alto: l'agente principale ragiona anche sull'orchestrazione | Ogni passo fa solo il suo lavoro |
| Controllo | Difficile fermarsi in un punto preciso | Stop, approvazioni e ripresa sono naturali |
| Background e pianificazione | Poco adatta: serve qualcuno che risponda | È il caso d'uso ideale |

Le due cose convivono. La delega serve per il lavoro esplorativo, i workflow per i processi
ricorrenti: review notturna, analizza e correggi, aggiornamento della documentazione. Un passo
può comunque usare un agente che delega a sua volta.

## 2. Limiti del formato attuale

Lo schema (`workflowSchema` in `backend/src/catalog/catalog.ts`) è una lista di 1–10 passi
`{ agent, prompt }` eseguiti in ordine. Ogni prompt vede solo `{{input}}` e `{{previous}}`, cioè
l'output del passo immediatamente precedente. È un grafo nella forma più semplice, una catena, e
non copre questi casi:

1. **Più input**: un passo ha bisogno degli output di due passi diversi.
2. **Parallelismo**: più revisori sullo stesso codice, poi un passo che unisce i risultati.
3. **Ciclo**: correggi e rivedi finché il revisore non dà l'OK, al massimo N volte.
4. **Condizioni**: se il revisore non trova problemi, salta la correzione.
5. **Approvazione umana**: fermarsi prima che un agente con `files: write` modifichi il progetto.

## 3. Scelta: grafo aciclico più un ciclo limitato

Le alternative considerate:

- **Grafo generico con archi liberi**, cicli compresi, sul modello di LangGraph. È molto
  flessibile, ma un YAML pieno di archi diventa illeggibile, richiede un editor visuale, e
  ripresa e debug si complicano.
- **Grafo aciclico più un ciclo limitato** (scelta). Ogni passo ha un nome e dichiara da quali
  passi dipende (`needs`), come i job di GitHub Actions. Il ciclo non è un arco all'indietro ma
  un costrutto a sé, `repeat`, con un numero massimo di iterazioni. Il grafo resta aciclico,
  quindi facile da validare, disegnare e riprendere.

## 4. Formato

### 4.1 Campi di un passo

| Campo | Obbligatorio | Default | Significato |
|---|---|---|---|
| `id` | no | `step-<n>` (posizione, da 1) | Nome del passo, unico nel workflow, stesse regole delle chiavi (minuscole, cifre, trattini). |
| `agent` | sì | — | Chiave dell'agente, come oggi. |
| `prompt` | sì | — | Testo del passo con le variabili del §4.2. |
| `needs` | no | il passo precedente nella lista | Passi da cui dipende. `[]` significa "può partire subito". |
| `verdict` | no | — | Valori ammessi del verdetto del passo (§4.4). |
| `when` | no | — | Condizione per eseguire il passo (§4.4). Se è falsa il passo è *saltato*. |
| `approval` | no | `false` | Il passo attende che l'utente approvi prima di partire (§6.2). |
| `repeat` | no | — | Ripete il passo finché vale una condizione (§4.5). |

Il default di `needs` mantiene **compatibili tutti i workflow esistenti**: senza `id` né
`needs` si ottiene esattamente la catena di oggi.

Il default `step-<n>` dipende dalla posizione. Non è un problema: un passo senza `id` esplicito
non può essere referenziato da `{{steps.x}}`, `needs`, `when` o `repeat.with`, quindi spostarlo
non rompe riferimenti. L'editor (§8.1) assegna comunque sempre un `id` esplicito.

Il limite di 10 passi resta. È un limite di leggibilità, non tecnico. Con `repeat` le
esecuzioni effettive possono essere di più: l'editor mostra il numero massimo (§8.1).

### 4.2 Variabili

| Variabile | Valore |
|---|---|
| `{{input}}` | Il testo inserito dall'utente all'avvio. |
| `{{steps.<id>}}` | L'output del passo `<id>`, senza la riga del verdetto. Se il passo è stato saltato vale `(passo saltato)`. |
| `{{previous}}` | Mantenuta per compatibilità: l'output dell'unico passo in `needs`. Senza dipendenze è vuota, come oggi nel primo passo; con più dipendenze è un errore di validazione. |
| `{{iteration}}` | Nel passo con `repeat` e nella sua verifica: il numero dell'iterazione, da 1. Altrove è un errore di validazione. |

Un prompt può riferirsi solo a passi presenti nelle sue dipendenze, dirette o indirette. Questo
garantisce che l'output esista quando il passo parte. **Unica eccezione**: il passo con `repeat`
può riferirsi al proprio passo di verifica `repeat.with` (§4.5).

Il valore `(passo saltato)` è esplicito di proposito: una stringa vuota in un prompt come
"Sicurezza: {{steps.security}}" confonderebbe l'agente.

### 4.3 Esempio

```yaml
description: Due revisioni in parallelo, poi correzione con approvazione e verifica.
input: Cosa controllare
steps:
  - id: review
    needs: []
    agent: reviewer
    prompt: "Rivedi {{input}} ed elenca i problemi concreti."
  - id: security
    needs: []
    agent: reviewer
    prompt: "Cerca problemi di sicurezza in {{input}}."
  - id: fix
    needs: [review, security]
    agent: assistant
    approval: true
    prompt: |
      Correggi i problemi trovati.
      Revisione: {{steps.review}}
      Sicurezza: {{steps.security}}
```

### 4.4 Condizioni e verdetti

Una condizione valutata sul testo libero ("contiene OK") è fragile. Gli agenti dicono "ok" in
mille modi. Per questo le condizioni si basano su un **verdetto**:

- un passo può dichiarare `verdict: [ok, problemi]`, cioè un elenco di valori ammessi, con le
  stesse regole delle chiavi (minuscole, cifre, trattini);
- al prompt si aggiunge in automatico l'istruzione di chiudere la risposta con una riga
  `VERDETTO: <valore>`;
- l'executor cerca l'**ultima** riga che inizia con `VERDETTO:`. Prima del confronto toglie
  spazi e marcatori markdown (`*`, `_`, `` ` ``) e porta il valore in minuscolo;
- se la riga manca o il valore non è tra quelli ammessi, l'executor manda **un solo** messaggio
  in più nella stessa sessione dell'agente, chiedendo solo la riga del verdetto. Se anche la
  seconda risposta non è valida, il passo è in errore;
- la riga del verdetto si toglie dall'output: il valore si salva a parte (`verdetto`, §6) e i
  passi successivi ricevono solo il testo;
- `when` confronta solo verdetti: `when: { step: review, verdict: problemi }`. Se il passo
  indicato è stato saltato, la condizione è falsa.

Le condizioni restano così **dichiarative e verificabili al salvataggio**: niente espressioni
libere da interpretare.

### 4.5 Ripetizione

```yaml
  - id: fix
    needs: [review]
    agent: assistant
    prompt: "Correggi: {{steps.review}} {{steps.check}}"
    repeat:
      with: check          # passo di verifica rieseguito dopo ogni iterazione
      until: ok            # verdetto del passo di verifica che ferma il ciclo
      max: 3
      onMax: fail          # oppure continue
  - id: check
    needs: [fix]
    agent: reviewer
    verdict: [ok, problemi]
    prompt: "Verifica le correzioni: {{steps.fix}}"
```

- `with` indica un passo che ha `needs` uguale esattamente al passo con `repeat` e che dichiara
  un `verdict`. Un passo di verifica appartiene a un solo `repeat`.
- Il passo e la sua verifica formano un **blocco**. A ogni iterazione si eseguono il passo e poi
  la verifica. Per lo scheduler il blocco è un nodo unico: i passi che dipendono dal passo o
  dalla verifica partono solo quando il blocco è finito, e vedono gli output dell'ultima
  iterazione.
- Il ciclo finisce quando la verifica restituisce il verdetto `until`.
- Arrivato a `max` iterazioni senza esito:
  - con `onMax: fail` (default) il passo è in errore e il run termina come `failed`, con il
    motivo;
  - con `onMax: continue` il blocco si chiude come completato, con un avviso nel run e nel
    passo. È utile quando una correzione parziale ha comunque valore.
- Alla prima iterazione `{{steps.check}}` vale `(nessuna verifica ancora)`. Nelle successive
  contiene l'ultima verifica, così l'agente sa cosa resta da correggere.
- Ogni iterazione è una sessione nuova dell'agente, come ogni passo oggi.

## 5. Validazione al salvataggio

Si estende `workflowSchema`, e il controllo incrociato che già verifica gli agenti
sconosciuti (`catalog.ts`), con queste regole:

1. `id` unici; `needs`, `when` e `repeat.with` fanno riferimento a passi esistenti.
2. Il grafo delle dipendenze è aciclico (ordinamento topologico).
3. Ogni `{{steps.x}}` di un prompt fa riferimento a un antenato del passo, oppure, per un passo
   con `repeat`, al suo passo di verifica.
4. `{{previous}}` non è ammesso con più di una dipendenza. Senza dipendenze resta valido e vuoto,
   per non invalidare i workflow esistenti che lo usano nel primo passo.
5. `when` usa solo passi con `verdict` e valori dichiarati.
6. `repeat.with` rispetta il §4.5: dipende solo dal passo che si ripete, dichiara `verdict`,
   `until` è tra i suoi valori, non è la verifica di un altro `repeat`, non ha a sua volta
   `repeat` né `approval`; `max` va da 1 a 5.
7. **Scritture in parallelo:** due passi che possono girare insieme (nessuno dei due è antenato
   dell'altro) non possono avere entrambi agenti con `files: write`. Il controllo va ripetuto
   all'avvio del run e a ogni approvazione (§6.2), perché i permessi di un agente possono
   cambiare dopo il salvataggio del workflow.

La regola 7 copre solo i file del progetto. Gli effetti dei tool MCP (database, API esterne)
non sono noti al backend: due passi in parallelo con lo stesso server MCP in scrittura restano
responsabilità di chi scrive il workflow. È un limite noto, da segnalare nel README del catalogo.

I messaggi di errore indicano il passo e il campo, così il frontend li mostra accanto al campo
giusto (§8.1).

## 6. Esecuzione

L'executor descritto in [esecuzione-in-background.md](esecuzione-in-background.md) segue questo
schema:

- **Passi pronti.** Un passo è pronto quando nessuna dipendenza è `pending`, `running` o
  `waiting_approval`, cioè quando tutte sono `done` o `skipped`. I passi pronti partono insieme,
  entro un limite per run (`RUNS_MAX_PARALLEL_STEPS`, default 3).
- **Concorrenza.** I limiti globali (`RUNS_MAX_CONCURRENT`, per utente, per progetto) contano i
  **run**, come oggi in `limits.ts`: un run occupa un posto qualunque sia il numero di passi in
  corso. `RUNS_MAX_PARALLEL_STEPS` limita quindi le sessioni di agente aperte da un run.
  Per il limite di scrittori per progetto, un run "scrive" se almeno un suo passo ha un agente
  con `files: write`, come oggi.
- **Stati di un passo:** `pending`, `waiting_approval`, `running`, `done`, `skipped`, `failed`,
  `aborted`.
- **Saltati.** Un passo è `skipped` in due casi:
  - il suo `when` è falso;
  - ha almeno una dipendenza e **tutte** le sue dipendenze sono `skipped`.

  Se almeno una dipendenza è `done`, il passo parte, e le dipendenze saltate compaiono nel
  prompt come `(passo saltato)`. Nell'esempio del §4.3, se `security` fosse saltato, `fix`
  partirebbe comunque con la sola revisione.
- **Errori.** Il primo passo in errore impedisce l'avvio di nuovi passi. Quelli già in corso
  finiscono, i passi in `waiting_approval` diventano `aborted`, poi il run termina come
  `failed`.
- **`stepsJson`** diventa un oggetto per `id`:
  `{ stato, agente, output, verdetto, iterazioni, costo, inizio, fine, avviso }`.
  `iterazioni` è un array con, per ogni iterazione di un `repeat`, output e costo del passo e
  output, verdetto e costo della verifica: serve a capire com'è andato il ciclo. `output` e
  `verdetto` sono quelli dell'ultima iterazione.
  I run vecchi, salvati come array, si leggono convertendo l'indice in `step-<n>`.
- **Eventi.** Quelli dello stream portano l'`id` del passo: `step_started`, `step_finished`,
  `step_skipped`, `approval_requested`, più `iteration_started` per i `repeat`. Anche gli
  eventi di testo e di tool portano l'`id`, perché con passi in parallelo arrivano mescolati.
  Il `TextCoalescer` accorpa il testo per passo, non per run.

### 6.1 Stato del run

Lo stato del run deriva da quello dei passi:

- `running` finché almeno un passo è `running` o pronto;
- `waiting` quando nessun passo è in corso o pronto e almeno uno è in `waiting_approval`;
- stato finale (`done`, `failed`, `aborted`) quando non resta niente da eseguire.

Un run `waiting` non ha passi in corso. Per questo può non occupare posti di concorrenza e non
serve l'heartbeat: il `RunRecoveryService` continua a controllare solo i run `running`, e tutti
i passi in esecuzione stanno in un run `running`.

### 6.2 Approvazione

- Quando un passo con `approval: true` diventa pronto, va in `waiting_approval` ed emette
  `approval_requested`. Gli altri rami del grafo continuano a girare, e il run resta `running`
  finché ci sono passi in corso o pronti (§6.1).
- `POST …/runs/:id/steps/:stepId/approve` e `…/reject` (rifiuto con nota facoltativa). Il
  rifiuto fa terminare il run come `aborted`: i passi in corso si fermano come con lo stop.
- **Approvazione con il run `running`**: il passo diventa pronto e l'executor, che sta ancora
  girando, lo avvia.
- **Approvazione con il run `waiting`**: il run torna `queued`. Quando lo scheduler lo riprende,
  l'executor ricostruisce lo stato da `stepsJson` e continua dallo stesso run, senza copiare
  niente. È la stessa logica della ripresa (§6.3), applicata al run stesso.
- **Controlli all'approvazione**, prima di accettarla:
  - l'hash della definizione deve essere ancora uguale a `workflowHash`. Se il workflow è
    cambiato, l'approvazione risponde 409 ("Il workflow è cambiato: rifiuta e avvia un nuovo
    run");
  - la regola 7 del §5 vale ancora con i permessi attuali degli agenti; altrimenti 409 con il
    passo in conflitto.
- Un'attesa troppo lunga (`RUNS_APPROVAL_TIMEOUT_HOURS`, default 72) chiude il run come
  `aborted`. Il controllo è del `RunRecoveryService` e riguarda solo i run `waiting`: un run
  `running` arriva comunque a `waiting` appena finiscono i passi in corso.
- La richiesta di approvazione deve bastare per decidere: mostra il prompt già compilato del
  passo e i permessi effettivi dell'agente, calcolati al momento della richiesta e ricontrollati
  all'approvazione.

### 6.3 Ripresa

Riprendere un run `interrupted` o `failed` crea un nuovo run, con il controllo su
`workflowHash` del documento sul background. Il nuovo run copia i passi `done` e `skipped` e
riparte da tutti gli altri, ricalcolando quali sono pronti.

Per un blocco `repeat` si copiano le iterazioni completate (passo e verifica) e si riparte
dall'iterazione interrotta, con l'ultima verifica salvata in `{{steps.check}}`. Un'iterazione
a metà si rifà da capo, come un passo interrotto.

## 7. Backend: modifiche

| File | Modifica |
|---|---|
| `src/catalog/catalog.ts` | Nuovo schema dei passi, normalizzazione dei default (`id`, `needs`), validazione del §5. |
| `src/catalog/catalog.spec.ts` | Test per ogni regola di validazione e per la compatibilità con i workflow attuali. |
| `src/workflows/workflows.service.ts` | Da ciclo `for` a scheduler di passi pronti; compilazione delle variabili; verdetti, `when`, blocchi `repeat`, approvazioni; ricostruzione dello stato da `stepsJson`. |
| `src/workflows/run-steps.controller.ts` | Endpoint di approvazione e rifiuto, con i controlli del §6.2. |
| `src/runs/run-executor.service.ts` | Stato del run derivato dai passi (§6.1); eventi con `id` del passo; attività corrente per passo. |
| `src/runs/text-coalescer.ts` | Accorpamento del testo per passo. |
| `catalog/workflows/review-and-fix.yaml` | Esempio aggiornato con verifica e `repeat`, più uno nuovo con revisioni in parallelo. |
| `catalog/README.md` | Documentazione del nuovo formato e del limite sui tool MCP (§5). |

Il formato YAML resta lo stesso per la libreria, per "Importa esempi" e per l'import/export: la
validazione è una sola, nel backend.

## 8. Frontend: creazione e modifica

Le opzioni valutate:

| | File di testo (YAML) | Tela con nodi | Moduli più anteprima del grafo |
|---|---|---|---|
| Curva di apprendimento | Alta: sintassi e nomi dei campi | Bassa per grafi piccoli | Bassa |
| Prompt lunghi | Comodi | Scomodi: non stanno in un nodo | Comodi |
| Dipendenze e parallelismo | Poco visibili | Molto visibili | Visibili nell'anteprima |
| Errori | Si scoprono al salvataggio | Pochi | Prevenuti dai controlli |
| Costo | Minimo | Alto: libreria grafica pesante, layout, uso da mobile | Medio, nessuna dipendenza |

**Scelta: moduli come vista principale, anteprima del grafo in sola lettura, scheda YAML per gli
esperti.** La tela con nodi rende bene con grafi grandi e prompt corti; qui vale il contrario
(al massimo 10 passi, prompt di più righe). Inoltre il frontend oggi dipende solo da React.

### 8.1 Moduli

Si estende l'editor esistente (`WorkflowFields` in `frontend/src/library/ResourceEditor.tsx`).
Per ogni passo:

- **Nome** (`id`): proposto dall'agente scelto (`reviewer`, `reviewer-2`, …), modificabile.
  Rinominarlo aggiorna tutti i riferimenti negli altri passi: `{{steps.x}}` nei prompt,
  `needs`, `when.step` e `repeat.with`.
- **Agente**: come oggi. Accanto, un'etichetta con i permessi sui file (`lettura`, `scrittura`).
- **Dipende da**: caselle con gli altri passi, con il precedente spuntato di default. Non si
  possono scegliere passi che creerebbero un ciclo.
- **Prompt**: area di testo con i pulsanti per inserire `{{input}}` e `{{steps.<nome>}}`.
  Vengono offerti solo gli antenati del passo, più la verifica se il passo ha un `repeat`,
  quindi i riferimenti sbagliati non si possono scrivere.
- **Opzioni avanzate**, chiuse di default:
  - "Chiedi approvazione prima di eseguire";
  - "Verdetto" con i valori ammessi;
  - "Esegui solo se…" (passo e verdetto da menu);
  - "Ripeti finché…" (passo di verifica, verdetto, massimo, cosa fare al massimo).
- **Errori** sotto il campo interessato, sia quelli calcolati nel browser (riferimenti, cicli)
  sia quelli restituiti dal backend al salvataggio (§5).
- **Ordine**: pulsanti su e giù.
- **Esecuzioni massime**: in fondo al modulo, "fino a N esecuzioni di agenti", contando
  `max × 2` per ogni blocco `repeat`. Rende visibile il costo nel caso peggiore.

**Come si salva `needs`.** Il modulo tiene sempre le dipendenze esplicite. Al salvataggio:

- se il grafo è una catena nell'ordine della lista, `needs` si omette e l'ordine definisce la
  catena, come oggi. Spostare un passo cambia la catena, e l'anteprima lo mostra subito;
- altrimenti `needs` si scrive su **tutti** i passi. Spostare un passo cambia solo l'ordine di
  lettura, non il grafo.

Così il default implicito non cambia mai il grafo all'insaputa dell'utente.

### 8.2 Anteprima del grafo

- Componente SVG senza librerie, accanto ai moduli su schermi larghi e sotto su mobile.
- Layout a livelli: il livello di un passo è la lunghezza del percorso più lungo dalle radici.
  I nodi di uno stesso livello sono affiancati e gli archi vanno da un livello al successivo.
  Con al massimo 10 nodi non serve altro.
- Ogni nodo mostra nome, agente e icone di approvazione, condizione e ripetizione. Un `repeat`
  si disegna come freccia di ritorno dalla verifica al passo, solo come decorazione, e il
  blocco è racchiuso in un riquadro.
- Cliccare un nodo porta al passo corrispondente nel modulo.
- Si aggiorna mentre si modifica; i nodi con errori sono evidenziati.
- Colori come variabili CSS in `index.css`, per tema chiaro e scuro.

### 8.3 Lo stesso grafo nella pagina del run

Il componente si riusa in `WorkflowsPanel.tsx` per seguire un run:

- colore e icona di ogni nodo seguono lo stato del passo (§6), aggiornati dagli eventi
  `step_*` dello stream;
- cliccando un nodo si vede il suo output e i tool chiamati; per un `repeat`, l'elenco delle
  iterazioni;
- un nodo in `waiting_approval` mostra i pulsanti Approva e Rifiuta con il prompt già compilato;
- per un `repeat` si vede l'iterazione corrente ("2 di 3");
- un blocco chiuso con `onMax: continue` mostra l'avviso.

### 8.4 Scheda YAML

- Mostra lo stesso workflow nel formato di `catalog/`: si può copiare, incollare, importare da
  file ed esportare.
- Le modifiche si validano quando si cambia scheda o si salva. Se il testo è valido, i moduli
  si aggiornano; altrimenti restano invariati e compare l'errore con la riga.
- La conversione e la validazione passano da un endpoint del backend, così lo schema non si
  duplica nel browser.
- Limite noto: i commenti del YAML si perdono passando dai moduli. Lo segnala un avviso.

### 8.5 Evoluzione

Se gli utenti iniziassero a costruire workflow molto più grandi, si potrà aggiungere una tela
come terza vista sullo stesso workflow, senza toccare formato e validazione. Allo stesso modo,
un tetto di spesa per run si potrà aggiungere come campo del workflow se il numero massimo di
esecuzioni (§8.1) non bastasse.

## 9. Test

- **Backend**:
  - validazione (cicli, riferimenti, eccezione del `repeat`, scritture in parallelo,
    compatibilità);
  - scheduler dei passi pronti con un provider finto (parallelismo, errori, saltati con una o
    tutte le dipendenze saltate);
  - verdetti: estrazione con markdown e maiuscole, richiesta di correzione, errore dopo il
    secondo tentativo;
  - `repeat` che si ferma all'OK, al massimo con `fail` e con `continue`; successori che
    partono solo a blocco chiuso;
  - stato del run derivato dai passi: `running` con un ramo in attesa e uno in corso, `waiting`
    quando restano solo attese;
  - approvazione con run `running` e `waiting`, rifiuto, timeout, 409 per workflow cambiato o
    permessi cambiati;
  - ripresa a metà di un grafo e a metà di un `repeat`.
- **Frontend**:
  - conversione moduli ↔ YAML in entrambe le direzioni, catena senza `needs` e grafo con
    `needs` su tutti i passi;
  - aggiornamento di tutti i riferimenti quando si rinomina un passo;
  - layout dell'anteprima su grafi tipici (catena, ventaglio, rombo, blocco `repeat`).

## 10. Piano di lavoro

1. **Nomi dei passi e `{{steps.x}}`**, con `needs` di default al precedente: compatibile,
   risolve subito il caso dei più input. Include `stepsJson` per `id` ed eventi con `id`.
   *Fatto*: `needs` espliciti sono già accettati e validati, ma i passi girano uno alla volta
   in ordine topologico; il parallelismo arriva al punto 4.
2. **Stato del run derivato dai passi e approvazione** (§6.1, §6.2), insieme alla coda del
   documento sul background (stato `waiting`). Lo scheduler va scritto già per i passi pronti,
   anche se a questo punto il grafo è ancora una catena.
   *Fatto*: scheduler dei passi pronti (uno alla volta), `approval`, endpoint in
   `src/workflows/run-steps.controller.ts`, timeout, approvazione e rifiuto nel pannello dei
   workflow. Restano per dopo i pulsanti Approva nella sezione Attività (oggi il run in attesa
   si apre da lì) e il controllo sulle scritture in parallelo all'approvazione (punto 4).
3. **Verdetti e `repeat`**, per il caso più richiesto: correggi e verifica. Semantica del
   blocco ed eccezione alla regola 3 vanno fatte insieme.
   *Fatto*: verdetti con seconda richiesta nella stessa sessione, blocchi `repeat` con
   `onMax`, storico delle iterazioni, ripresa dall'ultima iterazione completa, esempio
   `review-and-fix` con verifica, opzioni nell'editor. `{{iteration}}` vale sia nel passo che si
   ripete sia nella sua verifica; la verifica non può chiedere approvazione.
4. **`needs` espliciti e passi in parallelo**, con il controllo sulle scritture e il
   coalescer per passo.
5. **`when`** basato sui verdetti, con le regole dei saltati.
6. **Frontend**: moduli estesi in parallelo ai punti 1–5, poi l'anteprima SVG e il suo riuso
   nella pagina del run, infine la scheda YAML.
