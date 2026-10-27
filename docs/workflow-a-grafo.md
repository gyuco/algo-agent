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
| `when` | no | — | Condizione per eseguire il passo (§4.4). Se è falsa il passo è *saltato*. |
| `approval` | no | `false` | Il run si ferma e attende che l'utente approvi prima di eseguire il passo. |
| `repeat` | no | — | Ripete il passo finché vale una condizione (§4.5). |

Il default di `needs` mantiene **compatibili tutti i workflow esistenti**: senza `id` né
`needs` si ottiene esattamente la catena di oggi.

Il limite di 10 passi resta. È un limite di leggibilità, non tecnico.

### 4.2 Variabili

| Variabile | Valore |
|---|---|
| `{{input}}` | Il testo inserito dall'utente all'avvio. |
| `{{steps.<id>}}` | L'output del passo `<id>`; vuoto se il passo è stato saltato. |
| `{{previous}}` | Mantenuta per compatibilità: l'output dell'unico passo in `needs`. Con più dipendenze è un errore di validazione. |
| `{{iteration}}` | Dentro un `repeat`: il numero dell'iterazione, da 1. |

Un prompt può riferirsi solo a passi presenti nelle sue dipendenze, dirette o indirette. Questo
garantisce che l'output esista quando il passo parte.

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

- un passo può dichiarare `verdict: [ok, problemi]`, cioè un elenco di valori ammessi;
- al prompt si aggiunge in automatico l'istruzione di chiudere la risposta con una riga
  `VERDETTO: <valore>`;
