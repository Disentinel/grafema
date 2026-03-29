{-# LANGUAGE OverloadedStrings #-}
-- | SPM Package.swift manifest analysis for Swift.
--
-- Detects Package.swift files, extracts SPM target definitions and their
-- dependency relationships, and emits SPM_TARGET nodes with DEPENDS_ON edges.
--
-- Handles:
--   * .target(name:, dependencies:)      -> SPM_TARGET node (kind=target)
--   * .testTarget(name:, dependencies:)  -> SPM_TARGET node (kind=testTarget)
--   * .executableTarget(name:, ...)      -> SPM_TARGET node (kind=executableTarget)
--   * .plugin(name:, ...)                -> SPM_TARGET node (kind=plugin)
--   * String dependencies ("Core")       -> DEPENDS_ON edge to local target
--   * .product(name:, package:)          -> DEPENDS_ON edge with external metadata
--   * .package(url:, from:)              -> SPM_PACKAGE node (external dependency)
module Rules.PackageManifest
  ( walkPackageManifest
  , isPackageSwift
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import Data.Maybe (mapMaybe)

import SwiftAST
import Analysis.Types
import Analysis.Context
import Grafema.SemanticId (semanticId)

-- | Check if a file path ends with Package.swift.
isPackageSwift :: Text -> Bool
isPackageSwift path =
  path == "Package.swift" || T.isSuffixOf "/Package.swift" path

-- | Walk a Package.swift file's declarations, extracting SPM manifest info.
-- Should only be called when isPackageSwift returns True.
walkPackageManifest :: SwiftFile -> Analyzer ()
walkPackageManifest swiftFile = do
  file <- askFile
  moduleId <- askModuleId
  case findPackageCall (sfDeclarations swiftFile) of
    Nothing -> return ()
    Just (pkgName, extDeps, targets) -> do
      -- Emit SPM_PACKAGE nodes for external dependencies
      mapM_ (emitExternalDep file moduleId) extDeps
      -- Emit SPM_TARGET nodes
      mapM_ (emitTarget file moduleId pkgName) targets
      -- Emit DEPENDS_ON edges between local targets
      let targetNames = map stName targets
      mapM_ (emitTargetDeps file targetNames) targets

-- SPM data types

data SpmTarget = SpmTarget
  { stName         :: !Text
  , stKind         :: !Text       -- "target", "testTarget", "executableTarget", "plugin"
  , stDeps         :: ![SpmDep]
  , stPath         :: !(Maybe Text)
  } deriving (Show)

data SpmDep
  = LocalDep !Text                -- "Core"
  | ProductDep !Text !Text        -- .product(name: "X", package: "Y")
  deriving (Show)

data ExternalPkg = ExternalPkg
  { epUrl     :: !Text
  , epVersion :: !Text
  } deriving (Show)

-- AST extraction

-- | Find the Package(...) call in top-level declarations.
-- Looking for: let package = Package(name:, ..., targets:, ...)
findPackageCall :: [SwiftDecl] -> Maybe (Text, [ExternalPkg], [SpmTarget])
findPackageCall decls =
  case mapMaybe extractPackageInit decls of
    (result:_) -> Just result
    []         -> Nothing

extractPackageInit :: SwiftDecl -> Maybe (Text, [ExternalPkg], [SpmTarget])
extractPackageInit (VarDecl _mods _bindSpec bindings _attrs _sp) =
  case bindings of
    (b:_) -> case sbInitializer b of
      Just (CallExpr callee args _ _) | isPackageCallee callee ->
        let pkgName    = extractStringArg "name" args
            extDeps    = extractExternalDeps args
            targets    = extractTargets args
        in Just (pkgName, extDeps, targets)
      _ -> Nothing
    [] -> Nothing
extractPackageInit _ = Nothing

isPackageCallee :: SwiftExpr -> Bool
isPackageCallee (DeclRefExpr name _) = name == "Package"
isPackageCallee _ = False

-- | Extract a string argument by label.
extractStringArg :: Text -> [(Maybe Text, SwiftExpr)] -> Text
extractStringArg label args =
  case [v | (Just l, v) <- args, l == label] of
    (StringLiteral val _:_) -> val
    _ -> ""

-- | Extract external package dependencies from the "dependencies" argument.
extractExternalDeps :: [(Maybe Text, SwiftExpr)] -> [ExternalPkg]
extractExternalDeps args =
  case [v | (Just "dependencies", v) <- args] of
    (ArrayExpr elems _:_) -> mapMaybe extractExternalPkg elems
    _ -> []

extractExternalPkg :: SwiftExpr -> Maybe ExternalPkg
extractExternalPkg (CallExpr callee cargs _ _)
  | isPackageMember callee =
    let url = extractStringArg "url" cargs
        ver = extractStringArg "from" cargs
    in if T.null url then Nothing else Just (ExternalPkg url ver)
extractExternalPkg _ = Nothing

isPackageMember :: SwiftExpr -> Bool
isPackageMember (MemberAccessExpr member _ _) = member == "package"
isPackageMember _ = False

-- | Extract targets from the "targets" argument.
extractTargets :: [(Maybe Text, SwiftExpr)] -> [SpmTarget]
extractTargets args =
  case [v | (Just "targets", v) <- args] of
    (ArrayExpr elems _:_) -> mapMaybe extractTarget elems
    _ -> []

extractTarget :: SwiftExpr -> Maybe SpmTarget
extractTarget (CallExpr callee cargs _ _) =
  case extractTargetKind callee of
    Just kind ->
      let name = extractStringArg "name" cargs
          deps = extractDependencies cargs
          path = case extractStringArg "path" cargs of
                   p | T.null p  -> Nothing
                     | otherwise -> Just p
      in if T.null name
         then Nothing
         else Just SpmTarget
                { stName = name
                , stKind = kind
                , stDeps = deps
                , stPath = path
                }
    Nothing -> Nothing
extractTarget _ = Nothing

extractTargetKind :: SwiftExpr -> Maybe Text
extractTargetKind (MemberAccessExpr member _ _) =
  case member of
    "target"           -> Just "target"
    "testTarget"       -> Just "testTarget"
    "executableTarget" -> Just "executableTarget"
    "plugin"           -> Just "plugin"
    "systemLibrary"    -> Just "systemLibrary"
    "binaryTarget"     -> Just "binaryTarget"
    "macro"            -> Just "macro"
    _                  -> Nothing
extractTargetKind _ = Nothing

-- | Extract dependency list from target arguments.
extractDependencies :: [(Maybe Text, SwiftExpr)] -> [SpmDep]
extractDependencies args =
  case [v | (Just "dependencies", v) <- args] of
    (ArrayExpr elems _:_) -> mapMaybe extractDep elems
    _ -> []

extractDep :: SwiftExpr -> Maybe SpmDep
-- String literal: "Core"
extractDep (StringLiteral name _) = Just (LocalDep name)
-- .product(name: "X", package: "Y")
extractDep (CallExpr callee cargs _ _)
  | isProductMember callee =
    let name = extractStringArg "name" cargs
        pkg  = extractStringArg "package" cargs
    in if T.null name then Nothing else Just (ProductDep name pkg)
-- .target(name: "X") — explicit local target dep
extractDep (CallExpr callee cargs _ _)
  | isTargetMember callee =
    let name = extractStringArg "name" cargs
    in if T.null name then Nothing else Just (LocalDep name)
extractDep _ = Nothing

isProductMember :: SwiftExpr -> Bool
isProductMember (MemberAccessExpr "product" _ _) = True
isProductMember _ = False

isTargetMember :: SwiftExpr -> Bool
isTargetMember (MemberAccessExpr "target" _ _) = True
isTargetMember _ = False

-- Node emission

emitTarget :: Text -> Text -> Text -> SpmTarget -> Analyzer ()
emitTarget file moduleId pkgName target = do
  let nodeId = semanticId file "SPM_TARGET" (stName target) Nothing Nothing
  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "SPM_TARGET"
    , gnName      = stName target
    , gnFile      = file
    , gnLine      = 1
    , gnColumn    = 0
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported  = True
    , gnMetadata  = Map.fromList $
        [ ("kind", MetaText (stKind target))
        , ("package", MetaText pkgName)
        , ("language", MetaText "swift")
        ]
        ++ [("path", MetaText p) | Just p <- [stPath target]]
        ++ [("dependencies", MetaText (T.intercalate "," (map depName (stDeps target)))) | not (null (stDeps target))]
    }
  emitEdge GraphEdge
    { geSource = moduleId
    , geTarget = nodeId
    , geType   = "CONTAINS"
    , geMetadata = Map.empty
    }

depName :: SpmDep -> Text
depName (LocalDep n)     = n
depName (ProductDep n p) = n <> "@" <> p

emitExternalDep :: Text -> Text -> ExternalPkg -> Analyzer ()
emitExternalDep file moduleId pkg = do
  let pkgName = extractPkgName (epUrl pkg)
      nodeId  = semanticId file "SPM_PACKAGE" pkgName Nothing Nothing
  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "SPM_PACKAGE"
    , gnName      = pkgName
    , gnFile      = file
    , gnLine      = 1
    , gnColumn    = 0
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("url", MetaText (epUrl pkg))
        , ("version", MetaText (epVersion pkg))
        , ("language", MetaText "swift")
        ]
    }
  emitEdge GraphEdge
    { geSource = moduleId
    , geTarget = nodeId
    , geType   = "CONTAINS"
    , geMetadata = Map.empty
    }

