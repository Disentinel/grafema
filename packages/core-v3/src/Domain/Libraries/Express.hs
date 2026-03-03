{-# LANGUAGE OverloadedStrings #-}
-- Express.js library definition
module Domain.Libraries.Express (expressLib) where

import Data.Text (Text)
import Domain.LibraryDef

expressLib :: LibraryDef
expressLib = LibraryDef
  { libName   = "express"
  , libDetect =
      [ ImportName "express"
      , RequireArg "express"
      ]
  , libMethods =
      [ httpMethod "get"
      , httpMethod "post"
      , httpMethod "put"
      , httpMethod "delete"
      , httpMethod "patch"
      , httpMethod "options"
      , httpMethod "head"
      , httpMethod "all"
      , MethodRule
          { mrMethod   = "use"
          , mrNodeType = "express:middleware"
          , mrEdgeType = "MOUNTS"
          , mrArgRules =
              [ ArgRule 0 (ArgBecomesNode "express:middleware:path")
              ]
          }
      , MethodRule
          { mrMethod   = "listen"
          , mrNodeType = "express:listen"
          , mrEdgeType = "LISTENS_ON"
          , mrArgRules =
              [ ArgRule 0 (ArgBecomesNode "express:listen:port")
              ]
          }
      ]
  }

httpMethod :: Text -> MethodRule
httpMethod method = MethodRule
  { mrMethod   = method
  , mrNodeType = "http:route"
  , mrEdgeType = "EXPOSES"
  , mrArgRules =
      [ ArgRule 0 (ArgBecomesNode "http:route:path")
      , ArgRule 1 (ArgBecomesEdge "HANDLES")
      ]
  }
