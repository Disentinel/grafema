{-# LANGUAGE OverloadedStrings #-}
-- | Lexical scope emission for the Python analyzer.
--
-- Mirrors js-analyzer/src/Analysis/Scope.hs: entering a lexical binder
-- (function / class / lambda / comprehension / except handler) emits a
-- first-class SCOPE node and a HAS_SCOPE edge from the binder's OWNER node,
-- and pushes a scope whose 'scopeParent' links the lexical chain.
--
-- Convention (byte-stable with the flat resolver — see NOTE below):
--
--   * The SCOPE node id is @ownerId <> ":scope"@. This NEVER collides with
--     the FUNCTION/CLASS/lambda node id (@ownerId@) and is purely additive.
--   * HAS_SCOPE goes @ownerId -> ownerId:scope@ (the owner FUNCTION/CLASS
--     "has" its body scope — the JS idiom). The lexical-ancestor walk then
--     climbs SCOPE -HAS_SCOPE-> SCOPE for nested scopes and hops out of a
--     function body via owner FUNCTION -HAS_SCOPE-> scope, owner -CONTAINS->
--     outer scope.
--   * Child declarations/calls are CONTAINS-sourced from @ownerId:scope@
--     (re-sourced from the old @ownerId@), because the pushed scope's
--     'scopeId' becomes @ownerId:scope@. This is the structural re-parent:
--     FUNCTION -> SCOPE -> child instead of FUNCTION -> child.
--
-- Module root is intentionally NOT given a ":scope" node — top-level binders
-- stay MODULE-contained (the JS convention; @runAnalyzer@ seeds the root
-- scope with @scopeId = moduleId@). Only function/class/lambda/comprehension/
-- except bodies get a SCOPE node.
--
-- NOTE (lockstep / ID stability): the Python native resolvers (python-resolve)
-- are a NODES-ONLY daemon — they never read CONTAINS/HAS_SCOPE edges. They
-- resolve flat by (file, name) and by string-parsing the @[in:ClassName]@
-- payload of the FUNCTION/CLASS semantic id. This module keeps every owner
-- node id and every semantic-id @parent@ payload BYTE-STABLE; it only ADDS
-- SCOPE nodes / HAS_SCOPE edges and re-sources child CONTAINS. So the flat
-- resolver is unaffected (nothing to migrate without a protocol change).
module Analysis.Scope
  ( withLexicalScope
  ) where

import Control.Monad.Reader (asks, local)
import Data.Text (Text)
import qualified Data.Map.Strict as Map
import Analysis.Types (Scope(..), ScopeKind(..), GraphNode(..), GraphEdge(..), MetaValue(..))
import Analysis.Context (Analyzer, Ctx(..), askFile, emitNode, emitEdge)

-- | Enter a lexical scope owned by @ownerId@ (a FUNCTION/CLASS/lambda node id).
--
-- Emits the SCOPE node + HAS_SCOPE edge, then runs @inner@ in a context whose
-- current scope is the new @ownerId:scope@ with 'scopeParent' linked to the
-- enclosing scope. Replaces the old pattern of constructing a 'Scope' with
-- @scopeId = ownerId@ and @scopeParent = Nothing@ inline.
withLexicalScope :: ScopeKind -> Text -> Analyzer a -> Analyzer a
withLexicalScope kind ownerId inner = do
  file        <- askFile
  parentScope <- asks ctxScope
  let scopeNodeId = ownerId <> ":scope"
      kindText = scopeKindText kind

  -- SCOPE node (additive — never collides with the owner node id).
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

  -- HAS_SCOPE edge from the owner node to its body scope.
  emitEdge GraphEdge
    { geSource   = ownerId
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

scopeKindText :: ScopeKind -> Text
scopeKindText ModuleScope        = "module"
scopeKindText FunctionScope      = "function"
scopeKindText ClassScope         = "class"
scopeKindText LambdaScope        = "lambda"
scopeKindText ComprehensionScope = "comprehension"
scopeKindText ExceptScope        = "except"
