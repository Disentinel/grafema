{-# LANGUAGE OverloadedStrings #-}
-- | Reader context + Writer output for the Go analysis monad.
-- Follows the same pattern as java-analyzer's Analysis.Context but
-- with Go-specific context fields (packageName, receiver, pointerReceiver).
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
  , askPackageName
  , askReceiver
  , askPointerReceiver
  , askIsGoroutine
  , askIsDeferred
  , withScope
  , withEnclosingFn
  , withReceiver
  , withGoroutine
  , withDeferred
  ) where

import Control.Monad.Reader (ReaderT, runReaderT, asks, local)
import Control.Monad.Writer.Strict (Writer, runWriter, tell)
import Data.Text (Text)
import Analysis.Types

-- | Immutable context threaded through the analysis.
data Ctx = Ctx
  { ctxFile             :: !Text
  , ctxModuleId         :: !Text
  , ctxScope            :: !Scope
  , ctxEnclosingFn      :: !(Maybe Text)    -- ^ node ID of enclosing function/method
  , ctxPackageName      :: !Text            -- ^ Go package name
  , ctxReceiver         :: !(Maybe Text)    -- ^ receiver type name (for methods)
  , ctxPointerReceiver  :: !Bool            -- ^ pointer receiver?
  , ctxIsGoroutine      :: !Bool            -- ^ inside a @go@ statement
  , ctxIsDeferred       :: !Bool            -- ^ inside a @defer@ statement
  }

-- | The analysis monad: read context, write graph output.
type Analyzer a = ReaderT Ctx (Writer FileAnalysis) a

-- | Run the analyzer, producing a FileAnalysis.
runAnalyzer :: Text -> Text -> Text -> Analyzer a -> FileAnalysis
runAnalyzer file moduleId pkg action =
  let ctx = Ctx
        { ctxFile             = file
        , ctxModuleId         = moduleId
        , ctxScope            = Scope
            { scopeId = moduleId
            , scopeKind = ModuleScope
            , scopeDeclarations = mempty
            , scopeParent = Nothing
            }
        , ctxEnclosingFn      = Nothing
        , ctxPackageName      = pkg
        , ctxReceiver         = Nothing
        , ctxPointerReceiver  = False
        , ctxIsGoroutine      = False
        , ctxIsDeferred       = False
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

askPackageName :: Analyzer Text
askPackageName = asks ctxPackageName

askReceiver :: Analyzer (Maybe Text)
askReceiver = asks ctxReceiver

askPointerReceiver :: Analyzer Bool
askPointerReceiver = asks ctxPointerReceiver

askIsGoroutine :: Analyzer Bool
askIsGoroutine = asks ctxIsGoroutine

askIsDeferred :: Analyzer Bool
askIsDeferred = asks ctxIsDeferred

-- ── Context modifiers ───────────────────────────────────────────────────

-- | Push a new scope (for blocks, functions, etc.).
withScope :: Scope -> Analyzer a -> Analyzer a
withScope scope = local (\ctx -> ctx { ctxScope = scope })

-- | Set the enclosing function context.
withEnclosingFn :: Text -> Analyzer a -> Analyzer a
withEnclosingFn fnId = local (\ctx -> ctx { ctxEnclosingFn = Just fnId })

-- | Set the receiver context (for method analysis).
withReceiver :: Text -> Bool -> Analyzer a -> Analyzer a
withReceiver typeName isPointer = local (\ctx -> ctx
  { ctxReceiver = Just typeName
  , ctxPointerReceiver = isPointer
  })

-- | Mark analysis as inside a @go@ statement.
withGoroutine :: Analyzer a -> Analyzer a
withGoroutine = local (\ctx -> ctx { ctxIsGoroutine = True })

-- | Mark analysis as inside a @defer@ statement.
withDeferred :: Analyzer a -> Analyzer a
withDeferred = local (\ctx -> ctx { ctxIsDeferred = True })
