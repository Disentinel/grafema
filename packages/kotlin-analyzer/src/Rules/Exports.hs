{-# LANGUAGE OverloadedStrings #-}
-- | Exports rule for Kotlin.
--
-- Key difference from Java: Public by default in Kotlin (opposite of Java).
-- `internal` = module-visible. Export everything not `private`.
--
-- Items with no visibility modifier, `public`, `protected`, or `internal`
-- are considered exported. Only `private` items produce no ExportInfo.
module Rules.Exports
  ( walkDeclExports
  ) where

import Data.Text (Text)

import KotlinAST
import Analysis.Types (ExportInfo(..), ExportKind(..))
import Analysis.Context
    ( Analyzer
    , emitExport
    , askFile
    , askNamedParent
    )
import Grafema.SemanticId (semanticId)

-- Visibility helpers

-- | Is this modifier list indicating the item should NOT be exported?
isPrivate :: [Text] -> Bool
isPrivate mods = "private" `elem` mods

-- Top-level export walker

walkDeclExports :: KotlinDecl -> Analyzer ()

-- Public class (default) -> NamedExport + walk members
walkDeclExports (ClassDecl name _kind mods _tps _ctor _supers members _annots _sp)
  | not (isPrivate mods) = do
    file   <- askFile
    _parent <- askNamedParent
    let nodeId = semanticId file "CLASS" name _parent Nothing
    emitExport ExportInfo
      { eiName   = name
      , eiNodeId = nodeId
      , eiKind   = NamedExport
      , eiSource = Nothing
      }
    mapM_ (walkMemberExports file name) members

walkDeclExports (ObjectDecl name mods _supers members _annots _sp)
  | not (isPrivate mods) = do
    file   <- askFile
    _parent <- askNamedParent
    let nodeId = semanticId file "CLASS" name _parent Nothing
    emitExport ExportInfo
      { eiName   = name
      , eiNodeId = nodeId
      , eiKind   = NamedExport
      , eiSource = Nothing
      }
    mapM_ (walkMemberExports file name) members

walkDeclExports (FunDecl name mods _tps _recv _params _retType _body _annots _sp)
  | not (isPrivate mods) = do
    file   <- askFile
    _parent <- askNamedParent
    let nodeId = semanticId file "FUNCTION" name _parent Nothing
    emitExport ExportInfo
      { eiName   = name
      , eiNodeId = nodeId
      , eiKind   = NamedExport
      , eiSource = Nothing
      }

walkDeclExports (PropertyDecl name mods _isVal _pType _init _getter _setter _deleg _annots _sp)
  | not (isPrivate mods) = do
    file   <- askFile
    _parent <- askNamedParent
    let nodeId = semanticId file "VARIABLE" name _parent Nothing
    emitExport ExportInfo
      { eiName   = name
      , eiNodeId = nodeId
      , eiKind   = NamedExport
      , eiSource = Nothing
      }

walkDeclExports (TypeAliasDecl name mods _tps _aliased _annots _sp)
  | not (isPrivate mods) = do
    file   <- askFile
    _parent <- askNamedParent
    let nodeId = semanticId file "TYPE_ALIAS" name _parent Nothing
    emitExport ExportInfo
      { eiName   = name
      , eiNodeId = nodeId
      , eiKind   = NamedExport
      , eiSource = Nothing
      }

-- Private or unknown items: do nothing
walkDeclExports _ = pure ()

-- Member export walker

walkMemberExports :: Text -> Text -> KotlinMember -> Analyzer ()

-- Public method (default) -> NamedExport
walkMemberExports file className (FunMember name mods _ _ _ _ _ _ _)
  | not (isPrivate mods) = do
    let nodeId = semanticId file "FUNCTION" name (Just className) Nothing
    emitExport ExportInfo
      { eiName   = className <> "." <> name
      , eiNodeId = nodeId
      , eiKind   = NamedExport
      , eiSource = Nothing
      }

-- Public property (default) -> NamedExport
walkMemberExports file className (PropertyMember name mods _ _ _ _ _ _ _ _)
  | not (isPrivate mods) = do
    let nodeId = semanticId file "VARIABLE" name (Just className) Nothing
    emitExport ExportInfo
      { eiName   = className <> "." <> name
      , eiNodeId = nodeId
      , eiKind   = NamedExport
      , eiSource = Nothing
      }

-- Nested class: recurse
walkMemberExports _ _ (NestedClassMember decl _) =
  walkDeclExports decl

-- Other members / private: skip
walkMemberExports _ _ _ = pure ()
