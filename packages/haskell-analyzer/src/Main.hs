{-# LANGUAGE BangPatterns  #-}
{-# LANGUAGE OverloadedStrings #-}
module Main (main) where

import qualified Data.ByteString.Lazy as BL
import qualified Data.Text as T
import qualified Data.Text.IO as TIO
import Data.Aeson (FromJSON(..), ToJSON(..), eitherDecode, encode, (.:),
                   withObject, object, (.=))
import System.IO (hPutStrLn, stderr, hSetBinaryMode, stdin, stdout)
import System.Exit (exitFailure)
import System.Environment (getArgs)

import Analysis.Types (FileAnalysis(..))
import Analysis.Walker (walkModule)
import Analysis.Context (runAnalyzer)
import Parser (parseHaskell)
import Grafema.Protocol (readFrame, writeFrame)
import Grafema.SemanticId (makeModuleId)
import Rules.Coverage (checkCoverage)
import Rules.Dispatch (checkDispatch)

-- ── Daemon protocol types ──────────────────────────────────────────────

data DaemonRequest = DaemonRequest
  { drqFile   :: !T.Text
  , drqSource :: !T.Text
  } deriving (Show)

instance FromJSON DaemonRequest where
  parseJSON = withObject "DaemonRequest" $ \v -> DaemonRequest
    <$> v .: "file"
    <*> v .: "source"

data DaemonResponse
  = DaemonOk !FileAnalysis
  | DaemonError String

instance ToJSON DaemonResponse where
  toJSON (DaemonOk result) = object
    [ "status" .= ("ok" :: T.Text)
    , "result" .= result
    ]
  toJSON (DaemonError msg) = object
    [ "status" .= ("error" :: T.Text)
    , "error"  .= msg
    ]

-- ── Core analysis ──────────────────────────────────────────────────────

-- | Parse source text and analyze the resulting AST.
--
-- Returns @Left errorMsg@ on parse failure, @Right FileAnalysis@ on success.
analyzeSource :: T.Text -> T.Text -> Either String FileAnalysis
analyzeSource file source =
  case parseHaskell (T.unpack file) source of
    Left err -> Left err
    Right hsmod ->
      let moduleId = makeModuleId file
          rawResult = runAnalyzer file moduleId (walkModule hsmod)
          coverageEdges = checkCoverage rawResult
          dispatchEdges = checkDispatch rawResult
      in  Right rawResult { faEdges = faEdges rawResult ++ coverageEdges ++ dispatchEdges }

-- ── Daemon loop ────────────────────────────────────────────────────────

daemonLoop :: IO ()
daemonLoop = do
  mFrame <- readFrame stdin
  case mFrame of
    Nothing -> return ()  -- EOF, exit cleanly
    Just payload -> do
      case eitherDecode payload of
        Left err -> do
          let resp = DaemonError ("decode error: " ++ err)
          writeFrame stdout (encode resp)
        Right req -> do
          let resp = case analyzeSource (drqFile req) (drqSource req) of
                Left err     -> DaemonError err
                Right !result -> DaemonOk result
          writeFrame stdout (encode resp)
      daemonLoop

-- ── Entry point ────────────────────────────────────────────────────────

main :: IO ()
main = do
  hSetBinaryMode stdin True
  hSetBinaryMode stdout True

  args <- getArgs
  if "--daemon" `elem` args
    then daemonLoop
    else case filter (/= "--daemon") args of
      [path] -> do
        source <- TIO.readFile path
        case analyzeSource (T.pack path) source of
          Left err -> do
            hPutStrLn stderr err
            exitFailure
          Right fa -> BL.putStr (encode fa)
      _ -> do
        input <- BL.getContents
        case eitherDecode input of
          Left err -> do
            hPutStrLn stderr $ "JSON decode error: " ++ err
            exitFailure
          Right req -> case analyzeSource (drqFile req) (drqSource req) of
            Left err -> do
              hPutStrLn stderr err
              exitFailure
            Right fa -> BL.putStr (encode fa)
