{-# LANGUAGE OverloadedStrings #-}
module Main where

import Data.Aeson (FromJSON(..), ToJSON(..), withObject, (.:), (.:?), (.!=), object, (.=))
import qualified Data.Text as T
import Data.Text (Text)
import System.Environment (getArgs)
import System.IO (stdin, stdout, hSetBinaryMode)
import Options.Applicative
import qualified ImportResolution
import qualified RuntimeGlobals
import qualified Builtins
import qualified CrossFileCalls
import Grafema.Types (GraphNode)
import Grafema.Protocol (PluginCommand(..), readFrame, writeFrame, encodeMsgpack, decodeMsgpack)

-- | A workspace package mapping: npm name → entry point file path.
data WorkspacePackage = WorkspacePackage
  { wpName       :: !Text  -- ^ npm package name (e.g., "@grafema/util")
  , wpEntryPoint :: !Text  -- ^ entry point relative to project root (e.g., "packages/util/src/index.ts")
  , wpPackageDir :: !Text  -- ^ package directory relative to project root (e.g., "packages/util")
  } deriving (Show, Eq)

instance FromJSON WorkspacePackage where
  parseJSON = withObject "WorkspacePackage" $ \v -> WorkspacePackage
    <$> v .: "name"
    <*> v .: "entry_point"
    <*> v .: "package_dir"

-- | Request from orchestrator in daemon mode.
data DaemonRequest = DaemonRequest
  { drCmd               :: Text              -- "imports" | "runtime-globals" | "builtins" | "cross-file-calls"
  , drNodes             :: [GraphNode]
  , drWorkspacePackages :: [WorkspacePackage] -- workspace packages for cross-package resolution
  }

instance FromJSON DaemonRequest where
  parseJSON = withObject "DaemonRequest" $ \v -> DaemonRequest
    <$> v .: "cmd"
    <*> v .: "nodes"
    <*> v .:? "workspace_packages" .!= []

-- | Response to orchestrator.
data DaemonResponse
  = ResOk [PluginCommand]
  | ResError String

instance ToJSON DaemonResponse where
  toJSON (ResOk cmds) = object
    [ "status"   .= ("ok" :: Text)
    , "commands" .= cmds
    ]
  toJSON (ResError msg) = object
    [ "status" .= ("error" :: Text)
    , "error"  .= msg
    ]

-- | Daemon loop: read frames from stdin, dispatch, write responses.
daemonLoop :: IO ()
daemonLoop = do
  mFrame <- readFrame stdin
  case mFrame of
    Nothing -> return ()  -- EOF
    Just payload -> do
      case decodeMsgpack payload of
        Left err -> do
          writeFrame stdout (encodeMsgpack (ResError ("decode error: " ++ err)))
        Right req -> do
          result <- dispatch (drCmd req) (drNodes req) (drWorkspacePackages req)
          writeFrame stdout (encodeMsgpack result)
      daemonLoop

-- | Dispatch a request to the appropriate resolver.
dispatch :: Text -> [GraphNode] -> [WorkspacePackage] -> IO DaemonResponse
dispatch "imports" nodes wsPackages =
  let wsList = map (\wp -> (wpName wp, wpEntryPoint wp, wpPackageDir wp)) wsPackages
  in ResOk <$> ImportResolution.resolveAllWithWorkspace nodes wsList
dispatch "runtime-globals" nodes _ = return $ ResOk (RuntimeGlobals.resolveAll nodes)
dispatch "builtins" nodes _ = return $ ResOk (Builtins.resolveAll nodes)
dispatch "cross-file-calls" nodes _ = return $ ResOk (CrossFileCalls.resolveAll nodes)
dispatch cmd _ _ = return $ ResError ("unknown command: " ++ T.unpack cmd)

-- | Original CLI subcommand parser.
data Command = CmdImports | CmdRuntimeGlobals | CmdBuiltins | CmdCrossFileCalls

commandParser :: Parser Command
commandParser = subparser
  ( command "imports"
    (info (pure CmdImports) (progDesc "Resolve JS/TS imports across files"))
  <> command "runtime-globals"
    (info (pure CmdRuntimeGlobals) (progDesc "Resolve unresolved references to runtime globals"))
  <> command "builtins"
    (info (pure CmdBuiltins) (progDesc "Resolve Node.js builtin module imports and calls"))
  <> command "cross-file-calls"
    (info (pure CmdCrossFileCalls) (progDesc "Create CALLS edges for cross-file invocations"))
  )

cliOpts :: ParserInfo Command
cliOpts = info (commandParser <**> helper)
  ( fullDesc
  <> progDesc "Grafema cross-file resolution plugins"
  <> header "grafema-resolve - resolution plugins for the Grafema graph"
  )

main :: IO ()
main = do
  hSetBinaryMode stdin True
  hSetBinaryMode stdout True
  args <- getArgs
  if "--daemon" `elem` args
    then daemonLoop
    else do
      cmd <- execParser cliOpts
      case cmd of
        CmdImports        -> ImportResolution.run
        CmdRuntimeGlobals -> RuntimeGlobals.run
        CmdBuiltins       -> Builtins.run
        CmdCrossFileCalls -> CrossFileCalls.run
