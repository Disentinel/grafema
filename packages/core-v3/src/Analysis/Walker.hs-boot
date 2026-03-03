{-# LANGUAGE OverloadedStrings #-}
module Analysis.Walker
  ( walkNode
  ) where

import Data.Text (Text)
import Analysis.Context (Analyzer)
import AST.Types (ASTNode)

walkNode :: ASTNode -> Analyzer (Maybe Text)