- l'executor la estrae; se manca o non è tra i valori ammessi, il passo è in errore;
- `when` confronta solo verdetti: `when: { step: review, verdict: problemi }`.

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
```

- `with` indica un passo che dipende solo da questo e che dichiara un `verdict`. A ogni
  iterazione si eseguono il passo e poi la verifica.
- Il ciclo finisce quando la verifica restituisce il verdetto `until`. Arrivato a `max`
  iterazioni senza esito, il passo è in errore e il run termina come `failed`, con
  il motivo.
- Nelle iterazioni successive `{{steps.check}}` contiene l'ultima verifica, così l'agente sa
  cosa resta da correggere.

## 5. Validazione al salvataggio

Si estende `workflowSchema`, e il controllo incrociato che già verifica gli agenti
sconosciuti (`catalog.ts`), con queste regole:

1. `id` unici; `needs`, `when` e `repeat.with` fanno riferimento a passi esistenti.
2. Il grafo delle dipendenze è aciclico (ordinamento topologico).
3. Ogni `{{steps.x}}` di un prompt fa riferimento a un antenato del passo.
4. `{{previous}}` è ammesso solo con un'unica dipendenza.
5. `when` usa solo passi con `verdict` e valori dichiarati.
6. **Scritture in parallelo:** due passi che possono girare insieme (nessuno dei due è antenato
   dell'altro) non possono avere entrambi agenti con `files: write`. Il controllo va ripetuto
   all'avvio del run, perché i permessi di un agente possono cambiare dopo il salvataggio del
   workflow.

I messaggi di errore indicano il passo e il campo, così il frontend li mostra accanto al campo
giusto (§8.1).

## 6. Esecuzione

L'executor descritto in [esecuzione-in-background.md](esecuzione-in-background.md) segue questo
schema:

- **Passi pronti.** Un passo parte quando tutte le sue dipendenze sono *completate* o *saltate*.
  I passi pronti partono insieme, entro un limite per run (`RUNS_MAX_PARALLEL_STEPS`, default 3)
  e i limiti globali di concorrenza.
- **Stati di un passo:** `pending`, `waiting_approval`, `running`, `done`, `skipped`, `failed`,
  `aborted`.
- **Errori.** Il primo passo in errore impedisce l'avvio di nuovi passi. Quelli già in corso
  finiscono, poi il run termina come `failed`.
- **Saltati.** Se `when` è falso, il passo è `skipped` e anche i passi che dipendono solo da lui
  vengono saltati, a meno che non abbiano altre dipendenze completate.
- **`stepsJson`** diventa un oggetto per `id`:
  `{ stato, agente, output, verdetto, iterazioni, costo, inizio, fine }`.
  I run vecchi, salvati come array, si leggono convertendo l'indice in `step-<n>`.
- **Eventi.** Quelli dello stream portano l'`id` del passo: `step_started`, `step_finished`,
  `step_skipped`, `approval_requested`. Così il frontend sa a quale nodo associare testo e tool.

### 6.1 Approvazione

- Quando un passo con `approval: true` diventa pronto, va in `waiting_approval` e il run passa
  allo stato `waiting`. Questo stato si aggiunge al ciclo di vita del documento sul background.
  Un run in attesa **non occupa** posti di concorrenza.
- `POST …/runs/:id/steps/:stepId/approve` e `…/reject` (rifiuto con nota facoltativa). Il
  rifiuto fa terminare il run come `aborted`.
- Le altre parti del grafo che non dipendono dal passo in attesa continuano a girare.
- Un'attesa troppo lunga (`RUNS_APPROVAL_TIMEOUT_HOURS`, default 72) chiude il run come
  `aborted`.
- La richiesta di approvazione deve bastare per decidere: mostra il prompt già compilato del
  passo e i permessi effettivi dell'agente.

### 6.2 Ripresa

Riprendere un run `interrupted` o `failed` copia i passi `done` e `skipped` e riparte da tutti
gli altri. Per i passi con `repeat` si riparte dall'iterazione interrotta, con l'ultima verifica
salvata.

## 7. Backend: modifiche

| File | Modifica |
|---|---|
| `src/catalog/catalog.ts` | Nuovo schema dei passi, normalizzazione dei default (`id`, `needs`), validazione del §5. |
| `src/catalog/catalog.spec.ts` | Test per ogni regola di validazione e per la compatibilità con i workflow attuali. |
| `src/workflows/workflows.service.ts` | Da ciclo `for` a scheduler di passi pronti; compilazione delle variabili; verdetti, `when`, `repeat`, approvazioni. |
| `src/workflows/workflows.controller.ts` | Endpoint di approvazione e rifiuto. |
| `catalog/workflows/review-and-fix.yaml` | Esempio aggiornato con verifica e `repeat`, più uno nuovo con revisioni in parallelo. |
| `catalog/README.md` | Documentazione del nuovo formato. |

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
  Rinominarlo aggiorna i riferimenti `{{steps.x}}` negli altri prompt.
- **Agente**: come oggi. Accanto, un'etichetta con i permessi sui file (`lettura`, `scrittura`).
- **Dipende da**: caselle con gli altri passi, con il precedente spuntato di default. Non si
  possono scegliere passi che creerebbero un ciclo.
- **Prompt**: area di testo con i pulsanti per inserire `{{input}}` e `{{steps.<nome>}}`.
  Vengono offerti solo gli antenati del passo, quindi i riferimenti sbagliati non si possono
  scrivere.
- **Opzioni avanzate**, chiuse di default:
  - "Chiedi approvazione prima di eseguire";
  - "Verdetto" con i valori ammessi;
  - "Esegui solo se…" (passo e verdetto da menu);
  - "Ripeti finché…" (passo di verifica, verdetto, massimo).
- **Errori** sotto il campo interessato, sia quelli calcolati nel browser (riferimenti, cicli)
  sia quelli restituiti dal backend al salvataggio (§5).
- **Ordine**: pulsanti su e giù. L'ordine conta solo per la lettura e per il default di `needs`.

### 8.2 Anteprima del grafo

- Componente SVG senza librerie, accanto ai moduli su schermi larghi e sotto su mobile.
- Layout a livelli: il livello di un passo è la lunghezza del percorso più lungo dalle radici.
  I nodi di uno stesso livello sono affiancati e gli archi vanno da un livello al successivo.
  Con al massimo 10 nodi non serve altro.
- Ogni nodo mostra nome, agente e icone di approvazione, condizione e ripetizione. Un `repeat`
  si disegna come freccia di ritorno verso il passo di verifica, solo come decorazione.
- Cliccare un nodo porta al passo corrispondente nel modulo.
- Si aggiorna mentre si modifica; i nodi con errori sono evidenziati.
- Colori come variabili CSS in `index.css`, per tema chiaro e scuro.

### 8.3 Lo stesso grafo nella pagina del run

Il componente si riusa in `WorkflowsPanel.tsx` per seguire un run:

- colore e icona di ogni nodo seguono lo stato del passo (§6), aggiornati dagli eventi
  `step_*` dello stream;
- cliccando un nodo si vede il suo output e i tool chiamati;
- un nodo in `waiting_approval` mostra i pulsanti Approva e Rifiuta con il prompt già compilato;
- per un `repeat` si vede l'iterazione corrente ("2 di 3").

### 8.4 Scheda YAML

- Mostra lo stesso workflow nel formato di `catalog/`: si può copiare, incollare, importare da
  file ed esportare.
- Le modifiche si validano quando si cambia scheda o si salva. Se il testo è valido, i moduli
  si aggiornano; altrimenti restano invariati e compare l'errore con la riga.
- Serve un parser YAML nel browser (es. `yaml`, leggero) oppure un endpoint del backend che
  converte e valida. L'endpoint evita di duplicare lo schema ed è preferibile.
- Limite noto: i commenti del YAML si perdono passando dai moduli. Lo segnala un avviso.

### 8.5 Evoluzione

Se gli utenti iniziassero a costruire workflow molto più grandi, si potrà aggiungere una tela
come terza vista sullo stesso workflow, senza toccare formato e validazione.

## 9. Test

- **Backend**:
  - validazione (cicli, riferimenti, scritture in parallelo, compatibilità);
  - scheduler dei passi pronti con un provider finto (parallelismo, errori, saltati);
  - verdetti mancanti o non validi;
  - `repeat` che si ferma all'OK e al massimo;
  - approvazione, rifiuto e timeout;
  - ripresa a metà di un grafo.
- **Frontend**:
  - conversione moduli ↔ YAML in entrambe le direzioni;
  - aggiornamento dei riferimenti quando si rinomina un passo;
  - layout dell'anteprima su grafi tipici (catena, ventaglio, rombo).

## 10. Piano di lavoro

1. **Nomi dei passi e `{{steps.x}}`**, con `needs` di default al precedente: compatibile,
   risolve subito il caso dei più input.
2. **Approvazione**, da fare insieme alla coda del documento sul background (stato `waiting`).
3. **Verdetti e `repeat`**, per il caso più richiesto: correggi e verifica.
4. **`needs` espliciti e passi in parallelo**, con il controllo sulle scritture.
5. **`when`** basato sui verdetti.
6. **Frontend**: moduli estesi in parallelo ai punti 1–5, poi l'anteprima SVG e il suo riuso
   nella pagina del run, infine la scheda YAML.
