{-# LANGUAGE OverloadedStrings #-}
-- | Reader context + Writer output for the C/C++ analysis monad.
-- Follows the same pattern as go-analyzer's Analysis.Context but
-- with C/C++-specific context fields (namespace stack, current class,
-- access specifier, template depth).
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
  , askCurrentClass
  , askNamespaceStack
  , askAccessSpec
  , askIsHeader
  , withScope
  , withEnclosingFn
  , withClass
  , withNamespace
  , withAccessSpec
  , currentNamespacePrefix
  ) where

import Control.Monad.Reader (ReaderT, runReaderT, asks, local)
import Control.Monad.Writer.Strict (Writer, runWriter, tell)
import Data.Text (Text)
import qualified Data.Text as T
import Analysis.Types

-- | Immutable context threaded through the analysis.
data Ctx = Ctx
  { ctxFile           :: !Text
  , ctxModuleId       :: !Text
  , ctxScope          :: !Scope
  , ctxEnclosingFn    :: !(Maybe Text)    -- ^ node ID of enclosing function/method
  , ctxCurrentClass   :: !(Maybe Text)    -- ^ current class/struct name (for methods)
  , ctxNamespaceStack :: ![Text]          -- ^ namespace nesting stack (innermost first)
  , ctxAccessSpec     :: !AccessSpec      -- ^ current access specifier context
  , ctxIsHeader       :: !Bool            -- ^ is this a header file (.h/.hpp)?
  }

-- | The analysis monad: read context, write graph output.
type Analyzer a = ReaderT Ctx (Writer FileAnalysis) a

-- | Run the analyzer, producing a FileAnalysis.
runAnalyzer :: Text -> Text -> Bool -> Analyzer a -> FileAnalysis
runAnalyzer file moduleId isHeader action =
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
        , ctxCurrentClass   = Nothing
        , ctxNamespaceStack = []
        , ctxAccessSpec     = DefaultAccess
        , ctxIsHeader       = isHeader
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

askCurrentClass :: Analyzer (Maybe Text)
askCurrentClass = asks ctxCurrentClass

askNamespaceStack :: Analyzer [Text]
askNamespaceStack = asks ctxNamespaceStack

askAccessSpec :: Analyzer AccessSpec
askAccessSpec = asks ctxAccessSpec

askIsHeader :: Analyzer Bool
askIsHeader = asks ctxIsHeader

-- ── Context modifiers ───────────────────────────────────────────────────

-- | Push a new scope (for blocks, functions, etc.).
withScope :: Scope -> Analyzer a -> Analyzer a
withScope scope = local (\ctx -> ctx { ctxScope = scope })

-- | Set the enclosing function context.
withEnclosingFn :: Text -> Analyzer a -> Analyzer a
withEnclosingFn fnId = local (\ctx -> ctx { ctxEnclosingFn = Just fnId })

-- | Set the current class context.
withClass :: Text -> Analyzer a -> Analyzer a
withClass className = local (\ctx -> ctx { ctxCurrentClass = Just className })

-- | Push a namespace onto the namespace stack.
withNamespace :: Text -> Analyzer a -> Analyzer a
withNamespace ns = local (\ctx -> ctx
  { ctxNamespaceStack = ns : ctxNamespaceStack ctx
  })

-- | Set the access specifier context.
withAccessSpec :: AccessSpec -> Analyzer a -> Analyzer a
withAccessSpec spec = local (\ctx -> ctx { ctxAccessSpec = spec })

-- | Build the current namespace prefix from the stack.
-- E.g., stack = ["inner", "outer"] -> "outer::inner"
currentNamespacePrefix :: Analyzer (Maybe Text)
currentNamespacePrefix = do
  stack <- askNamespaceStack
  case stack of
    [] -> pure Nothing
    _  -> pure (Just (T.intercalate "::" (reverse stack)))