-- | Extract package name from git URL.
-- "https://github.com/Alamofire/Alamofire.git" -> "Alamofire"
extractPkgName :: Text -> Text
extractPkgName url =
  let stripped = if T.isSuffixOf ".git" url then T.dropEnd 4 url else url
      segments = T.splitOn "/" stripped
  in if null segments then url else last segments

emitTargetDeps :: Text -> [Text] -> SpmTarget -> Analyzer ()
emitTargetDeps file localTargetNames target = do
  let srcId = semanticId file "SPM_TARGET" (stName target) Nothing Nothing
  mapM_ (emitOneDep file srcId localTargetNames) (stDeps target)

emitOneDep :: Text -> Text -> [Text] -> SpmDep -> Analyzer ()
emitOneDep file srcId localTargetNames dep = case dep of
  LocalDep name | name `elem` localTargetNames -> do
    let dstId = semanticId file "SPM_TARGET" name Nothing Nothing
    emitEdge GraphEdge
      { geSource   = srcId
      , geTarget   = dstId
      , geType     = "DEPENDS_ON"
      , geMetadata = Map.singleton "resolvedVia" (MetaText "spm-package-manifest")
      }
  ProductDep prodName pkgName -> do
    let dstId = semanticId file "SPM_PACKAGE" (if T.null pkgName then prodName else pkgName) Nothing Nothing
    emitEdge GraphEdge
      { geSource   = srcId
      , geTarget   = dstId
      , geType     = "DEPENDS_ON"
      , geMetadata = Map.fromList
          [ ("resolvedVia", MetaText "spm-package-manifest")
          , ("product", MetaText prodName)
          , ("external", MetaText "true")
          ]
      }
  _ -> return ()
