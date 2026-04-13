{-# LANGUAGE OverloadedStrings #-}
-- | BEAM message-pattern shape parser + unification (REG-1098 W9).
--
-- The beam-analyzer emits @pattern_shape@ / @message_shape@ metadata on
-- MESSAGE_TYPE nodes and SENDS_TO / BROADCASTS_TO edges in a compact
-- nested-list form produced by @BeamAnalyzer.Rules.Patterns.shape_to_meta/1@:
--
-- > ["atom", "pay"]                           -- atom literal
-- > ["str", "hello"]                          -- string literal
-- > ["number"]                                -- any number
-- > ["wildcard"]                              -- `_` / bare variable
-- > ["unknown"]                               -- unsupported expression
-- > ["tuple", [<shape>, ...]]
-- > ["list",  [<shape>, ...]]
-- > ["cons",  <head>, <tail>]
-- > ["map",   [[<keyText>, <shape>], ...]]
-- > ["struct", "ModuleName", [[<keyText>, <shape>], ...]]
--
-- This module parses that tree into a typed 'Shape' and implements the
-- same 'unify' semantics as the Elixir reference implementation at
-- @packages/beam-analyzer/lib/beam_analyzer/rules/patterns.ex@.
module BeamShape
  ( Shape(..)
  , parseShape
  , unify
  , compatMap
  , topLevelMaps
  , topLevelMapKV
  ) where

import Data.Text (Text)
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set

import Grafema.Types (MetaValue(..))

-- | Typed view of a message / pattern shape. See module header for the
-- serialized form.
data Shape
  = SAny                            -- ^ @["wildcard"]@
  | SUnknown                        -- ^ @["unknown"]@
  | SNumber                         -- ^ @["number"]@
  | SAtom !Text
  | SStr  !Text
  | STuple ![Shape]
  | SList  ![Shape]
  | SCons !Shape !Shape
  | SMap    ![(Text, Shape)]
  | SStruct !Text ![(Text, Shape)]
  deriving (Eq, Show)

-- | Parse a shape tree out of a 'MetaValue'. Returns 'SUnknown' on any
-- malformed subtree; this matches the Elixir side which also treats
-- unrecognised shapes as opaque.
parseShape :: MetaValue -> Shape
parseShape (MetaList [MetaText "wildcard"]) = SAny
parseShape (MetaList [MetaText "unknown"])  = SUnknown
parseShape (MetaList [MetaText "number"])   = SNumber
parseShape (MetaList [MetaText "atom",  MetaText a]) = SAtom a
parseShape (MetaList [MetaText "str",   MetaText s]) = SStr  s
parseShape (MetaList [MetaText "tuple", MetaList es]) = STuple (map parseShape es)
parseShape (MetaList [MetaText "list",  MetaList es]) = SList  (map parseShape es)
parseShape (MetaList [MetaText "cons",  h, t])        = SCons (parseShape h) (parseShape t)
parseShape (MetaList [MetaText "map",   MetaList pairs]) = SMap (map parsePair pairs)
parseShape (MetaList [MetaText "struct", MetaText m, MetaList pairs]) =
  SStruct m (map parsePair pairs)
parseShape _ = SUnknown

parsePair :: MetaValue -> (Text, Shape)
parsePair (MetaList [MetaText k, v]) = (k, parseShape v)
parsePair _ = ("", SUnknown)

-- | Structural unification. Mirrors
-- @BeamAnalyzer.Rules.Patterns.unify?/2@ from the Elixir side:
-- 'SAny' / 'SUnknown' unify with anything, atoms / strings must match
-- exactly, tuples and lists compare element-wise, cons and list are
-- considered compatible (since a list literal matches a cons pattern),
-- maps and structs unify on their intersection of keys.
unify :: Shape -> Shape -> Bool
unify SAny _ = True
unify _ SAny = True
unify SUnknown _ = True
unify _ SUnknown = True
unify (SAtom a) (SAtom b) = a == b
unify (SStr a)  (SStr b)  = a == b
unify SNumber SNumber = True
unify (STuple a) (STuple b)
  | length a == length b = and (zipWith unify a b)
  | otherwise            = False
unify (SList a) (SList b)
  | length a == length b = and (zipWith unify a b)
  | otherwise            = False
unify (SCons h1 t1) (SCons h2 t2) = unify h1 h2 && unify t1 t2
unify (SList _)     (SCons _ _)   = True
unify (SCons _ _)   (SList _)     = True
unify (SMap a)      (SMap b)      = compatMap a b
unify (SStruct m a) (SStruct n b) = m == n && compatMap a b
unify (SStruct _ _) (SMap _)      = True
unify (SMap _)      (SStruct _ _) = True
unify _ _ = False

-- | True iff two map shapes agree on every common key.
compatMap :: [(Text, Shape)] -> [(Text, Shape)] -> Bool
compatMap a b =
  let ma = Map.fromList a
      mb = Map.fromList b
      common = Set.intersection (Map.keysSet ma) (Map.keysSet mb)
  in all (\k -> unify (ma Map.! k) (mb Map.! k)) (Set.toList common)

-- | Collect all top-level maps/structs reachable by descending into
-- outer tuples. Used by the @heterogeneous_key_type@ finding to locate
-- the inner @%{...}@ of a pattern like @{:event, %{type: ...}}@.
topLevelMaps :: Shape -> [[(Text, Shape)]]
topLevelMaps (SMap kvs)      = [kvs]
topLevelMaps (SStruct _ kvs) = [kvs]
topLevelMaps (STuple xs)     = concatMap topLevelMaps xs
topLevelMaps _               = []

-- | Shorthand: all @(key, shape)@ pairs from any top-level map in a
-- shape (tuple-wrapped or not).
topLevelMapKV :: Shape -> [(Text, Shape)]
topLevelMapKV = concat . topLevelMaps
