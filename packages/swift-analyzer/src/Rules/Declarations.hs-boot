module Rules.Declarations (walkDeclaration, walkMembers) where

import SwiftAST (SwiftDecl)
import Analysis.Context (Analyzer)

walkDeclaration :: SwiftDecl -> Analyzer ()
walkMembers :: [SwiftDecl] -> Analyzer ()
