{-# LANGUAGE OverloadedStrings #-}
-- Scope management via Reader local
module Analysis.Scope
  ( withScope
  , declareInScope
  ) where

import Control.Monad.Reader (local, asks)
import Data.Text (Text)
import qualified Data.Map.Strict as Map
import Analysis.Types (Scope(..), ScopeKind(..), Declaration(..), GraphNode(..), GraphEdge(..), MetaValue(..))
import Analysis.Context (Analyzer, Ctx(..), askFile, emitNode, emitEdge)

-- | Push a new scope for the duration of the inner action.
-- Emits a SCOPE node and HAS_SCOPE edge from the parent scope.
withScope :: ScopeKind -> Text -> Analyzer a -> Analyzer a
withScope kind scopeId' inner = do
  file <- askFile
  parentScope <- asks ctxScope
  let parentScopeId = scopeId parentScope
      -- Unique SCOPE node ID — avoids collision with FUNCTION/LOOP/CLASS nodes
      scopeNodeId = scopeId' <> ":scope"
      kindText = case kind of
        GlobalScope   -> "global"
        ModuleScope   -> "module"
        FunctionScope -> "function"
        BlockScope    -> "block"
        ClassScope    -> "class"
        WithScope     -> "with"
        CatchScope    -> "catch"

  -- Emit SCOPE node
  emitNode GraphNode
    { gnId       = scopeNodeId
    , gnType     = "SCOPE"
    , gnName     = kindText
    , gnFile     = file
    , gnLine     = 0
    , gnColumn   = 0
    , gnEndLine  = 0
    , gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.singleton "kind" (MetaText kindText)
    }

  -- Emit HAS_SCOPE edge from parent
  emitEdge GraphEdge
    { geSource   = parentScopeId
    , geTarget   = scopeNodeId
    , geType     = "HAS_SCOPE"
    , geMetadata = Map.empty
    }

  let newScope = Scope
        { scopeId           = scopeNodeId
        , scopeKind         = kind
        , scopeDeclarations = Map.empty
        , scopeParent       = Just parentScope
        }
  local (\ctx -> ctx { ctxScope = newScope }) inner

-- | Register a declaration in the current scope.
-- Returns the analyzer action that runs in a scope with the declaration added.
declareInScope :: Declaration -> Analyzer a -> Analyzer a
declareInScope decl inner =
  local (\ctx ->
    let s = ctxScope ctx
        s' = s { scopeDeclarations =
                    Map.insert (Analysis.Types.declName decl)
                               decl
                               (scopeDeclarations s) }
    in ctx { ctxScope = s' }
  ) inner
