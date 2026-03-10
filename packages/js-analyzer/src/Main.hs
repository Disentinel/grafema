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

import AST.Types (ASTNode)
import AST.Decode ()      -- FromJSON instance
import Output.Encode ()   -- ToJSON instances
import Analysis.Types (FileAnalysis)
import Analysis.Walker (walkProgram)
import Analysis.Context (runAnalyzer)
import Analysis.NodeId (makeModuleId)
import Analysis.Resolve (resolveFileRefs)
import Grafema.Protocol (readFrame, writeFrame)

-- ── Daemon protocol types ──────────────────────────────────────────────

data DaemonRequest = DaemonRequest
  { drFile :: !T.Text
  , drAst  :: !ASTNode
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

-- | Analyze a program AST and produce a FileAnalysis result.
analyzeProgram :: T.Text -> ASTNode -> FileAnalysis
analyzeProgram fileTxt program =
  let moduleId  = makeModuleId fileTxt
      rawResult = runAnalyzer fileTxt moduleId (walkProgram program)
  in  resolveFileRefs rawResult

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
          let !result = analyzeProgram (drFile req) (drAst req)
              resp = DaemonOk result
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
    else do
      let file = case filter (/= "--daemon") args of
            [f] -> f
            _   -> "unknown"
      input <- BL.getContents
      case eitherDecode input :: Either String ASTNode of
        Left err -> do
          hPutStrLn stderr $ "Parse error: " ++ err
          exitFailure
        Right program -> do
          let result = analyzeProgram (T.pack file) program
          BL.putStr (encode result)
