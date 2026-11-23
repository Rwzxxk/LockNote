-- ============================================================================
--  LockNote — back-end
-- ============================================================================
--
--  Este arquivo é o servidor inteiro do LockNote. Ele faz três coisas:
--
--    1. Guarda as notas num banco SQLite (um único arquivo, "notes.db").
--    2. Oferece uma API REST (JSON) para o front-end criar, ler, editar,
--       buscar e apagar notas.
--    3. Entrega os arquivos do front-end (HTML, CSS e JS da pasta static/).
--
--  Bibliotecas principais:
--
--    * Scotty         — framework web pequeno, no estilo do Express (Node) ou
--                       do Sinatra (Ruby). Por baixo usa o Warp, um servidor
--                       HTTP rápido e multithread.
--    * sqlite-simple  — acesso ao SQLite. O próprio SQLite vem embutido na
--                       biblioteca, então não há nada para instalar.
--    * aeson          — converte valores Haskell <-> JSON.
--
--  Rotas da API:
--
--    GET    /api/notes?q=texto   lista as notas (busca opcional)
--    GET    /api/notes/:id       devolve uma nota
--    POST   /api/notes           cria uma nota   {title, content, kind, language}
--    PUT    /api/notes/:id       atualiza uma nota
--    DELETE /api/notes/:id       apaga uma nota
--
--  Caminho de uma requisição, por exemplo  PUT /api/notes/3 :
--
--    navegador ──HTTP──► Warp/Scotty ──► rota "put /api/notes/:id"
--        ──► withId     (lê o "3" da URL e confere que é número)
--        ──► withInput  (lê o corpo JSON e valida o "kind")
--        ──► db (updateNote ...)   (abre o banco, roda o UPDATE, fecha)
--        ──► json nota             (devolve a nota atualizada em JSON)
--
--  Organização do arquivo (de cima para baixo):
--    Modelo → Banco de dados → Funções auxiliares HTTP → main (rotas)
-- ============================================================================

