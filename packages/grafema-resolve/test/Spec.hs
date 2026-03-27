{-# LANGUAGE OverloadedStrings #-}
module Main (main) where

import qualified Data.Map.Strict as Map
import Data.Text (Text)
import System.Exit (exitFailure, exitSuccess)
import System.IO (hPutStrLn, stderr)

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..))
import qualified PropertyAccess
import qualified SameFileCalls

-- ---------------------------------------------------------------------------
-- Test helpers
-- ---------------------------------------------------------------------------

-- | Create a minimal GraphNode with defaults for unused fields.
mkNode :: Text -> Text -> Text -> Text -> Map.Map Text MetaValue -> GraphNode
mkNode nid ntype name file meta = GraphNode
  { gnId        = nid
  , gnType      = ntype
  , gnName      = name
  , gnFile      = file
  , gnLine      = 1
  , gnColumn    = 0
  , gnEndLine   = 1
  , gnEndColumn = 0
  , gnExported  = False
  , gnMetadata  = meta
  }

-- | Create an IMPORT_BINDING node for a namespace import (import * as X).
mkNamespaceImportBinding :: Text -> Text -> Text -> GraphNode
mkNamespaceImportBinding file localName source =
  mkNode
    (file <> "->IMPORT_BINDING->" <> localName <> "[in:" <> source <> "]")
    "IMPORT_BINDING"
    localName
    file
    (Map.fromList
      [ ("source", MetaText source)
      , ("importedName", MetaText "*")
      ])

-- | Create an IMPORT_BINDING node for a named import (import { X } from '...').
mkNamedImportBinding :: Text -> Text -> Text -> Text -> GraphNode
mkNamedImportBinding file localName importedName source =
  mkNode
    (file <> "->IMPORT_BINDING->" <> localName <> "[in:" <> source <> "]")
    "IMPORT_BINDING"
    localName
    file
    (Map.fromList
      [ ("source", MetaText source)
      , ("importedName", MetaText importedName)
      ])

-- | Create a PROPERTY_ACCESS node.
mkPropertyAccess :: Text -> Text -> Text -> GraphNode
mkPropertyAccess file name nid =
  mkNode nid "PROPERTY_ACCESS" name file Map.empty

-- | Create a PROPERTY_ACCESS node with base metadata and line number.
mkPropertyAccessWithBase :: Text -> Text -> Text -> Text -> Int -> GraphNode
mkPropertyAccessWithBase file name base nid line =
  (mkNode nid "PROPERTY_ACCESS" name file (Map.singleton "base" (MetaText base)))
    { gnLine = line }

-- | Create a PROPERTY_ASSIGNMENT node with className metadata.
mkPropertyAssignment :: Text -> Text -> Text -> GraphNode
mkPropertyAssignment file className propName =
  mkNode
    (file <> "->PROPERTY_ASSIGNMENT->" <> propName <> "[in:" <> className <> "]")
    "PROPERTY_ASSIGNMENT"
    propName
    file
    (Map.singleton "className" (MetaText className))

-- | Create an exported FUNCTION node.
mkExportedFunction :: Text -> Text -> GraphNode
mkExportedFunction file name =
  (mkNode (file <> "->FUNCTION->" <> name) "FUNCTION" name file Map.empty)
    { gnExported = True }

-- | Create an exported VARIABLE node.
mkExportedVariable :: Text -> Text -> GraphNode
mkExportedVariable file name =
  (mkNode (file <> "->VARIABLE->" <> name) "VARIABLE" name file Map.empty)
    { gnExported = True }

-- | Extract edges from plugin commands.
extractEdges :: [PluginCommand] -> [GraphEdge]
extractEdges = concatMap getEdge
  where
    getEdge (EmitEdge e) = [e]
    getEdge _            = []

-- | Create a CLASS node with line range.
mkClass :: Text -> Text -> Int -> Int -> GraphNode
mkClass file name startLine endLine =
  (mkNode (file <> "->CLASS->" <> name) "CLASS" name file Map.empty)
    { gnLine = startLine, gnEndLine = endLine }

