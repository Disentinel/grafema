{-# LANGUAGE OverloadedStrings #-}
-- | Phase 7 rule: exports — pub visibility.
--
-- In Rust, there is no explicit export list like in Haskell.  Instead,
-- items marked @pub@ (or @pub(crate)@) are exported from the module.
-- Earlier phases (3-6) already set @gnExported = True@ on pub items;
-- this phase collects those items into the 'faExports' list of
-- 'ExportInfo' records so the orchestrator can build cross-file
-- resolution tables.
--
-- Handles these Rust AST constructs:
--   * 'ItemFn'     with pub/pub(crate) vis  -> NamedExport
--   * 'ItemStruct' with pub/pub(crate) vis  -> NamedExport
--   * 'ItemEnum'   with pub/pub(crate) vis  -> NamedExport
--   * 'ItemTrait'  with pub/pub(crate) vis  -> NamedExport
--   * 'ItemConst'  with pub/pub(crate) vis  -> NamedExport
--   * 'ItemStatic' with pub/pub(crate) vis  -> NamedExport
--   * 'ItemType'   with pub/pub(crate) vis  -> NamedExport
--   * 'ItemUse'    with pub vis             -> ReExport (per flattened binding)
--
-- Non-pub items produce no ExportInfo.
--
-- Called from 'Analysis.Walker.walkFile' for each top-level item.
module Rules.Exports
  ( walkExports
  ) where

import Data.Text (Text)
import qualified Data.Text as T

import RustAST
import Analysis.Types (ExportInfo(..), ExportKind(..))
import Analysis.Context
    ( Analyzer
    , emitExport
    , askFile
    , askNamedParent
    )
import Grafema.SemanticId (semanticId)

-- ── Visibility helpers ──────────────────────────────────────────────────

-- | Is this visibility public (exported)?
isPub :: Vis -> Bool
isPub VisPub      = True
isPub VisPubCrate = True
isPub _           = False

-- ── Use tree flattening (for pub use re-exports) ────────────────────────

-- | A single flattened binding from a use tree.
data FlatUseBinding = FlatUseBinding
  { fubPath :: !Text    -- ^ full path like "crate::internal::Foo"
  , fubName :: !Text    -- ^ leaf name or "*" for glob
  , fubGlob :: !Bool    -- ^ true for glob re-exports
  } deriving (Show, Eq)

-- | Flatten a recursive 'RustUseTree' into a list of flat bindings.
flattenUseTree :: Text -> RustUseTree -> [FlatUseBinding]
flattenUseTree prefix (UsePath ident subtree) =
  let newPrefix = if T.null prefix then ident else prefix <> "::" <> ident
  in flattenUseTree newPrefix subtree
flattenUseTree prefix (UseName ident) =
  [FlatUseBinding
    { fubPath = if T.null prefix then ident else prefix <> "::" <> ident
    , fubName = ident
    , fubGlob = False
    }]
flattenUseTree prefix (UseRename ident _rename) =
  [FlatUseBinding
    { fubPath = if T.null prefix then ident else prefix <> "::" <> ident
    , fubName = ident
    , fubGlob = False
    }]
flattenUseTree prefix UseGlob =
  [FlatUseBinding
    { fubPath = prefix <> "::*"
    , fubName = "*"
    , fubGlob = True
    }]
flattenUseTree prefix (UseGroup items) =
  concatMap (flattenUseTree prefix) items

-- ── Top-level item walker ───────────────────────────────────────────────

-- | Walk a single Rust item for export analysis.
--
-- Emits 'ExportInfo' records for pub items. Non-pub items are silently
-- ignored.
walkExports :: RustItem -> Analyzer ()

-- pub fn -> NamedExport
walkExports (ItemFn ident vis _sig _block _attrs _sp) | isPub vis = do
  file   <- askFile
  parent <- askNamedParent
  let nodeId = semanticId file "FUNCTION" ident parent Nothing
  emitExport ExportInfo
    { eiName   = ident
    , eiNodeId = nodeId
    , eiKind   = NamedExport
    , eiSource = Nothing
    }

-- pub struct -> NamedExport
walkExports (ItemStruct ident vis _fields _attrs _sp _isTuple _isUnit) | isPub vis = do
  file   <- askFile
  parent <- askNamedParent
  let nodeId = semanticId file "STRUCT" ident parent Nothing
  emitExport ExportInfo
    { eiName   = ident
    , eiNodeId = nodeId
    , eiKind   = NamedExport
    , eiSource = Nothing
    }

-- pub enum -> NamedExport
walkExports (ItemEnum ident vis _variants _attrs _sp) | isPub vis = do
  file   <- askFile
  parent <- askNamedParent
  let nodeId = semanticId file "ENUM" ident parent Nothing
  emitExport ExportInfo
    { eiName   = ident
    , eiNodeId = nodeId
    , eiKind   = NamedExport
    , eiSource = Nothing
    }

-- pub trait -> NamedExport
walkExports (ItemTrait ident vis _items _attrs _sp _unsafe) | isPub vis = do
  file   <- askFile
  parent <- askNamedParent
  let nodeId = semanticId file "TRAIT" ident parent Nothing
  emitExport ExportInfo
    { eiName   = ident
    , eiNodeId = nodeId
    , eiKind   = NamedExport
    , eiSource = Nothing
    }

-- pub const -> NamedExport
walkExports (ItemConst ident vis _ty _expr _sp _attrs) | isPub vis = do
  file   <- askFile
  let nodeId = semanticId file "VARIABLE" ident Nothing Nothing
  emitExport ExportInfo
    { eiName   = ident
    , eiNodeId = nodeId
    , eiKind   = NamedExport
    , eiSource = Nothing
    }

-- pub static -> NamedExport
walkExports (ItemStatic ident vis _ty _mut _expr _sp _attrs) | isPub vis = do
  file   <- askFile
  let nodeId = semanticId file "VARIABLE" ident Nothing Nothing
  emitExport ExportInfo
    { eiName   = ident
    , eiNodeId = nodeId
    , eiKind   = NamedExport
    , eiSource = Nothing
    }

-- pub type -> NamedExport
walkExports (ItemType ident vis _ty _sp _attrs) | isPub vis = do
  file   <- askFile
  parent <- askNamedParent
  let nodeId = semanticId file "TYPE_ALIAS" ident parent Nothing
  emitExport ExportInfo
    { eiName   = ident
    , eiNodeId = nodeId
    , eiKind   = NamedExport
    , eiSource = Nothing
    }

-- pub use -> ReExport(s)
walkExports (ItemUse tree vis _sp _attrs) | isPub vis = do
  file <- askFile
  let bindings = flattenUseTree T.empty tree
  mapM_ (emitReExport file) bindings

-- Non-pub items and unhandled item types: do nothing
walkExports _ = pure ()

-- ── Re-export emission ──────────────────────────────────────────────────

-- | Emit a single ReExport 'ExportInfo' for a pub use binding.
emitReExport :: Text -> FlatUseBinding -> Analyzer ()
emitReExport file binding = do
  let path = fubPath binding
      name = fubName binding
      -- For glob re-exports there is no specific node; use empty nodeId
      nodeId = if fubGlob binding
               then ""
               else semanticId file "IMPORT_BINDING" name Nothing (Just path)
  emitExport ExportInfo
    { eiName   = name
    , eiNodeId = nodeId
    , eiKind   = ReExport
    , eiSource = Just path
    }
