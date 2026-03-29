{-# LANGUAGE OverloadedStrings #-}
-- | Exports rule for Swift.
--
-- Key difference from Kotlin: internal by default in Swift.
-- Items with `public` or `open` visibility are considered exported.
-- `internal`, `fileprivate`, and `private` items are not exported.
module Rules.Exports (walkDeclExports) where

import Data.Text (Text)
import qualified Data.Text as T

import SwiftAST
import Analysis.Types (ExportInfo(..), ExportKind(..))
import Analysis.Context (Analyzer, askFile, askNamedParent, emitExport)
import Grafema.SemanticId (semanticId, contentHash)

-- | Walk exports for a declaration.
-- Emits ExportInfo for public/open declarations.
walkDeclExports :: SwiftDecl -> Analyzer ()
walkDeclExports decl = do
  file   <- askFile
  parent <- askNamedParent
  case decl of
    StructDecl name mods _ _ members _ _ ->
      when' (isPublicOrOpen mods) $
        emitExportNamed file "CLASS" name parent >> walkMemberExports mods members
    ClassDecl name mods _ _ members _ _ ->
      when' (isPublicOrOpen mods) $
        emitExportNamed file "CLASS" name parent >> walkMemberExports mods members
    EnumDecl name mods _ _ members _ _ ->
      when' (isPublicOrOpen mods) $
        emitExportNamed file "CLASS" name parent >> walkMemberExports mods members
    ProtocolDecl name mods _ members _ _ ->
      when' (isPublicOrOpen mods) $
        emitExportNamed file "CLASS" name parent >> walkMemberExports mods members
    ActorDecl name mods _ _ members _ _ ->
      when' (isPublicOrOpen mods) $
        emitExportNamed file "CLASS" name parent >> walkMemberExports mods members
    ExtensionDecl extType mods _ members _ sp ->
      when' (isPublicOrOpen mods) $ do
        let typeName = typeDisplayName extType
            hash = contentHash [("line", T.pack (show (posLine (spanStart sp))))]
        emitExportNamedWithHash file "EXTENSION" typeName parent (Just hash)
        walkMemberExports mods members
    FuncDecl name mods _ _ _ _ _ _ _ _ ->
      when' (isPublicOrOpen mods) $
        emitExportNamed file "FUNCTION" name parent
    TypeAliasDecl name mods _ _ _ _ ->
      when' (isPublicOrOpen mods) $
        emitExportNamed file "TYPE_ALIAS" name parent
    VarDecl mods _ bindings _ _ ->
      when' (isPublicOrOpen mods) $
        mapM_ (emitBindingExport file parent) bindings
    _ -> return ()

-- | Check if modifiers include public or open.
isPublicOrOpen :: [Text] -> Bool
isPublicOrOpen mods = "public" `elem` mods || "open" `elem` mods

-- | Walk members of a public type, emitting exports for public/open members.
-- Members of a public type inherit the parent's name for semantic ID scoping.
walkMemberExports :: [Text] -> [SwiftDecl] -> Analyzer ()
walkMemberExports _parentMods members = mapM_ walkDeclExports members

-- | Emit a named export for a declaration.
emitExportNamed :: Text -> Text -> Text -> Maybe Text -> Analyzer ()
emitExportNamed file nodeType name parent = do
  let nodeId = semanticId file nodeType name parent Nothing
  emitExport ExportInfo
    { eiName   = name
    , eiNodeId = nodeId
    , eiKind   = NamedExport
    , eiSource = Nothing
    }

-- | Emit a named export with content hash (for extensions).
emitExportNamedWithHash :: Text -> Text -> Text -> Maybe Text -> Maybe Text -> Analyzer ()
emitExportNamedWithHash file nodeType name parent hash = do
  let nodeId = semanticId file nodeType name parent hash
  emitExport ExportInfo
    { eiName   = name
    , eiNodeId = nodeId
    , eiKind   = NamedExport
    , eiSource = Nothing
    }

-- | Emit export for a variable binding.
emitBindingExport :: Text -> Maybe Text -> SwiftBinding -> Analyzer ()
emitBindingExport file parent binding = do
  let patName = patternName (sbPattern binding)
      nodeId = semanticId file "VARIABLE" patName parent Nothing
  emitExport ExportInfo
    { eiName   = patName
    , eiNodeId = nodeId
    , eiKind   = NamedExport
    , eiSource = Nothing
    }

-- | Extract the display name from a pattern.
patternName :: SwiftPattern -> Text
patternName (IdentifierPattern name) = name
patternName (ValueBindingPattern _ pat) = patternName pat
patternName (TuplePattern pats) = T.intercalate "," (map patternName pats)
patternName _ = "_"

-- | Type display name (matches Declarations.hs).
typeDisplayName :: SwiftType -> Text
typeDisplayName (SimpleType name _) = name
typeDisplayName (OptionalType t) = typeDisplayName t <> "?"
typeDisplayName (ArrayType t) = "[" <> typeDisplayName t <> "]"
typeDisplayName (DictionaryType k v') = "[" <> typeDisplayName k <> ":" <> typeDisplayName v' <> "]"
typeDisplayName (MemberType base name) = typeDisplayName base <> "." <> name
typeDisplayName (UnknownType t) = t
typeDisplayName _ = "<type>"

-- | Conditional execution helper.
when' :: Bool -> Analyzer () -> Analyzer ()
when' True  m = m
when' False _ = return ()