-- | Create a METHOD node inside a class.
mkMethod :: Text -> Text -> Text -> GraphNode
mkMethod file className methodName =
  mkNode
    (file <> "->METHOD->" <> methodName <> "[in:" <> className <> "]")
    "METHOD"
    methodName
    file
    Map.empty

-- | Create a CALL node for a method call.
mkMethodCall :: Text -> Text -> Int -> Text -> GraphNode
mkMethodCall file callee line nid =
  (mkNode nid "CALL" callee file Map.empty)
    { gnLine = line }

-- | Create a FUNCTION node.
mkFunction :: Text -> Text -> GraphNode
mkFunction file name =
  mkNode (file <> "->FUNCTION->" <> name) "FUNCTION" name file Map.empty

-- ---------------------------------------------------------------------------
-- Test runner
-- ---------------------------------------------------------------------------

data TestResult = Pass | Fail String

runTest :: String -> TestResult -> IO Bool
runTest name Pass = do
  putStrLn $ "  PASS: " ++ name
  return True
runTest name (Fail msg) = do
  hPutStrLn stderr $ "  FAIL: " ++ name ++ " -- " ++ msg
  return False

-- ---------------------------------------------------------------------------
-- Tests
-- ---------------------------------------------------------------------------

-- | Namespace import: utils.greet -> READS_FROM to exported greet function
testNamespaceImport :: TestResult
testNamespaceImport =
  let utilsFile = "src/utils.ts"
      appFile = "src/app.ts"
      nodes =
        [ mkNamespaceImportBinding appFile "utils" "./utils"
        , mkExportedFunction utilsFile "greet"
        , mkPropertyAccess appFile "utils.greet"
            (appFile <> "->PROPERTY_ACCESS->utils.greet[in:main]")
        ]
      cmds = PropertyAccess.resolveAll nodes
      edges = extractEdges cmds
  in case edges of
    [e] | geSource e == appFile <> "->PROPERTY_ACCESS->utils.greet[in:main]"
        , geTarget e == utilsFile <> "->FUNCTION->greet"
        , geType e == "READS_FROM"
        , Map.lookup "resolvedVia" (geMetadata e) == Just (MetaText "property-access")
        -> Pass
    _ -> Fail $ "Expected 1 READS_FROM edge, got: " ++ show edges

-- | Named import (config.port) -> no edges (V1 skips)
testNamedImportSkipped :: TestResult
testNamedImportSkipped =
  let utilsFile = "src/utils.ts"
      appFile = "src/app.ts"
      nodes =
        [ mkNamedImportBinding appFile "config" "config" "./utils"
        , mkExportedVariable utilsFile "config"
        , mkPropertyAccess appFile "config.port"
            (appFile <> "->PROPERTY_ACCESS->config.port[in:main]")
        ]
      cmds = PropertyAccess.resolveAll nodes
      edges = extractEdges cmds
  in case edges of
    [] -> Pass
    _  -> Fail $ "Expected 0 edges for named import, got: " ++ show edges

-- | Chained access (ns.foo.bar) -> no edges for the chained node (V1 skips)
testChainedAccessSkipped :: TestResult
testChainedAccessSkipped =
  let utilsFile = "src/utils.ts"
      appFile = "src/app.ts"
      nodes =
        [ mkNamespaceImportBinding appFile "ns" "./utils"
        , mkExportedVariable utilsFile "foo"
        -- The chained PROPERTY_ACCESS node: ns.foo.bar
        -- T.breakOn "." "ns.foo.bar" gives objectName="ns", propertyName="foo.bar"
        -- "foo.bar" won't match any export
        , mkPropertyAccess appFile "ns.foo.bar"
            (appFile <> "->PROPERTY_ACCESS->ns.foo.bar[in:main]")
        ]
      cmds = PropertyAccess.resolveAll nodes
      edges = extractEdges cmds
  in case edges of
    [] -> Pass
    _  -> Fail $ "Expected 0 edges for chained access, got: " ++ show edges

-- | Non-import variable access -> no edges
testNonImportAccessSkipped :: TestResult
testNonImportAccessSkipped =
  let appFile = "src/app.ts"
      nodes =
        [ mkPropertyAccess appFile "localVar.prop"
            (appFile <> "->PROPERTY_ACCESS->localVar.prop[in:main]")
        ]
      cmds = PropertyAccess.resolveAll nodes
      edges = extractEdges cmds
  in case edges of
    [] -> Pass
    _  -> Fail $ "Expected 0 edges for non-import access, got: " ++ show edges

