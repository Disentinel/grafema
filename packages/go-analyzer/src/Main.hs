{-# LANGUAGE BangPatterns  #-}
{-# LANGUAGE OverloadedStrings #-}
module Main (main) where

import qualified Data.ByteString.Lazy as BL
import qualified Data.Text as T
import Data.Aeson (FromJSON(..), ToJSON(..), eitherDecode, encode, (.:),
                   withObject, object, (.=))
import System.IO (hPutStrLn, stderr, hSetBinaryMode, stdin, stdout)
import System.Exit (exitFailure)
import System.Environment (getArgs)

import Analysis.Types (FileAnalysis(..))
import Analysis.Walker (walkFile)
import Analysis.Context (runAnalyzer)
import GoAST (GoFile(..))
import Grafema.Protocol (readFrame, writeFrame)
import Grafema.SemanticId (makeModuleId)

-- ── Daemon protocol types ──────────────────────────────────────────────

data DaemonRequest = DaemonRequest
  { drqFile :: !T.Text
  , drqAst  :: !GoFile
  } deriving (Show)

instance FromJSON DaemonRequest where
  parseJSON = withObject "DaemonRequest" $ \v -> DaemonRequest
    <$> v .: "file"
    <*> v .: "ast"

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

-- | Analyze a pre-parsed Go AST (received as JSON from the orchestrator).
analyzeAst :: T.Text -> GoFile -> FileAnalysis
analyzeAst file ast =
  let moduleId = makeModuleId file
      pkg = gfPackage ast
  in runAnalyzer file moduleId pkg (walkFile ast)

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
          let !result = analyzeAst (drqFile req) (drqAst req)
          writeFrame stdout (encode (DaemonOk result))
      daemonLoop

-- ── Entry point ────────────────────────────────────────────────────────

main :: IO ()
main = do
  hSetBinaryMode stdin True
  hSetBinaryMode stdout True

  args <- getArgs
  if "--daemon" `elem` args
    then daemonLoop
    else do
      input <- BL.getContents
      case eitherDecode input of
        Left err -> do
          hPutStrLn stderr $ "JSON decode error: " ++ err
          exitFailure
        Right req -> BL.putStr (encode (analyzeAst (drqFile req) (drqAst req)))
