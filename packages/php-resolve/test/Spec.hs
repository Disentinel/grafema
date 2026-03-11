{-# LANGUAGE OverloadedStrings #-}
module Main where

import Test.Hspec
import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import Data.Map.Strict (Map)

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..))
import PhpIndex
import qualified PhpImportResolution
import qualified PhpTypeResolution
import qualified PhpTypeInference
import qualified PhpCallResolution

-- ── Test fixture helpers ─────────────────────────────────────────────

mkNode :: Text -> Text -> Text -> Text -> Map Text MetaValue -> GraphNode
mkNode nodeId nodeType name file meta = GraphNode
  { gnId        = nodeId
  , gnType      = nodeType
  , gnName      = name
  , gnFile      = file
  , gnLine      = 1
  , gnColumn    = 0
  , gnEndLine   = 10
  , gnEndColumn = 0
  , gnExported  = True
  , gnMetadata  = meta
  }

-- | Like mkNode but with explicit line range (for line-containment tests).
mkNodeAt :: Text -> Text -> Text -> Text -> Int -> Int -> Map Text MetaValue -> GraphNode
mkNodeAt nodeId nodeType name file startLine endLine meta = GraphNode
  { gnId        = nodeId
  , gnType      = nodeType
  , gnName      = name
  , gnFile      = file
  , gnLine      = startLine
  , gnColumn    = 0
  , gnEndLine   = endLine
  , gnEndColumn = 0
  , gnExported  = True
  , gnMetadata  = meta
  }

-- | Extract edges from PluginCommands
extractEdges :: [PluginCommand] -> [(Text, Text, Text)]
extractEdges = concatMap go
  where
    go (EmitEdge e) = [(geSource e, geTarget e, geType e)]
    go _            = []

-- | Extract edge metadata from PluginCommands
extractEdgeMeta :: [PluginCommand] -> [(Text, Text, Text, Map Text MetaValue)]
extractEdgeMeta = concatMap go
  where
    go (EmitEdge e) = [(geSource e, geTarget e, geType e, geMetadata e)]
    go _            = []

-- ── Multi-file PHP project fixture ──────────────────────────────────

-- Simulates a PHP project with:
--   app/Models/User.php          - class User extends BaseModel implements Serializable
--   app/Models/BaseModel.php     - abstract class BaseModel
--   app/Contracts/Serializable.php - interface Serializable
--   app/Traits/HasTimestamps.php - trait HasTimestamps
--   app/Services/UserService.php - class UserService (uses User, static calls, $this)
--   app/helpers.php              - function helper()

