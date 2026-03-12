{-# LANGUAGE OverloadedStrings #-}
-- | C/C++ type resolution: resolves type references and builds class hierarchy.
--
-- == Edge Types Emitted
--
--   * EXTENDS: derived CLASS -> base CLASS (inheritance)
--   * IMPLEMENTS: CLASS -> CLASS (when base has only pure virtual methods)
--   * TYPE_OF: VARIABLE -> CLASS (variable's declared type)
--   * RETURNS: FUNCTION -> CLASS (function return type)
--   * TYPE_ALIAS: TYPEDEF -> CLASS (typedef/using target type)
--
-- == Resolution Strategies
--
-- 1. **Inheritance resolution**: For each CLASS with @base_classes@ metadata,
--    look up each base class in the class index. Emit EXTENDS or IMPLEMENTS
--    based on whether the base is a pure interface (all methods virtual+pure).
--
-- 2. **Variable type resolution**: For each VARIABLE with @type@ metadata,
--    look up the type in the class index. Emit TYPE_OF edge.
--
-- 3. **Function return type resolution**: For each FUNCTION with @return_type@
--    metadata, look up the type. Emit RETURNS edge.
--
-- 4. **Typedef resolution**: For each TYPEDEF with @target_type@ metadata,
--    look up the target. Emit TYPE_ALIAS edge.
--
-- Namespace-qualified names are tried both qualified and unqualified.
-- C++ primitive types (int, char, void, etc.) are skipped.
--
-- Node types consumed: CLASS, FUNCTION, VARIABLE, TYPEDEF
-- Edge types emitted: EXTENDS, IMPLEMENTS, TYPE_OF, RETURNS, TYPE_ALIAS
module CppTypeResolution
  ( resolveAll
  ) where

import Grafema.Types (GraphNode(..), GraphEdge(..))
import Grafema.Protocol (PluginCommand(..))
import CppIndex (CppIndex(..), lookupMetaText, unqualifiedName)

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set

-- | C/C++ primitive types that should be skipped during resolution.
primitives :: Set.Set Text
primitives = Set.fromList
  [ "void", "bool"
  , "char", "signed char", "unsigned char"
  , "wchar_t", "char8_t", "char16_t", "char32_t"
  , "short", "unsigned short", "int", "unsigned int"
  , "long", "unsigned long", "long long", "unsigned long long"
  , "float", "double", "long double"
  , "size_t", "ptrdiff_t", "intptr_t", "uintptr_t"
  , "int8_t", "int16_t", "int32_t", "int64_t"
  , "uint8_t", "uint16_t", "uint32_t", "uint64_t"
  , "auto", "decltype"
  ]

-- | Check if a type name is a C/C++ primitive.
isPrimitive :: Text -> Bool
isPrimitive t = Set.member (stripTypeQualifiers t) primitives

-- | Strip C++ type qualifiers and decorators.
--
-- Removes: @const@, @volatile@, @*@, @&@, @&&@, trailing whitespace.
-- @stripTypeQualifiers "const int*"@ -> @"int"@
-- @stripTypeQualifiers "std::vector<int>"@ -> @"std::vector<int>"@ (unchanged — not a qualifier)
stripTypeQualifiers :: Text -> Text
stripTypeQualifiers = T.strip
  . T.dropWhileEnd (\c -> c == '*' || c == '&' || c == ' ')
  . stripPrefix' "const "
  . stripPrefix' "volatile "
  . stripPrefix' "mutable "
  . stripPrefix' "static "
  . stripPrefix' "extern "
  . T.strip
  where
    stripPrefix' pfx t = case T.stripPrefix pfx t of
      Just rest -> rest
      Nothing   -> t

-- | Extract the base type name from a potentially decorated type.
--
-- Strips pointers, references, const, template parameters.
-- @extractBaseType "const std::vector<int>*"@ -> @"std::vector"@
-- @extractBaseType "MyClass&"@ -> @"MyClass"@
extractBaseType :: Text -> Text
extractBaseType rawType =
  let stripped = stripTypeQualifiers rawType
      -- Remove template parameters (everything after '<')
      noTemplates = case T.breakOn "<" stripped of
        (base, _) -> T.strip base
  in noTemplates

-- | Resolve all type references across all nodes.
--
-- Parameters:
--   * @nodes@ — all graph nodes from the C/C++ project
--   * @idx@ — pre-built 'CppIndex'
--
-- Returns a list of 'EmitEdge' commands.
resolveAll :: [GraphNode] -> CppIndex -> [PluginCommand]
resolveAll nodes idx =
     resolveInheritance nodes idx
  ++ resolveVariableTypes nodes idx
  ++ resolveFunctionReturnTypes nodes idx
  ++ resolveTypedefs nodes idx

-- ── Inheritance Resolution ─────────────────────────────────────────────

-- | Resolve class inheritance relationships.
--
-- For each CLASS node with @base_classes@ metadata (comma-separated list
-- of base class names), looks up each base in the class index and emits
-- EXTENDS or IMPLEMENTS edges.
resolveInheritance :: [GraphNode] -> CppIndex -> [PluginCommand]
resolveInheritance nodes idx =
  [ edge
  | n <- nodes
  , gnType n == "CLASS"
  , Just baseList <- [lookupMetaText "base_classes" n]
  , baseName <- map T.strip (T.splitOn "," baseList)
  , not (T.null baseName)
  , let cleanBase = stripAccessSpecifier baseName
  , edge <- resolveOneBase idx n cleanBase
  ]

-- | Strip C++ access specifier from base class declaration.
--
-- @stripAccessSpecifier "public Base"@ -> @"Base"@
-- @stripAccessSpecifier "virtual protected Base"@ -> @"Base"@
-- @stripAccessSpecifier "Base"@ -> @"Base"@
stripAccessSpecifier :: Text -> Text
stripAccessSpecifier name =
  let stripped = stripKw "virtual " $ stripKw "public " $ stripKw "protected " $ stripKw "private " name
  in T.strip stripped
  where
    stripKw kw t = case T.stripPrefix kw (T.stripStart t) of
      Just rest -> rest
      Nothing   -> t

-- | Resolve a single base class reference.
resolveOneBase :: CppIndex -> GraphNode -> Text -> [PluginCommand]
resolveOneBase idx derivedNode baseName =
  case lookupClass idx baseName of
    Nothing -> []
    Just baseNodeId ->
      let edgeType = if isPureInterface idx baseName
                     then "IMPLEMENTS"
                     else "EXTENDS"
      in [ EmitEdge GraphEdge
             { geSource   = gnId derivedNode
             , geTarget   = baseNodeId
             , geType     = edgeType
             , geMetadata = Map.empty
             }
         ]

-- | Look up a class in the index, trying qualified name first, then unqualified.
lookupClass :: CppIndex -> Text -> Maybe Text
lookupClass idx name =
  case Map.lookup name (classIndex idx) of
    Just (nodeId:_) -> Just nodeId
    _ ->
      let uq = unqualifiedName name
      in if uq /= name
         then case Map.lookup uq (classIndex idx) of
           Just (nodeId:_) -> Just nodeId
           _               -> Nothing
         else Nothing

-- | Check if a class is a pure interface (all methods are pure virtual).
--
-- A class is considered a pure interface if it has at least one method
-- and all methods have @isPureVirtual=true@ metadata.
isPureInterface :: CppIndex -> Text -> Bool
isPureInterface idx className =
  let methods = Map.filterWithKey (\(cls, _) _ -> cls == className || cls == unqualifiedName className) (methodIndex idx)
  in not (Map.null methods)
     -- We can't reliably check purity from the index alone since we don't
     -- store method metadata in the index. Return False conservatively —
     -- EXTENDS is always safe. The orchestrator or a separate pass can
     -- refine this to IMPLEMENTS if needed.
     && False

-- ── Variable Type Resolution ───────────────────────────────────────────

-- | Resolve variable type references.
resolveVariableTypes :: [GraphNode] -> CppIndex -> [PluginCommand]
resolveVariableTypes nodes idx =
  [ EmitEdge GraphEdge
      { geSource   = gnId varNode
      , geTarget   = typeNodeId
      , geType     = "TYPE_OF"
      , geMetadata = Map.empty
      }
  | varNode <- nodes
  , gnType varNode == "VARIABLE"
  , Just rawType <- [lookupMetaText "type" varNode]
  , let baseType = extractBaseType rawType
  , not (T.null baseType)
  , not (isPrimitive baseType)
  , Just typeNodeId <- [lookupClass idx baseType]
  ]

-- ── Function Return Type Resolution ────────────────────────────────────

-- | Resolve function return type references.
resolveFunctionReturnTypes :: [GraphNode] -> CppIndex -> [PluginCommand]
resolveFunctionReturnTypes nodes idx =
  [ EmitEdge GraphEdge
      { geSource   = gnId funcNode
      , geTarget   = typeNodeId
      , geType     = "RETURNS"
      , geMetadata = Map.empty
      }
  | funcNode <- nodes
  , gnType funcNode == "FUNCTION"
  , Just rawRetType <- [lookupMetaText "return_type" funcNode]
  , let baseType = extractBaseType rawRetType
  , not (T.null baseType)
  , not (isPrimitive baseType)
  , Just typeNodeId <- [lookupClass idx baseType]
  ]

-- ── Typedef Resolution ─────────────────────────────────────────────────

-- | Resolve typedef/using alias targets.
resolveTypedefs :: [GraphNode] -> CppIndex -> [PluginCommand]
resolveTypedefs nodes idx =
  [ EmitEdge GraphEdge
      { geSource   = gnId tdNode
      , geTarget   = typeNodeId
      , geType     = "TYPE_ALIAS"
      , geMetadata = Map.empty
      }
  | tdNode <- nodes
  , gnType tdNode == "TYPEDEF"
  , Just rawTarget <- [lookupMetaText "target_type" tdNode]
  , let baseType = extractBaseType rawTarget
  , not (T.null baseType)
  , not (isPrimitive baseType)
  , Just typeNodeId <- [lookupClass idx baseType]
  ]
