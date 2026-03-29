{-# LANGUAGE OverloadedStrings #-}
module PhpTypeResolution (run, resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)
import PhpIndex

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import System.IO (hPutStrLn, stderr)

-- Split comma-separated type names
splitTypes :: Text -> [Text]
splitTypes = filter (not . T.null) . map T.strip . T.splitOn ","

resolveAll :: [GraphNode] -> IO [PluginCommand]
resolveAll nodes = do
  let modIdx  = buildModuleIndex nodes
      nameIdx = buildNameIndex nodes modIdx
      impIdx  = buildImportIndex nodes

  let extendsEdges    = resolveExtends modIdx impIdx nameIdx nodes
      implementsEdges = resolveImplements modIdx impIdx nameIdx nodes
      traitEdges      = resolveTraits modIdx impIdx nameIdx nodes

      allEdges = extendsEdges ++ implementsEdges ++ traitEdges

  hPutStrLn stderr $
    "php-type-resolve: " ++ show (length allEdges) ++ " type edges"
    ++ " (EXTENDS=" ++ show (length extendsEdges)
    ++ ", IMPLEMENTS=" ++ show (length implementsEdges)
    ++ ", TRAITS=" ++ show (length traitEdges) ++ ")"

  return allEdges

resolveExtends :: ModuleIndex -> ImportIndex -> NameIndex -> [GraphNode] -> [PluginCommand]
-- For CLASS: single extends (metadata "extends" is MetaText with one name)
-- For INTERFACE: can extend multiple (comma-separated)
resolveExtends modIdx impIdx nameIdx = concatMap go
  where
    go node
      | gnType node == "CLASS" =
          case getMetaText "extends" node of
            Nothing -> []
            Just name ->
              case lookupFQName name (gnFile node) modIdx impIdx nameIdx of
                Just (_, targetId) -> [mkEdge (gnId node) targetId "EXTENDS"]
                Nothing -> []
      | gnType node == "INTERFACE" =
          case getMetaText "extends" node of
            Nothing -> []
            Just extendsStr ->
              [ mkEdge (gnId node) targetId "EXTENDS"
              | typeName <- splitTypes extendsStr
              , Just (_, targetId) <- [lookupFQName typeName (gnFile node) modIdx impIdx nameIdx]
              ]
      | otherwise = []

resolveImplements :: ModuleIndex -> ImportIndex -> NameIndex -> [GraphNode] -> [PluginCommand]
resolveImplements modIdx impIdx nameIdx = concatMap go
  where
    go node
      | gnType node == "CLASS" || gnType node == "ENUM" =
          case getMetaText "implements" node of
            Nothing -> []
            Just implStr ->
              [ mkEdge (gnId node) targetId "IMPLEMENTS"
              | typeName <- splitTypes implStr
              , Just (_, targetId) <- [lookupFQName typeName (gnFile node) modIdx impIdx nameIdx]
              ]
      | otherwise = []

resolveTraits :: ModuleIndex -> ImportIndex -> NameIndex -> [GraphNode] -> [PluginCommand]
resolveTraits modIdx impIdx nameIdx = concatMap go
  where
    go node
      | gnType node == "CLASS" =
          case getMetaText "traits" node of
            Nothing -> []
            Just traitsStr ->
              [ EmitEdge GraphEdge
                  { geSource = gnId node
                  , geTarget = targetId
                  , geType = "EXTENDS"
                  , geMetadata = Map.singleton "via" (MetaText "trait_use")
                  }
              | typeName <- splitTypes traitsStr
              , Just (_, targetId) <- [lookupFQName typeName (gnFile node) modIdx impIdx nameIdx]
              ]
      | otherwise = []

run :: IO ()
run = do
  nodes <- readNodesFromStdin
  commands <- resolveAll nodes
  writeCommandsToStdout commands
