{-# LANGUAGE OverloadedStrings #-}
-- | Exports rule: public/protected visibility -> ExportInfo records.
--
-- In Java, there is no explicit export list. Items with @public@ or
-- @protected@ visibility are considered exported from the module.
-- Earlier phases already set @gnExported = True@ on public items;
-- this phase collects those items into the 'faExports' list of
-- 'ExportInfo' records so the orchestrator can build cross-file
-- resolution tables.
--
-- Handles these Java AST constructs:
--   * 'ClassDecl'          with public/protected -> NamedExport
--   * 'InterfaceDecl'      with public/protected -> NamedExport
--   * 'EnumDecl'           with public/protected -> NamedExport
--   * 'RecordDecl'         with public/protected -> NamedExport
--   * 'AnnotationTypeDecl' with public/protected -> NamedExport
--   * 'MethodMember'       with public/protected -> NamedExport
--   * 'ConstructorMember'  with public/protected -> NamedExport
--   * 'FieldMember'        with public/protected -> NamedExport (per variable)
--
-- Non-public/non-protected items produce no ExportInfo.
--
-- Called from 'Analysis.Walker.walkFile' for each type declaration.
module Rules.Exports
  ( walkExports
  ) where

import Data.Text (Text)
import qualified Data.Text as T

import JavaAST
import Analysis.Types (ExportInfo(..), ExportKind(..))
import Analysis.Context
    ( Analyzer
    , emitExport
    , askFile
    , askNamedParent
    )
import Grafema.SemanticId (semanticId, contentHash)

-- ── Visibility helpers ─────────────────────────────────────────────────

-- | Is this modifier list indicating exported visibility?
isExported :: [Text] -> Bool
isExported mods = "public" `elem` mods || "protected" `elem` mods

-- ── Top-level export walker ─────────────────────────────────────────────

-- | Walk a type declaration for export analysis.
walkExports :: JavaTypeDecl -> Analyzer ()

-- public class -> NamedExport + walk members
walkExports (ClassDecl name mods _ _ _ members _ _) | isExported mods = do
  file   <- askFile
  parent <- askNamedParent
  let nodeId = semanticId file "CLASS" name parent Nothing
  emitExport ExportInfo
    { eiName   = name
    , eiNodeId = nodeId
    , eiKind   = NamedExport
    , eiSource = Nothing
    }
  mapM_ (walkMemberExports file name) members

-- public interface -> NamedExport + walk members
walkExports (InterfaceDecl name mods _ _ members _ _) | isExported mods = do
  file   <- askFile
  parent <- askNamedParent
  let nodeId = semanticId file "INTERFACE" name parent Nothing
  emitExport ExportInfo
    { eiName   = name
    , eiNodeId = nodeId
    , eiKind   = NamedExport
    , eiSource = Nothing
    }
  mapM_ (walkMemberExports file name) members

-- public enum -> NamedExport + walk members
walkExports (EnumDecl name mods _ _ members _ _) | isExported mods = do
  file   <- askFile
  parent <- askNamedParent
  let nodeId = semanticId file "ENUM" name parent Nothing
  emitExport ExportInfo
    { eiName   = name
    , eiNodeId = nodeId
    , eiKind   = NamedExport
    , eiSource = Nothing
    }
  mapM_ (walkMemberExports file name) members

-- public record -> NamedExport + walk members
walkExports (RecordDecl name mods _ _ _ members _ _) | isExported mods = do
  file   <- askFile
  parent <- askNamedParent
  let nodeId = semanticId file "RECORD" name parent Nothing
  emitExport ExportInfo
    { eiName   = name
    , eiNodeId = nodeId
    , eiKind   = NamedExport
    , eiSource = Nothing
    }
  mapM_ (walkMemberExports file name) members

-- public annotation type -> NamedExport
walkExports (AnnotationTypeDecl name mods _ _) | isExported mods = do
  file   <- askFile
  parent <- askNamedParent
  let nodeId = semanticId file "ANNOTATION_TYPE" name parent Nothing
  emitExport ExportInfo
    { eiName   = name
    , eiNodeId = nodeId
    , eiKind   = NamedExport
    , eiSource = Nothing
    }

-- Non-exported items: do nothing
walkExports _ = pure ()

-- ── Member export walker ────────────────────────────────────────────────

-- | Walk a member for export analysis. Public/protected members of a
-- public class are exported.
walkMemberExports :: Text -> Text -> JavaMember -> Analyzer ()

-- public method -> NamedExport
walkMemberExports file className (MethodMember name mods _ _ _ _ _ _ _)
  | isExported mods = do
    let nodeId = semanticId file "FUNCTION" name (Just className) Nothing
    emitExport ExportInfo
      { eiName   = className <> "." <> name
      , eiNodeId = nodeId
      , eiKind   = NamedExport
      , eiSource = Nothing
      }

-- public constructor -> NamedExport
walkMemberExports file className (ConstructorMember name mods _ _ _ _ _ _)
  | isExported mods = do
    let nodeId = semanticId file "FUNCTION" name (Just className) (Just "ctor")
    emitExport ExportInfo
      { eiName   = className <> "." <> name
      , eiNodeId = nodeId
      , eiKind   = NamedExport
      , eiSource = Nothing
      }

-- public field -> NamedExport per variable
walkMemberExports file className (FieldMember mods _ variables _ sp)
  | isExported mods = do
    let line = posLine (spanStart sp)
    mapM_ (\var -> do
      let hash = contentHash [("line", T.pack (show line)), ("name", jvName var)]
          nodeId = semanticId file "VARIABLE" (jvName var) (Just className) (Just hash)
      emitExport ExportInfo
        { eiName   = className <> "." <> jvName var
        , eiNodeId = nodeId
        , eiKind   = NamedExport
        , eiSource = Nothing
        }
      ) variables

-- Nested type: recurse
walkMemberExports _ _ (NestedTypeMember typeDecl _) =
  walkExports typeDecl

-- Other members / non-exported: skip
walkMemberExports _ _ _ = pure ()
