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

-- | Index of struct field types: (structName, fieldName) → fieldTypeName.
type FieldTypeIndex = Map (Text, Text) Text

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

-- | Build field type index from RECORD_FIELD nodes with typeAnnotation.
-- Extracts the struct name from the semantic ID (parent of the field).
buildFieldTypeIndex :: [GraphNode] -> FieldTypeIndex
buildFieldTypeIndex nodes =
  Map.fromList
    [ ((structName, gnName n), ty)
    | n <- nodes
    , gnType n == "RECORD_FIELD"
    , not (T.null (gnName n))
    , Just ty <- [lookupTypeAnnotation (gnMetadata n)]
    , Just structName <- [extractStructName (gnId n)]
    ]

-- | Extract struct name from a RECORD_FIELD semantic ID.
-- Format: @...STRUCT->StructName...@ or @...STRUCT-%3EStructName...@
extractStructName :: Text -> Maybe Text
extractStructName sid =
  let tryM m = case T.breakOn m sid of
        (_, rest)
          | T.null rest -> Nothing
          | otherwise ->
              let after = T.drop (T.length m) rest
                  name = T.takeWhile (\c -> c `notElem` [']', '[', '%', '#']) after
              in if T.null name then Nothing else Just name
  in case tryM "STRUCT-%3E" of
       Just t  -> Just t
       Nothing -> tryM "STRUCT->"

-- | Extract typeAnnotation from metadata.
lookupTypeAnnotation :: Map Text MetaValue -> Maybe Text
lookupTypeAnnotation meta =
  case Map.lookup "typeAnnotation" meta of
    Just (MetaText t) -> Just t
    _                 -> Nothing

-- | Resolve method calls using type information.
resolveAll :: [GraphNode] -> IO [PluginCommand]
resolveAll nodes = do
  let implIdx  = buildImplMethodIndex nodes
      varIdx   = buildVarTypeIndex nodes
      fieldIdx = buildFieldTypeIndex nodes
      callNodes = filter isMethodCall nodes
      results = concatMap (resolveOne implIdx varIdx fieldIdx) callNodes
  hPutStrLn stderr $ "[rust-cross-methods] implIdx=" ++ show (Map.size implIdx)
    ++ " varIdx=" ++ show (Map.size varIdx)
    ++ " fieldIdx=" ++ show (Map.size fieldIdx)
    ++ " calls=" ++ show (length callNodes)
    ++ " resolved=" ++ show (length results)
  return results

-- | Check if a node is a method call.
isMethodCall :: GraphNode -> Bool
isMethodCall n =
  gnType n == "CALL" &&
  Map.lookup "method" (gnMetadata n) == Just (MetaBool True)

-- | Try to resolve a single method call.
resolveOne :: ImplMethodIndex -> VarTypeIndex -> FieldTypeIndex -> GraphNode -> [PluginCommand]
resolveOne implIdx varIdx fieldIdx callNode =
  let file     = gnFile callNode
      methName = gnName callNode
      mReceiver = lookupReceiver (gnMetadata callNode)
      -- Determine the containing struct from the semantic ID (for self.field lookups)
      containingStruct = extractImplType (gnId callNode)
  in case mReceiver of
    Nothing -> []
    Just receiver ->
      -- Strategy 1: look up receiver variable type directly
      let mType = Map.lookup (file, receiver) varIdx
          -- Strategy 2: if receiver looks like it could be a struct field,
          -- look up in the field type index using the containing struct
          mFieldType = containingStruct >>= \structName ->
            Map.lookup (structName, receiver) fieldIdx
          typeName = case mType of
            Just t  -> Just t
            Nothing -> mFieldType
      in case typeName of
        Nothing -> []
        Just tn ->
          let baseType = T.takeWhile (\c -> c /= '<' && c /= ':') tn
          in case Map.lookup (baseType, methName) implIdx of
            Nothing -> []
            Just targetId ->
              [ EmitEdge GraphEdge
                  { geSource   = gnId callNode
                  , geTarget   = targetId
                  , geType     = "CALLS"
                  , geMetadata = Map.fromList
                      [ ("resolvedVia",  MetaText "rust-cross-method")
                      , ("receiverType", MetaText tn)
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
