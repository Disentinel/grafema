{-# LANGUAGE OverloadedStrings #-}
-- | Reader context + Writer output for the Java analysis monad.
-- Follows the same pattern as rust-analyzer's Analysis.Context but
-- with Java-specific context fields (enclosingClass, package, static).
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
  , askPackage
  , withScope
  , withEnclosingFn
  , withEnclosingClass
  , withNamedParent
  , withExported
  , askExported
  , withStatic
  , askStatic
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
  , ctxEnclosingFn    :: !(Maybe Text)    -- ^ node ID of enclosing method/constructor
  , ctxEnclosingClass :: !(Maybe Text)    -- ^ node ID of enclosing class/interface/enum
  , ctxNamedParent    :: !(Maybe Text)    -- ^ nearest named ancestor name
  , ctxPackage        :: !(Maybe Text)    -- ^ package name (e.g. "com.example.app")
  , ctxExported       :: !Bool            -- ^ inside a public declaration?
  , ctxStatic         :: !Bool            -- ^ inside a static context?
  }

-- | The analysis monad: read context, write graph output.
type Analyzer a = ReaderT Ctx (Writer FileAnalysis) a

-- | Run the analyzer, producing a FileAnalysis.
runAnalyzer :: Text -> Text -> Maybe Text -> Analyzer a -> FileAnalysis
runAnalyzer file moduleId pkg action =
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
        , ctxPackage        = pkg
        , ctxExported       = False
        , ctxStatic         = False
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

askPackage :: Analyzer (Maybe Text)
askPackage = asks ctxPackage

askExported :: Analyzer Bool
askExported = asks ctxExported

askStatic :: Analyzer Bool
askStatic = asks ctxStatic

-- ── Context modifiers ───────────────────────────────────────────────────

-- | Push a new scope (for blocks, classes, methods, lambdas, etc.).
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

withStatic :: Analyzer a -> Analyzer a
withStatic = local (\ctx -> ctx { ctxStatic = True })
