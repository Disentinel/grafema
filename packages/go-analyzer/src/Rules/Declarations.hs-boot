module Rules.Declarations (walkDeclarations, walkMember, walkParam) where

import Data.Text (Text)
import GoAST (GoDecl, GoFieldDef, GoParam)
import Analysis.Context (Analyzer)

walkDeclarations :: GoDecl -> Analyzer ()
walkMember :: GoFieldDef -> Analyzer ()
walkParam :: Text -> Text -> GoParam -> Analyzer ()