-- "Pragma" de linguagem: liga uma extensão do compilador GHC.
-- OverloadedStrings permite escrever "texto" entre aspas e usá-lo como Text,
-- Query (SQL) ou ByteString, e não só como String. Sem isso teríamos que
-- converter cada literal à mão.
{-# LANGUAGE OverloadedStrings #-}

-- O módulo Main exporta só a função "main", o ponto de entrada do programa.
module Main (main) where

-- ---------------------------------------------------------------------------
--  Imports
-- ---------------------------------------------------------------------------
-- Em Haskell cada import diz de onde vem cada nome. "qualified ... as T"
-- obriga a escrever T.strip, T.null etc., o que evita conflito de nomes.

import Data.Aeson                     -- JSON: ToJSON, FromJSON, object, (.=) ...
import Crypto.KDF.PBKDF2 (Parameters(..), fastPBKDF2_SHA256)
import Crypto.Random (getRandomBytes)
import qualified Data.ByteString as BS
import Data.Char (isAsciiLower, isDigit)
import Data.Maybe (fromMaybe)         -- fromMaybe padrao x: usa o padrão quando x é Nothing
import Data.Text (Text)               -- tipo de texto eficiente (Unicode)
import qualified Data.Text as T       -- funções sobre Text (strip, null ...)
import qualified Data.Text.Encoding as TE
import qualified Data.Text.Lazy as TL -- Text "preguiçoso", usado pelo Scotty
import Data.Time (UTCTime, getCurrentTime)   -- datas e hora atual (UTC)
import Database.SQLite.Simple                -- Connection, query, execute ...
import Network.HTTP.Types.Status (status201, status204, status400, status404, status409)
import Network.Wai.Middleware.Static (addBase, noDots, staticPolicy, (>->))
import System.Environment (lookupEnv) -- lê variáveis de ambiente (PORT, NOTES_DB)
import Text.Read (readMaybe)          -- converte texto em número sem quebrar se for inválido
import Web.Scotty                     -- o framework web: get, post, json, status ...

-- ============================================================================
--  MODELO
-- ============================================================================
-- Aqui definimos os tipos de dados do domínio e como eles são convertidos
-- de/para o banco (FromRow) e de/para JSON (ToJSON / FromJSON).

-- | Uma nota como ela existe no banco.
--
-- "data" declara um novo tipo. Esta é a sintaxe de "registro" (record):
-- cada campo ganha um nome, e o Haskell cria automaticamente funções com
-- esses nomes para ler o campo. Por exemplo, noteTitle n devolve o título
-- da nota n.
--
-- O "::" se lê "tem o tipo". Int = número inteiro, Text = texto,
-- UTCTime = data/hora em UTC.
data Note = Note
  { noteId       :: Int       -- chave primária (gerada pelo banco)
  , noteTitle    :: Text
  , noteContent  :: Text
  , noteKind     :: Text      -- "text" (nota comum) ou "code" (nota de código)
  , noteLanguage :: Text      -- linguagem detectada pelo front-end ("" se nenhuma)
  , noteCreated  :: UTCTime   -- quando foi criada
  , noteUpdated  :: UTCTime   -- última edição (usada para ordenar a lista)
  }

-- | Como transformar uma LINHA do resultado SQL numa Note.
--
-- "instance FromRow Note" diz: "Note sabe ser lida de uma linha do banco".
-- Isso é uma type class, parecida com uma interface em Java/C#.
--
-- Cada "field" lê a próxima coluna, na ordem do SELECT (veja selectCols).
-- O padrão  Construtor <$> a <*> b <*> c  é o estilo "aplicativo":
-- lê a, b e c e passa os três para o construtor Note. Se alguma coluna
-- tiver o tipo errado, a leitura inteira falha com um erro claro.
instance FromRow Note where
  fromRow = Note <$> field <*> field <*> field <*> field <*> field <*> field <*> field

-- | Como transformar uma Note em JSON para enviar ao navegador.
--
-- "object [...]" monta um objeto JSON, e  "chave" .= valor  cria cada par.
-- Os nomes das chaves seguem o padrão do JavaScript (camelCase), por isso
-- "createdAt" e não "created_at". As datas viram texto ISO-8601, por
-- exemplo "2026-11-15T18:30:00Z", que o JS entende com new Date(...).
instance ToJSON Note where
  toJSON n = object
    [ "id"        .= noteId n
    , "title"     .= noteTitle n
    , "content"   .= noteContent n
    , "kind"      .= noteKind n
    , "language"  .= noteLanguage n
    , "createdAt" .= noteCreated n
    , "updatedAt" .= noteUpdated n
    ]

-- | O que o cliente pode ENVIAR ao criar (POST) ou editar (PUT) uma nota.
--
-- É um tipo separado de Note de propósito: o cliente não escolhe o id nem
-- as datas, que são decididos pelo servidor. Assim é impossível, por
-- exemplo, um cliente forjar a data de criação.
data NoteInput = NoteInput
  { inTitle    :: Text
  , inContent  :: Text
  , inKind     :: Text
  , inLanguage :: Text
  }

-- | Como ler um NoteInput a partir do JSON recebido.
--
-- withObject exige que o corpo seja um objeto JSON ({...}); se vier outra
-- coisa (um número, uma lista...), a leitura falha e o Scotty responde
-- 400 Bad Request automaticamente.
--
--   o .:? "campo"     lê um campo OPCIONAL (pode faltar no JSON)
--   ... .!= padrão    valor usado quando o campo faltar
--
-- Ou seja, todos os campos são opcionais: um POST com corpo {} cria uma
-- nota de texto vazia.
instance FromJSON NoteInput where
  parseJSON = withObject "NoteInput" $ \o ->
    NoteInput
      <$> o .:? "title"    .!= ""
      <*> o .:? "content"  .!= ""
      <*> o .:? "kind"     .!= "text"
      <*> o .:? "language" .!= ""

-- | Regra de negócio: o tipo da nota só pode ser "text" ou "code".
-- (O banco também garante isso com um CHECK, veja initDb. Validamos aqui
-- antes para devolver uma mensagem de erro amigável em vez de um erro SQL.)
validKind :: Text -> Bool
validKind k = k `elem` ["text", "code"]
-- `elem` entre crases é a função elem usada como operador:
-- "k é elemento da lista [...]?"

data Registration = Registration Text Text Text Text Text

instance FromJSON Registration where
  parseJSON = withObject "Registration" $ \o ->
    Registration <$> o .: "email" <*> o .: "emailConfirmation"
      <*> o .: "username" <*> o .: "password" <*> o .: "passwordConfirmation"

registerAccount :: FilePath -> Registration -> ActionM ()
registerAccount dbPath (Registration rawEmail confirmation rawUsername password passwordConfirmation)
  | not (validRegistrationEmail email) = invalid "Informe um e-mail válido, como nome@exemplo.com."
  | email /= T.toLower (T.strip confirmation) = invalid "Os e-mails precisam coincidir."
  | T.length username < 3 || T.length username > 50 = invalid "O nome de usuário deve ter entre 3 e 50 caracteres."
  | T.length password < 12 || T.length password > 128 = invalid "A senha deve ter entre 12 e 128 caracteres."
  | password /= passwordConfirmation = invalid "As senhas precisam coincidir."
  | otherwise = do
      conflict <- liftIO $ do
        salt <- getRandomBytes 16 :: IO BS.ByteString
        let iterations = 600000
            passwordHash = fastPBKDF2_SHA256 (Parameters iterations 32) (TE.encodeUtf8 password) salt :: BS.ByteString
        withConnection dbPath $ \c -> withTransaction c $ do
          execute c
            "INSERT INTO accounts (email, username, password_salt, password_hash, password_iterations) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING"
            (email, username, salt, passwordHash, iterations)
          inserted <- changes c
          if inserted > 0
            then pure Nothing
            else do
              matches <- query c
                "SELECT EXISTS(SELECT 1 FROM accounts WHERE email = ?), EXISTS(SELECT 1 FROM accounts WHERE username = ?)"
                (email, username) :: IO [(Int, Int)]
              pure $ Just $ case matches of
                [(1, 1)] -> "Este e-mail e este nome de usuário já estão cadastrados."
                [(1, 0)] -> "Este e-mail já está cadastrado."
                [(0, 1)] -> "Este nome de usuário já está cadastrado."
                _ -> "Já existe uma conta com esses dados."
      case conflict of
        Nothing -> status status201 >> json (object ["username" .= username])
        Just message -> status status409 >> jsonError message
  where
    email = T.toLower (T.strip rawEmail)
    username = T.strip rawUsername
    invalid message = status status400 >> jsonError message

validRegistrationEmail :: Text -> Bool
validRegistrationEmail email = T.length email <= 254 && case T.splitOn "@" email of
  [local, domain] ->
    T.length local <= 64
      && all (\part -> not (T.null part) && T.all localChar part) (T.splitOn "." local)
      && case T.splitOn "." domain of
        labels@(_ : _ : _) -> all validLabel labels
        _ -> False
  _ -> False
  where
    letterOrDigit ch = isAsciiLower ch || isDigit ch
    localChar ch = letterOrDigit ch || ch `elem` ("!#$%&'*+-/=?^_`{|}~" :: String)
    validLabel label = not (T.null label)
      && T.length label <= 63
      && letterOrDigit (T.head label)
      && letterOrDigit (T.last label)
      && T.all (\ch -> letterOrDigit ch || ch == '-') label

-- ============================================================================
--  BANCO DE DADOS
-- ============================================================================
-- Todas as funções desta seção recebem uma Connection (conexão aberta com o
-- SQLite) e devolvem algo dentro de IO.
--
-- IO é como o Haskell marca funções que têm efeitos colaterais (ler disco,
-- acessar a rede, consultar a hora...). Uma função com tipo  IO Note  é uma
-- "ação que, quando executada, produz uma Note". O compilador impede que
-- código puro (sem IO) faça efeitos escondidos.
--
-- Segurança: todos os valores vão para o SQL pelos marcadores "?". A
-- biblioteca envia esses valores separados do comando, então não existe
-- risco de SQL injection mesmo que o usuário digite aspas ou SQL na nota.

-- | Prepara o banco na inicialização. Pode rodar várias vezes sem problema.
initDb :: Connection -> IO ()
initDb c = do
  -- WAL ("write-ahead log") permite que leituras aconteçam ao mesmo tempo
  -- que uma escrita, o que é bom para um servidor com várias requisições.
  execute_ c "PRAGMA journal_mode = WAL"
  execute_ c
    "CREATE TABLE IF NOT EXISTS accounts (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, username TEXT NOT NULL COLLATE NOCASE UNIQUE, password_salt BLOB NOT NULL, password_hash BLOB NOT NULL, password_iterations INTEGER NOT NULL)"

  -- Cria a tabela só se ela ainda não existir ("IF NOT EXISTS").
  -- As barras invertidas no fim/início das linhas são a forma do Haskell
  -- de quebrar uma string longa em várias linhas.
  --
  --   AUTOINCREMENT  o banco gera ids 1, 2, 3... e nunca reaproveita um id apagado
  --   NOT NULL       a coluna nunca fica vazia (NULL)
  --   CHECK (...)    o banco recusa qualquer kind diferente de 'text' ou 'code'
  --   created_at e updated_at ficam como TEXT; o sqlite-simple converte
  --   UTCTime <-> texto sozinho.
  execute_ c
    "CREATE TABLE IF NOT EXISTS notes (\
    \  id         INTEGER PRIMARY KEY AUTOINCREMENT,\
    \  title      TEXT NOT NULL DEFAULT '',\
    \  content    TEXT NOT NULL DEFAULT '',\
    \  kind       TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','code')),\
    \  language   TEXT NOT NULL DEFAULT '',\
    \  created_at TEXT NOT NULL,\
    \  updated_at TEXT NOT NULL)"

-- | Início comum de todos os SELECTs.
-- A ORDEM das colunas aqui tem que bater com a ordem dos campos de Note,
-- porque o FromRow lê coluna por coluna, em sequência.
selectCols :: Query
selectCols = "SELECT id, title, content, kind, language, created_at, updated_at FROM notes"

-- | Lista as notas, das editadas mais recentemente para as mais antigas.
--
-- "Maybe Text" é um texto que pode existir ou não: Just "abc" ou Nothing.
-- Em Haskell não existe null; a ausência fica explícita no tipo, e o
-- compilador obriga a tratar os dois casos.
--
-- Se veio um termo de busca não vazio, filtra por título, conteúdo ou
-- linguagem com LIKE '%termo%' (o SQLite ignora maiúsculas/minúsculas
-- para letras sem acento). Senão, devolve tudo.
listNotes :: Connection -> Maybe Text -> IO [Note]
listNotes c mq = case T.strip <$> mq of     -- tira espaços das pontas do termo
  -- "Just q | condição" só entra neste caso se houver termo E ele não for vazio
  Just q | not (T.null q) ->
    let pat = "%" <> q <> "%"                -- "<>" concatena textos
    in query c (selectCols <> " WHERE title LIKE ? OR content LIKE ? OR language LIKE ? ORDER BY updated_at DESC")
         (pat, pat, pat)                     -- um valor para cada "?"
  -- "_" significa "qualquer outro caso" (Nothing ou termo vazio)
  _ -> query_ c (selectCols <> " ORDER BY updated_at DESC")
  -- query  = SELECT com parâmetros;  query_ = SELECT sem parâmetros

-- | Busca uma nota pelo id. Devolve Nothing se ela não existir.
getNote :: Connection -> Int -> IO (Maybe Note)
getNote c i = do
  -- "Only i" é uma tupla de um elemento só (o Haskell não tem tupla de 1).
  rs <- query c (selectCols <> " WHERE id = ?") (Only i)
  -- O resultado é uma lista. "case" faz pattern matching:
  --   (n : _)  lista com pelo menos um elemento: pega o primeiro (n)
  --   []       lista vazia: não achou
  pure $ case rs of
    (n : _) -> Just n
    []      -> Nothing

-- | Insere uma nota nova e devolve a nota como ficou gravada no banco
-- (já com o id e as datas gerados).
createNote :: Connection -> NoteInput -> IO (Maybe Note)
createNote c n = do
  now <- getCurrentTime        -- "<-" executa a ação IO e guarda o resultado
  execute c
    "INSERT INTO notes (title, content, kind, language, created_at, updated_at) VALUES (?,?,?,?,?,?)"
    (inTitle n, inContent n, inKind n, inLanguage n, now, now)
  i <- lastInsertRowId c       -- id que o AUTOINCREMENT acabou de gerar
  getNote c (fromIntegral i)   -- relê a nota; fromIntegral converte Int64 -> Int

-- | Atualiza uma nota existente. Devolve Nothing se o id não existir.
-- O created_at não muda; só o updated_at recebe a hora atual.
updateNote :: Connection -> Int -> NoteInput -> IO (Maybe Note)
updateNote c i n = do
  now <- getCurrentTime
  execute c
    "UPDATE notes SET title = ?, content = ?, kind = ?, language = ?, updated_at = ? WHERE id = ?"
    (inTitle n, inContent n, inKind n, inLanguage n, now, i)
  -- changes = quantas linhas o último comando alterou.
  -- 0 significa que não havia nota com esse id.
  changed <- changes c
  if changed == 0 then pure Nothing else getNote c i

-- | Apaga uma nota. Devolve True se apagou, False se o id não existia.
deleteNote :: Connection -> Int -> IO Bool
deleteNote c i = do
  execute c "DELETE FROM notes WHERE id = ?" (Only i)
  -- (> 0) é uma função "maior que zero" e <$> a aplica ao resultado de
  -- "changes c" sem precisar de uma variável intermediária.
  (> 0) <$> changes c

-- ============================================================================
--  FUNÇÕES AUXILIARES HTTP
-- ============================================================================
-- ActionM é o tipo das "ações" do Scotty: código que roda dentro de uma
-- requisição e pode ler parâmetros, ler o corpo, definir o status e escrever
-- a resposta. ActionM () = uma ação que não devolve valor, só responde.

-- | Responde com um JSON de erro: {"error": "mensagem"}.
jsonError :: Text -> ActionM ()
jsonError msg = json (object ["error" .= msg])

-- | Resposta padrão para "nota não encontrada": status 404 + JSON de erro.
-- ">>" executa uma ação e depois a outra (aqui: define o status, depois escreve o corpo).
notFound404 :: ActionM ()
notFound404 = status status404 >> jsonError "nota não encontrada"

-- | Lê o ":id" da URL e, se for um número, chama k com ele.
-- Se não for número (ex.: /api/notes/abc), responde 404.
--
-- Recebe uma função "k" (de "continuação": o que fazer em seguida). Esse
-- padrão evita repetir a mesma validação em todas as rotas que têm :id:
--
--     withId $ \i -> ... código que já recebe o id como Int ...
--
-- "\i -> ..." é uma função anônima (lambda) que recebe i.
withId :: (Int -> ActionM ()) -> ActionM ()
withId k = do
  idText <- pathParam "id" :: ActionM TL.Text
  -- readMaybe devolve Just numero ou Nothing se o texto não for número.
  -- maybe padrao f valor  =  se valor for Nothing usa o padrão, se for Just x chama f x
  maybe notFound404 k (readMaybe (TL.unpack idText))

-- | Lê o corpo JSON da requisição como NoteInput, valida o "kind" e, se
-- estiver tudo certo, chama k com os dados. Mesmo padrão de withId.
--
-- jsonData usa a instância FromJSON NoteInput lá de cima. Se o JSON for
-- inválido, o próprio Scotty já responde 400 e k nem é chamado.
withInput :: (NoteInput -> ActionM ()) -> ActionM ()
withInput k = do
  n <- jsonData
  if validKind (inKind n)
    then k n
    else status status400 >> jsonError "kind deve ser \"text\" ou \"code\""

-- ============================================================================
--  MAIN — configuração e rotas
-- ============================================================================

main :: IO ()
main = do
  -- Configuração por variáveis de ambiente, com valores padrão:
  --   PORT      porta HTTP           (padrão 3000)
  --   NOTES_DB  caminho do banco     (padrão notes.db, na pasta atual)
  --
  -- Lendo a linha da porta da direita para a esquerda:
  --   lookupEnv "PORT"      -> Maybe String   (a variável pode não existir)
  --   (>>= readMaybe)       -> Maybe Int      (Nothing se não existir OU não for número)
  --   fromMaybe 3000        -> Int            (usa 3000 se deu Nothing)
  port   <- fromMaybe 3000 . (>>= readMaybe) <$> lookupEnv "PORT"
  dbPath <- fromMaybe "notes.db" <$> lookupEnv "NOTES_DB"

  -- Cria o arquivo do banco e a tabela, se ainda não existirem.
  -- withConnection abre a conexão, roda a função e fecha a conexão,
  -- mesmo se der erro no meio.
  withConnection dbPath initDb

  -- Atalho usado por todas as rotas para falar com o banco.
  --
  -- Cada requisição abre a sua própria conexão e a fecha no final. O Warp
  -- atende várias requisições em paralelo (uma thread leve para cada), e
  -- assim nenhuma delas divide conexão com outra. Para um app deste tamanho,
  -- abrir um arquivo SQLite é muito barato.
  --
  -- liftIO "eleva" uma ação IO para dentro de ActionM, porque as rotas
  -- rodam em ActionM e as funções de banco rodam em IO.
  --
  -- O "a" no tipo é genérico: db serve para qualquer função de banco,
  -- devolva ela [Note], Maybe Note ou Bool.
  let db :: (Connection -> IO a) -> ActionM a
      db f = liftIO (withConnection dbPath f)

  putStrLn $ "LockNote rodando em http://localhost:" ++ show port
  putStrLn $ "Banco de dados: " ++ dbPath

  -- A partir daqui, o Scotty sobe o servidor e fica atendendo para sempre.
  -- Dentro do bloco "do" declaramos o middleware e as rotas. A ordem
  -- importa: a primeira rota que casar com a requisição é a que responde.
  scotty port $ do

    -- Middleware = código que roda ANTES das rotas, em toda requisição.
    -- Este serve arquivos estáticos: um pedido como GET /style.css é
    -- respondido com o arquivo static/style.css.
    --   noDots       recusa caminhos com ".." (impede ler arquivos fora de static/)
    --   addBase      acrescenta o prefixo "static/" ao caminho pedido
    --   >->          encadeia as duas regras
    -- Se o arquivo não existir, a requisição segue para as rotas abaixo.
    middleware $ staticPolicy (noDots >-> addBase "static")

    post "/api/accounts" $ jsonData >>= registerAccount dbPath

    -- Página principal: devolve o index.html do front-end.
    get "/" $ do
      setHeader "Content-Type" "text/html; charset=utf-8"
      file "static/index.html"

    -- GET /api/notes?q=termo  → lista (com busca opcional)
    -- queryParamMaybe devolve Nothing quando não há ?q= na URL.
    -- (`listNotes` q) é uma "seção": uma função que ainda espera a Connection,
    -- igual a  \c -> listNotes c q.
    -- "=<<" pega o resultado da ação da direita e passa para "json".
    get "/api/notes" $ do
      q <- queryParamMaybe "q"
      json =<< db (`listNotes` q)

    -- GET /api/notes/:id  → uma nota (200) ou 404
    -- ">>=" encadeia: executa a busca e passa o resultado (Maybe Note) para
    -- "maybe notFound404 json": se for Nothing responde 404, se for
    -- Just nota responde a nota em JSON.
    get "/api/notes/:id" $ withId $ \i ->
      db (`getNote` i) >>= maybe notFound404 json

    -- POST /api/notes  → cria a nota e responde 201 Created com ela.
    post "/api/notes" $ withInput $ \n ->
      db (`createNote` n) >>= maybe notFound404 (\note -> status status201 >> json note)

    -- PUT /api/notes/:id  → atualiza: valida o id, depois o corpo.
    -- Responde 200 com a nota atualizada, ou 404 se o id não existir.
    put "/api/notes/:id" $ withId $ \i -> withInput $ \n ->
      db (\c -> updateNote c i n) >>= maybe notFound404 json

    -- DELETE /api/notes/:id  → 204 No Content (sucesso, sem corpo) ou 404.
    delete "/api/notes/:id" $ withId $ \i -> do
      ok <- db (`deleteNote` i)
      if ok then status status204 else notFound404