-- | Computed property (no dot in name) -> no edges
testNoDotSkipped :: TestResult
testNoDotSkipped =
  let appFile = "src/app.ts"
      nodes =
        [ mkPropertyAccess appFile "computedProp"
            (appFile <> "->PROPERTY_ACCESS->computedProp[in:main]")
        ]
      cmds = PropertyAccess.resolveAll nodes
      edges = extractEdges cmds
  in case edges of
    [] -> Pass
    _  -> Fail $ "Expected 0 edges for no-dot name, got: " ++ show edges

-- | Multiple namespace accesses from same import -> multiple READS_FROM edges
testMultipleAccesses :: TestResult
testMultipleAccesses =
  let utilsFile = "src/utils.ts"
      appFile = "src/app.ts"
      nodes =
        [ mkNamespaceImportBinding appFile "utils" "./utils"
        , mkExportedFunction utilsFile "greet"
        , mkExportedFunction utilsFile "farewell"
        , mkPropertyAccess appFile "utils.greet"
            (appFile <> "->PROPERTY_ACCESS->utils.greet[in:main]")
        , mkPropertyAccess appFile "utils.farewell"
            (appFile <> "->PROPERTY_ACCESS->utils.farewell[in:main]")
        ]
      cmds = PropertyAccess.resolveAll nodes
      edges = extractEdges cmds
  in case edges of
    [e1, e2]
      | geTarget e1 == utilsFile <> "->FUNCTION->greet"
      , geTarget e2 == utilsFile <> "->FUNCTION->farewell"
      -> Pass
    _ -> Fail $ "Expected 2 READS_FROM edges, got: " ++ show edges

-- | Empty nodes list -> no crash, no edges
testEmptyNodes :: TestResult
testEmptyNodes =
  let cmds = PropertyAccess.resolveAll []
      edges = extractEdges cmds
  in case edges of
    [] -> Pass
    _  -> Fail $ "Expected 0 edges for empty input, got: " ++ show edges

-- | Property access to non-existent export -> no edges
testNonExistentExport :: TestResult
testNonExistentExport =
  let utilsFile = "src/utils.ts"
      appFile = "src/app.ts"
      nodes =
        [ mkNamespaceImportBinding appFile "utils" "./utils"
        , mkExportedFunction utilsFile "greet"
        , mkPropertyAccess appFile "utils.nonExistent"
            (appFile <> "->PROPERTY_ACCESS->utils.nonExistent[in:main]")
        ]
      cmds = PropertyAccess.resolveAll nodes
      edges = extractEdges cmds
  in case edges of
    [] -> Pass
    _  -> Fail $ "Expected 0 edges for non-existent export, got: " ++ show edges

-- | this.prop -> READS_FROM edge to PROPERTY_ASSIGNMENT via line containment
testThisPropAccess :: TestResult
testThisPropAccess =
  let file = "src/app.ts"
      nodes =
        [ mkClass file "Foo" 1 100
        , mkPropertyAssignment file "Foo" "name"
        , mkPropertyAccessWithBase file "name" "this"
            (file <> "->PROPERTY_ACCESS->this.name[in:bar,h:1234]") 50
        ]
      cmds = PropertyAccess.resolveAll nodes
      edges = extractEdges cmds
  in case edges of
    [e] | geTarget e == file <> "->PROPERTY_ASSIGNMENT->name[in:Foo]"
        , geType e == "READS_FROM"
        -> Pass
    _ -> Fail $ "Expected 1 READS_FROM edge for this.prop, got: " ++ show edges

