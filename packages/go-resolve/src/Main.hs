{-# LANGUAGE OverloadedStrings #-}
module Main where

import Data.Aeson (FromJSON(..), ToJSON(..), withObject, (.:), (.:?), (.!=), object, (.=))
import qualified Data.Text as T
import Data.Text (Text)
import System.Environment (getArgs)
import System.IO (stdin, stdout, hSetBinaryMode, hPutStrLn, stderr)
import Grafema.Types (GraphNode, GraphEdge(..))
import Grafema.Protocol (PluginCommand(..), readFrame, writeFrame, encodeMsgpack, decodeMsgpack)
import Data.Maybe (mapMaybe)
import qualified GoImportResolution
import qualified GoCallResolution
import qualified GoInterfaceSatisfaction
import qualified GoTypeResolution
import qualified GoContextPropagation

-- | Workspace package descriptor from orchestrator config.
data WorkspacePackage = WorkspacePackage
  { wpName       :: !Text
  , wpEntryPoint :: !Text
  , wpPackageDir :: !Text
  } deriving (Show, Eq)

instance FromJSON WorkspacePackage where
  parseJSON = withObject "WorkspacePackage" $ \v -> WorkspacePackage
    <$> v .: "name"
    <*> v .: "entry_point"
    <*> v .: "package_dir"

-- | Request from orchestrator in daemon mode.
data DaemonRequest = DaemonRequest
  { drCmd               :: Text
  , drNodes             :: [GraphNode]
  , drWorkspacePackages :: [WorkspacePackage]
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

-- | Extract the module path from workspace packages.
-- Takes the name of the first package as the Go module path.
extractModulePath :: [WorkspacePackage] -> Text
extractModulePath []    = ""
extractModulePath (w:_) = wpName w

-- | Dispatch a command to the appropriate resolver.
dispatch :: Text -> [GraphNode] -> [WorkspacePackage] -> IO DaemonResponse
dispatch "go-imports"    nodes ws = return $ ResOk (GoImportResolution.resolveAll nodes (extractModulePath ws))
dispatch "go-calls"      nodes ws = return $ ResOk (GoCallResolution.resolveAll nodes (extractModulePath ws))
dispatch "go-interfaces" nodes _  = return $ ResOk (GoInterfaceSatisfaction.resolveAll nodes)
dispatch "go-types"      nodes _  = return $ ResOk (GoTypeResolution.resolveAll nodes)
dispatch "go-context"    nodes _  = return $ ResOk (GoContextPropagation.resolveAll nodes [])
dispatch "go-all"        nodes ws = do
  let modPath    = extractModulePath ws
      imports    = GoImportResolution.resolveAll nodes modPath
      calls      = GoCallResolution.resolveAll nodes modPath
      interfaces = GoInterfaceSatisfaction.resolveAll nodes
      types      = GoTypeResolution.resolveAll nodes
      callEdges  = extractCallEdges calls
      context    = GoContextPropagation.resolveAll nodes callEdges
  return $ ResOk (imports ++ calls ++ interfaces ++ types ++ context)
dispatch cmd _ _ = return $ ResError ("unknown command: " ++ T.unpack cmd)

-- | Extract (source, target) pairs from CALLS EmitEdge commands.
extractCallEdges :: [PluginCommand] -> [(Text, Text)]
extractCallEdges = mapMaybe go
  where go (EmitEdge e) | geType e == "CALLS" = Just (geSource e, geTarget e)
        go _ = Nothing

-- | Daemon loop: read frames, dispatch, write responses.
daemonLoop :: IO ()
daemonLoop = do
  mFrame <- readFrame stdin
  case mFrame of
    Nothing -> return ()
    Just payload -> do
      case decodeMsgpack payload of
        Left err -> do
          writeFrame stdout (encodeMsgpack (ResError ("decode error: " ++ err)))
        Right req -> do
          result <- dispatch (drCmd req) (drNodes req) (drWorkspacePackages req)
          writeFrame stdout (encodeMsgpack result)
      daemonLoop

main :: IO ()
main = do
  hSetBinaryMode stdin True
  hSetBinaryMode stdout True
  args <- getArgs
  if "--daemon" `elem` args
    then daemonLoop
    else hPutStrLn stderr "Usage: go-resolve --daemon"
