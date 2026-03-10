{-# LANGUAGE OverloadedStrings #-}
-- Reader context + Writer output for the analysis monad
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
  , askAncestors
  , withAncestor
  , withEnclosingFn
  , withEnclosingClass
  , withNamedParent
  , withExported
  , askExported
  ) where

import Control.Monad.Reader (ReaderT, runReaderT, asks, local)
import Control.Monad.Writer.Strict (Writer, runWriter, tell)
import Data.Text (Text)
import Analysis.Types
import AST.Types (ASTNode)

-- | Immutable context threaded through the analysis.
data Ctx = Ctx
  { ctxFile           :: !Text
  , ctxModuleId       :: !Text
  , ctxScope          :: !Scope
  , ctxEnclosingFn    :: !(Maybe Text)    -- node ID
  , ctxEnclosingClass :: !(Maybe Text)    -- node ID
  , ctxNamedParent    :: !(Maybe Text)    -- nearest named ancestor name
  , ctxAncestors      :: ![ASTNode]       -- parent chain (head = immediate parent)
  , ctxExported       :: !Bool            -- inside an export declaration?
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
        , ctxAncestors      = []
        , ctxExported       = False
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

askEnclosingClass :: Analyzer (Maybe Text)
askEnclosingClass = asks ctxEnclosingClass

askNamedParent :: Analyzer (Maybe Text)
askNamedParent = asks ctxNamedParent

askAncestors :: Analyzer [ASTNode]
askAncestors = asks ctxAncestors

-- ── Context modifiers ───────────────────────────────────────────────────

withAncestor :: ASTNode -> Analyzer a -> Analyzer a
withAncestor node = local (\ctx -> ctx { ctxAncestors = node : ctxAncestors ctx })

withEnclosingFn :: Text -> Analyzer a -> Analyzer a
withEnclosingFn fnId = local (\ctx -> ctx { ctxEnclosingFn = Just fnId })

withEnclosingClass :: Text -> Analyzer a -> Analyzer a
withEnclosingClass clsId = local (\ctx -> ctx { ctxEnclosingClass = Just clsId })

withNamedParent :: Text -> Analyzer a -> Analyzer a
withNamedParent name = local (\ctx -> ctx { ctxNamedParent = Just name })

withExported :: Analyzer a -> Analyzer a
withExported = local (\ctx -> ctx { ctxExported = True })

askExported :: Analyzer Bool
askExported = asks ctxExported