-- | super.prop -> READS_FROM edge to PROPERTY_ASSIGNMENT via line containment
testSuperPropAccess :: TestResult
testSuperPropAccess =
  let file = "src/app.ts"
      nodes =
        [ mkClass file "Foo" 1 100
        , mkPropertyAssignment file "Foo" "value"
        , mkPropertyAccessWithBase file "value" "super"
            (file <> "->PROPERTY_ACCESS->super.value[in:bar,h:1234]") 50
        ]
      cmds = PropertyAccess.resolveAll nodes
      edges = extractEdges cmds
  in case edges of
    [e] | geTarget e == file <> "->PROPERTY_ASSIGNMENT->value[in:Foo]"
        , geType e == "READS_FROM"
        -> Pass
    _ -> Fail $ "Expected 1 READS_FROM edge for super.prop, got: " ++ show edges

-- | <obj>.prop (backward compat) -> READS_FROM edge if inside CLASS range
testObjPropAccess :: TestResult
testObjPropAccess =
  let file = "src/app.ts"
      nodes =
        [ mkClass file "Foo" 1 100
        , mkPropertyAssignment file "Foo" "data"
        , mkPropertyAccessWithBase file "data" "<obj>"
            (file <> "->PROPERTY_ACCESS-><obj>.data[in:<expression>,h:1234]") 50
        ]
      cmds = PropertyAccess.resolveAll nodes
      edges = extractEdges cmds
  in case edges of
    [e] | geTarget e == file <> "->PROPERTY_ASSIGNMENT->data[in:Foo]"
        , geType e == "READS_FROM"
        -> Pass
    _ -> Fail $ "Expected 1 READS_FROM edge for <obj>.prop, got: " ++ show edges

-- | this.prop inside nested arrow -> still resolves via line containment
testNestedArrowPropAccess :: TestResult
testNestedArrowPropAccess =
  let file = "src/app.ts"
      nodes =
        [ mkClass file "Foo" 1 100
        , mkPropertyAssignment file "Foo" "items"
        , mkPropertyAccessWithBase file "items" "this"
            (file <> "->PROPERTY_ACCESS->this.items[in:<expression>,h:5678]") 60
        ]
      cmds = PropertyAccess.resolveAll nodes
      edges = extractEdges cmds
  in case edges of
    [e] | geTarget e == file <> "->PROPERTY_ASSIGNMENT->items[in:Foo]"
        , geType e == "READS_FROM"
        -> Pass
    _ -> Fail $ "Expected 1 READS_FROM edge for nested arrow, got: " ++ show edges

-- | this.prop outside any class -> no READS_FROM edge
testThisPropOutsideClass :: TestResult
testThisPropOutsideClass =
  let file = "src/app.ts"
      nodes =
        [ mkPropertyAssignment file "Foo" "name"
        , mkPropertyAccessWithBase file "name" "this"
            (file <> "->PROPERTY_ACCESS->this.name[in:main,h:1234]") 200
        -- No CLASS node, so line containment finds nothing
        ]
      cmds = PropertyAccess.resolveAll nodes
      edges = extractEdges cmds
  in case edges of
    [] -> Pass
    _  -> Fail $ "Expected 0 edges for this.prop outside class, got: " ++ show edges

-- | this.prop resolves to METHOD node in same class
testThisPropToMethod :: TestResult
testThisPropToMethod =
  let file = "src/app.ts"
      nodes =
        [ mkClass file "Foo" 1 100
        , mkMethod file "Foo" "getData"
        , mkPropertyAccessWithBase file "getData" "this"
            (file <> "->PROPERTY_ACCESS->this.getData[in:render,h:1234]") 50
        ]
      cmds = PropertyAccess.resolveAll nodes
      edges = extractEdges cmds
  in case edges of
    [e] | geTarget e == file <> "->METHOD->getData[in:Foo]"
        , geType e == "READS_FROM"
        -> Pass
    _ -> Fail $ "Expected 1 READS_FROM edge to METHOD, got: " ++ show edges

-- ---------------------------------------------------------------------------
-- SameFileCalls tests
-- ---------------------------------------------------------------------------

-- | this.method() -> CALLS edge to METHOD
testThisMethodCall :: TestResult
testThisMethodCall =
  let file = "src/app.ts"
      nodes =
        [ mkClass file "Foo" 1 100
        , mkMethod file "Foo" "bar"
        , mkMethodCall file "this.bar" 50
            (file <> "->CALL->this.bar[in:baz,h:1234]")
        ]
      cmds = SameFileCalls.resolveAll nodes
      edges = extractEdges cmds
  in case edges of
    [e] | geTarget e == file <> "->METHOD->bar[in:Foo]"
        , geType e == "CALLS"
        -> Pass
    _ -> Fail $ "Expected 1 CALLS edge to METHOD, got: " ++ show edges

