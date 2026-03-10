{-# LANGUAGE OverloadedStrings #-}
-- Generic call-site matching against LibraryDefs
module Domain.Matcher
  ( matchCallSite
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import Analysis.Types
import Analysis.Context
import Analysis.SemanticId (semanticId)
import AST.Types
import AST.Span (Span(..))
import Domain.LibraryDef
import Domain.Libraries.Express (expressLib)

-- | All registered library definitions
allLibraryDefs :: [LibraryDef]
allLibraryDefs =
  [ expressLib
  ]

-- | Check if a call expression matches any library definition.
-- If it does, emit domain-specific nodes and edges.
-- Called from ruleCallExpression after the normal CALL node is emitted.
matchCallSite :: Text -> Text -> ASTNode -> Analyzer ()
matchCallSite callee callNodeId node = do
  let (receiver, method) = splitCallee callee
  mapM_ (\lib -> matchLib lib receiver method callNodeId node) allLibraryDefs

-- | Split "obj.method" into ("obj", "method"). If no dot, receiver is "".
splitCallee :: Text -> (Text, Text)
splitCallee t =
  case T.breakOnEnd "." t of
    ("", _)  -> ("", t)            -- no dot: bare function call
    (pre, m) -> (T.dropEnd 1 pre, m)  -- drop trailing dot from prefix

-- | Try to match a single library definition
matchLib :: LibraryDef -> Text -> Text -> Text -> ASTNode -> Analyzer ()
matchLib lib receiver method callNodeId node =
  -- For now, match if receiver matches any detect pattern name AND method matches
  -- Full import tracking would require cross-file resolution (Datalog phase)
  if receiverMatchesLib lib receiver
    then mapM_ (\rule ->
           if mrMethod rule == method
             then applyMethodRule lib rule callNodeId node
             else return ()
         ) (libMethods lib)
    else return ()

-- | Check if the receiver name could refer to this library.
-- Simple heuristic: receiver matches the library name or common aliases.
receiverMatchesLib :: LibraryDef -> Text -> Bool
receiverMatchesLib lib receiver =
  receiver == libName lib ||
  receiver == "app" ||  -- express convention: const app = express()
  receiver == "router"  -- express convention: const router = express.Router()

-- | Apply a matched method rule: emit domain nodes + edges
applyMethodRule :: LibraryDef -> MethodRule -> Text -> ASTNode -> Analyzer ()
applyMethodRule _lib rule callNodeId node = do
  file <- askFile
  parent <- askNamedParent
  let sp     = astNodeSpan node
      nodeId = semanticId file (mrNodeType rule) (mrMethod rule) parent Nothing

  -- Emit the domain node (e.g., http:route)
  emitNode GraphNode
    { gnId       = nodeId
    , gnType     = mrNodeType rule
    , gnName     = mrMethod rule
    , gnFile     = file
    , gnLine     = spanStart sp
    , gnColumn   = 0
    , gnEndLine  = spanEnd sp
    , gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.singleton "method" (MetaText (mrMethod rule))
    }

  -- Emit the domain edge (e.g., EXPOSES from call to domain node)
  emitEdge GraphEdge
    { geSource   = callNodeId
    , geTarget   = nodeId
    , geType     = mrEdgeType rule
    , geMetadata = Map.empty
    }

  -- Process argument rules
  let args = getChildren "arguments" node
  mapM_ (\argRule ->
    let idx = arIndex argRule
    in if idx < length args
       then applyArgRule argRule (args !! idx) nodeId file
       else return ()
    ) (mrArgRules rule)

-- | Apply a single argument rule
applyArgRule :: ArgRule -> ASTNode -> Text -> Text -> Analyzer ()
applyArgRule argRule argNode parentNodeId file = do
  let sp = astNodeSpan argNode
  case arAction argRule of
    ArgBecomesNode nodeType -> do
      let argValue = getTextFieldOr "value" (getTextFieldOr "name" "<arg>" argNode) argNode
          argId = semanticId file nodeType argValue Nothing Nothing
      emitNode GraphNode
        { gnId       = argId
        , gnType     = nodeType
        , gnName     = argValue
        , gnFile     = file
        , gnLine     = spanStart sp
        , gnColumn   = 0
        , gnEndLine  = spanEnd sp
        , gnEndColumn = 0
        , gnExported = False
        , gnMetadata = Map.empty
        }
      emitEdge GraphEdge
        { geSource = parentNodeId
        , geTarget = argId
        , geType   = "HAS_PATH"
        , geMetadata = Map.empty
        }
    ArgBecomesEdge edgeType -> do
      let argId = semanticId file "ARG" (T.pack (show (arIndex argRule))) Nothing Nothing
      emitEdge GraphEdge
        { geSource = parentNodeId
        , geTarget = argId
        , geType   = edgeType
        , geMetadata = Map.empty
        }
    ArgIgnore -> return ()
