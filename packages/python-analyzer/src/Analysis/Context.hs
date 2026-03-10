{-# LANGUAGE OverloadedStrings #-}
-- | Reader context + Writer output for the Python analysis monad.
-- Follows the same pattern as java-analyzer's Analysis.Context but
-- with Python-specific context fields (globals, nonlocals, async).
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
  , askEnclosingClass
  , askNamedParent
  , askExported
  , askAsync
  , askGlobals
  , askNonlocals
  , withScope
  , withEnclosingFn
  , withEnclosingClass
  , withNamedParent
  , withExported
  , withAsync
  , withGlobals
  , withNonlocals
  ) where

import Control.Monad.Reader (ReaderT, runReaderT, asks, local)
import Control.Monad.Writer.Strict (Writer, runWriter, tell)
import Data.Text (Text)
import Data.Set (Set)
import qualified Data.Set as Set
import Analysis.Types

-- | Immutable context threaded through the analysis.
data Ctx = Ctx
  { ctxFile           :: !Text
  , ctxModuleId       :: !Text
  , ctxScope          :: !Scope
  , ctxEnclosingFn    :: !(Maybe Text)    -- ^ node ID of enclosing function
  , ctxEnclosingClass :: !(Maybe Text)    -- ^ node ID of enclosing class
  , ctxNamedParent    :: !(Maybe Text)    -- ^ nearest named ancestor name
  , ctxExported       :: !Bool            -- ^ inside public scope?
  , ctxAsync          :: !Bool            -- ^ inside async context?
  , ctxGlobals        :: !(Set Text)      -- ^ names declared global in current function
  , ctxNonlocals      :: !(Set Text)      -- ^ names declared nonlocal in current function
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
        , ctxEnclosingClass = Nothing
        , ctxNamedParent    = Nothing
        , ctxExported       = True   -- module-level names are exported by default in Python
        , ctxAsync          = False
        , ctxGlobals        = Set.empty
        , ctxNonlocals      = Set.empty
        }
      (_, result) = runWriter (runReaderT action ctx)
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

askEnclosingClass :: Analyzer (Maybe Text)
askEnclosingClass = asks ctxEnclosingClass

askNamedParent :: Analyzer (Maybe Text)
askNamedParent = asks ctxNamedParent

askExported :: Analyzer Bool
askExported = asks ctxExported

askAsync :: Analyzer Bool
askAsync = asks ctxAsync

askGlobals :: Analyzer (Set Text)
askGlobals = asks ctxGlobals

askNonlocals :: Analyzer (Set Text)
askNonlocals = asks ctxNonlocals

-- ── Context modifiers ───────────────────────────────────────────────────

-- | Push a new scope (for functions, classes, comprehensions, etc.).
withScope :: Scope -> Analyzer a -> Analyzer a
withScope scope = local (\ctx -> ctx { ctxScope = scope })

withEnclosingFn :: Text -> Analyzer a -> Analyzer a
withEnclosingFn fnId = local (\ctx -> ctx { ctxEnclosingFn = Just fnId })

withEnclosingClass :: Text -> Analyzer a -> Analyzer a
withEnclosingClass clsId = local (\ctx -> ctx { ctxEnclosingClass = Just clsId })

withNamedParent :: Text -> Analyzer a -> Analyzer a
withNamedParent name = local (\ctx -> ctx { ctxNamedParent = Just name })

withExported :: Analyzer a -> Analyzer a
withExported = local (\ctx -> ctx { ctxExported = True })

withAsync :: Analyzer a -> Analyzer a
withAsync = local (\ctx -> ctx { ctxAsync = True })

withGlobals :: Set Text -> Analyzer a -> Analyzer a
withGlobals names = local (\ctx -> ctx { ctxGlobals = names })

withNonlocals :: Set Text -> Analyzer a -> Analyzer a
withNonlocals names = local (\ctx -> ctx { ctxNonlocals = names })