-- | super.method() -> CALLS edge to METHOD
testSuperMethodCall :: TestResult
testSuperMethodCall =
  let file = "src/app.ts"
      nodes =
        [ mkClass file "Foo" 1 100
        , mkMethod file "Foo" "bar"
        , mkMethodCall file "super.bar" 50
            (file <> "->CALL->super.bar[in:baz,h:1234]")
        ]
      cmds = SameFileCalls.resolveAll nodes
      edges = extractEdges cmds
  in case edges of
    [e] | geTarget e == file <> "->METHOD->bar[in:Foo]"
        , geType e == "CALLS"
        -> Pass
    _ -> Fail $ "Expected 1 CALLS edge for super, got: " ++ show edges

-- | <obj>.method() (backward compat) -> CALLS edge if inside CLASS range
testObjMethodCall :: TestResult
testObjMethodCall =
  let file = "src/app.ts"
      nodes =
        [ mkClass file "Foo" 1 100
        , mkMethod file "Foo" "bar"
        , mkMethodCall file "<obj>.bar" 50
            (file <> "->CALL-><obj>.bar[in:<expression>,h:1234]")
        ]
      cmds = SameFileCalls.resolveAll nodes
      edges = extractEdges cmds
  in case edges of
    [e] | geTarget e == file <> "->METHOD->bar[in:Foo]"
        , geType e == "CALLS"
        -> Pass
    _ -> Fail $ "Expected 1 CALLS edge for <obj>, got: " ++ show edges

-- | obj.method() (local variable) -> no CALLS edge
testLocalVarMethodCall :: TestResult
testLocalVarMethodCall =
  let file = "src/app.ts"
      nodes =
        [ mkClass file "Foo" 1 100
        , mkMethod file "Foo" "bar"
        , mkMethodCall file "myObj.bar" 50
            (file <> "->CALL->myObj.bar[in:baz,h:1234]")
        ]
      cmds = SameFileCalls.resolveAll nodes
      edges = extractEdges cmds
  in case edges of
    [] -> Pass
    _  -> Fail $ "Expected 0 edges for local var method call, got: " ++ show edges

-- | ClassName.staticMethod() -> CALLS edge
testStaticMethodCall :: TestResult
testStaticMethodCall =
  let file = "src/app.ts"
      nodes =
        [ mkClass file "Foo" 1 100
        , mkMethod file "Foo" "create"
        , mkMethodCall file "Foo.create" 200
            (file <> "->CALL->Foo.create[in:main,h:1234]")
        ]
      cmds = SameFileCalls.resolveAll nodes
      edges = extractEdges cmds
  in case edges of
    [e] | geTarget e == file <> "->METHOD->create[in:Foo]"
        , geType e == "CALLS"
        -> Pass
    _ -> Fail $ "Expected 1 CALLS edge for static method, got: " ++ show edges

-- | this.method() inside nested arrow inside method -> still resolves via line containment
testNestedArrowMethodCall :: TestResult
testNestedArrowMethodCall =
  let file = "src/app.ts"
      nodes =
        [ mkClass file "Foo" 1 100
        , mkMethod file "Foo" "bar"
        , mkMethodCall file "this.bar" 60
            (file <> "->CALL->this.bar[in:<expression>,h:5678]")
        ]
      cmds = SameFileCalls.resolveAll nodes
      edges = extractEdges cmds
  in case edges of
    [e] | geTarget e == file <> "->METHOD->bar[in:Foo]"
        , geType e == "CALLS"
        -> Pass
    _ -> Fail $ "Expected 1 CALLS edge for nested arrow, got: " ++ show edges

