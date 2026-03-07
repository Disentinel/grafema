module Rules.Declarations (walkDeclarations, walkMember) where

import JavaAST (JavaTypeDecl, JavaMember)
import Analysis.Context (Analyzer)

walkDeclarations :: JavaTypeDecl -> Analyzer ()
walkMember :: JavaMember -> Analyzer ()
