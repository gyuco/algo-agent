# Prova del sandbox (fase 2, §0)

Macchina: macOS 27.0.1, `/usr/bin/sandbox-exec` presente, `bwrap` assente (non serve qui).
Node: v22.23.4 installato con nvm, quindi in `~/.nvm` dentro la home.

Il profilo è quello generato da `MacSandbox` (`src/missions/sandbox.ts`), passato a
`sandbox-exec -f <profilo> -D NOME=valore … -- <comando>`: nessun percorso è interpolato nel
testo del profilo.

Progetto di prova: cartella temporanea con `package.json` (`prisma@7.10.1`, `vitest@^3.2.4`),
`schema.prisma` con `prisma-client` e SQLite, `prisma.config.ts`, una migrazione, un test che
apre un server su `localhost` e uno script `build`. `HOME` e `TMPDIR` puntavano a una cartella
dentro `DATA_DIR`; la cache npm era `<DATA_DIR>/sandbox-cache/npm`.

## Risultati

| Prova | Esito | Note |
|---|---|---|
| `npm ci` con la rete aperta, `HOME` finta e cache condivisa | passa | cache fredda: servono rete e registry |
| `npm ci` con la rete chiusa e la cache calda | passa | con la cache calda il registry non serve |
| `npm run build` con la rete chiusa | passa | |
| `node -v` da nvm dentro `HOME` | passa | `~/.nvm` non è fra le negazioni |
| `prisma generate` con la rete chiusa | passa | scrive il client dentro il worktree |
| `prisma migrate deploy` su SQLite dentro il worktree | passa | |
| `vitest run` con un test che apre un server su `localhost` | passa | |
| `cat ~/.ssh/known_hosts` | negata | `Operation not permitted` |
| lettura del DB in `DATA_DIR` | negata | |
| lettura della cartella di un altro progetto | negata | |
| scrittura in `HOME` | negata | |
| scrittura in un altro progetto | negata | |
| scrittura nel worktree | permessa | |
| connessione a `1.1.1.1:443` fuori da `setup` | negata | |
| connessione a `1.1.1.1:443` in `setup` | permessa | la rete in `setup` è aperta del tutto |
| `git status` e `git log` nel worktree, con `.git` nel progetto | passano | serve `file-read-metadata` sulla cartella del progetto |
| `npm ci --ignore-scripts`, poi `prisma generate` | passano | con Prisma 7 gli engine sono nei pacchetti: nessuno script necessario |

## Cosa ha richiesto una correzione al profilo di partenza

1. **`TMPDIR` sta sotto `DATA_DIR`.** `npm` e Prisma risolvono il path reale della cartella
   temporanea (`realpath`, quindi `lstat` di ogni componente): con `DATA_DIR` negata in lettura
   anche i metadati, `npm ci` falliva con `EPERM` su `DATA_DIR`. Si aggiunge
   `(allow file-read-metadata (subpath (param "DATA_DIR")))`: si può stat, non leggere.
2. **Git in un worktree.** `git status` cercava di stat la cartella del progetto, negata in
   lettura: serve `(allow file-read-metadata (subpath (param "PROJECT_n")))` per ogni progetto.
3. **Percorsi risolti.** I parametri vanno passati dopo `realpath`: su macOS `/var` è
   `/private/var` e il kernel confronta i percorsi risolti. `MacSandbox.wrap` lo fa per
   worktree, cache, `DATA_DIR`, home, `.git` e progetti.

## Decisioni

- **Script di installazione**: si tengono. `npm ci --ignore-scripts` seguito da `prisma
  generate` passa con Prisma 7, ma non è una garanzia per gli altri progetti; la regola della
  §3.4 resta quella scritta: `--ignore-scripts` solo quando `scope.dependencies` non è vuoto,
  cioè per le dipendenze nuove dei task, già filtrate dal perimetro.
- **Rete in `setup`**: aperta del tutto. `sandbox-exec` non filtra per nome host: la
  correzione alla §8.2 del documento principale è dovuta.
- La prova è stata fatta con una cache npm calda e una fredda: la prima `npm ci` ha bisogno
  della rete, le successive no. La cache è condivisa fra le missioni.
