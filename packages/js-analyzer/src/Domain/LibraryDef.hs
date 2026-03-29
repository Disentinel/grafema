{-# LANGUAGE OverloadedStrings #-}
-- Declarative library definition ADT for domain-specific graph enrichment
module Domain.LibraryDef
  ( LibraryDef(..)
  , DetectPattern(..)
  , MethodRule(..)
  , ArgRule(..)
  , ArgAction(..)
  ) where

import Data.Text (Text)

-- | How to detect that a module uses this library
data DetectPattern
  = ImportName !Text      -- ^ import X from "name"
  | RequireArg !Text      -- ^ require("name")
  deriving (Show, Eq)

-- | What to do with a specific argument position
data ArgAction
  = ArgBecomesNode !Text  -- ^ emit a node of this type (e.g., "http:route:path")
  | ArgBecomesEdge !Text  -- ^ emit an edge of this type
  | ArgIgnore             -- ^ skip this argument
  deriving (Show, Eq)

-- | Rule for a specific argument position
data ArgRule = ArgRule
  { arIndex  :: !Int        -- ^ 0-based argument index
  , arAction :: !ArgAction  -- ^ what to do with this arg
  } deriving (Show, Eq)

-- | Rule for a specific method on the library object
data MethodRule = MethodRule
  { mrMethod   :: !Text     -- ^ method name: "get", "post", "use"
  , mrNodeType :: !Text     -- ^ graph node type to emit: "http:route"
  , mrEdgeType :: !Text     -- ^ edge type from caller: "EXPOSES"
  , mrArgRules :: ![ArgRule] -- ^ per-argument rules
  } deriving (Show, Eq)

-- | Declarative definition of a library's graph semantics
data LibraryDef = LibraryDef
  { libName    :: !Text            -- ^ "express"
  , libDetect  :: ![DetectPattern] -- ^ how to detect usage
  , libMethods :: ![MethodRule]    -- ^ per-method rules
  } deriving (Show, Eq)