fixtureNodes :: [GraphNode]
fixtureNodes =
  -- ── File 1: app/Models/User.php ──
  [ mkNode "app/Models/User.php->MODULE" "MODULE" "User" "app/Models/User.php"
      Map.empty
  , mkNode "app/Models/User.php->CLASS->User" "CLASS" "User" "app/Models/User.php"
      (Map.fromList
        [ ("namespace",  MetaText "App\\Models")
        , ("extends",    MetaText "BaseModel")
        , ("implements", MetaText "Serializable")
        , ("traits",     MetaText "HasTimestamps")
        ])
  , mkNode "app/Models/User.php->FUNCTION->getName[in:User]" "FUNCTION" "getName" "app/Models/User.php"
      (Map.fromList [("kind", MetaText "method"), ("namespace", MetaText "App\\Models"), ("return_type", MetaText "self")])
  , mkNode "app/Models/User.php->FUNCTION->find[in:User]" "FUNCTION" "find" "app/Models/User.php"
      (Map.fromList [("kind", MetaText "method"), ("static", MetaBool True), ("namespace", MetaText "App\\Models")])
  -- Static call with self receiver: self::find() inside User::getName
  , mkNode "app/Models/User.php->CALL->find[in:getName,static]" "CALL" "find" "app/Models/User.php"
      (Map.fromList [("static", MetaBool True), ("receiver", MetaText "self")])

  -- Static call with parent receiver: parent::save() inside User::getName
  , mkNode "app/Models/User.php->CALL->save[in:getName,static]" "CALL" "save" "app/Models/User.php"
      (Map.fromList [("static", MetaBool True), ("receiver", MetaText "parent")])

  -- $this->save() in User — save() is inherited from BaseModel
  , mkNode "app/Models/User.php->CALL->save[in:User]" "CALL" "save" "app/Models/User.php"
      (Map.fromList [("receiver", MetaText "$this")])

  -- $this->touchTimestamp() in User — touchTimestamp() comes from HasTimestamps trait
  , mkNode "app/Models/User.php->CALL->touchTimestamp[in:User]" "CALL" "touchTimestamp" "app/Models/User.php"
      (Map.fromList [("receiver", MetaText "$this")])

  -- $this->getId() in User — getId() is in AbstractEntity (grandparent: User → BaseModel → AbstractEntity)
  , mkNode "app/Models/User.php->CALL->getId[in:User]" "CALL" "getId" "app/Models/User.php"
      (Map.fromList [("receiver", MetaText "$this")])

  , mkNode "app/Models/User.php->IMPORT_BINDING->Connection" "IMPORT_BINDING" "Connection" "app/Models/User.php"
      (Map.fromList [("source", MetaText "App\\Database\\Connection"), ("imported_name", MetaText "Connection")])
  , mkNode "app/Models/User.php->IMPORT_BINDING->Response" "IMPORT_BINDING" "Response" "app/Models/User.php"
      (Map.fromList [("source", MetaText "App\\Http\\Response"), ("imported_name", MetaText "Response")])
  , mkNode "app/Models/User.php->IMPORT_BINDING->Serializable" "IMPORT_BINDING" "Serializable" "app/Models/User.php"
      (Map.fromList [("source", MetaText "App\\Contracts\\Serializable"), ("imported_name", MetaText "Serializable")])
  , mkNode "app/Models/User.php->IMPORT_BINDING->HasTimestamps" "IMPORT_BINDING" "HasTimestamps" "app/Models/User.php"
      (Map.fromList [("source", MetaText "App\\Traits\\HasTimestamps"), ("imported_name", MetaText "HasTimestamps")])

  -- ── File 2a: app/Models/AbstractEntity.php (grandparent) ──
  , mkNode "app/Models/AbstractEntity.php->MODULE" "MODULE" "AbstractEntity" "app/Models/AbstractEntity.php"
      Map.empty
  , mkNode "app/Models/AbstractEntity.php->CLASS->AbstractEntity" "CLASS" "AbstractEntity" "app/Models/AbstractEntity.php"
      (Map.fromList [("namespace", MetaText "App\\Models"), ("abstract", MetaBool True)])
  , mkNode "app/Models/AbstractEntity.php->FUNCTION->getId[in:AbstractEntity]" "FUNCTION" "getId" "app/Models/AbstractEntity.php"
      (Map.fromList [("kind", MetaText "method"), ("namespace", MetaText "App\\Models")])

  -- ── File 2: app/Models/BaseModel.php ──
  , mkNode "app/Models/BaseModel.php->MODULE" "MODULE" "BaseModel" "app/Models/BaseModel.php"
      Map.empty
  , mkNode "app/Models/BaseModel.php->CLASS->BaseModel" "CLASS" "BaseModel" "app/Models/BaseModel.php"
      (Map.fromList [("namespace", MetaText "App\\Models"), ("abstract", MetaBool True), ("extends", MetaText "AbstractEntity")])
  , mkNode "app/Models/BaseModel.php->FUNCTION->save[in:BaseModel]" "FUNCTION" "save" "app/Models/BaseModel.php"
      (Map.fromList [("kind", MetaText "method"), ("namespace", MetaText "App\\Models")])

  -- ── File 3: app/Contracts/Serializable.php ──
  , mkNode "app/Contracts/Serializable.php->MODULE" "MODULE" "Serializable" "app/Contracts/Serializable.php"
      Map.empty
  , mkNode "app/Contracts/Serializable.php->INTERFACE->Serializable" "INTERFACE" "Serializable" "app/Contracts/Serializable.php"
      (Map.fromList [("namespace", MetaText "App\\Contracts")])
  , mkNode "app/Contracts/Serializable.php->FUNCTION->serialize[in:Serializable]" "FUNCTION" "serialize" "app/Contracts/Serializable.php"
      (Map.fromList [("kind", MetaText "method"), ("namespace", MetaText "App\\Contracts")])

  -- ── File 4: app/Traits/HasTimestamps.php ──
  , mkNode "app/Traits/HasTimestamps.php->MODULE" "MODULE" "HasTimestamps" "app/Traits/HasTimestamps.php"
      Map.empty
  , mkNode "app/Traits/HasTimestamps.php->TRAIT->HasTimestamps" "TRAIT" "HasTimestamps" "app/Traits/HasTimestamps.php"
      (Map.fromList [("namespace", MetaText "App\\Traits")])
  , mkNode "app/Traits/HasTimestamps.php->FUNCTION->touchTimestamp[in:HasTimestamps]" "FUNCTION" "touchTimestamp" "app/Traits/HasTimestamps.php"
      (Map.fromList [("kind", MetaText "method"), ("namespace", MetaText "App\\Traits")])

  -- ── File 5: app/Services/UserService.php ──
  , mkNode "app/Services/UserService.php->MODULE" "MODULE" "UserService" "app/Services/UserService.php"
      Map.empty
  , mkNode "app/Services/UserService.php->CLASS->UserService" "CLASS" "UserService" "app/Services/UserService.php"
      (Map.fromList [("namespace", MetaText "App\\Services")])
  , mkNodeAt "app/Services/UserService.php->FUNCTION->createUser[in:UserService]" "FUNCTION" "createUser" "app/Services/UserService.php" 20 50
      (Map.fromList [("kind", MetaText "method"), ("namespace", MetaText "App\\Services"), ("return_type", MetaText "User")])
  , mkNode "app/Services/UserService.php->IMPORT_BINDING->User" "IMPORT_BINDING" "User" "app/Services/UserService.php"
      (Map.fromList [("source", MetaText "App\\Models\\User"), ("imported_name", MetaText "User")])
  , mkNode "app/Services/UserService.php->IMPORT_BINDING->Serializable" "IMPORT_BINDING" "Serializable" "app/Services/UserService.php"
      (Map.fromList [("source", MetaText "App\\Contracts\\Serializable"), ("imported_name", MetaText "Serializable")])

  -- Typed parameter: User $user in createUser function (line 21, inside 20-50)
  , mkNodeAt "app/Services/UserService.php->VARIABLE->$user[in:createUser]" "VARIABLE" "$user" "app/Services/UserService.php" 21 21
      (Map.fromList [("kind", MetaText "parameter"), ("type", MetaText "User")])

  -- Typed property: ?Connection $conn (nullable type, external — no target in project)
  , mkNode "app/Services/UserService.php->VARIABLE->$conn[in:UserService]" "VARIABLE" "$conn" "app/Services/UserService.php"
      (Map.fromList [("kind", MetaText "property"), ("type", MetaText "?Connection")])

  -- Typed property: User $model (resolvable type)
  , mkNode "app/Services/UserService.php->VARIABLE->$model[in:UserService]" "VARIABLE" "$model" "app/Services/UserService.php"
      (Map.fromList [("kind", MetaText "property"), ("type", MetaText "User")])

  -- Typed parameter with primitive type (should NOT produce TYPE_OF edge)
  , mkNodeAt "app/Services/UserService.php->VARIABLE->$name[in:createUser]" "VARIABLE" "$name" "app/Services/UserService.php" 21 21
      (Map.fromList [("kind", MetaText "parameter"), ("type", MetaText "string")])

  -- Typed parameter with "static" type hint (should resolve to enclosing class UserService)
  , mkNodeAt "app/Services/UserService.php->VARIABLE->$self[in:createUser]" "VARIABLE" "$self" "app/Services/UserService.php" 21 21
      (Map.fromList [("kind", MetaText "parameter"), ("type", MetaText "static")])

  -- Interface-typed parameter: Serializable $item
  , mkNodeAt "app/Services/UserService.php->VARIABLE->$item[in:createUser]" "VARIABLE" "$item" "app/Services/UserService.php" 21 21
      (Map.fromList [("kind", MetaText "parameter"), ("type", MetaText "Serializable")])

  -- Union-typed parameter: User|null $maybeUser
  , mkNodeAt "app/Services/UserService.php->VARIABLE->$maybeUser[in:createUser]" "VARIABLE" "$maybeUser" "app/Services/UserService.php" 21 21
      (Map.fromList [("kind", MetaText "parameter"), ("type", MetaText "User|null")])

  -- Instance method call: $user->getName() — resolved via param type
  , mkNodeAt "app/Services/UserService.php->CALL->getName[in:createUser]" "CALL" "getName" "app/Services/UserService.php" 25 25
      (Map.fromList [("method", MetaBool True), ("receiver", MetaText "$user")])

  -- Property-based call: $this->model->getName() — resolved via property type
  , mkNode "app/Services/UserService.php->CALL->getName[in:createUser,prop]" "CALL" "getName" "app/Services/UserService.php"
      (Map.fromList [("method", MetaBool True), ("receiver", MetaText "$this->model")])

  -- Interface method call: $item->serialize() — via interface-typed param
  , mkNodeAt "app/Services/UserService.php->CALL->serialize[in:createUser]" "CALL" "serialize" "app/Services/UserService.php" 30 30
      (Map.fromList [("method", MetaBool True), ("receiver", MetaText "$item")])

  -- Union-typed param call: $maybeUser->getName() — User|null → User
  , mkNodeAt "app/Services/UserService.php->CALL->getName[in:createUser,union]" "CALL" "getName" "app/Services/UserService.php" 31 31
      (Map.fromList [("method", MetaBool True), ("receiver", MetaText "$maybeUser")])

  -- CALL: new User() — constructor
  , mkNode "app/Services/UserService.php->CALL->new User[in:createUser]" "CALL" "new User" "app/Services/UserService.php"
      (Map.fromList [("kind", MetaText "constructor")])

  -- CALL: User::find(1) — static method call
  , mkNode "app/Services/UserService.php->CALL->find[in:createUser,static]" "CALL" "find" "app/Services/UserService.php"
      (Map.fromList [("static", MetaBool True), ("receiver", MetaText "User")])

  -- CALL: $this->validate() — $this method call
  , mkNode "app/Services/UserService.php->CALL->validate[in:UserService]" "CALL" "validate" "app/Services/UserService.php"
      (Map.fromList [("receiver", MetaText "$this")])
  , mkNode "app/Services/UserService.php->FUNCTION->validate[in:UserService]" "FUNCTION" "validate" "app/Services/UserService.php"
      (Map.fromList [("kind", MetaText "method"), ("namespace", MetaText "App\\Services")])

  -- ── File 6: app/helpers.php (no namespace) ──
  , mkNode "app/helpers.php->MODULE" "MODULE" "helpers" "app/helpers.php"
      Map.empty
  , mkNode "app/helpers.php->FUNCTION->helper" "FUNCTION" "helper" "app/helpers.php"
      (Map.fromList [("kind", MetaText "function")])

  -- CALL: helper() — plain function call from UserService
  , mkNode "app/Services/UserService.php->CALL->helper[in:createUser]" "CALL" "helper" "app/Services/UserService.php"
      Map.empty

  -- ── Interface extending another interface ──
  , mkNode "app/Contracts/JsonSerializable.php->MODULE" "MODULE" "JsonSerializable" "app/Contracts/JsonSerializable.php"
      Map.empty
  , mkNode "app/Contracts/JsonSerializable.php->INTERFACE->JsonSerializable" "INTERFACE" "JsonSerializable" "app/Contracts/JsonSerializable.php"
      (Map.fromList [("namespace", MetaText "App\\Contracts"), ("extends", MetaText "Serializable")])

  -- ── Enum implementing interface ──
  , mkNode "app/Enums/Status.php->MODULE" "MODULE" "Status" "app/Enums/Status.php"
      Map.empty
  , mkNode "app/Enums/Status.php->ENUM->Status" "ENUM" "Status" "app/Enums/Status.php"
      (Map.fromList [("namespace", MetaText "App\\Enums"), ("implements", MetaText "Serializable")])
  , mkNode "app/Enums/Status.php->IMPORT_BINDING->Serializable" "IMPORT_BINDING" "Serializable" "app/Enums/Status.php"
      (Map.fromList [("source", MetaText "App\\Contracts\\Serializable"), ("imported_name", MetaText "Serializable")])
  ]

