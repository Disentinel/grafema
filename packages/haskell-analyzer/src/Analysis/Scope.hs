{-# LANGUAGE OverloadedStrings #-}
-- | Lexical-scope minting for the Haskell analyzer.
--
-- Unlike 'Analysis.Context.withScope' (which only swaps the threaded
-- 'ctxScope' without emitting any graph structure), 'withScopeNode'
-- materialises a finer lexical block as a real SCOPE node and wires it
-- into the lexical chain via a HAS_SCOPE edge from the enclosing scope.
--
-- This mirrors @js-analyzer\/src\/Analysis\/Scope.hs@, but the Haskell
-- analyzer must emit the HAS_SCOPE edge itself: the orchestrator's
-- @ensure_function_scope_edges@ post-processing is JS-only and is not
-- run for Haskell files (see @grafema-orchestrator\/src\/analyzer.rs@
-- @analyze_haskell_file@, which returns the analysis verbatim).
--
-- The node id scheme is @\<anchor\>:scope@ where @anchor@ is a stable,
-- position-stamped owning id supplied by the caller, so that sibling
-- clauses / case alternatives / lambdas never collide.
module Analysis.Scope
  ( withScopeNode
  ) where

import Control.Monad.Reader (local, asks)
import Data.Text (Text)
import qualified Data.Map.Strict as Map

import Analysis.Context (Analyzer, Ctx(..), askFile, emitNode, emitEdge)
import Analysis.Types
  ( Scope(..)
  , ScopeKind(..)
  , GraphNode(..)
  , GraphEdge(..)
  , MetaValue(..)
  )

-- | Render a 'ScopeKind' to the metadata\/name text used on SCOPE nodes.
scopeKindText :: ScopeKind -> Text
scopeKindText ModuleScope   = "module"
scopeKindText FunctionScope = "function"
scopeKindText WhereScope    = "where"
scopeKindText LetScope      = "let"
scopeKindText CaseScope     = "case"
scopeKindText DoScope       = "do"
scopeKindText LambdaScope   = "lambda"
scopeKindText ClassScope    = "class"
scopeKindText InstanceScope = "instance"

-- | Push a new lexical SCOPE for the duration of the inner action.
--
-- @withScopeNode kind anchor inner@:
--
--   1. computes the scope node id as @anchor <> ":scope"@,
--   2. emits a SCOPE 'GraphNode' (@gnType="SCOPE"@, @gnName=<kind>@,
--      @gnMetadata={kind:<kind>}@),
--   3. emits a HAS_SCOPE 'GraphEdge' from the *current* scope id to the
--      new scope node — this is where the lexical parent chain (thrown
--      away by the old @scopeParent=Nothing@ literals) is recovered,
--   4. swaps @ctxScope@ to the new 'Scope' (with @scopeParent@ pointing
--      at the enclosing scope) for the inner action.
--
-- Binders ('PARAMETER'\/'VARIABLE') and occurrences
-- ('REFERENCE'\/'CALL'\/'LAMBDA'\/'BRANCH'\/...) emitted by the inner
-- action read 'Analysis.Context.askScopeId' for their CONTAINS source,
-- so they are automatically re-sourced from this finer scope without any
-- edit to their emit sites.
withScopeNode :: ScopeKind -> Text -> Analyzer a -> Analyzer a
withScopeNode kind anchor inner = do
  file <- askFile
  parentScope <- asks ctxScope
  let parentScopeId = scopeId parentScope
      scopeNodeId   = anchor <> ":scope"
      kindText      = scopeKindText kind

  -- Emit SCOPE node.
  emitNode GraphNode
    { gnId        = scopeNodeId
    , gnType      = "SCOPE"
    , gnName      = kindText
    , gnFile      = file
    , gnLine      = 0
    , gnColumn    = 0
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported  = False
    , gnMetadata  = Map.singleton "kind" (MetaText kindText)
    }

  -- Emit HAS_SCOPE edge from the enclosing scope (recovers the chain).
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
