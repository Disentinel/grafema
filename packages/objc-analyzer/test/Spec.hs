{-# LANGUAGE OverloadedStrings #-}
module Main where

import Test.Hspec
import Data.Text (Text)
import qualified Data.Map.Strict as Map

import ObjcAST
import Analysis.Types
import Analysis.Context (runAnalyzer)
import Analysis.Walker (walkFile)

-- ── Test helpers ──────────────────────────────────────────────────────

-- | Default span for test nodes.
testSpan :: Span
testSpan = Span (Pos 1 0) (Pos 10 0)

-- | Run analyzer on a file with given declarations.
analyzeDecls :: Text -> [ObjcDecl] -> FileAnalysis
analyzeDecls file decls =
  let moduleId = file <> "->MODULE->" <> file
      objcFile = ObjcFile (Just file) decls
  in runAnalyzer file moduleId (walkFile objcFile)

-- | Find nodes of a specific type in analysis output.
nodesOfType :: Text -> FileAnalysis -> [GraphNode]
nodesOfType t fa = [ n | n <- faNodes fa, gnType n == t ]

-- | Find nodes with a specific metadata key-value pair.
nodesWithMeta :: Text -> MetaValue -> FileAnalysis -> [GraphNode]
nodesWithMeta k v fa =
  [ n | n <- faNodes fa, Map.lookup k (gnMetadata n) == Just v ]

-- | Find edges of a specific type in analysis output.
edgesOfType :: Text -> FileAnalysis -> [GraphEdge]
edgesOfType t fa = [ e | e <- faEdges fa, geType e == t ]

-- | Count nodes of a specific type.
countNodes :: Text -> FileAnalysis -> Int
countNodes t = length . nodesOfType t

-- | Count edges of a specific type.
countEdges :: Text -> FileAnalysis -> Int
countEdges t = length . edgesOfType t

-- ── Tests ─────────────────────────────────────────────────────────────

main :: IO ()
main = hspec $ do

  -- ── MODULE node emission ────────────────────────────────────────────

  describe "Walker: MODULE node" $ do

    it "emits a MODULE node for the file" $ do
      let fa = analyzeDecls "AppDelegate.m" []
      countNodes "MODULE" fa `shouldBe` 1
      gnName (head (nodesOfType "MODULE" fa)) `shouldBe` "AppDelegate"

    it "sets language metadata to objc" $ do
      let fa = analyzeDecls "AppDelegate.m" []
          modNode = head (nodesOfType "MODULE" fa)
      Map.lookup "language" (gnMetadata modNode) `shouldBe` Just (MetaText "objc")

    it "strips .h extension for header files" $ do
      let fa = analyzeDecls "MyClass.h" []
      gnName (head (nodesOfType "MODULE" fa)) `shouldBe` "MyClass"

  -- ── @interface declarations ────────────────────────────────────────

  describe "Rules.Declarations: @interface" $ do

    it "emits CLASS node with kind objc_interface" $ do
      let fa = analyzeDecls "MyClass.h"
            [ ObjCInterfaceDecl "MyClass" [] testSpan ]
      countNodes "CLASS" fa `shouldBe` 1
      let cls = head (nodesOfType "CLASS" fa)
      gnName cls `shouldBe` "MyClass"
      Map.lookup "kind" (gnMetadata cls) `shouldBe` Just (MetaText "objc_interface")

    it "emits CONTAINS edge from MODULE to CLASS" $ do
      let fa = analyzeDecls "MyClass.h"
            [ ObjCInterfaceDecl "MyClass" [] testSpan ]
      countEdges "CONTAINS" fa `shouldSatisfy` (>= 1)

    it "nests methods inside interface" $ do
      let fa = analyzeDecls "MyClass.h"
            [ ObjCInterfaceDecl "MyClass"
                [ ObjCInstanceMethodDecl "doSomething" (Just "void") [] testSpan
                , ObjCClassMethodDecl "sharedInstance" (Just "instancetype") [] testSpan
                ]
                testSpan
            ]
      countNodes "FUNCTION" fa `shouldBe` 2

  -- ── @protocol declarations ─────────────────────────────────────────

  describe "Rules.Declarations: @protocol" $ do

    it "emits CLASS node with kind objc_protocol" $ do
      let fa = analyzeDecls "MyProtocol.h"
            [ ObjCProtocolDecl "MyProtocol" [] testSpan ]
      let cls = head (nodesOfType "CLASS" fa)
      gnName cls `shouldBe` "MyProtocol"
      Map.lookup "kind" (gnMetadata cls) `shouldBe` Just (MetaText "objc_protocol")

  -- ── @category declarations ─────────────────────────────────────────

  describe "Rules.Declarations: @category" $ do

    it "emits EXTENSION node with kind category" $ do
      let fa = analyzeDecls "NSString+Utils.h"
            [ ObjCCategoryDecl "NSString_Utils" [] testSpan ]
      countNodes "EXTENSION" fa `shouldBe` 1
      let ext = head (nodesOfType "EXTENSION" fa)
      Map.lookup "kind" (gnMetadata ext) `shouldBe` Just (MetaText "category")

  -- ── Method declarations ────────────────────────────────────────────

  describe "Rules.Declarations: methods" $ do

    it "emits FUNCTION with isClassMethod=False for instance method" $ do
      let fa = analyzeDecls "MyClass.m"
            [ ObjCInterfaceDecl "MyClass"
                [ ObjCInstanceMethodDecl "init" (Just "instancetype") [] testSpan ]
                testSpan
            ]
          funcs = nodesOfType "FUNCTION" fa
      length funcs `shouldBe` 1
      Map.lookup "isClassMethod" (gnMetadata (head funcs)) `shouldBe` Just (MetaBool False)

    it "emits FUNCTION with isClassMethod=True for class method" $ do
      let fa = analyzeDecls "MyClass.m"
            [ ObjCInterfaceDecl "MyClass"
                [ ObjCClassMethodDecl "alloc" (Just "instancetype") [] testSpan ]
                testSpan
            ]
          funcs = nodesOfType "FUNCTION" fa
      length funcs `shouldBe` 1
      Map.lookup "isClassMethod" (gnMetadata (head funcs)) `shouldBe` Just (MetaBool True)

  -- ── Property declarations ──────────────────────────────────────────

  describe "Rules.Declarations: @property" $ do

    it "emits VARIABLE node with kind objc_property" $ do
      let fa = analyzeDecls "MyClass.h"
            [ ObjCInterfaceDecl "MyClass"
                [ ObjCPropertyDecl "name" (Just "NSString *") (Just "nonnull") [] testSpan ]
                testSpan
            ]
          vars = nodesOfType "VARIABLE" fa
      length vars `shouldBe` 1
      Map.lookup "kind" (gnMetadata (head vars)) `shouldBe` Just (MetaText "objc_property")

    it "includes nullability metadata when present" $ do
      let fa = analyzeDecls "MyClass.h"
            [ ObjCInterfaceDecl "MyClass"
                [ ObjCPropertyDecl "delegate" (Just "id") (Just "nullable") [] testSpan ]
                testSpan
            ]
          vars = nodesOfType "VARIABLE" fa
      Map.lookup "nullability" (gnMetadata (head vars)) `shouldBe` Just (MetaText "nullable")

  -- ── Enum declarations ──────────────────────────────────────────────

  describe "Rules.Declarations: enum" $ do

    it "emits CLASS node with kind objc_enum and enum constant VARIABLE nodes" $ do
      let fa = analyzeDecls "Status.h"
            [ EnumDecl "StatusCode"
                [ EnumConstantDecl "StatusOK" testSpan
                , EnumConstantDecl "StatusError" testSpan
                ]
                testSpan
            ]
      countNodes "CLASS" fa `shouldBe` 1
      Map.lookup "kind" (gnMetadata (head (nodesOfType "CLASS" fa)))
        `shouldBe` Just (MetaText "objc_enum")
      countNodes "VARIABLE" fa `shouldBe` 2

  -- ── C function declarations ────────────────────────────────────────

  describe "Rules.Declarations: C functions" $ do

    it "emits FUNCTION node with kind c_function" $ do
      let fa = analyzeDecls "utils.m"
            [ FunctionDecl "NSLog" [] testSpan ]
          funcs = nodesOfType "FUNCTION" fa
      length funcs `shouldBe` 1
      Map.lookup "kind" (gnMetadata (head funcs)) `shouldBe` Just (MetaText "c_function")

  -- ── Variable declarations ──────────────────────────────────────────

  describe "Rules.Declarations: variables" $ do

    it "emits VARIABLE node with kind c_variable" $ do
      let fa = analyzeDecls "constants.m"
            [ VarDecl "kVersion" testSpan ]
          vars = nodesOfType "VARIABLE" fa
      length vars `shouldBe` 1
      Map.lookup "kind" (gnMetadata (head vars)) `shouldBe` Just (MetaText "c_variable")

  -- ── Typedef declarations ───────────────────────────────────────────

  describe "Rules.Declarations: typedef" $ do

    it "emits CLASS node with kind typedef" $ do
      let fa = analyzeDecls "Types.h"
            [ TypedefDecl "CompletionHandler" testSpan ]
          classes = nodesOfType "CLASS" fa
      length classes `shouldBe` 1
      Map.lookup "kind" (gnMetadata (head classes)) `shouldBe` Just (MetaText "typedef")

  -- ── Superclass / protocol refs ─────────────────────────────────────

  describe "Rules.Declarations: superclass and protocol refs" $ do

    it "emits EXTENDS deferred ref for ObjCSuperClassRef" $ do
      let fa = analyzeDecls "MyClass.h"
            [ ObjCInterfaceDecl "MyClass"
                [ ObjCSuperClassRef "NSObject" testSpan ]
                testSpan
            ]
      let refs = faUnresolvedRefs fa
          extendsRefs = [ r | r <- refs, drEdgeType r == "EXTENDS" ]
      length extendsRefs `shouldBe` 1
      drName (head extendsRefs) `shouldBe` "NSObject"

    it "emits IMPLEMENTS deferred ref for ObjCProtocolRef" $ do
      let fa = analyzeDecls "MyClass.h"
            [ ObjCInterfaceDecl "MyClass"
                [ ObjCProtocolRef "NSCoding" testSpan ]
                testSpan
            ]
      let refs = faUnresolvedRefs fa
          implRefs = [ r | r <- refs, drEdgeType r == "IMPLEMENTS" ]
      length implRefs `shouldBe` 1
      drName (head implRefs) `shouldBe` "NSCoding"

  -- ── Import directives ──────────────────────────────────────────────

  describe "Rules.Imports" $ do

    it "emits IMPORT node for #import directive" $ do
      let fa = analyzeDecls "MyClass.m"
            [ InclusionDirective "Foundation/Foundation.h" testSpan ]
      countNodes "IMPORT" fa `shouldBe` 1
      gnName (head (nodesOfType "IMPORT" fa)) `shouldBe` "Foundation/Foundation.h"

  -- ── Message expressions ────────────────────────────────────────────

  describe "Rules.Messages" $ do

    it "emits CALL node with kind objc_message for message send" $ do
      let fa = analyzeDecls "MyClass.m"
            [ ObjCInterfaceDecl "MyClass"
                [ ObjCInstanceMethodDecl "viewDidLoad" (Just "void")
                    [ ObjCMessageExpr "self" (Just "doSetup:") [] testSpan ]
                    testSpan
                ]
                testSpan
            ]
          calls = nodesOfType "CALL" fa
      length calls `shouldBe` 1
      Map.lookup "kind" (gnMetadata (head calls)) `shouldBe` Just (MetaText "objc_message")

  -- ── Implementation linking ─────────────────────────────────────────

  describe "Rules.Declarations: @implementation" $ do

    it "walks children of @implementation (methods)" $ do
      let fa = analyzeDecls "MyClass.m"
            [ ObjCImplementationDecl "MyClass"
                [ ObjCInstanceMethodDecl "init" (Just "instancetype") [] testSpan
                , ObjCInstanceMethodDecl "dealloc" (Just "void") [] testSpan
                ]
                testSpan
            ]
      countNodes "FUNCTION" fa `shouldBe` 2

  -- ── All nodes have language metadata ───────────────────────────────

  describe "Metadata integrity" $ do

    it "all emitted nodes have language=objc metadata" $ do
      let fa = analyzeDecls "MyClass.h"
            [ ObjCInterfaceDecl "MyClass"
                [ ObjCInstanceMethodDecl "init" (Just "instancetype") [] testSpan
                , ObjCPropertyDecl "name" (Just "NSString *") Nothing [] testSpan
                ]
                testSpan
            , InclusionDirective "Foundation/Foundation.h" testSpan
            ]
          allHaveLang = all (\n -> Map.lookup "language" (gnMetadata n) == Just (MetaText "objc"))
                        (faNodes fa)
      allHaveLang `shouldBe` True

  -- ── Complex real-world file ────────────────────────────────────────

  describe "Complex: realistic Obj-C header" $ do

    it "produces correct node counts for a full header" $ do
      let fa = analyzeDecls "AppDelegate.h"
            [ InclusionDirective "UIKit/UIKit.h" testSpan
            , InclusionDirective "CoreData/CoreData.h" testSpan
            , ObjCInterfaceDecl "AppDelegate"
                [ ObjCSuperClassRef "UIResponder" testSpan
                , ObjCProtocolRef "UIApplicationDelegate" testSpan
                , ObjCPropertyDecl "window" (Just "UIWindow *") (Just "nonnull") [] testSpan
                , ObjCPropertyDecl "managedObjectContext" (Just "NSManagedObjectContext *") (Just "nullable") [] testSpan
                , ObjCInstanceMethodDecl "applicationDidFinishLaunching:" (Just "BOOL") [] testSpan
                , ObjCClassMethodDecl "sharedDelegate" (Just "instancetype") [] testSpan
                ]
                testSpan
            ]
      -- 1 MODULE + 1 CLASS + 2 VARIABLE + 2 FUNCTION + 2 IMPORT = 8 nodes
      countNodes "MODULE" fa `shouldBe` 1
      countNodes "CLASS" fa `shouldBe` 1
      countNodes "VARIABLE" fa `shouldBe` 2
      countNodes "FUNCTION" fa `shouldBe` 2
      countNodes "IMPORT" fa `shouldBe` 2
      length (faNodes fa) `shouldBe` 8
      -- Deferred refs: 1 EXTENDS (UIResponder) + 1 IMPLEMENTS (UIApplicationDelegate)
      length (faUnresolvedRefs fa) `shouldBe` 2

  -- ── Type metadata on nodes ───────────────────────────────────────

  describe "Rules.Types: type metadata" $ do

    it "sets return_type on instance method" $ do
      let fa = analyzeDecls "MyClass.h"
            [ ObjCInterfaceDecl "MyClass"
                [ ObjCInstanceMethodDecl "init" (Just "instancetype") [] testSpan ]
                testSpan
            ]
          funcs = nodesOfType "FUNCTION" fa
      Map.lookup "return_type" (gnMetadata (head funcs)) `shouldBe` Just (MetaText "instancetype")

    it "sets return_type on class method" $ do
      let fa = analyzeDecls "MyClass.h"
            [ ObjCInterfaceDecl "MyClass"
                [ ObjCClassMethodDecl "sharedInstance" (Just "instancetype") [] testSpan ]
                testSpan
            ]
          funcs = nodesOfType "FUNCTION" fa
      Map.lookup "return_type" (gnMetadata (head funcs)) `shouldBe` Just (MetaText "instancetype")

    it "omits return_type when not present" $ do
      let fa = analyzeDecls "MyClass.h"
            [ ObjCInterfaceDecl "MyClass"
                [ ObjCInstanceMethodDecl "doSomething" Nothing [] testSpan ]
                testSpan
            ]
          funcs = nodesOfType "FUNCTION" fa
      Map.lookup "return_type" (gnMetadata (head funcs)) `shouldBe` Nothing

    it "sets type on property" $ do
      let fa = analyzeDecls "MyClass.h"
            [ ObjCInterfaceDecl "MyClass"
                [ ObjCPropertyDecl "name" (Just "NSString *") Nothing [] testSpan ]
                testSpan
            ]
          vars = nodesOfType "VARIABLE" fa
      Map.lookup "type" (gnMetadata (head vars)) `shouldBe` Just (MetaText "NSString *")

    it "omits type when property type not present" $ do
      let fa = analyzeDecls "MyClass.h"
            [ ObjCInterfaceDecl "MyClass"
                [ ObjCPropertyDecl "delegate" Nothing Nothing [] testSpan ]
                testSpan
            ]
          vars = nodesOfType "VARIABLE" fa
      Map.lookup "type" (gnMetadata (head vars)) `shouldBe` Nothing

    it "sets extends metadata on interface with superclass" $ do
      let fa = analyzeDecls "MyClass.h"
            [ ObjCInterfaceDecl "MyClass"
                [ ObjCSuperClassRef "NSObject" testSpan ]
                testSpan
            ]
          cls = head (nodesOfType "CLASS" fa)
      Map.lookup "extends" (gnMetadata cls) `shouldBe` Just (MetaText "NSObject")

    it "sets implements metadata on interface with protocols" $ do
      let fa = analyzeDecls "MyClass.h"
            [ ObjCInterfaceDecl "MyClass"
                [ ObjCProtocolRef "NSCoding" testSpan
                , ObjCProtocolRef "NSCopying" testSpan
                ]
                testSpan
            ]
          cls = head (nodesOfType "CLASS" fa)
      Map.lookup "implements" (gnMetadata cls) `shouldBe` Just (MetaText "NSCoding,NSCopying")

    it "sets implements metadata on protocol with inherited protocols" $ do
      let fa = analyzeDecls "MyProtocol.h"
            [ ObjCProtocolDecl "MyProtocol"
                [ ObjCProtocolRef "NSObject" testSpan ]
                testSpan
            ]
          cls = head (nodesOfType "CLASS" fa)
      Map.lookup "implements" (gnMetadata cls) `shouldBe` Just (MetaText "NSObject")

    it "omits extends/implements metadata when no refs" $ do
      let fa = analyzeDecls "MyClass.h"
            [ ObjCInterfaceDecl "MyClass" [] testSpan ]
          cls = head (nodesOfType "CLASS" fa)
      Map.lookup "extends" (gnMetadata cls) `shouldBe` Nothing
      Map.lookup "implements" (gnMetadata cls) `shouldBe` Nothing

  -- ── Export visibility (.h vs .m) ─────────────────────────────────

  describe "Rules.Exports: header vs implementation visibility" $ do

    it "marks .h declarations as exported" $ do
      let fa = analyzeDecls "MyClass.h"
            [ ObjCInterfaceDecl "MyClass"
                [ ObjCInstanceMethodDecl "init" (Just "instancetype") [] testSpan
                , ObjCPropertyDecl "name" (Just "NSString *") Nothing [] testSpan
                ]
                testSpan
            ]
          nonModule = [ n | n <- faNodes fa, gnType n /= "MODULE" ]
      all gnExported nonModule `shouldBe` True

    it "marks .m declarations as not exported" $ do
      let fa = analyzeDecls "MyClass.m"
            [ ObjCInterfaceDecl "MyClass"
                [ ObjCInstanceMethodDecl "init" (Just "instancetype") [] testSpan
                , ObjCPropertyDecl "name" (Just "NSString *") Nothing [] testSpan
                ]
                testSpan
            ]
          nonModule = [ n | n <- faNodes fa, gnType n /= "MODULE" ]
      all (not . gnExported) nonModule `shouldBe` True

    it "marks .mm declarations as not exported" $ do
      let fa = analyzeDecls "MyClass.mm"
            [ FunctionDecl "helperFunc" [] testSpan ]
          funcs = nodesOfType "FUNCTION" fa
      gnExported (head funcs) `shouldBe` False

    it "emits ExportInfo for .h file declarations" $ do
      let fa = analyzeDecls "MyClass.h"
            [ ObjCInterfaceDecl "MyClass" [] testSpan
            , FunctionDecl "createMyClass" [] testSpan
            , EnumDecl "MyEnum" [] testSpan
            , TypedefDecl "MyHandler" testSpan
            , VarDecl "kVersion" testSpan
            ]
      length (faExports fa) `shouldBe` 5
      let exportNames = map eiName (faExports fa)
      exportNames `shouldBe` ["MyClass", "createMyClass", "MyEnum", "MyHandler", "kVersion"]

    it "does not emit ExportInfo for .m file declarations" $ do
      let fa = analyzeDecls "MyClass.m"
            [ ObjCInterfaceDecl "MyClass" [] testSpan
            , FunctionDecl "helperFunc" [] testSpan
            ]
      length (faExports fa) `shouldBe` 0

    it "MODULE node is always exported regardless of file type" $ do
      let fa = analyzeDecls "MyClass.m" []
          modNode = head (nodesOfType "MODULE" fa)
      gnExported modNode `shouldBe` True