-- | Direct function call: foo() -> CALLS edge to FUNCTION
testDirectFunctionCall :: TestResult
testDirectFunctionCall =
  let file = "src/app.ts"
      nodes =
        [ mkFunction file "greet"
        , mkMethodCall file "greet" 10
            (file <> "->CALL->greet[in:main,h:1234]")
        ]
      cmds = SameFileCalls.resolveAll nodes
      edges = extractEdges cmds
  in case edges of
    [e] | geTarget e == file <> "->FUNCTION->greet"
        , geType e == "CALLS"
        -> Pass
    _ -> Fail $ "Expected 1 CALLS edge for direct call, got: " ++ show edges

-- | Call outside any class with this -> no CALLS edge (no enclosing class)
testThisOutsideClass :: TestResult
testThisOutsideClass =
  let file = "src/app.ts"
      nodes =
        [ mkMethod file "Foo" "bar"
        , mkMethodCall file "this.bar" 200
            (file <> "->CALL->this.bar[in:main,h:1234]")
        -- No CLASS node in the file, or call line outside class range
        ]
      cmds = SameFileCalls.resolveAll nodes
      edges = extractEdges cmds
  in case edges of
    [] -> Pass
    _  -> Fail $ "Expected 0 edges for this outside class, got: " ++ show edges

-- | Two classes in same file with same method name -> line containment picks correct class
testMultipleClassesSameMethod :: TestResult
testMultipleClassesSameMethod =
  let file = "src/app.ts"
      nodes =
        [ mkClass file "Foo" 1 50
        , mkClass file "Bar" 60 120
        , mkMethod file "Foo" "doSomething"
        , mkMethod file "Bar" "doSomething"
        , mkMethodCall file "this.doSomething" 80
            (file <> "->CALL->this.doSomething[in:handler,h:5678]")
        ]
      cmds = SameFileCalls.resolveAll nodes
      edges = extractEdges cmds
  in case edges of
    [e] | geTarget e == file <> "->METHOD->doSomething[in:Bar]"
        , geType e == "CALLS"
        -> Pass
    _ -> Fail $ "Expected 1 CALLS edge to Bar.doSomething, got: " ++ show edges

-- ---------------------------------------------------------------------------
-- Main
-- ---------------------------------------------------------------------------

main :: IO ()
main = do
  putStrLn "PropertyAccess unit tests:"
  paResults <- sequence
    [ runTest "namespace import resolves to READS_FROM" testNamespaceImport
    , runTest "named import skipped (V1)" testNamedImportSkipped
    , runTest "chained access skipped (V1)" testChainedAccessSkipped
    , runTest "non-import access skipped" testNonImportAccessSkipped
    , runTest "no dot in name skipped" testNoDotSkipped
    , runTest "multiple accesses from same import" testMultipleAccesses
    , runTest "empty nodes no crash" testEmptyNodes
    , runTest "non-existent export no edge" testNonExistentExport
    , runTest "this.prop resolves via line containment" testThisPropAccess
    , runTest "super.prop resolves via line containment" testSuperPropAccess
    , runTest "<obj>.prop backward compat resolves" testObjPropAccess
    , runTest "nested arrow this.prop resolves" testNestedArrowPropAccess
    , runTest "this.prop outside class no resolution" testThisPropOutsideClass
    , runTest "this.prop resolves to METHOD" testThisPropToMethod
    ]
  putStrLn ""
  putStrLn "SameFileCalls unit tests:"
  sfcResults <- sequence
    [ runTest "this.method() resolves to METHOD" testThisMethodCall
    , runTest "super.method() resolves to METHOD" testSuperMethodCall
    , runTest "<obj>.method() backward compat resolves" testObjMethodCall
    , runTest "obj.method() local var no resolution" testLocalVarMethodCall
    , runTest "ClassName.staticMethod() resolves" testStaticMethodCall
    , runTest "nested arrow this.method() resolves" testNestedArrowMethodCall
    , runTest "direct function call resolves" testDirectFunctionCall
    , runTest "this.method() outside class no resolution" testThisOutsideClass
    , runTest "multiple classes same method resolves to correct class" testMultipleClassesSameMethod
    ]
  let allResults = paResults ++ sfcResults
      total = length allResults
      passed = length (filter id allResults)
  putStrLn $ "\n" ++ show passed ++ "/" ++ show total ++ " tests passed"
  if all id allResults then exitSuccess else exitFailure
