{-# LANGUAGE OverloadedStrings #-}
-- | Shared indexes for PHP cross-file resolution.
--
-- PHP namespaces use @\\@ as separator (e.g., @App\\Models\\User@).
-- The PHP analyzer emits:
--
--   - MODULE nodes with @namespace@ metadata (e.g., @"App\\Models"@)
--   - CLASS, INTERFACE, TRAIT, ENUM, FUNCTION, CONSTANT nodes with simple names
--   - IMPORT_BINDING nodes with @source@ metadata (namespace path) and @name@ (leaf)
--
-- This module builds three indexes consumed by all PHP resolution phases:
--
--   - 'ModuleIndex': file path -> (moduleId, namespace)
--   - 'NameIndex':   fully-qualified name -> (file path, nodeId)
--   - 'FileIndex':   file path -> [(name, type, nodeId)]
module PhpIndex
  ( ModuleIndex
  , NameIndex
  , FileIndex
  , ImportIndex
  , ParamTypeIndex
  , FunctionClassIndex
  , ClassExtendsIndex
  , ClassTraitsIndex
  , MethodIndex
  , PropertyTypeIndex
  , buildModuleIndex
  , buildNameIndex
  , buildFileIndex
  , buildImportIndex
  , buildParamTypeIndex
  , buildFunctionClassIndex
  , buildClassExtendsIndex
  , buildClassTraitsIndex
  , buildMethodIndex
  , buildPropertyTypeIndex
  , lookupMethodInHierarchy
  , lookupFQName
  , getMetaText
  , getMetaBool
  , mkEdge
  , extractParentClass
  , extractEnclosingName
  , normalizePhpType
  , phpPrimitiveTypes
  , isSpecialSelfType
  ) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..))
