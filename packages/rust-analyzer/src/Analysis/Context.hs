{-# LANGUAGE OverloadedStrings #-}
-- | Reader context + Writer output for the Rust analysis monad.
-- Follows the same pattern as haskell-analyzer's Analysis.Context but
-- with Rust-specific context fields (enclosingImpl, unsafe, async).
module Analysis.Context
  ( Ctx(..)
  , Analyzer
  , runAnalyzer
  , emitNode
  , emitEdge
  , emitDeferred
  , emitExport
  , askFile
  , askModuleId
  , askScope
  , askScopeId
  , askEnclosingFn
  , askEnclosingImpl
  , askNamedParent
  , withScope
  , withEnclosingFn
  , withEnclosingImpl
  , withNamedParent
  , withExported
  , askExported
  , withUnsafe
  , askUnsafe
  , withAsync
  , askAsync
  ) where

import Control.Monad.Reader (ReaderT, runReaderT, asks, local)
import Control.Monad.Writer.Strict (Writer, runWriter, tell)
import Data.Text (Text)
import Analysis.Types

-- | Immutable context threaded through the analysis.
data Ctx = Ctx
  { ctxFile           :: !Text
  , ctxModuleId       :: !Text
  , ctxScope          :: !Scope
  , ctxEnclosingFn    :: !(Maybe Text)    -- ^ node ID of enclosing function
  , ctxEnclosingImpl  :: !(Maybe Text)    -- ^ node ID of enclosing impl block
  , ctxNamedParent    :: !(Maybe Text)    -- ^ nearest named ancestor name
  , ctxExported       :: !Bool            -- ^ inside an exported (pub) declaration?
  , ctxUnsafe         :: !Bool            -- ^ inside an unsafe block?
  , ctxAsync          :: !Bool            -- ^ inside an async block/fn?
  }

-- | The analysis monad: read context, write graph output.
type Analyzer a = ReaderT Ctx (Writer FileAnalysis) a

-- | Run the analyzer, producing a FileAnalysis.
runAnalyzer :: Text -> Text -> Analyzer a -> FileAnalysis
runAnalyzer file moduleId action =
  let ctx = Ctx
        { ctxFile           = file
        , ctxModuleId       = moduleId
        , ctxScope          = Scope
            { scopeId = moduleId
            , scopeKind = ModuleScope
            , scopeDeclarations = mempty
            , scopeParent = Nothing
            }
        , ctxEnclosingFn    = Nothing
        , ctxEnclosingImpl  = Nothing
        , ctxNamedParent    = Nothing
        , ctxExported       = False
        , ctxUnsafe         = False
        , ctxAsync          = False
        }
      (_, result) = runWriter (runReaderT action ctx)
      -- Patch file/moduleId into the result
  in result { faFile = file, faModuleId = moduleId }

-- ── Emit helpers ────────────────────────────────────────────────────────

emitNode :: GraphNode -> Analyzer ()
emitNode n = tell mempty { faNodes = [n] }

emitEdge :: GraphEdge -> Analyzer ()
emitEdge e = tell mempty { faEdges = [e] }

emitDeferred :: DeferredRef -> Analyzer ()
emitDeferred d = tell mempty { faUnresolvedRefs = [d] }

emitExport :: ExportInfo -> Analyzer ()
emitExport e = tell mempty { faExports = [e] }

-- ── Context accessors ───────────────────────────────────────────────────

askFile :: Analyzer Text
askFile = asks ctxFile

askModuleId :: Analyzer Text
askModuleId = asks ctxModuleId

askScope :: Analyzer Scope
askScope = asks ctxScope

askScopeId :: Analyzer Text
askScopeId = asks (scopeId . ctxScope)

askEnclosingFn :: Analyzer (Maybe Text)
askEnclosingFn = asks ctxEnclosingFn

askEnclosingImpl :: Analyzer (Maybe Text)
askEnclosingImpl = asks ctxEnclosingImpl

askNamedParent :: Analyzer (Maybe Text)
askNamedParent = asks ctxNamedParent

askExported :: Analyzer Bool
askExported = asks ctxExported

askUnsafe :: Analyzer Bool
askUnsafe = asks ctxUnsafe

askAsync :: Analyzer Bool
askAsync = asks ctxAsync

-- ── Context modifiers ───────────────────────────────────────────────────

-- | Push a new scope (for blocks, impls, closures, match arms, etc.).
withScope :: Scope -> Analyzer a -> Analyzer a
withScope scope = local (\ctx -> ctx { ctxScope = scope })

withEnclosingFn :: Text -> Analyzer a -> Analyzer a
withEnclosingFn fnId = local (\ctx -> ctx { ctxEnclosingFn = Just fnId })

withEnclosingImpl :: Text -> Analyzer a -> Analyzer a
withEnclosingImpl implId = local (\ctx -> ctx { ctxEnclosingImpl = Just implId })

withNamedParent :: Text -> Analyzer a -> Analyzer a
withNamedParent name = local (\ctx -> ctx { ctxNamedParent = Just name })

withExported :: Analyzer a -> Analyzer a
withExported = local (\ctx -> ctx { ctxExported = True })

withUnsafe :: Analyzer a -> Analyzer a
withUnsafe = local (\ctx -> ctx { ctxUnsafe = True })

withAsync :: Analyzer a -> Analyzer a
withAsync = local (\ctx -> ctx { ctxAsync = True })
