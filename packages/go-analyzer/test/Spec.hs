{-# LANGUAGE OverloadedStrings #-}
module Main where

import Test.Hspec
import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import GoAST
import Analysis.Types
import Analysis.Context (runAnalyzer)
import Analysis.Walker (walkFile)

-- ── Test helpers ─────────────────────────────────────────────────────────

-- | Default span for test ASTs.
sp :: Span
sp = Span (Pos 1 0) (Pos 1 10)

sp2 :: Span
sp2 = Span (Pos 5 0) (Pos 5 10)

sp3 :: Span
sp3 = Span (Pos 10 0) (Pos 10 10)

sp4 :: Span
sp4 = Span (Pos 15 0) (Pos 15 10)

sp5 :: Span
sp5 = Span (Pos 20 0) (Pos 20 10)

-- | Run analyzer on a GoFile with the given file path.
analyze :: Text -> GoFile -> FileAnalysis
analyze file ast = runAnalyzer file ("MODULE#" <> file) (gfPackage ast) (walkFile ast)

-- | Find nodes by type.
nodesByType :: Text -> FileAnalysis -> [GraphNode]
nodesByType ty fa = filter (\n -> gnType n == ty) (faNodes fa)

-- | Find nodes by name.
nodesByName :: Text -> FileAnalysis -> [GraphNode]
nodesByName name fa = filter (\n -> gnName n == name) (faNodes fa)

-- | Find edges by type.
edgesByType :: Text -> FileAnalysis -> [GraphEdge]
edgesByType ty fa = filter (\e -> geType e == ty) (faEdges fa)

-- | Find edges from a source.
edgesFrom :: Text -> FileAnalysis -> [GraphEdge]
edgesFrom src fa = filter (\e -> geSource e == src) (faEdges fa)

-- | Get metadata value as Text.
metaText :: Text -> GraphNode -> Maybe Text
metaText key node = case Map.lookup key (gnMetadata node) of
  Just (MetaText t) -> Just t
  _                 -> Nothing

-- | Get metadata value as Bool.
metaBool :: Text -> GraphNode -> Maybe Bool
metaBool key node = case Map.lookup key (gnMetadata node) of
  Just (MetaBool b) -> Just b
  _                 -> Nothing

-- | Get metadata value as Int.
metaInt :: Text -> GraphNode -> Maybe Int
metaInt key node = case Map.lookup key (gnMetadata node) of
  Just (MetaInt i) -> Just i
  _                -> Nothing

-- ── Test AST helpers ─────────────────────────────────────────────────────

emptyFile :: GoFile
emptyFile = GoFile "main" [] []

simpleFunc :: Text -> [GoParam] -> Maybe GoStmt -> GoDecl
simpleFunc name params body = FuncDecl name Nothing [] params [] body sp

methodDecl :: Text -> Text -> Bool -> Maybe GoStmt -> GoDecl
methodDecl name recvType isPointer body =
  FuncDecl name (Just (GoReceiver (Just "r") recvType isPointer)) [] [] [] body sp2

structDecl :: Text -> [GoFieldDef] -> GoDecl
structDecl name fields = StructTypeDecl name fields [] sp

interfaceDecl :: Text -> [GoMethodSig] -> [GoType] -> GoDecl
interfaceDecl name methods embeds = InterfaceTypeDecl name methods embeds [] sp

varDecl :: [GoVarSpec] -> GoDecl
varDecl specs = VarDecl specs sp

constDecl :: [GoVarSpec] -> GoDecl
constDecl specs = ConstDecl specs sp

typeAlias :: Text -> GoDecl
typeAlias name = TypeAliasDecl name (IdentType "string" sp) sp

mkParam :: Text -> GoParam
mkParam name = GoParam (Just name) (IdentType "int" sp) False sp

mkField :: Text -> Bool -> GoFieldDef
mkField name embedded = GoFieldDef name (IdentType "string" sp) Nothing embedded sp

mkMethodSig :: Text -> GoMethodSig
mkMethodSig name = GoMethodSig name [] [] sp

mkVarSpec :: [Text] -> GoVarSpec
mkVarSpec names = GoVarSpec names Nothing [] sp3

mkImport :: Text -> Text -> GoImport
mkImport name path = GoImport name path Nothing False False sp

-- ── Tests ────────────────────────────────────────────────────────────────

main :: IO ()
main = hspec $ do

  describe "MODULE node" $ do
    it "emits a MODULE node for empty file" $ do
      let result = analyze "src/main.go" emptyFile
          modules = nodesByType "MODULE" result
      length modules `shouldBe` 1
      gnName (head modules) `shouldBe` "main"
      gnExported (head modules) `shouldBe` True

    it "includes package metadata in MODULE node" $ do
      let result = analyze "src/main.go" emptyFile
          modules = nodesByType "MODULE" result
      metaText "package" (head modules) `shouldBe` Just "main"

    it "extracts module name from file path" $ do
      let result = analyze "pkg/handler.go" (GoFile "pkg" [] [])
          modules = nodesByType "MODULE" result
      gnName (head modules) `shouldBe` "handler"

  describe "FUNCTION node (function)" $ do
    it "emits FUNCTION node for a top-level function" $ do
      let ast = emptyFile { gfDecls = [simpleFunc "main" [] Nothing] }
          result = analyze "main.go" ast
          funcs = nodesByType "FUNCTION" result
      length funcs `shouldBe` 1
      gnName (head funcs) `shouldBe` "main"
      metaText "kind" (head funcs) `shouldBe` Just "function"

    it "sets paramCount metadata" $ do
      let params = [mkParam "x", mkParam "y"]
          ast = emptyFile { gfDecls = [simpleFunc "Add" params Nothing] }
          result = analyze "math.go" ast
          funcs = nodesByName "Add" result
      metaInt "paramCount" (head funcs) `shouldBe` Just 2

    it "detects exported function (uppercase)" $ do
      let ast = emptyFile { gfDecls = [simpleFunc "Export" [] Nothing] }
          result = analyze "lib.go" ast
          funcs = nodesByName "Export" result
      gnExported (head funcs) `shouldBe` True

    it "detects unexported function (lowercase)" $ do
      let ast = emptyFile { gfDecls = [simpleFunc "helper" [] Nothing] }
          result = analyze "lib.go" ast
          funcs = nodesByName "helper" result
      gnExported (head funcs) `shouldBe` False

  describe "FUNCTION node (method)" $ do
    it "emits FUNCTION node with kind=method for method with receiver" $ do
      let ast = emptyFile { gfDecls = [methodDecl "String" "MyType" False Nothing] }
          result = analyze "types.go" ast
          funcs = nodesByType "FUNCTION" result
      length funcs `shouldBe` 1
      metaText "kind" (head funcs) `shouldBe` Just "method"
      metaText "receiver" (head funcs) `shouldBe` Just "MyType"

    it "sets pointer_receiver metadata" $ do
      let ast = emptyFile { gfDecls = [methodDecl "Set" "MyType" True Nothing] }
          result = analyze "types.go" ast
          funcs = nodesByType "FUNCTION" result
      metaBool "pointer_receiver" (head funcs) `shouldBe` Just True

    it "method semantic ID includes receiver type" $ do
      let ast = emptyFile { gfDecls = [methodDecl "Get" "Srv" False Nothing] }
          result = analyze "srv.go" ast
          funcs = nodesByName "Get" result
      -- Semantic ID should contain receiver type as parent
      T.isInfixOf "Srv" (gnId (head funcs)) `shouldBe` True

  describe "CLASS node (struct)" $ do
    it "emits CLASS node for struct with kind=struct" $ do
      let ast = emptyFile { gfDecls = [structDecl "Server" []] }
          result = analyze "server.go" ast
          classes = nodesByType "CLASS" result
      length classes `shouldBe` 1
      gnName (head classes) `shouldBe` "Server"
      metaText "kind" (head classes) `shouldBe` Just "struct"

    it "emits VARIABLE nodes for struct fields with kind=field" $ do
      let fields = [mkField "Name" False, mkField "Age" False]
          ast = emptyFile { gfDecls = [structDecl "Person" fields] }
          result = analyze "person.go" ast
          vars = filter (\n -> metaText "kind" n == Just "field") (nodesByType "VARIABLE" result)
      length vars `shouldBe` 2

    it "emits EXTENDS edge for embedded struct field" $ do
      let fields = [mkField "BaseModel" True]
          ast = emptyFile { gfDecls = [structDecl "User" fields] }
          result = analyze "user.go" ast
          extends = edgesByType "EXTENDS" result
      length extends `shouldBe` 1

    it "emits HAS_PROPERTY edges for struct fields" $ do
      let fields = [mkField "Name" False]
          ast = emptyFile { gfDecls = [structDecl "Person" fields] }
          result = analyze "person.go" ast
          props = edgesByType "HAS_PROPERTY" result
      length props `shouldBe` 1

  describe "INTERFACE node" $ do
    it "emits INTERFACE node for interface" $ do
      let ast = emptyFile { gfDecls = [interfaceDecl "Reader" [mkMethodSig "Read"] []] }
          result = analyze "io.go" ast
          ifaces = nodesByType "INTERFACE" result
      length ifaces `shouldBe` 1
      gnName (head ifaces) `shouldBe` "Reader"

    it "emits FUNCTION nodes for interface methods" $ do
      let methods = [mkMethodSig "Read", mkMethodSig "Close"]
          ast = emptyFile { gfDecls = [interfaceDecl "ReadCloser" methods []] }
          result = analyze "io.go" ast
          funcs = filter (\n -> metaText "kind" n == Just "interface_method") (nodesByType "FUNCTION" result)
      length funcs `shouldBe` 2

    it "emits EXTENDS edge for embedded interface" $ do
      let ast = emptyFile { gfDecls = [interfaceDecl "ReadWriter" [] [IdentType "Reader" sp, IdentType "Writer" sp]] }
          result = analyze "io.go" ast
          extends = edgesByType "EXTENDS" result
      length extends `shouldBe` 2

  describe "IMPORT node" $ do
    it "emits IMPORT node for import" $ do
      let ast = emptyFile { gfImports = [mkImport "fmt" "fmt"] }
          result = analyze "main.go" ast
          imports = nodesByType "IMPORT" result
      length imports `shouldBe` 1
      gnName (head imports) `shouldBe` "fmt"
      metaText "path" (head imports) `shouldBe` Just "fmt"

    it "IMPORT node is never exported" $ do
      let ast = emptyFile { gfImports = [mkImport "fmt" "fmt"] }
          result = analyze "main.go" ast
          imports = nodesByType "IMPORT" result
      gnExported (head imports) `shouldBe` False

    it "sets blank metadata for blank import" $ do
      let imp = GoImport "_" "database/sql" Nothing True False sp
          ast = emptyFile { gfImports = [imp] }
          result = analyze "main.go" ast
          imports = nodesByType "IMPORT" result
      metaBool "blank" (head imports) `shouldBe` Just True

    it "sets dot metadata for dot import" $ do
      let imp = GoImport "." "fmt" Nothing False True sp
          ast = emptyFile { gfImports = [imp] }
          result = analyze "main.go" ast
          imports = nodesByType "IMPORT" result
      metaBool "dot" (head imports) `shouldBe` Just True

    it "emits CONTAINS edge from MODULE to IMPORT" $ do
      let ast = emptyFile { gfImports = [mkImport "fmt" "fmt"] }
          result = analyze "main.go" ast
          moduleId = "MODULE#main.go"
          contains = filter (\e -> geSource e == moduleId && geType e == "CONTAINS")
                            (faEdges result)
          importEdges = filter (\e -> T.isInfixOf "IMPORT" (geTarget e)) contains
      length importEdges `shouldSatisfy` (> 0)

  describe "VARIABLE node" $ do
    it "emits VARIABLE node for var declaration" $ do
      let spec = mkVarSpec ["count"]
          ast = emptyFile { gfDecls = [varDecl [spec]] }
          result = analyze "main.go" ast
          vars = nodesByType "VARIABLE" result
      length vars `shouldBe` 1
      gnName (head vars) `shouldBe` "count"
      metaText "kind" (head vars) `shouldBe` Just "variable"
      metaBool "mutable" (head vars) `shouldBe` Just True

    it "emits multiple VARIABLE nodes for multi-name var spec" $ do
      let spec = GoVarSpec ["x", "y", "z"] Nothing [] sp3
          ast = emptyFile { gfDecls = [varDecl [spec]] }
          result = analyze "main.go" ast
          vars = nodesByType "VARIABLE" result
      length vars `shouldBe` 3

    it "detects exported variable (uppercase)" $ do
      let spec = mkVarSpec ["MaxRetries"]
          ast = emptyFile { gfDecls = [varDecl [spec]] }
          result = analyze "config.go" ast
          vars = nodesByName "MaxRetries" result
      gnExported (head vars) `shouldBe` True

  describe "CONSTANT node" $ do
    it "emits CONSTANT node for const declaration" $ do
      let spec = mkVarSpec ["Pi"]
          ast = emptyFile { gfDecls = [constDecl [spec]] }
          result = analyze "math.go" ast
          consts = nodesByType "CONSTANT" result
      length consts `shouldBe` 1
      gnName (head consts) `shouldBe` "Pi"
      metaText "kind" (head consts) `shouldBe` Just "constant"
      metaBool "mutable" (head consts) `shouldBe` Just False

  describe "TypeAliasDecl" $ do
    it "emits CLASS node with kind=type_alias" $ do
      let ast = emptyFile { gfDecls = [typeAlias "MyString"] }
          result = analyze "types.go" ast
          classes = nodesByType "CLASS" result
      length classes `shouldBe` 1
      gnName (head classes) `shouldBe` "MyString"
      metaText "kind" (head classes) `shouldBe` Just "type_alias"

  describe "Export detection" $ do
    it "exports uppercase function" $ do
      let ast = emptyFile { gfDecls = [simpleFunc "Handler" [] Nothing] }
          result = analyze "handler.go" ast
      length (faExports result) `shouldBe` 1
      eiName (head (faExports result)) `shouldBe` "Handler"

    it "does not export lowercase function" $ do
      let ast = emptyFile { gfDecls = [simpleFunc "helper" [] Nothing] }
          result = analyze "handler.go" ast
      length (faExports result) `shouldBe` 0

    it "exports uppercase struct" $ do
      let ast = emptyFile { gfDecls = [structDecl "Config" []] }
          result = analyze "config.go" ast
      length (faExports result) `shouldBe` 1

    it "does not export lowercase struct" $ do
      let ast = emptyFile { gfDecls = [structDecl "config" []] }
          result = analyze "config.go" ast
      length (faExports result) `shouldBe` 0

    it "exports uppercase interface" $ do
      let ast = emptyFile { gfDecls = [interfaceDecl "Service" [] []] }
          result = analyze "service.go" ast
      length (faExports result) `shouldBe` 1

    it "exports uppercase constant" $ do
      let spec = mkVarSpec ["MaxSize"]
          ast = emptyFile { gfDecls = [constDecl [spec]] }
          result = analyze "limits.go" ast
      length (faExports result) `shouldBe` 1

    it "exports uppercase variable" $ do
      let spec = mkVarSpec ["DefaultTimeout"]
          ast = emptyFile { gfDecls = [varDecl [spec]] }
          result = analyze "config.go" ast
      length (faExports result) `shouldBe` 1

    it "exports uppercase type alias" $ do
      let ast = emptyFile { gfDecls = [typeAlias "ID"] }
          result = analyze "types.go" ast
      length (faExports result) `shouldBe` 1

    it "exports method with uppercase name" $ do
      let ast = emptyFile { gfDecls = [methodDecl "GetName" "User" False Nothing] }
          result = analyze "user.go" ast
      length (faExports result) `shouldBe` 1
      T.isInfixOf "User.GetName" (eiName (head (faExports result))) `shouldBe` True

  describe "CONTAINS edges" $ do
    it "emits CONTAINS edge from MODULE to function" $ do
      let ast = emptyFile { gfDecls = [simpleFunc "main" [] Nothing] }
          result = analyze "main.go" ast
          moduleId = "MODULE#main.go"
          contains = filter (\e -> geSource e == moduleId && geType e == "CONTAINS")
                            (faEdges result)
      length contains `shouldSatisfy` (> 0)

    it "emits CONTAINS edge from MODULE to struct" $ do
      let ast = emptyFile { gfDecls = [structDecl "Config" []] }
          result = analyze "config.go" ast
          moduleId = "MODULE#config.go"
          contains = filter (\e -> geSource e == moduleId && geType e == "CONTAINS")
                            (faEdges result)
      length contains `shouldSatisfy` (> 0)

    it "emits CONTAINS edge from struct to field" $ do
      let fields = [mkField "Name" False]
          ast = emptyFile { gfDecls = [structDecl "Person" fields] }
          result = analyze "person.go" ast
          structId = "person.go->CLASS->Person"
          contains = filter (\e -> geSource e == structId && geType e == "CONTAINS")
                            (faEdges result)
      length contains `shouldSatisfy` (> 0)

    it "emits CONTAINS edge from interface to method" $ do
      let ast = emptyFile { gfDecls = [interfaceDecl "Reader" [mkMethodSig "Read"] []] }
          result = analyze "io.go" ast
          ifaceId = "io.go->INTERFACE->Reader"
          contains = filter (\e -> geSource e == ifaceId && geType e == "CONTAINS")
                            (faEdges result)
      length contains `shouldSatisfy` (> 0)

  describe "Short variable declaration (:=)" $ do
    it "emits VARIABLE nodes for short var decl inside function body" $ do
      let body = BlockStmt
            [ AssignStmtNode
                [IdentNode "x" sp3]
                [BasicLitNode "INT" "42" sp4]
                ":="
                sp3
            ] sp2
          ast = emptyFile { gfDecls = [simpleFunc "main" [] (Just body)] }
          result = analyze "main.go" ast
          vars = filter (\n -> gnName n == "x" && gnType n == "VARIABLE") (faNodes result)
      length vars `shouldBe` 1
      metaText "kind" (head vars) `shouldBe` Just "variable"

    it "skips blank identifier in short var decl" $ do
      let body = BlockStmt
            [ AssignStmtNode
                [IdentNode "_" sp3, IdentNode "err" sp4]
                [BasicLitNode "INT" "0" sp5, IdentNode "nil" sp5]
                ":="
                sp3
            ] sp2
          ast = emptyFile { gfDecls = [simpleFunc "main" [] (Just body)] }
          result = analyze "main.go" ast
          vars = filter (\n -> gnName n == "_" && gnType n == "VARIABLE") (faNodes result)
      length vars `shouldBe` 0

  describe "Parameters" $ do
    it "emits VARIABLE nodes for function parameters" $ do
      let params = [mkParam "x", mkParam "y"]
          ast = emptyFile { gfDecls = [simpleFunc "Add" params Nothing] }
          result = analyze "math.go" ast
          paramVars = filter (\n -> metaText "kind" n == Just "parameter") (nodesByType "VARIABLE" result)
      length paramVars `shouldBe` 2

    it "skips unnamed parameters" $ do
      let params = [GoParam Nothing (IdentType "int" sp) False sp]
          ast = emptyFile { gfDecls = [simpleFunc "Noop" params Nothing] }
          result = analyze "noop.go" ast
          paramVars = filter (\n -> metaText "kind" n == Just "parameter") (nodesByType "VARIABLE" result)
      length paramVars `shouldBe` 0

  describe "CALL node" $ do
    it "emits CALL node for function call in body" $ do
      let body = BlockStmt
            [ ExprStmtNode
                (CallExprNode (IdentNode "fmt.Println" sp3) [BasicLitNode "STRING" "\"hello\"" sp4] False sp3)
                sp3
            ] sp2
          ast = emptyFile { gfDecls = [simpleFunc "main" [] (Just body)] }
          result = analyze "main.go" ast
          calls = nodesByType "CALL" result
      length calls `shouldBe` 1

    it "emits CALL node with receiver for method call" $ do
      let body = BlockStmt
            [ ExprStmtNode
                (CallExprNode
                  (SelectorExprNode (IdentNode "s" sp3) "Start" sp3)
                  []
                  False
                  sp3)
                sp3
            ] sp2
          ast = emptyFile { gfDecls = [simpleFunc "main" [] (Just body)] }
          result = analyze "main.go" ast
          calls = nodesByType "CALL" result
      length calls `shouldBe` 1
      metaText "receiver" (head calls) `shouldBe` Just "s"

  describe "Control flow nodes" $ do
    it "emits BRANCH node for if statement" $ do
      let body = BlockStmt
            [ IfStmt Nothing (IdentNode "true" sp3) (BlockStmt [] sp3) Nothing sp3
            ] sp2
          ast = emptyFile { gfDecls = [simpleFunc "main" [] (Just body)] }
          result = analyze "main.go" ast
          branches = nodesByType "BRANCH" result
      length branches `shouldBe` 1
      metaText "kind" (head branches) `shouldBe` Just "if"

    it "emits LOOP node for for statement" $ do
      let body = BlockStmt
            [ ForStmt Nothing Nothing Nothing (BlockStmt [] sp3) sp3
            ] sp2
          ast = emptyFile { gfDecls = [simpleFunc "main" [] (Just body)] }
          result = analyze "main.go" ast
          loops = nodesByType "LOOP" result
      length loops `shouldBe` 1
      metaText "kind" (head loops) `shouldBe` Just "for"

    it "emits LOOP node for range statement" $ do
      let body = BlockStmt
            [ RangeStmt Nothing Nothing (IdentNode "items" sp3) (BlockStmt [] sp3) sp3
            ] sp2
          ast = emptyFile { gfDecls = [simpleFunc "main" [] (Just body)] }
          result = analyze "main.go" ast
          loops = nodesByType "LOOP" result
      length loops `shouldBe` 1
      metaText "kind" (head loops) `shouldBe` Just "range"

    it "emits BRANCH node for switch statement" $ do
      let body = BlockStmt
            [ SwitchStmt Nothing Nothing (BlockStmt [] sp3) sp3
            ] sp2
          ast = emptyFile { gfDecls = [simpleFunc "main" [] (Just body)] }
          result = analyze "main.go" ast
          branches = nodesByType "BRANCH" result
      length branches `shouldBe` 1
      metaText "kind" (head branches) `shouldBe` Just "switch"

    it "emits CASE node for case clause" $ do
      let body = BlockStmt
            [ SwitchStmt Nothing Nothing
                (BlockStmt
                  [CaseClauseStmt [BasicLitNode "INT" "1" sp4] [ExprStmtNode (IdentNode "x" sp4) sp4] sp4]
                  sp3)
                sp3
            ] sp2
          ast = emptyFile { gfDecls = [simpleFunc "main" [] (Just body)] }
          result = analyze "main.go" ast
          cases = nodesByType "CASE" result
      length cases `shouldBe` 1

  describe "Deferred references" $ do
    it "emits deferred IMPORTS_FROM for imports" $ do
      let ast = emptyFile { gfImports = [mkImport "fmt" "fmt"] }
          result = analyze "main.go" ast
          deferred = faUnresolvedRefs result
      length deferred `shouldSatisfy` (> 0)
      drEdgeType (head deferred) `shouldBe` "IMPORTS_FROM"

    it "emits deferred CALLS for function calls" $ do
      let body = BlockStmt
            [ ExprStmtNode
                (CallExprNode (IdentNode "println" sp3) [] False sp3)
                sp3
            ] sp2
          ast = emptyFile { gfDecls = [simpleFunc "main" [] (Just body)] }
          result = analyze "main.go" ast
          callDefs = filter (\d -> drEdgeType d == "CALLS") (faUnresolvedRefs result)
      length callDefs `shouldSatisfy` (> 0)

  describe "End-to-end" $ do
    it "handles a complete Go file with multiple declaration types" $ do
      let ast = GoFile "mypackage"
            [ mkImport "fmt" "fmt"
            , mkImport "os" "os"
            ]
            [ structDecl "Config"
                [ mkField "Host" False
                , mkField "Port" False
                ]
            , interfaceDecl "Service"
                [ mkMethodSig "Start"
                , mkMethodSig "Stop"
                ]
                []
            , simpleFunc "NewConfig" [mkParam "host"] Nothing
            , constDecl [mkVarSpec ["DefaultPort"]]
            , varDecl [mkVarSpec ["globalState"]]
            ]
          result = analyze "app.go" ast

      -- Should have MODULE + CLASS + INTERFACE + FUNCTION + CONSTANT + VARIABLE + 2 IMPORT + 2 fields + 2 iface methods
      length (nodesByType "MODULE" result) `shouldBe` 1
      length (nodesByType "CLASS" result) `shouldBe` 1
      length (nodesByType "INTERFACE" result) `shouldBe` 1
      length (nodesByType "IMPORT" result) `shouldBe` 2
      length (nodesByType "CONSTANT" result) `shouldBe` 1

      -- Exports: Config, Service, NewConfig, DefaultPort (all uppercase)
      -- globalState is lowercase so not exported
      let exportNames = map eiName (faExports result)
      "Config" `elem` exportNames `shouldBe` True
      "Service" `elem` exportNames `shouldBe` True
      "NewConfig" `elem` exportNames `shouldBe` True
      "DefaultPort" `elem` exportNames `shouldBe` True

    it "produces correct file and moduleId in output" $ do
      let result = analyze "pkg/server.go" emptyFile
      faFile result `shouldBe` "pkg/server.go"
      faModuleId result `shouldBe` "MODULE#pkg/server.go"
