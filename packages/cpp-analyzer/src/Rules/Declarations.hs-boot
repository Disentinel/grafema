module Rules.Declarations (walkDeclaration, walkParam, walkBodyChild) where

import Data.Text (Text)
import CppAST (CppNode)
import Analysis.Context (Analyzer)

walkDeclaration :: CppNode -> Analyzer ()
walkParam :: Text -> Text -> CppNode -> Analyzer ()
walkBodyChild :: CppNode -> Analyzer ()
