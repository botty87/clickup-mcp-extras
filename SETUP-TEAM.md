# Setup `clickup-mcp-extras` — guida per il team

MCP server locale che aggiunge a Claude Code i tool ClickUp con **@-mention reali** (notifica + box blu cliccabile) e **immagini dentro i commenti**, come quando incolli uno screenshot nell'app. Coesiste con l'MCP ClickUp ufficiale, che resta attivo per tutto il resto.

## Prerequisiti

- macOS o Linux (su Windows: WSL2 funziona)
- **Node.js ≥ 18** (verifica con `node --version`)
- **Claude Code CLI** installato (`claude --version`)
- Account ClickUp con accesso al workspace dove serviranno le mention

> Se manca Node: `brew install node` (macOS) o nvm/fnm.

## 1. Estrai lo zip

Estrai in una cartella stabile a livello utente (non cestinabile). Convenzione: `~/.local/share/clickup-mcp-extras/`.

```sh
mkdir -p ~/.local/share
unzip clickup-mcp-extras.zip -d ~/.local/share/
cd ~/.local/share/clickup-mcp-extras
```

Se preferisci altro path va bene: ricorda solo di usarlo coerentemente al passo 4.

## 2. Genera il tuo ClickUp Personal API Token

1. Vai su https://app.clickup.com
2. Click sul tuo avatar in basso a sinistra → **Settings**
3. Sidebar → **Apps**
4. Sezione **API Token** → **Generate**
5. Copia il token (formato `pk_xxxxxxxxxxxx...`)

Il token è **personale e privato** — non condividerlo, non committarlo.

## 3. Crea il file `.env`

```sh
cp .env.example .env
```

Apri `.env` e sostituisci `pk_your_token_here` con il token vero. Salva.

`.env` è già in `.gitignore`, non finirà mai su git anche se aggiungerai questa cartella a un repo.

## 4. Installa dipendenze e builda

```sh
./install.sh
```

Lo script fa `npm install` + `npm run build` e stampa il comando esatto da copiare per registrare il server.

In alternativa manualmente:

```sh
npm install
npm run build
```

## 5. Registra l'MCP server in Claude Code

Lo script di setup ti stampa la riga giusta. Sarà tipo:

```sh
claude mcp add clickup-extras --scope user -- node /Users/TUO-USERNAME/.local/share/clickup-mcp-extras/dist/index.js
```

> `--scope user` rende il server disponibile in **tutte** le sessioni Claude Code, non solo nella cartella corrente.

Verifica:

```sh
claude mcp list
```

Deve apparire `clickup-extras: ✓ Connected`. Se vedi `✗ Failed to connect`: probabilmente manca `.env` o il token è errato. Vedi sezione Troubleshooting.

## 6. Riavvia Claude Code

Se Claude Code è già aperto, esci con `/exit` e riapri. Necessario per registrare i tool MCP della sessione.

## 7. Test rapido

In una chat Claude Code:

> Posta un commento sul task ClickUp `<id-task-tuo>` con: "Test setup, ciao @MioNome".

Claude userà `post_comment_with_mentions`. Verifica su ClickUp web: la mention deve apparire come **box blu cliccabile** e devi ricevere la notifica.

Per ottenere il tuo `user_id` (e quello dei colleghi) usa l'MCP ufficiale ClickUp:

> Trovami il mio user_id ClickUp dal workspace `<nome-workspace>`.

(Claude userà `clickup_get_workspace_members`.)

## Tool esposti

### Commenti con @-mention e immagini

Accettano `blocks: Block[]` dove `Block` è:

```ts
{ type: "text", value: "..." }                         // testo normale
{ type: "mention", user_id: 12345 }                     // mention reale
{ type: "image", file_path: "/abs/path.png", width?: 300 } // immagine nel commento
```

- `post_comment_with_mentions(task_id, blocks, notify_all?, assignee?)`
- `reply_to_comment_with_mentions(comment_id, blocks, task_id?, notify_all?, assignee?)` — `task_id` serve solo se ci sono immagini
- `update_comment_with_mentions(comment_id, blocks, resolved?, assignee?)` — solo testo e mention

Le immagini (png, jpg, gif, webp, riconosciute dal contenuto e non dall'estensione; percorso assoluto) vengono caricate come allegato del task e poi mostrate nel commento: compaiono quindi anche nel pannello Allegati del task. ClickUp non permette di aggiungere un'immagine modificando un commento esistente, quindi l'update accetta solo testo e mention e toglie le immagini che il commento aveva: per aggiungere uno screenshot, rispondi al commento.

### Gestione parent / subtask

L'MCP ClickUp ufficiale non espone il campo `parent` nello schema di `update_task`, quindi spostare un subtask da un padre all'altro via tool ufficiale è impossibile. Questi tool colmano il gap:

- `reparent_subtask(task_id, new_parent_id)` — sposta un subtask sotto un nuovo padre
- `set_task_parent(task_id, parent_id)` — alias semantico: rende un task figlio di `parent_id` (se era standalone diventa subtask, se aveva già un padre lo sostituisce)

> Nota: rimuovere completamente il legame parent (promuovere subtask a standalone) **non è supportato** dalla REST API ClickUp v2 — `parent: null` ritorna HTTP 200 ma viene ignorato silenziosamente. Limite del backend ClickUp, non del wrapper.

## Troubleshooting

### `✗ Failed to connect`
- Controlla `.env` esiste e contiene `CLICKUP_API_TOKEN=pk_...`
- Token deve iniziare con `pk_`
- Riprova: `node ~/.local/share/clickup-mcp-extras/dist/index.js < /dev/null` → se stampa `CLICKUP_API_TOKEN missing` → manca `.env`
- Se cambi `.env` riavvia Claude Code

### Mention appare come `@user_12345` invece del nome
- Il `user_id` è errato o l'utente non fa parte del workspace del task
- Recupera lo user_id corretto via `clickup_get_workspace_members`

### `401 Unauthorized` nelle risposte
- Token revocato o errato → rigenera al passo 2

### Modifiche al codice non hanno effetto
- Dopo modifica src: `npm run build` poi riavvia Claude Code

## Aggiornamenti futuri

Se Marco rilascia una nuova versione:

```sh
cd ~/.local/share/clickup-mcp-extras
# scarica nuovo zip, sovrascrivi sorgente (NON .env)
npm install
npm run build
# riavvia Claude Code
```
