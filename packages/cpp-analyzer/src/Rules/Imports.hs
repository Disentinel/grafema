{-# LANGUAGE OverloadedStrings #-}
-- | Import directives: #include, using directive, using declaration.
--
-- Handles these C/C++ AST constructs:
--   * 'IncludeDirective'  -> IMPORT node, deferred IncludeResolve
--   * 'UsingDirective'    -> IMPORT_BINDING node (using namespace X)
--   * 'UsingDeclaration'  -> IMPORT_BINDING node (using X::y)
module Rules.Imports
  ( walkImport
  ) where

import Data.Text (Text)
import qualified Data.Map.Strict as Map

import CppAST
import Analysis.Types
import Analysis.Context
import Grafema.SemanticId (semanticId)

-- ── Import walker ──────────────────────────────────────────────────────

walkImport :: CppNode -> Analyzer ()

-- #include directive
walkImport node | nodeKind node == "IncludeDirective" = do
  file     <- askFile
  moduleId <- askModuleId

  let includePath  = maybe "<unknown>" id (nodeName node)
      line         = nodeLine node
      col          = nodeColumn node
      endLine      = maybe line id (nodeEndLine node)
      endCol       = maybe col id (nodeEndColumn node)
      isSystem     = lookupBoolField "isSystem" node
      importName   = "#include " <> quoteInclude includePath isSystem
      importNodeId = semanticId file "IMPORT" importName Nothing Nothing

  emitNode GraphNode
    { gnId        = importNodeId
    , gnType      = "IMPORT"
    , gnName      = importName
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("path",     MetaText includePath)
        , ("isSystem", MetaBool isSystem)
        ]
    }

  emitEdge GraphEdge
    { geSource   = moduleId
    , geTarget   = importNodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Deferred resolution for #include
  emitDeferred DeferredRef
    { drKind       = IncludeResolve
    , drName       = includePath
    , drFromNodeId = importNodeId
    , drEdgeType   = "IMPORTS_FROM"
    , drScopeId    = Nothing
    , drSource     = Just includePath
    , drFile       = file
    , drLine       = line
    , drColumn     = col
    , drReceiver   = Nothing
    , drMetadata   = Map.fromList
        [ ("isSystem", MetaBool isSystem) ]
    }

-- using namespace X
walkImport node | nodeKind node == "UsingDirective" = do
  file     <- askFile
  moduleId <- askModuleId

  let nsName   = maybe "<namespace>" id (nodeName node)
      line     = nodeLine node
      col      = nodeColumn node
      endLine  = maybe line id (nodeEndLine node)
      endCol   = maybe col id (nodeEndColumn node)
      nodeId   = semanticId file "IMPORT_BINDING" nsName Nothing Nothing

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "IMPORT_BINDING"
    , gnName      = nsName
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind",      MetaText "using_directive")
        , ("namespace", MetaText nsName)
        ]
    }

  emitEdge GraphEdge
    { geSource   = moduleId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

-- using X::y
walkImport node | nodeKind node == "UsingDeclaration" = do
  file     <- askFile
  moduleId <- askModuleId

  let targetName = maybe "<target>" id (nodeName node)
      line       = nodeLine node
      col        = nodeColumn node
      endLine    = maybe line id (nodeEndLine node)
      endCol     = maybe col id (nodeEndColumn node)
      nodeId     = semanticId file "IMPORT_BINDING" targetName Nothing Nothing

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "IMPORT_BINDING"
    , gnName      = targetName
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind",   MetaText "using_declaration")
        , ("target", MetaText targetName)
        ]
    }

  emitEdge GraphEdge
    { geSource   = moduleId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

-- Fallback
walkImport _ = pure ()

-- ── Helpers ────────────────────────────────────────────────────────────

-- | Format include path with appropriate brackets/quotes.
quoteInclude :: Text -> Bool -> Text
quoteInclude path True  = "<" <> path <> ">"
quoteInclude path False = "\"" <> path <> "\""
