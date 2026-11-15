# Bloco de Notas (Haskell + SQLite)

Notas de texto e de código, com realce de sintaxe, busca e salvamento automático.

- **Back-end:** Haskell com [Scotty](https://hackage.haskell.org/package/scotty)
- **Banco:** SQLite — um único arquivo `notes.db`, criado sozinho na primeira execução. Nada para instalar ou configurar.
- **Front-end:** HTML/CSS/JS puro (sem build), responsivo, tema claro/escuro automático. Realce de código com highlight.js (CDN).

## Rodar

```bash
cabal build
cabal run notas
```

Abra http://localhost:3000. Rode a partir desta pasta (o servidor lê `static/`).

Variáveis opcionais: `PORT` (padrão `3000`) e `NOTES_DB` (padrão `notes.db`).

### Problemas comuns no Windows

- **Download falha com 503/403:** no `C:\cabal\config`, troque `url: http://hackage.haskell.org/` por `url: https://hackage.haskell.org/`.
- **Erros "does not exist" / "invalid argument" ao compilar:** o caminho da pasta é longo demais (limite de 260 caracteres). Use uma pasta de build curta: `cabal build --builddir=C:\b`.

## API

| Método | Rota               | Corpo / parâmetros                                   |
|--------|--------------------|------------------------------------------------------|
| GET    | `/api/notes`       | `?q=texto` (opcional) — busca em título, conteúdo e linguagem |
| GET    | `/api/notes/:id`   |                                                      |
| POST   | `/api/notes`       | `{ "title", "content", "kind": "text"\|"code", "language" }` |
| PUT    | `/api/notes/:id`   | mesmo corpo do POST                                  |
| DELETE | `/api/notes/:id`   |                                                      |

## Atalhos no editor

- `Ctrl+S` salva na hora (também salva sozinho ao parar de digitar)
- Em notas de código: `Tab` insere 4 espaços e `Enter` mantém a indentação

## Estrutura

```
app/Main.hs        servidor + acesso ao banco
static/index.html  página
static/style.css   estilos (responsivo)
static/app.js      lógica do front-end
notas.cabal
```