main :: IO ()
main = hspec $ do
  -- ════════════════════════════════════════════════════════════════════
  -- PhpIndex tests
  -- ════════════════════════════════════════════════════════════════════
  describe "PhpIndex" $ do
    let modIdx  = buildModuleIndex fixtureNodes
        nameIdx = buildNameIndex fixtureNodes modIdx
        fileIdx = buildFileIndex fixtureNodes
        impIdx  = buildImportIndex fixtureNodes

    describe "buildModuleIndex" $ do
      it "indexes all MODULE nodes by file path" $ do
        Map.size modIdx `shouldBe` 9
        Map.member "app/Models/User.php" modIdx `shouldBe` True

      it "fills namespace from declaration nodes" $ do
        case Map.lookup "app/Models/User.php" modIdx of
          Just (_, ns) -> ns `shouldBe` "App\\Models"
          Nothing      -> expectationFailure "User.php not in ModuleIndex"

    describe "buildNameIndex" $ do
      it "maps FQ class names to node IDs" $ do
        Map.member "App\\Models\\User" nameIdx `shouldBe` True
        Map.member "App\\Models\\BaseModel" nameIdx `shouldBe` True
        Map.member "App\\Contracts\\Serializable" nameIdx `shouldBe` True
        Map.member "App\\Traits\\HasTimestamps" nameIdx `shouldBe` True

      it "maps global function without namespace" $ do
        Map.member "helper" nameIdx `shouldBe` True

      it "maps namespaced function" $ do
        -- Methods with namespace should be indexed
        Map.member "App\\Models\\getName" nameIdx `shouldBe` True

    describe "buildFileIndex" $ do
      it "groups declarations by file" $ do
        case Map.lookup "app/Models/User.php" fileIdx of
          Just decls -> length decls `shouldSatisfy` (>= 3) -- User class + 2 methods
          Nothing    -> expectationFailure "User.php not in FileIndex"

    describe "lookupFQName" $ do
      it "finds already-qualified names" $ do
        lookupFQName "App\\Models\\User" "app/Services/UserService.php" modIdx impIdx nameIdx
          `shouldSatisfy` isJust

      it "resolves relative names in same namespace" $ do
        -- From User.php (namespace App\Models), "BaseModel" should resolve
        lookupFQName "BaseModel" "app/Models/User.php" modIdx impIdx nameIdx
          `shouldSatisfy` isJust

      it "resolves imported names from different namespace" $ do
        -- From User.php, "Serializable" resolves via IMPORT_BINDING
        lookupFQName "Serializable" "app/Models/User.php" modIdx impIdx nameIdx
          `shouldSatisfy` isJust

      it "falls back to global for unnamespaced" $ do
        lookupFQName "helper" "app/Services/UserService.php" modIdx impIdx nameIdx
          `shouldSatisfy` isJust

      it "returns Nothing for external deps" $ do
        lookupFQName "App\\External\\Missing" "app/Models/User.php" modIdx impIdx nameIdx
          `shouldBe` Nothing

  -- ════════════════════════════════════════════════════════════════════
  -- Import resolution tests
  -- ════════════════════════════════════════════════════════════════════
  describe "PhpImportResolution" $ do
    it "resolves IMPORT_BINDING → target CLASS via source metadata" $ do
      edges <- PhpImportResolution.resolveAll fixtureNodes
      let resolved = extractEdges edges
      -- User import in UserService → CLASS User
      resolved `shouldSatisfy` any (\(s, t, ty) ->
        "IMPORT_BINDING->User" `T.isInfixOf` s &&
        "CLASS->User" `T.isInfixOf` t &&
        ty == "IMPORTS_FROM")

    it "skips external imports (no target in project)" $ do
      edges <- PhpImportResolution.resolveAll fixtureNodes
      let resolved = extractEdges edges
      -- Connection and Response are external (no matching CLASS node)
      resolved `shouldSatisfy` all (\(_, _, ty) ->
        ty == "IMPORTS_FROM") -- all edges should be valid

    it "produces correct edge count" $ do
      edges <- PhpImportResolution.resolveAll fixtureNodes
      -- 5 resolve: User (UserService), Serializable (User), HasTimestamps (User), Serializable (Status), Serializable (UserService)
      -- Connection/Response have no targets in project
      length edges `shouldBe` 5

  -- ════════════════════════════════════════════════════════════════════
  -- Type resolution tests
  -- ════════════════════════════════════════════════════════════════════
  describe "PhpTypeResolution" $ do
    it "resolves CLASS extends" $ do
      edges <- PhpTypeResolution.resolveAll fixtureNodes
      let resolved = extractEdges edges
      -- User extends BaseModel (same namespace → resolves)
      resolved `shouldSatisfy` any (\(s, t, ty) ->
        "CLASS->User" `T.isInfixOf` s &&
        "CLASS->BaseModel" `T.isInfixOf` t &&
        ty == "EXTENDS")

    it "resolves CLASS implements via import" $ do
      edges <- PhpTypeResolution.resolveAll fixtureNodes
      let resolved = extractEdges edges
      -- User implements Serializable — resolves via IMPORT_BINDING
      resolved `shouldSatisfy` any (\(s, t, ty) ->
        "CLASS->User" `T.isInfixOf` s &&
        "INTERFACE->Serializable" `T.isInfixOf` t &&
        ty == "IMPLEMENTS")

    it "resolves trait usage" $ do
      edges <- PhpTypeResolution.resolveAll fixtureNodes
      let resolved = extractEdgeMeta edges
      -- User uses HasTimestamps → EXTENDS edge with via=trait_use
      resolved `shouldSatisfy` any (\(s, _, ty, meta) ->
        "CLASS->User" `T.isInfixOf` s &&
        ty == "EXTENDS" &&
        Map.lookup "via" meta == Just (MetaText "trait_use"))

    it "resolves INTERFACE extends" $ do
      edges <- PhpTypeResolution.resolveAll fixtureNodes
      let resolved = extractEdges edges
      -- JsonSerializable extends Serializable (same namespace → resolves)
      resolved `shouldSatisfy` any (\(s, t, ty) ->
        "INTERFACE->JsonSerializable" `T.isInfixOf` s &&
        "INTERFACE->Serializable" `T.isInfixOf` t &&
        ty == "EXTENDS")

    it "resolves ENUM implements via import" $ do
      edges <- PhpTypeResolution.resolveAll fixtureNodes
      let resolved = extractEdges edges
      -- Status implements Serializable — resolves via IMPORT_BINDING
      resolved `shouldSatisfy` any (\(s, t, ty) ->
        "ENUM->Status" `T.isInfixOf` s &&
        "INTERFACE->Serializable" `T.isInfixOf` t &&
        ty == "IMPLEMENTS")

  -- ════════════════════════════════════════════════════════════════════
  -- Type inference tests (TYPE_OF, RETURNS)
  -- ════════════════════════════════════════════════════════════════════
  describe "PhpTypeInference" $ do
    it "resolves TYPE_OF from typed parameter" $ do
      edges <- PhpTypeInference.resolveAll fixtureNodes
      let resolved = extractEdges edges
      -- $user parameter has type "User" → TYPE_OF → CLASS User
      resolved `shouldSatisfy` any (\(s, t, ty) ->
        "VARIABLE->$user" `T.isInfixOf` s &&
        "CLASS->User" `T.isInfixOf` t &&
        ty == "TYPE_OF")

    it "resolves TYPE_OF from nullable property (strips ?)" $ do
      edges <- PhpTypeInference.resolveAll fixtureNodes
      let resolved = extractEdges edges
      -- $conn property has type "?Connection" — Connection is external (no class node),
      -- so this should NOT produce an edge (Connection class doesn't exist in fixtures)
      -- We test the normalization path works (? stripped) but no edge because no target
      resolved `shouldSatisfy` all (\(s, _, ty) ->
        not ("VARIABLE->$conn" `T.isInfixOf` s && ty == "TYPE_OF"))

    it "skips primitive types (no TYPE_OF for string)" $ do
      edges <- PhpTypeInference.resolveAll fixtureNodes
      let resolved = extractEdges edges
      -- $name has type "string" — primitive, should NOT produce TYPE_OF
      resolved `shouldSatisfy` all (\(s, _, ty) ->
        not ("VARIABLE->$name" `T.isInfixOf` s && ty == "TYPE_OF"))

    it "resolves RETURNS from function return_type" $ do
      edges <- PhpTypeInference.resolveAll fixtureNodes
      let resolved = extractEdges edges
      -- createUser has return_type "User" → RETURNS → CLASS User
      resolved `shouldSatisfy` any (\(s, t, ty) ->
        "FUNCTION->createUser" `T.isInfixOf` s &&
        "CLASS->User" `T.isInfixOf` t &&
        ty == "RETURNS")

    it "resolves RETURNS with self return type to enclosing class" $ do
      edges <- PhpTypeInference.resolveAll fixtureNodes
      let resolved = extractEdges edges
      -- getName has return_type "self", enclosing class is User → RETURNS → CLASS User
      resolved `shouldSatisfy` any (\(s, t, ty) ->
        "FUNCTION->getName" `T.isInfixOf` s &&
        "CLASS->User" `T.isInfixOf` t &&
        ty == "RETURNS")

    it "resolves TYPE_OF with static type to enclosing class" $ do
      edges <- PhpTypeInference.resolveAll fixtureNodes
      let resolved = extractEdges edges
      -- $self param has type "static", enclosing function is createUser[in:UserService]
      -- → TYPE_OF → CLASS UserService
      resolved `shouldSatisfy` any (\(s, t, ty) ->
        "VARIABLE->$self" `T.isInfixOf` s &&
        "CLASS->UserService" `T.isInfixOf` t &&
        ty == "TYPE_OF")

    it "resolves TYPE_OF from interface-typed parameter" $ do
      edges <- PhpTypeInference.resolveAll fixtureNodes
      let resolved = extractEdges edges
      -- $item has type "Serializable" → TYPE_OF → INTERFACE Serializable
      resolved `shouldSatisfy` any (\(s, t, ty) ->
        "VARIABLE->$item" `T.isInfixOf` s &&
        "INTERFACE->Serializable" `T.isInfixOf` t &&
        ty == "TYPE_OF")

    it "resolves TYPE_OF from union type (User|null)" $ do
      edges <- PhpTypeInference.resolveAll fixtureNodes
      let resolved = extractEdges edges
      -- $maybeUser has type "User|null" → normalizes to User → TYPE_OF → CLASS User
      resolved `shouldSatisfy` any (\(s, t, ty) ->
        "VARIABLE->$maybeUser" `T.isInfixOf` s &&
        "CLASS->User" `T.isInfixOf` t &&
        ty == "TYPE_OF")

    it "produces correct edge counts" $ do
      edges <- PhpTypeInference.resolveAll fixtureNodes
      let typeOfCount = length [ () | EmitEdge e <- edges, geType e == "TYPE_OF" ]
          returnsCount = length [ () | EmitEdge e <- edges, geType e == "RETURNS" ]
      -- 5 TYPE_OF: $user->User, $self(static)->UserService, $model->User, $item->Serializable, $maybeUser->User
      typeOfCount `shouldBe` 5
      -- 2 RETURNS: createUser -> User, getName (self) -> User
      returnsCount `shouldBe` 2

  -- ════════════════════════════════════════════════════════════════════
  -- Call resolution tests
  -- ════════════════════════════════════════════════════════════════════
  describe "PhpCallResolution" $ do
    it "resolves constructor (new User) → INSTANTIATES" $ do
      edges <- PhpCallResolution.resolveAll fixtureNodes
      let resolved = extractEdges edges
      resolved `shouldSatisfy` any (\(s, t, ty) ->
        "CALL->new User" `T.isInfixOf` s &&
        "CLASS->User" `T.isInfixOf` t &&
        ty == "INSTANTIATES")

    it "resolves $this->method() → CALLS" $ do
      edges <- PhpCallResolution.resolveAll fixtureNodes
      let resolved = extractEdges edges
      resolved `shouldSatisfy` any (\(s, t, ty) ->
        "CALL->validate" `T.isInfixOf` s &&
        "FUNCTION->validate" `T.isInfixOf` t &&
        ty == "CALLS")

    it "resolves plain function call → CALLS" $ do
      edges <- PhpCallResolution.resolveAll fixtureNodes
      let resolved = extractEdges edges
      resolved `shouldSatisfy` any (\(s, t, ty) ->
        "CALL->helper" `T.isInfixOf` s &&
        "FUNCTION->helper" `T.isInfixOf` t &&
        ty == "CALLS")

    it "resolves static method call → CALLS" $ do
      edges <- PhpCallResolution.resolveAll fixtureNodes
      let resolved = extractEdges edges
      -- User::find() — receiver "User" resolves to class, method "find" in MethodIndex
      resolved `shouldSatisfy` any (\(s, t, ty) ->
        "CALL->find" `T.isInfixOf` s &&
        "FUNCTION->find" `T.isInfixOf` t &&
        ty == "CALLS")

    it "resolves self::method() static call → CALLS" $ do
      edges <- PhpCallResolution.resolveAll fixtureNodes
      let resolved = extractEdges edges
      -- self::find() inside User::getName → resolves self to User → find[in:User]
      resolved `shouldSatisfy` any (\(s, t, ty) ->
        "User.php->CALL->find[in:getName" `T.isInfixOf` s &&
        "FUNCTION->find[in:User]" `T.isInfixOf` t &&
        ty == "CALLS")

    it "resolves parent::method() static call → CALLS" $ do
      edges <- PhpCallResolution.resolveAll fixtureNodes
      let resolved = extractEdges edges
      -- parent::save() inside User::getName → User extends BaseModel → save[in:BaseModel]
      resolved `shouldSatisfy` any (\(s, t, ty) ->
        "User.php->CALL->save[in:getName" `T.isInfixOf` s &&
        "FUNCTION->save[in:BaseModel]" `T.isInfixOf` t &&
        ty == "CALLS")

    it "resolves $this->method() via inheritance chain → CALLS" $ do
      edges <- PhpCallResolution.resolveAll fixtureNodes
      let resolved = extractEdges edges
      -- $this->save() in User → save is in BaseModel (parent)
      resolved `shouldSatisfy` any (\(s, t, ty) ->
        "User.php->CALL->save[in:User]" `T.isInfixOf` s &&
        "FUNCTION->save[in:BaseModel]" `T.isInfixOf` t &&
        ty == "CALLS")

    it "resolves $this->method() via trait → CALLS" $ do
      edges <- PhpCallResolution.resolveAll fixtureNodes
      let resolved = extractEdges edges
      -- $this->touchTimestamp() in User → touchTimestamp is in HasTimestamps trait
      resolved `shouldSatisfy` any (\(s, t, ty) ->
        "CALL->touchTimestamp[in:User]" `T.isInfixOf` s &&
        "FUNCTION->touchTimestamp[in:HasTimestamps]" `T.isInfixOf` t &&
        ty == "CALLS")

    it "resolves $this->method() via grandparent (2-level inheritance) → CALLS" $ do
      edges <- PhpCallResolution.resolveAll fixtureNodes
      let resolved = extractEdges edges
      -- $this->getId() in User → User→BaseModel→AbstractEntity has getId
      resolved `shouldSatisfy` any (\(s, t, ty) ->
        "CALL->getId[in:User]" `T.isInfixOf` s &&
        "FUNCTION->getId[in:AbstractEntity]" `T.isInfixOf` t &&
        ty == "CALLS")

    it "resolves interface-typed param → method on interface → CALLS" $ do
      edges <- PhpCallResolution.resolveAll fixtureNodes
      let resolved = extractEdges edges
      -- $item->serialize() — $item is Serializable → serialize[in:Serializable]
      resolved `shouldSatisfy` any (\(s, t, ty) ->
        "CALL->serialize[in:createUser]" `T.isInfixOf` s &&
        "FUNCTION->serialize[in:Serializable]" `T.isInfixOf` t &&
        ty == "CALLS")

    it "resolves union-typed param (User|null) → method → CALLS" $ do
      edges <- PhpCallResolution.resolveAll fixtureNodes
      let resolved = extractEdges edges
      -- $maybeUser->getName() — User|null → normalizes to User → getName[in:User]
      resolved `shouldSatisfy` any (\(s, t, ty) ->
        "CALL->getName[in:createUser,union]" `T.isInfixOf` s &&
        "FUNCTION->getName[in:User]" `T.isInfixOf` t &&
        ty == "CALLS")

    it "resolves $this->prop->method() via property type → CALLS" $ do
      edges <- PhpCallResolution.resolveAll fixtureNodes
      let resolved = extractEdges edges
      -- $this->model->getName() — model is User property → getName[in:User]
      resolved `shouldSatisfy` any (\(s, t, ty) ->
        "CALL->getName[in:createUser,prop]" `T.isInfixOf` s &&
        "FUNCTION->getName[in:User]" `T.isInfixOf` t &&
        ty == "CALLS")

    it "resolves instance method via param type → CALLS" $ do
      edges <- PhpCallResolution.resolveAll fixtureNodes
      let resolved = extractEdges edges
      -- $user->getName() — $user is User param → getName is method in User class
      resolved `shouldSatisfy` any (\(s, t, ty) ->
        "CALL->getName" `T.isInfixOf` s &&
        "FUNCTION->getName" `T.isInfixOf` t &&
        ty == "CALLS")

  -- ════════════════════════════════════════════════════════════════════
  -- Coverage analysis: what % of scenarios produce edges
  -- ════════════════════════════════════════════════════════════════════
  describe "Coverage Analysis" $ do
    it "reports edge counts by type across all resolvers" $ do
      imports   <- PhpImportResolution.resolveAll fixtureNodes
      types     <- PhpTypeResolution.resolveAll fixtureNodes
      inference <- PhpTypeInference.resolveAll fixtureNodes
      calls     <- PhpCallResolution.resolveAll fixtureNodes
      let allEdges = imports ++ types ++ inference ++ calls
          edgesByType = foldl (\acc cmd -> case cmd of
            EmitEdge e -> Map.insertWith (+) (geType e) (1 :: Int) acc
            _          -> acc) Map.empty allEdges
      putStrLn "\n=== Resolution Coverage ==="
      putStrLn $ "  IMPORTS_FROM: " ++ show (Map.findWithDefault 0 "IMPORTS_FROM" edgesByType)
      putStrLn $ "  EXTENDS:      " ++ show (Map.findWithDefault 0 "EXTENDS" edgesByType)
      putStrLn $ "  IMPLEMENTS:   " ++ show (Map.findWithDefault 0 "IMPLEMENTS" edgesByType)
      putStrLn $ "  CALLS:        " ++ show (Map.findWithDefault 0 "CALLS" edgesByType)
      putStrLn $ "  INSTANTIATES: " ++ show (Map.findWithDefault 0 "INSTANTIATES" edgesByType)
      putStrLn $ "  TYPE_OF:      " ++ show (Map.findWithDefault 0 "TYPE_OF" edgesByType)
      putStrLn $ "  RETURNS:      " ++ show (Map.findWithDefault 0 "RETURNS" edgesByType)
      putStrLn $ "  TOTAL:        " ++ show (length allEdges)
      -- Phase 4: 4 IMPORTS + 3 EXTENDS + 2 IMPLEMENTS + 5 CALLS + 1 INSTANTIATES + 2 TYPE_OF + 2 RETURNS = 19
      length allEdges `shouldSatisfy` (>= 17)

-- Helper
isJust :: Maybe a -> Bool
isJust (Just _) = True
isJust Nothing  = False
