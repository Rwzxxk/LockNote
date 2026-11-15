{-# LANGUAGE OverloadedStrings #-}

-- Bloco de notas: API REST em Scotty + SQLite (um único arquivo notes.db).
--
--   GET    /api/notes?q=texto   lista (com busca opcional)
--   GET    /api/notes/:id       uma nota
--   POST   /api/notes           cria   {title, content, kind, language}
--   PUT    /api/notes/:id       atualiza
--   DELETE /api/notes/:id       exclui
--
-- O front-end (pasta static/) é servido pelo mesmo processo.
module Main (main) where

import Data.Aeson
import Data.Maybe (fromMaybe)
import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Text.Lazy as TL
import Data.Time (UTCTime, getCurrentTime)
import Database.SQLite.Simple
import Network.HTTP.Types.Status (status201, status204, status400, status404)
import Network.Wai.Middleware.Static (addBase, noDots, staticPolicy, (>->))
import System.Environment (lookupEnv)
import Text.Read (readMaybe)
import Web.Scotty

-- * Modelo -------------------------------------------------------------------

data Note = Note
  { noteId       :: Int
  , noteTitle    :: Text
  , noteContent  :: Text
  , noteKind     :: Text   -- "text" ou "code"
  , noteLanguage :: Text   -- linguagem do código ("" = detecção automática)
  , noteCreated  :: UTCTime
  , noteUpdated  :: UTCTime
  }

instance FromRow Note where
  fromRow = Note <$> field <*> field <*> field <*> field <*> field <*> field <*> field

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

-- | Corpo aceito em POST/PUT. Todos os campos são opcionais.
data NoteInput = NoteInput
  { inTitle    :: Text
  , inContent  :: Text
  , inKind     :: Text
  , inLanguage :: Text
  }

instance FromJSON NoteInput where
  parseJSON = withObject "NoteInput" $ \o ->
    NoteInput
      <$> o .:? "title"    .!= ""
      <*> o .:? "content"  .!= ""
      <*> o .:? "kind"     .!= "text"
      <*> o .:? "language" .!= ""

validKind :: Text -> Bool
validKind k = k `elem` ["text", "code"]

-- * Banco de dados -----------------------------------------------------------

initDb :: Connection -> IO ()
initDb c = do
  execute_ c "PRAGMA journal_mode = WAL"
  execute_ c
    "CREATE TABLE IF NOT EXISTS notes (\
    \  id         INTEGER PRIMARY KEY AUTOINCREMENT,\
    \  title      TEXT NOT NULL DEFAULT '',\
    \  content    TEXT NOT NULL DEFAULT '',\
    \  kind       TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','code')),\
    \  language   TEXT NOT NULL DEFAULT '',\
    \  created_at TEXT NOT NULL,\
    \  updated_at TEXT NOT NULL)"

selectCols :: Query
selectCols = "SELECT id, title, content, kind, language, created_at, updated_at FROM notes"

listNotes :: Connection -> Maybe Text -> IO [Note]
listNotes c mq = case T.strip <$> mq of
  Just q | not (T.null q) ->
    let pat = "%" <> q <> "%"
    in query c (selectCols <> " WHERE title LIKE ? OR content LIKE ? OR language LIKE ? ORDER BY updated_at DESC")
         (pat, pat, pat)
  _ -> query_ c (selectCols <> " ORDER BY updated_at DESC")

getNote :: Connection -> Int -> IO (Maybe Note)
getNote c i = do
  rs <- query c (selectCols <> " WHERE id = ?") (Only i)
  pure $ case rs of
    (n : _) -> Just n
    []      -> Nothing

createNote :: Connection -> NoteInput -> IO (Maybe Note)
createNote c n = do
  now <- getCurrentTime
  execute c
    "INSERT INTO notes (title, content, kind, language, created_at, updated_at) VALUES (?,?,?,?,?,?)"
    (inTitle n, inContent n, inKind n, inLanguage n, now, now)
  i <- lastInsertRowId c
  getNote c (fromIntegral i)

updateNote :: Connection -> Int -> NoteInput -> IO (Maybe Note)
updateNote c i n = do
  now <- getCurrentTime
  execute c
    "UPDATE notes SET title = ?, content = ?, kind = ?, language = ?, updated_at = ? WHERE id = ?"
    (inTitle n, inContent n, inKind n, inLanguage n, now, i)
  changed <- changes c
  if changed == 0 then pure Nothing else getNote c i

deleteNote :: Connection -> Int -> IO Bool
deleteNote c i = do
  execute c "DELETE FROM notes WHERE id = ?" (Only i)
  (> 0) <$> changes c

-- * HTTP ---------------------------------------------------------------------

jsonError :: Text -> ActionM ()
jsonError msg = json (object ["error" .= msg])

notFound404 :: ActionM ()
notFound404 = status status404 >> jsonError "nota não encontrada"

-- | Lê o :id da rota; responde 404 se não for número.
withId :: (Int -> ActionM ()) -> ActionM ()
withId k = do
  idText <- pathParam "id" :: ActionM TL.Text
  maybe notFound404 k (readMaybe (TL.unpack idText))

-- | Lê e valida o corpo JSON.
withInput :: (NoteInput -> ActionM ()) -> ActionM ()
withInput k = do
  n <- jsonData
  if validKind (inKind n)
    then k n
    else status status400 >> jsonError "kind deve ser \"text\" ou \"code\""

main :: IO ()
main = do
  port   <- fromMaybe 3000 . (>>= readMaybe) <$> lookupEnv "PORT"
  dbPath <- fromMaybe "notes.db" <$> lookupEnv "NOTES_DB"
  withConnection dbPath initDb

  -- Uma conexão por requisição: simples e seguro com o servidor multithread.
  let db :: (Connection -> IO a) -> ActionM a
      db f = liftIO (withConnection dbPath f)

  putStrLn $ "Bloco de notas rodando em http://localhost:" ++ show port
  putStrLn $ "Banco de dados: " ++ dbPath

  scotty port $ do
    middleware $ staticPolicy (noDots >-> addBase "static")

    get "/" $ do
      setHeader "Content-Type" "text/html; charset=utf-8"
      file "static/index.html"

    get "/api/notes" $ do
      q <- queryParamMaybe "q"
      json =<< db (`listNotes` q)

    get "/api/notes/:id" $ withId $ \i ->
      db (`getNote` i) >>= maybe notFound404 json

    post "/api/notes" $ withInput $ \n ->
      db (`createNote` n) >>= maybe notFound404 (\note -> status status201 >> json note)

    put "/api/notes/:id" $ withId $ \i -> withInput $ \n ->
      db (\c -> updateNote c i n) >>= maybe notFound404 json

    delete "/api/notes/:id" $ withId $ \i -> do
      ok <- db (`deleteNote` i)
      if ok then status status204 else notFound404
