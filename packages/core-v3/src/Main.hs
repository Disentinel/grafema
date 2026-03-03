{-# LANGUAGE OverloadedStrings #-}
module Main (main) where

import qualified Data.ByteString.Lazy as BL
import qualified Data.Text as T
import Data.Aeson (eitherDecode, encode)
import System.IO (hPutStrLn, stderr, hSetBinaryMode, stdin, stdout)
import System.Exit (exitFailure)
import System.Environment (getArgs)

import AST.Types (ASTNode)
import AST.Decode ()      -- FromJSON instance
import Output.Encode ()   -- ToJSON instances
import Analysis.Walker (walkProgram)
import Analysis.Context (runAnalyzer)
import Analysis.NodeId (makeModuleId)

main :: IO ()
main = do
  hSetBinaryMode stdin True
  hSetBinaryMode stdout True

  args <- getArgs
  let file = case args of
        [f] -> f
        _   -> "unknown"

  input <- BL.getContents
  case eitherDecode input :: Either String ASTNode of
    Left err -> do
      hPutStrLn stderr $ "Parse error: " ++ err
      exitFailure
    Right program -> do
      let fileTxt   = T.pack file
          moduleId  = makeModuleId fileTxt
          result    = runAnalyzer fileTxt moduleId (walkProgram program)
      BL.putStr (encode result)
