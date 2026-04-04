{-# LANGUAGE OverloadedStrings #-}
-- | Rust cross-file method call resolution plugin.
--
-- Resolves method calls like @seg.get_record()@ where the receiver variable
-- has a known type (from 'typeAnnotation' metadata on VARIABLE/PARAMETER nodes)
-- and the method is defined in an impl block in another file.
--
-- == Algorithm
--
-- 1. Build ImplMethodIndex: @(typeName, methodName)@ → @nodeId@
--    from FUNCTION nodes whose semantic ID contains @IMPL_BLOCK->TypeName@.
-- 2. Build VarTypeIndex: @(file, varName)@ → @typeName@
--    from VARIABLE/PARAMETER nodes with @typeAnnotation@ metadata.
-- 3. For each unresolved method CALL (has @method=true@, no CALLS edge yet):
--    a. Look up receiver type: @VarTypeIndex[(file, receiverName)]@
--    b. Look up method target: @ImplMethodIndex[(typeName, methodName)]@
--    c. If found → emit CALLS edge.
--
-- Only produces edges where the type is explicitly known — no guessing.
module RustCrossMethodCalls (run, resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import Data.Map.Strict (Map)
import System.IO (hPutStrLn, stderr)

-- | Index of methods defined inside impl blocks: (typeName, methodName) → nodeId.
type ImplMethodIndex = Map (Text, Text) Text

-- | Index of variable types: (file, varName) → typeName.
type VarTypeIndex = Map (Text, Text) Text

-- | Build impl method index from FUNCTION nodes.
--
-- Extracts the impl type name from the semantic ID. The format is:
-- @file#FUNCTION->methodName[in:...IMPL_BLOCK->TypeName...]@
--
-- We look for @IMPL_BLOCK->@ followed by the type name.
buildImplMethodIndex :: [GraphNode] -> ImplMethodIndex
buildImplMethodIndex nodes =
  Map.fromList
    [ ((typeName, gnName n), gnId n)
    | n <- nodes
    , gnType n == "FUNCTION"
    , not (T.null (gnName n))
    , Just typeName <- [extractImplType (gnId n)]
    ]

-- | Extract impl block type name from a semantic ID.
--
-- @"...IMPL_BLOCK->Shard]"@ → @Just "Shard"@
-- @"...IMPL_BLOCK->Shard[in:From]]"@ → @Just "Shard"@
-- @"...no impl..."@ → @Nothing@
extractImplType :: Text -> Maybe Text
extractImplType sid =
  -- Try both URL-encoded (-%3E, %5B, %5D) and plain (->,[,]) formats
  let marker1 = "IMPL_BLOCK->"
      marker2 = "IMPL_BLOCK-%3E"
      stopChars = [']', '[', '%']  -- % catches %5D/%5B in URL-encoded IDs
      tryMarker m s = case T.breakOn m s of
        (_, rest)
          | T.null rest -> Nothing
          | otherwise ->
              let afterMarker = T.drop (T.length m) rest
                  typeName = T.takeWhile (\c -> c `notElem` stopChars) afterMarker
              in if T.null typeName then Nothing else Just typeName
  in case tryMarker marker2 sid of  -- try URL-encoded first (more common)
       Just t  -> Just t
       Nothing -> tryMarker marker1 sid

-- | Build variable type index from VARIABLE and PARAMETER nodes
-- that have a typeAnnotation metadata field.
buildVarTypeIndex :: [GraphNode] -> VarTypeIndex
buildVarTypeIndex nodes =
  Map.fromList
    [ ((gnFile n, gnName n), ty)
    | n <- nodes
    , gnType n == "VARIABLE" || gnType n == "PARAMETER"
    , not (T.null (gnName n))
    , Just ty <- [lookupTypeAnnotation (gnMetadata n)]
    ]

-- | Extract typeAnnotation from metadata.
lookupTypeAnnotation :: Map Text MetaValue -> Maybe Text
lookupTypeAnnotation meta =
  case Map.lookup "typeAnnotation" meta of
    Just (MetaText t) -> Just t
    _                 -> Nothing

-- | Resolve method calls using type information.
resolveAll :: [GraphNode] -> IO [PluginCommand]
resolveAll nodes = do
  let implIdx = buildImplMethodIndex nodes
      varIdx  = buildVarTypeIndex nodes
      callNodes = filter isMethodCall nodes
      results = concatMap (resolveOne implIdx varIdx) callNodes
  hPutStrLn stderr $ "[rust-cross-methods] implIdx=" ++ show (Map.size implIdx)
    ++ " varIdx=" ++ show (Map.size varIdx)
    ++ " calls=" ++ show (length callNodes)
    ++ " resolved=" ++ show (length results)
  return results

-- | Check if a node is a method call.
isMethodCall :: GraphNode -> Bool
isMethodCall n =
  gnType n == "CALL" &&
  Map.lookup "method" (gnMetadata n) == Just (MetaBool True)

-- | Try to resolve a single method call.
resolveOne :: ImplMethodIndex -> VarTypeIndex -> GraphNode -> [PluginCommand]
resolveOne implIdx varIdx callNode =
  let file     = gnFile callNode
      methName = gnName callNode
      mReceiver = lookupReceiver (gnMetadata callNode)
  in case mReceiver of
    Nothing -> []
    Just receiver ->
      case Map.lookup (file, receiver) varIdx of
        Nothing -> []
        Just typeName ->
          -- Strip generic suffixes: "Vec<String>" → "Vec"
          let baseType = T.takeWhile (\c -> c /= '<' && c /= ':') typeName
          in case Map.lookup (baseType, methName) implIdx of
            Nothing -> []
            Just targetId ->
              [ EmitEdge GraphEdge
                  { geSource   = gnId callNode
                  , geTarget   = targetId
                  , geType     = "CALLS"
                  , geMetadata = Map.fromList
                      [ ("resolvedVia",  MetaText "rust-cross-method")
                      , ("receiverType", MetaText typeName)
                      ]
                  }
              ]

-- | Get receiver name from CALL metadata.
lookupReceiver :: Map Text MetaValue -> Maybe Text
lookupReceiver meta =
  case Map.lookup "receiver" meta of
    Just (MetaText r) | r /= "<expr>" && not (T.null r) -> Just r
    _ -> Nothing

-- | CLI entry point.
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  results <- resolveAll nodes
  writeCommandsToStdout results