import Data.List (foldl')
import Data.Text (Text)
import qualified Data.Text as T
import Data.Map.Strict (Map)
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set

-- | Module index: file path -> (moduleId, namespace).
-- Built from MODULE nodes.
type ModuleIndex = Map Text (Text, Text)

-- | Fully-qualified name index: FQ name -> (file path, nodeId).
-- Built from declaration nodes (CLASS, INTERFACE, TRAIT, ENUM, FUNCTION, CONSTANT).
-- FQ name = namespace \\ name (or just name if no namespace).
type NameIndex = Map Text (Text, Text)

-- | File index: file path -> [(name, type, nodeId)].
-- All declarations in a file, for same-file resolution.
type FileIndex = Map Text [(Text, Text, Text)]

-- | Import index: (file, localName) -> fullyQualifiedName.
-- Built from IMPORT_BINDING nodes. Maps imported names to their FQ source.
-- Used to resolve unqualified names through PHP use declarations.
type ImportIndex = Map (Text, Text) Text

-- | Declaration node types that participate in name resolution.
declTypes :: Set.Set Text
declTypes = Set.fromList
  ["CLASS", "INTERFACE", "TRAIT", "ENUM", "FUNCTION", "CONSTANT"]

-- ---------------------------------------------------------------------
-- Index builders
-- ---------------------------------------------------------------------

-- | Build the module index from MODULE nodes.
--
-- Scans all nodes for @gnType == "MODULE"@ and maps @gnFile@ to
-- @(gnId, namespace)@ where namespace comes from @metadata.namespace@.
-- Defaults to @""@ if no namespace metadata is present.
buildModuleIndex :: [GraphNode] -> ModuleIndex
buildModuleIndex nodes =
  let -- First pass: MODULE nodes → file → (moduleId, "")
      modMap = foldl' goModule Map.empty nodes
      -- Second pass: declaration nodes → fill in namespace from first declaration
      withNs = foldl' goDecl modMap nodes
  in withNs
  where
    goModule acc n
      | gnType n == "MODULE" =
          let ns = case Map.lookup "namespace" (gnMetadata n) of
                Just (MetaText t) | not (T.null t) -> t
                _                                  -> ""
          in Map.insert (gnFile n) (gnId n, ns) acc
      | otherwise = acc

    goDecl acc n
      | Set.member (gnType n) declTypes =
          case Map.lookup (gnFile n) acc of
            Just (modId, "") ->
              -- Module exists but namespace is empty — fill from declaration
              case Map.lookup "namespace" (gnMetadata n) of
                Just (MetaText nsText) | not (T.null nsText) ->
                  Map.insert (gnFile n) (modId, nsText) acc
                _ -> acc
            _ -> acc  -- already has namespace or file not in index
      | otherwise = acc

-- | Build the fully-qualified name index from declaration nodes.
--
-- For each CLASS, INTERFACE, TRAIT, ENUM, FUNCTION, or CONSTANT node:
--
-- 1. Look up file in 'ModuleIndex' to get the namespace.
-- 2. If namespace is non-empty: FQ name = @namespace <> \"\\\\\" <> gnName@.
--    Otherwise FQ name = @gnName@.
-- 3. Insert: FQ name -> (gnFile, gnId).
buildNameIndex :: [GraphNode] -> ModuleIndex -> NameIndex
buildNameIndex nodes _modIdx = foldl' go Map.empty nodes
  where
    go acc n
      | Set.member (gnType n) declTypes =
          let ns = case Map.lookup "namespace" (gnMetadata n) of
                Just (MetaText nsText) | not (T.null nsText) -> nsText
                _                                            -> ""
              fqName = if T.null ns
                       then gnName n
                       else ns <> "\\" <> gnName n
          in Map.insert fqName (gnFile n, gnId n) acc
      | otherwise = acc

-- | Build the file index: all declarations grouped by file path.
--
-- For each declaration node, appends @(gnName, gnType, gnId)@ to the
-- list under @gnFile@.
buildFileIndex :: [GraphNode] -> FileIndex
buildFileIndex = foldl' go Map.empty
  where
    go acc n
      | Set.member (gnType n) declTypes =
          let entry = (gnName n, gnType n, gnId n)
          in Map.insertWith (++) (gnFile n) [entry] acc
      | otherwise = acc

-- | Build the import index from IMPORT_BINDING nodes.
--
-- Maps @(file, localName)@ to the fully-qualified name from @source@
-- metadata. Used by 'lookupFQName' to resolve imported names.
buildImportIndex :: [GraphNode] -> ImportIndex
buildImportIndex = foldl' go Map.empty
  where
    go acc n
      | gnType n == "IMPORT_BINDING" =
          case getMetaText "source" n of
            Just fqName -> Map.insert (gnFile n, gnName n) fqName acc
            Nothing     -> acc
      | otherwise = acc

-- ---------------------------------------------------------------------
-- Lookup
-- ---------------------------------------------------------------------

-- | Look up a name in the 'NameIndex', resolving relative to the
-- current file's namespace and imports.
--
-- Resolution order:
--
-- 1. If the name contains @\\@, treat it as already fully-qualified
--    and look up directly.
-- 2. Try current file's namespace + @\\@ + name.
-- 3. Try import index: @(currentFile, name)@ → FQ name → look up.
-- 4. Fall back to global namespace (name as-is).
lookupFQName :: Text -> Text -> ModuleIndex -> ImportIndex -> NameIndex -> Maybe (Text, Text)
lookupFQName name currentFile modIdx impIdx nameIdx
  -- Already fully qualified (contains backslash)
  | "\\" `T.isInfixOf` name = Map.lookup name nameIdx
  -- Try current namespace first, then imports, then global fallback
  | otherwise =
      let currentNs = case Map.lookup currentFile modIdx of
            Just (_, ns) | not (T.null ns) -> ns
            _                              -> ""
          fqWithNs = if T.null currentNs then name else currentNs <> "\\" <> name
      in case Map.lookup fqWithNs nameIdx of
           Just result -> Just result
           Nothing ->
             -- Try import index
             case Map.lookup (currentFile, name) impIdx of
               Just fqViaImport -> Map.lookup fqViaImport nameIdx
               Nothing -> Map.lookup name nameIdx  -- fallback: global

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------

-- | Extract a text metadata value from a graph node.
getMetaText :: Text -> GraphNode -> Maybe Text
getMetaText key node = case Map.lookup key (gnMetadata node) of
  Just (MetaText t) | not (T.null t) -> Just t
  _                                  -> Nothing

-- | Extract a boolean metadata value from a graph node.
getMetaBool :: Text -> GraphNode -> Maybe Bool
getMetaBool key node = case Map.lookup key (gnMetadata node) of
  Just (MetaBool b) -> Just b
  _                 -> Nothing

-- | Construct an edge-emission command with no metadata.
mkEdge :: Text -> Text -> Text -> PluginCommand
mkEdge src dst edgeType = EmitEdge GraphEdge
  { geSource   = src
  , geTarget   = dst
  , geType     = edgeType
  , geMetadata = Map.empty
  }

-- | Extract the parent class from a semantic ID.
--
-- PHP semantic IDs use the @[in:ClassName]@ convention.
-- Strips comma-separated suffixes: @[in:createUser,static]@ → @"createUser"@.
--
-- Examples:
--
-- >>> extractParentClass "file.php->CLASS->Foo->METHOD->bar[in:Foo]"
-- Just "Foo"
--
-- >>> extractParentClass "file.php->CALL->find[in:createUser,static]"
-- Just "createUser"
--
-- >>> extractParentClass "file.php->FUNCTION->helper"
-- Nothing
extractParentClass :: Text -> Maybe Text
extractParentClass sid =
  case T.breakOn "[in:" sid of
    (_, rest)
      | T.null rest -> Nothing
      | otherwise ->
          let afterPrefix = T.drop 4 rest  -- drop "[in:"
              (beforeClose, _) = T.breakOn "]" afterPrefix
              -- Strip any comma-separated suffixes (e.g., ",static", ",h:abc")
              (cleanParent, _) = T.breakOn "," beforeClose
          in if T.null cleanParent then Nothing else Just cleanParent

-- | Extract the enclosing function/method name from a semantic ID's @[in:]@ annotation.
--
-- This is the same as 'extractParentClass' but named for the function-context use case.
-- For a CALL node like @"file.php->CALL->getName[in:createUser]"@, returns @"createUser"@.
extractEnclosingName :: Text -> Maybe Text
extractEnclosingName = extractParentClass

-- ---------------------------------------------------------------------
-- PHP type normalization
-- ---------------------------------------------------------------------

-- | PHP primitive types that should not be resolved to class nodes.
--
-- Note: @self@ and @static@ are NOT included here — they are special types
-- that resolve to the enclosing class. Use 'isSpecialSelfType' to check.
-- @parent@ IS included because resolving it requires EXTENDS chain traversal.
phpPrimitiveTypes :: Set.Set Text
phpPrimitiveTypes = Set.fromList
  [ "string", "int", "integer", "float", "double", "bool", "boolean"
  , "array", "void", "mixed", "callable", "object", "iterable"
  , "never", "null", "false", "true", "parent"
  ]

-- | Check if a normalized type name is @self@ or @static@ (case-insensitive).
--
-- These types resolve to the enclosing class rather than being looked up
-- in the NameIndex.
isSpecialSelfType :: Text -> Bool
isSpecialSelfType t = let lower = T.toLower t in lower == "self" || lower == "static"

-- | Normalize a PHP type hint for class lookup.
--
-- Strips nullable prefix @?@, handles union types @X|null@ by taking
-- the first non-null/non-primitive component, and filters out primitives.
--
-- Returns 'Nothing' for primitives and unsupported types.
--
-- Examples:
--
-- >>> normalizePhpType "User"
-- Just "User"
--
-- >>> normalizePhpType "?User"
-- Just "User"
--
-- >>> normalizePhpType "User|null"
-- Just "User"
--
-- >>> normalizePhpType "string"
-- Nothing
normalizePhpType :: Text -> Maybe Text
normalizePhpType raw =
  let trimmed = T.strip raw
      -- Strip nullable prefix: "?User" -> "User"
      stripped = if "?" `T.isPrefixOf` trimmed
                 then T.drop 1 trimmed
                 else trimmed
  in if T.isInfixOf "|" stripped
     then -- Union type: pick first non-null, non-primitive component
       let parts = map T.strip (T.splitOn "|" stripped)
           candidates = filter (\p -> not (T.null p) && not (Set.member (T.toLower p) phpPrimitiveTypes)) parts
       in case candidates of
            (c:_) -> Just c
            []    -> Nothing
     else if T.null stripped
       then Nothing
     else if Set.member (T.toLower stripped) phpPrimitiveTypes
       then Nothing
     else Just stripped

-- ---------------------------------------------------------------------
-- Parameter type index
-- ---------------------------------------------------------------------

-- | Parameter type index: @(file, functionName, paramName)@ -> type name.
--
-- Built from VARIABLE nodes with @kind=parameter@ and @type@ metadata,
-- matched to enclosing FUNCTION nodes by line-range containment.
type ParamTypeIndex = Map (Text, Text, Text) Text

-- | Build the parameter type index.
--
-- 1. Collect FUNCTION nodes: (file, name, startLine, endLine)
-- 2. Collect typed parameters: VARIABLE(kind=parameter, has type)
-- 3. Match each param to enclosing function by line containment
-- 4. Index as (file, fnName, paramName) -> typeName
buildParamTypeIndex :: [GraphNode] -> ParamTypeIndex
buildParamTypeIndex nodes =
  let -- Step 1: collect functions with their line ranges
      functions = [ (gnFile n, gnName n, gnLine n, gnEndLine n)
                  | n <- nodes
                  , gnType n == "FUNCTION"
                  ]
      -- Step 2: collect typed parameters
      params = [ (gnFile n, gnName n, gnLine n, t)
               | n <- nodes
               , gnType n == "VARIABLE"
               , getMetaText "kind" n == Just "parameter"
               , Just t <- [getMetaText "type" n]
               ]
      -- Step 3: match params to functions by line containment
      entries = [ ((pFile, fName, pName), pType)
                | (pFile, pName, pLine, pType) <- params
                , (fFile, fName, fStart, fEnd) <- functions
                , pFile == fFile
                , pLine >= fStart && pLine <= fEnd
                ]
  in Map.fromList entries

-- ---------------------------------------------------------------------
-- Function-to-class index
-- ---------------------------------------------------------------------

-- | Maps @(file, functionName)@ to the enclosing class name.
--
-- Built from FUNCTION nodes whose semantic IDs contain @[in:ClassName]@.
-- Used to resolve @self@/@static@ type hints for variables inside methods.
type FunctionClassIndex = Map (Text, Text) Text

-- | Build the function-to-class index from FUNCTION nodes.
buildFunctionClassIndex :: [GraphNode] -> FunctionClassIndex
buildFunctionClassIndex = foldl' go Map.empty
  where
    go acc n
      | gnType n == "FUNCTION" =
          case extractParentClass (gnId n) of
            Just className -> Map.insert (gnFile n, gnName n) className acc
            Nothing        -> acc
      | otherwise = acc

-- ---------------------------------------------------------------------
-- Class extends index
-- ---------------------------------------------------------------------

-- | Maps class name to its parent class name (from @extends@ metadata).
--
-- Used to resolve @parent::method()@ static calls.
type ClassExtendsIndex = Map Text Text

-- | Build the class extends index from CLASS nodes with "extends" metadata.
buildClassExtendsIndex :: [GraphNode] -> ClassExtendsIndex
buildClassExtendsIndex = foldl' go Map.empty
  where
    go acc n
      | gnType n == "CLASS" =
          case getMetaText "extends" n of
            Just parentName -> Map.insert (gnName n) parentName acc
            Nothing         -> acc
      | otherwise = acc

-- ---------------------------------------------------------------------
-- Class traits index
-- ---------------------------------------------------------------------

-- | Maps class name to its used trait names (from @traits@ metadata).
type ClassTraitsIndex = Map Text [Text]

-- | Build the class traits index from CLASS nodes with "traits" metadata.
buildClassTraitsIndex :: [GraphNode] -> ClassTraitsIndex
buildClassTraitsIndex = foldl' go Map.empty
  where
    go acc n
      | gnType n == "CLASS" =
          case getMetaText "traits" n of
            Just traitsStr ->
              let traits = filter (not . T.null) . map T.strip $ T.splitOn "," traitsStr
              in Map.insert (gnName n) traits acc
            Nothing -> acc
      | otherwise = acc

-- ---------------------------------------------------------------------
-- Method index + hierarchy lookup
-- ---------------------------------------------------------------------

-- | Method index: @(className, methodName)@ -> list of matching node IDs.
type MethodIndex = Map (Text, Text) [Text]

-- | Build method index from FUNCTION/METHOD nodes with @[in:ClassName]@.
buildMethodIndex :: [GraphNode] -> MethodIndex
buildMethodIndex = foldl' go Map.empty
  where
    go acc n
      | gnType n == "FUNCTION" || gnType n == "METHOD" =
          case extractParentClass (gnId n) of
            Just className ->
              let key = (className, gnName n)
              in Map.insertWith (++) key [gnId n] acc
            Nothing -> acc
      | otherwise = acc

-- | Look up a method in a class, walking the inheritance chain and traits.
--
-- Resolution order for @$this->method()@:
--
-- 1. Direct: @(className, methodName)@ in MethodIndex
-- 2. Traits: for each trait used by the class, try @(traitName, methodName)@
-- 3. Parent: look up parent class in ClassExtendsIndex, recurse (depth limit 10)
lookupMethodInHierarchy :: MethodIndex -> ClassExtendsIndex -> ClassTraitsIndex -> Text -> Text -> Int -> Maybe Text
lookupMethodInHierarchy _methodIdx _extendsIdx _traitsIdx _className _methodName depth
  | depth <= 0 = Nothing
lookupMethodInHierarchy methodIdx extendsIdx traitsIdx className methodName depth =
  -- 1. Direct lookup
  case Map.lookup (className, methodName) methodIdx of
    Just (m:_) -> Just m
    _ ->
      -- 2. Try traits
      let traitResult = case Map.lookup className traitsIdx of
            Nothing -> Nothing
            Just traits -> findFirst traits
          findFirst [] = Nothing
          findFirst (t:ts) = case Map.lookup (t, methodName) methodIdx of
            Just (m:_) -> Just m
            _          -> findFirst ts
      in case traitResult of
           Just m -> Just m
           Nothing ->
             -- 3. Try parent class (recurse)
             case Map.lookup className extendsIdx of
               Nothing -> Nothing
               Just parentClass ->
                 lookupMethodInHierarchy methodIdx extendsIdx traitsIdx parentClass methodName (depth - 1)

-- ---------------------------------------------------------------------
-- Property type index
-- ---------------------------------------------------------------------

-- | Maps @(className, propertyName)@ to the property's type name.
--
-- Built from VARIABLE nodes with @kind=property@ and @type@ metadata,
-- where the class name is extracted from the @[in:]@ annotation.
-- Used to resolve @$this->prop->method()@ patterns.
type PropertyTypeIndex = Map (Text, Text) Text

-- | Build the property type index from VARIABLE(kind=property) nodes.
buildPropertyTypeIndex :: [GraphNode] -> PropertyTypeIndex
buildPropertyTypeIndex = foldl' go Map.empty
  where
    go acc n
      | gnType n == "VARIABLE"
      , getMetaText "kind" n == Just "property"
      , Just typeName <- getMetaText "type" n
      , Just className <- extractParentClass (gnId n) =
          -- Property name may have $ prefix — store both with and without
          let propName = gnName n
              cleanName = if "$" `T.isPrefixOf` propName
                          then T.drop 1 propName
                          else propName
          in Map.insert (className, cleanName) typeName acc
      | otherwise = acc
