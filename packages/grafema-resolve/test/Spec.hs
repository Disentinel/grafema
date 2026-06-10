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
import qualified JsThisMethodCalls
import qualified ClassInheritance
import qualified ImportResolution

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

-- | Create an exported NAMESPACE node.
mkExportedNamespace :: Text -> Text -> GraphNode
mkExportedNamespace file name =
  (mkNode (file <> "->NAMESPACE->" <> name) "NAMESPACE" name file Map.empty)
    { gnExported = True }

-- | Extract edges from plugin commands.
extractEdges :: [PluginCommand] -> [GraphEdge]
extractEdges = concatMap getEdge
  where
    getEdge (EmitEdge e) = [e]
    getEdge _            = []

-- | Extract emitted nodes from plugin commands.
extractNodes :: [PluginCommand] -> [GraphNode]
extractNodes = concatMap getNode
  where
    getNode (EmitNode n) = [n]
    getNode _            = []

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

-- | Run a test whose check requires IO (e.g. calls a plugin's IO resolveAll).
runTestIO :: String -> IO TestResult -> IO Bool
runTestIO name action = do
  result <- action
  runTest name result

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
-- JsThisMethodCalls tests
-- ---------------------------------------------------------------------------

-- | Happy path: this.bar() resolves to METHOD bar when exactly one candidate
-- exists in the same file.
testJsThisResolved :: IO TestResult
testJsThisResolved = do
  let file = "src/app.ts"
      nodes =
        [ mkMethod file "Foo" "bar"
        , mkMethodCall file "this.bar" 10
            (file <> "->CALL->this.bar[in:baz,h:1]")
        ]
  cmds <- JsThisMethodCalls.resolveAll nodes []
  let edges = extractEdges cmds
  return $ case edges of
    [e] | geType e == "CALLS"
        , geTarget e == file <> "->METHOD->bar[in:Foo]"
        -> Pass
    _ -> Fail $ "Expected 1 CALLS edge to Foo.bar, got: " ++ show edges

-- | Unresolved: this.foo() when no METHOD named foo exists → 0 edges.
testJsThisUnresolved :: IO TestResult
testJsThisUnresolved = do
  let file = "src/app.ts"
      nodes =
        [ mkMethod file "Foo" "bar"  -- not "foo"
        , mkMethodCall file "this.foo" 10
            (file <> "->CALL->this.foo[in:baz,h:1]")
        ]
  cmds <- JsThisMethodCalls.resolveAll nodes []
  let edges = extractEdges cmds
  return $ case edges of
    [] -> Pass
    _  -> Fail $ "Expected 0 edges for unresolved this.foo(), got: " ++ show edges

-- | Ambiguous: two classes with same method name → skipped (0 edges).
testJsThisAmbiguous :: IO TestResult
testJsThisAmbiguous = do
  let file = "src/app.ts"
      nodes =
        [ mkMethod file "Foo" "bar"
        , mkMethod file "Baz" "bar"
        , mkMethodCall file "this.bar" 10
            (file <> "->CALL->this.bar[in:q,h:1]")
        ]
  cmds <- JsThisMethodCalls.resolveAll nodes []
  let edges = extractEdges cmds
  return $ case edges of
    [] -> Pass
    _  -> Fail $ "Expected 0 edges for ambiguous this.bar(), got: " ++ show edges

-- ---------------------------------------------------------------------------
-- ClassInheritance tests
-- ---------------------------------------------------------------------------

-- | Helper: CLASS node with superClass metadata.
mkClassWithSuper :: Text -> Text -> Text -> GraphNode
mkClassWithSuper file className superName =
  (mkNode
    (file <> "->CLASS->" <> className)
    "CLASS"
    className
    file
    (Map.singleton "superClass" (MetaText superName)))
  { gnLine = 1, gnEndLine = 10 }

-- | Helper: plain CLASS node (no superClass), for ClassInheritance tests.
mkSimpleClass :: Text -> Text -> GraphNode
mkSimpleClass file className =
  mkNode
    (file <> "->CLASS->" <> className)
    "CLASS"
    className
    file
    Map.empty

-- | VARIABLE node initialized from `new <className>()` (REG-585 pt2 metadata).
mkVarWithInstanceOf :: Text -> Text -> Text -> GraphNode
mkVarWithInstanceOf file varName className =
  mkNode
    (file <> "->VARIABLE->" <> varName)
    "VARIABLE"
    varName
    file
    (Map.fromList [("kind", MetaText "const"), ("instanceOfName", MetaText className)])

-- | Same-file inheritance: class Dog extends Animal in same .ts file.
testSameFileExtends :: TestResult
testSameFileExtends =
  let file  = "src/animals.ts"
      nodes =
        [ mkClassWithSuper file "Dog" "Animal"
        , mkSimpleClass file "Animal"
        ]
      cmds  = ClassInheritance.resolveAll nodes
      edges = extractEdges cmds
  in case edges of
    [e] | geSource e == file <> "->CLASS->Dog"
        , geTarget e == file <> "->CLASS->Animal"
        , geType e == "EXTENDS"
        , Map.lookup "resolvedVia" (geMetadata e) == Just (MetaText "class-inheritance")
        -> Pass
    _ -> Fail $ "Expected 1 EXTENDS edge Dog→Animal, got: " ++ show edges

-- | No superClass → no EXTENDS edge.
testNoSuperClass :: TestResult
testNoSuperClass =
  let file  = "src/animals.ts"
      nodes = [ mkSimpleClass file "Animal" ]
      cmds  = ClassInheritance.resolveAll nodes
      edges = extractEdges cmds
  in case edges of
    [] -> Pass
    _  -> Fail $ "Expected 0 edges for class without superClass, got: " ++ show edges

-- | Builtin superClass (e.g. EventEmitter) → EXTENDS edge to a virtual
-- BUILTIN_CLASS node + the CLASS node itself (REG-585).
testBuiltinBaseExtends :: TestResult
testBuiltinBaseExtends =
  let file  = "src/animals.ts"
      nodes = [ mkClassWithSuper file "Logger" "EventEmitter" ]
      cmds  = ClassInheritance.resolveAll nodes
      edges = extractEdges cmds
      clsNodes = filter (\n -> gnType n == "CLASS" && gnId n == "BUILTIN_CLASS::EventEmitter") (extractNodes cmds)
  in case (edges, clsNodes) of
    ([e], (_:_))
      | geSource e == file <> "->CLASS->Logger"
      , geTarget e == "BUILTIN_CLASS::EventEmitter"
      , geType e == "EXTENDS"
      , Map.lookup "resolvedVia" (geMetadata e) == Just (MetaText "builtin-class")
      -> Pass
    _ -> Fail $ "Expected builtin EXTENDS edge + BUILTIN_CLASS node, got edges: " ++ show edges

-- | Unknown NON-builtin superClass (not in file, not imported, not builtin) → no edge.
testUnknownNonBuiltinSuper :: TestResult
testUnknownNonBuiltinSuper =
  let file  = "src/animals.ts"
      nodes = [ mkClassWithSuper file "Dog" "TotallyMadeUpBase" ]
      cmds  = ClassInheritance.resolveAll nodes
      edges = extractEdges cmds
  in case edges of
    [] -> Pass
    _  -> Fail $ "Expected 0 edges for unknown non-builtin superClass, got: " ++ show edges

-- | Cross-file inheritance: Animal imported from ./base, class Dog extends Animal.
testCrossFileExtends :: TestResult
testCrossFileExtends =
  let appFile  = "src/dog.ts"
      baseFile = "src/base.ts"
      nodes =
        [ mkClassWithSuper appFile "Dog" "Animal"
        , mkNamedImportBinding appFile "Animal" "Animal" "./base"
        , (mkSimpleClass baseFile "Animal") { gnExported = True }
        ]
      cmds  = ClassInheritance.resolveAll nodes
      edges = extractEdges cmds
  in case edges of
    [e] | geSource e == appFile <> "->CLASS->Dog"
        , geTarget e == baseFile <> "->CLASS->Animal"
        , geType e == "EXTENDS"
        -> Pass
    _ -> Fail $ "Expected 1 cross-file EXTENDS edge Dog→Animal, got: " ++ show edges

-- | REG-585 pt2: const x = new Foo() (same-file class) → VARIABLE -INSTANCE_OF-> CLASS Foo.
testInstanceOfSameFile :: TestResult
testInstanceOfSameFile =
  let file  = "src/app.ts"
      nodes = [ mkSimpleClass file "Foo", mkVarWithInstanceOf file "x" "Foo" ]
      ioEdges = filter (\e -> geType e == "INSTANCE_OF") (extractEdges (ClassInheritance.resolveAll nodes))
  in case ioEdges of
    [e] | geSource e == file <> "->VARIABLE->x", geTarget e == file <> "->CLASS->Foo" -> Pass
    _ -> Fail $ "Expected INSTANCE_OF x->Foo, got: " ++ show ioEdges

-- | REG-585 pt2: const e = new Error() → VARIABLE -INSTANCE_OF-> BUILTIN_CLASS::Error + node.
testInstanceOfBuiltin :: TestResult
testInstanceOfBuiltin =
  let file  = "src/app.ts"
      cmds  = ClassInheritance.resolveAll [ mkVarWithInstanceOf file "e" "Error" ]
      ioEdges = filter (\e -> geType e == "INSTANCE_OF") (extractEdges cmds)
      clsNodes = filter (\n -> gnType n == "CLASS" && gnId n == "BUILTIN_CLASS::Error") (extractNodes cmds)
  in case (ioEdges, clsNodes) of
    ([e], (_:_)) | geSource e == file <> "->VARIABLE->e", geTarget e == "BUILTIN_CLASS::Error" -> Pass
    _ -> Fail $ "Expected INSTANCE_OF e->BUILTIN_CLASS::Error + node, got: " ++ show ioEdges

-- | REG-585 pt2: VARIABLE without instanceOfName → no INSTANCE_OF edge.
testInstanceOfNoMetadata :: TestResult
testInstanceOfNoMetadata =
  let file  = "src/app.ts"
      nodes = [ mkNode (file <> "->VARIABLE->y") "VARIABLE" "y" file (Map.singleton "kind" (MetaText "const")) ]
      ioEdges = filter (\e -> geType e == "INSTANCE_OF") (extractEdges (ClassInheritance.resolveAll nodes))
  in case ioEdges of
    [] -> Pass
    _  -> Fail $ "Expected no INSTANCE_OF edge, got: " ++ show ioEdges

-- ---------------------------------------------------------------------------
-- ImportResolution unit tests
-- ---------------------------------------------------------------------------

-- | Exported NAMESPACE node appears in export index
testNamespaceInExportIndex :: TestResult
testNamespaceInExportIndex =
  let schemasFile = "src/vs/base/common/network.ts"
      nsNode = mkExportedNamespace schemasFile "Schemas"
      idx = ImportResolution.buildExportIndex [nsNode]
  in case Map.lookup schemasFile idx of
    Just entries | any (\e -> ImportResolution.eeName e == "Schemas") entries -> Pass
    Just entries -> Fail $ "Schemas not in entries: " ++ show (map ImportResolution.eeName entries)
    Nothing -> Fail "File not found in export index"

-- | Exported NAMESPACE resolves named import { Schemas } from './network'
testNamespaceNamedImportResolves :: IO TestResult
testNamespaceNamedImportResolves = do
  let schemasFile = "src/vs/base/common/network.ts"
      consumerFile = "src/vs/base/common/opener.ts"
      nodes =
        [ mkNamedImportBinding consumerFile "Schemas" "Schemas" "./network"
        , mkExportedNamespace schemasFile "Schemas"
        ]
  cmds <- ImportResolution.resolveAll nodes
  let edges = filter (\e -> geType e == "IMPORTS_FROM") (extractEdges cmds)
  return $ case edges of
    [e] | geTarget e == schemasFile <> "->NAMESPACE->Schemas" -> Pass
    es -> Fail $ "Expected 1 IMPORTS_FROM edge to NAMESPACE, got: " ++ show es

-- | ESM .js import resolves to .ts file (TS convention: import './foo.js' → foo.ts)
testJsToTsResolution :: IO TestResult
testJsToTsResolution = do
  let targetFile = "src/vs/base/node/pfs.ts"
      importerFile = "src/vs/platform/extensionManagement/node/extensionManagementService.ts"
      nodes =
        [ mkNamedImportBinding importerFile "Promises" "Promises" "../../../base/node/pfs.js"
        , mkExportedVariable targetFile "Promises"
        ]
  cmds <- ImportResolution.resolveAll nodes
  let edges = filter (\e -> geType e == "IMPORTS_FROM") (extractEdges cmds)
  return $ case edges of
    [e] | geTarget e == targetFile <> "->VARIABLE->Promises" -> Pass
    es -> Fail $ "Expected 1 IMPORTS_FROM edge via .js→.ts swap, got: " ++ show es

-- | .d.ts-only module resolves import (e.g., extensions/git/src/api/git.d.ts)
testDtsOnlyModuleResolves :: IO TestResult
testDtsOnlyModuleResolves = do
  let dtsFile = "extensions/git/src/api/git.d.ts"
      consumerFile = "extensions/git/src/api/consumer.ts"
      nodes =
        [ mkNamedImportBinding consumerFile "GitAPI" "GitAPI" "./git"
        , (mkNode (dtsFile <> "->INTERFACE->GitAPI") "INTERFACE" "GitAPI" dtsFile Map.empty)
            { gnExported = True }
        ]
  cmds <- ImportResolution.resolveAll nodes
  let edges = filter (\e -> geType e == "IMPORTS_FROM") (extractEdges cmds)
  return $ case edges of
    [e] | geTarget e == dtsFile <> "->INTERFACE->GitAPI" -> Pass
    es -> Fail $ "Expected 1 IMPORTS_FROM edge from .d.ts module, got: " ++ show es

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
  putStrLn ""
  putStrLn "JsThisMethodCalls unit tests:"
  jsResults <- sequence
    [ runTestIO "this.bar() resolves to single METHOD" testJsThisResolved
    , runTestIO "this.foo() unresolved when no METHOD matches" testJsThisUnresolved
    , runTestIO "this.bar() ambiguous (two classes) skipped" testJsThisAmbiguous
    ]
  putStrLn ""
  putStrLn "ClassInheritance unit tests:"
  ciResults <- sequence
    [ runTest "same-file class extends creates EXTENDS edge" testSameFileExtends
    , runTest "class without superClass produces no edge" testNoSuperClass
    , runTest "builtin superClass (EventEmitter) creates EXTENDS to BUILTIN_CLASS node" testBuiltinBaseExtends
    , runTest "unknown non-builtin superClass produces no edge" testUnknownNonBuiltinSuper
    , runTest "cross-file inheritance via import creates EXTENDS edge" testCrossFileExtends
    , runTest "new Foo() (same-file) creates INSTANCE_OF edge" testInstanceOfSameFile
    , runTest "new Error() creates INSTANCE_OF to BUILTIN_CLASS node" testInstanceOfBuiltin
    , runTest "VARIABLE without instanceOfName produces no INSTANCE_OF" testInstanceOfNoMetadata
    ]
  putStrLn ""
  putStrLn "ImportResolution unit tests:"
  irResults <- sequence
    [ runTest "exported NAMESPACE in export index" testNamespaceInExportIndex
    , runTestIO "NAMESPACE resolves named import" testNamespaceNamedImportResolves
    , runTestIO ".js ESM import resolves to .ts file" testJsToTsResolution
    , runTestIO ".d.ts-only module resolves import" testDtsOnlyModuleResolves
    ]
  let allResults = paResults ++ sfcResults ++ jsResults ++ ciResults ++ irResults
      total = length allResults
      passed = length (filter id allResults)
  putStrLn $ "\n" ++ show passed ++ "/" ++ show total ++ " tests passed"
  if all id allResults then exitSuccess else exitFailure
