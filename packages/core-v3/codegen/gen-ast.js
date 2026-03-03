#!/usr/bin/env node
/**
 * AST codegen: reads @oxc-project/types .d.ts → generates Haskell modules:
 *   - AST/Types.hs   (ASTNode sum type with one constructor per ESTree type)
 *   - AST/Decode.hs  (FromJSON instance dispatching on "type" field)
 *   - AST/Span.hs    (Span type)
 *
 * Each ASTNode constructor carries: Span + raw aeson Object for field access.
 * This gives us exhaustiveness checking via -Wall while keeping field access flexible.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, '..', 'src', 'AST');
mkdirSync(outDir, { recursive: true });

// ── Parse .d.ts ──────────────────────────────────────────────────────────

function parseOxcTypes() {
  // Find the types file - try multiple locations
  const candidates = [
    resolve(__dirname, '..', 'node_modules', '@oxc-project', 'types', 'types.d.ts'),
    resolve(__dirname, '..', '..', '..', 'node_modules', '.pnpm', '@oxc-project+types@0.96.0',
      'node_modules', '@oxc-project', 'types', 'types.d.ts'),
  ];

  let src;
  for (const p of candidates) {
    try { src = readFileSync(p, 'utf8'); break; } catch { /* next */ }
  }
  if (!src) throw new Error('Cannot find @oxc-project/types/types.d.ts');

  const lines = src.split('\n');

  // ── Pass 1: collect type aliases (for resolving type: FunctionType etc.) ──
  const typeAliases = new Map();
  let collecting = null;
  for (const line of lines) {
    // Single-line: export type Foo = 'A' | 'B';
    const tm = line.match(/^export\s+type\s+(\w+)\s*=\s*(.+);$/);
    if (tm && !tm[2].includes('{')) {
      const literals = tm[2].split('|').map(s => s.trim())
        .map(p => p.match(/^'([^']+)'$/)).filter(Boolean).map(m => m[1]);
      if (literals.length > 0) typeAliases.set(tm[1], literals);
      continue;
    }
    // Multi-line start: export type Foo =
    const tm2 = line.match(/^export\s+type\s+(\w+)\s*=\s*$/);
    if (tm2) { collecting = { name: tm2[1], members: [] }; continue; }
    if (collecting) {
      const um = line.match(/^\s+\|?\s*'([^']+)'/);
      if (um) collecting.members.push(um[1]);
      if (line.match(/;\s*$/)) {
        if (collecting.members.length > 0) typeAliases.set(collecting.name, collecting.members);
        collecting = null;
      }
    }
  }

  // ── Pass 2: parse interfaces ──
  const interfaces = [];
  let cur = null;
  let depth = 0;

  for (const line of lines) {
    const m = line.match(/^export\s+interface\s+(\w+)(?:\s+extends\s+([\w,\s]+))?\s*\{/);
    if (m) {
      cur = { name: m[1], extends: m[2]?.trim() || null, fields: [], discriminator: null };
      depth = 1;
      continue;
    }
    if (cur) {
      for (const ch of line) {
        if (ch === '{') depth++;
        if (ch === '}') depth--;
      }
      if (depth <= 0) { interfaces.push(cur); cur = null; continue; }
      const fm = line.match(/^\s+(\w+)(\??):\s*(.+?);?\s*$/);
      if (fm) {
        const f = { name: fm[1], optional: fm[2] === '?', type: fm[3].replace(/;$/, '').trim() };
        if (f.name === 'type') {
          const dm = f.type.match(/^'([^']+)'$/);
          if (dm) {
            cur.discriminator = dm[1];
          } else {
            // Try inline union: type: 'Foo' | 'Bar'
            const parts = f.type.split('|').map(s => s.trim());
            const literals = parts.map(p => p.match(/^'([^']+)'$/)).filter(Boolean).map(m => m[1]);
            if (literals.length > 0) {
              cur.discriminator = literals;
            } else {
              // Try resolving type alias: type: FunctionType → ['FunctionDeclaration', 'FunctionExpression']
              const aliasName = f.type.trim();
              if (typeAliases.has(aliasName)) {
                cur.discriminator = typeAliases.get(aliasName);
              }
            }
          }
        }
        if (f.name !== 'parent') cur.fields.push(f);
      }
    }
  }
  if (cur) interfaces.push(cur);

  // Flatten: each unique discriminator string → interface fields
  const byDisc = new Map();
  for (const iface of interfaces) {
    if (!iface.discriminator) continue;
    const discs = Array.isArray(iface.discriminator)
      ? iface.discriminator
      : [iface.discriminator];
    for (const d of discs) {
      if (!byDisc.has(d)) byDisc.set(d, iface);
    }
  }

  return { byDisc, interfaces };
}

// ── Generate Haskell constructor name from ESTree type string ────────────

function toConstructor(disc) {
  // "CallExpression" → "CallExpression'"  (avoid clashing with Haskell keywords)
  // Actually just use the discriminator directly — they're already PascalCase
  // and don't clash with Haskell keywords
  return disc + 'Node';
}

// ── Generate AST/Types.hs ───────────────────────────────────────────────

function genTypes(byDisc) {
  const discs = [...byDisc.keys()].sort();
  const constructors = discs.map((d, i) =>
    `    ${i === 0 ? '=' : '|'} ${toConstructor(d)} !Span !Object`
  );
  const cases = discs.map(d =>
    `      "${d}" -> pure (${toConstructor(d)} sp obj)`
  );

  return `{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE StrictData #-}
-- AUTO-GENERATED by codegen/gen-ast.js — DO NOT EDIT
-- Source: @oxc-project/types@0.96.0
module AST.Types
  ( ASTNode(..)
  , astNodeType
  , astNodeSpan
  , astNodeFields
  , getField
  , getFieldMaybe
  , getChildren
  , getChildrenMaybe
  , getTextFieldOr
  , getBoolFieldOr
  ) where

import Data.Aeson (FromJSON(..), Value(..), Object, withObject, (.:))
import Data.Aeson.Types (Parser, parseMaybe)
import Data.Text (Text)
import qualified Data.Aeson.KeyMap as KM
import qualified Data.Aeson.Key as K
import qualified Data.Vector as V
import AST.Span (Span(..))

-- | One constructor per ESTree node type (${discs.length} total).
-- Each carries the byte-offset Span and the raw JSON Object for field access.
data ASTNode
${constructors.join('\n')}
    | UnknownNode !Text !Span !Object   -- ^ Fallback for unrecognized types
    deriving (Show)

-- | Extract the ESTree type string from a node.
astNodeType :: ASTNode -> Text
${discs.map(d => `astNodeType (${toConstructor(d)} _ _) = "${d}"`).join('\n')}
astNodeType (UnknownNode t _ _) = t

-- | Extract the Span from a node.
astNodeSpan :: ASTNode -> Span
${discs.map(d => `astNodeSpan (${toConstructor(d)} s _) = s`).join('\n')}
astNodeSpan (UnknownNode _ s _) = s

-- | Extract the raw JSON Object from a node.
astNodeFields :: ASTNode -> Object
${discs.map(d => `astNodeFields (${toConstructor(d)} _ o) = o`).join('\n')}
astNodeFields (UnknownNode _ _ o) = o

-- | Get a typed field from the raw Object. Returns Nothing on missing/wrong type.
getField :: FromJSON a => Text -> ASTNode -> Maybe a
getField key node =
  let obj = astNodeFields node
  in case KM.lookup (K.fromText key) obj of
       Nothing -> Nothing
       Just v  -> parseMaybe parseJSON v

-- | Get a field that may be null.
getFieldMaybe :: FromJSON a => Text -> ASTNode -> Maybe (Maybe a)
getFieldMaybe key node =
  let obj = astNodeFields node
  in case KM.lookup (K.fromText key) obj of
       Nothing   -> Nothing
       Just Null -> Just Nothing
       Just v    -> Just <$> parseMaybe parseJSON v

-- | Get child nodes from an array field.
getChildren :: Text -> ASTNode -> [ASTNode]
getChildren key node =
  case KM.lookup (K.fromText key) (astNodeFields node) of
    Just (Array arr) ->
      [ child | v <- V.toList arr
      , Just child <- [parseMaybe parseJSON v]
      ]
    _ -> []

-- | Get child nodes from a field that can be a single node or null.
getChildrenMaybe :: Text -> ASTNode -> Maybe ASTNode
getChildrenMaybe key node =
  case KM.lookup (K.fromText key) (astNodeFields node) of
    Just Null -> Nothing
    Just v    -> parseMaybe parseJSON v
    Nothing   -> Nothing

-- | Get a text field with a default.
getTextFieldOr :: Text -> Text -> ASTNode -> Text
getTextFieldOr key def node = maybe def id (getField key node)

-- | Get a boolean field with a default.
getBoolFieldOr :: Text -> Bool -> ASTNode -> Bool
getBoolFieldOr key def node = maybe def id (getField key node)

-- ── FromJSON instance ───────────────────────────────────────────────────

instance FromJSON ASTNode where
  parseJSON = withObject "ASTNode" $ \\obj -> do
    typ <- obj .: "type" :: Parser Text
    st  <- obj .: "start" :: Parser Int
    en  <- obj .: "end"   :: Parser Int
    let sp = Span st en
    case typ of
${cases.join('\n')}
      other -> pure (UnknownNode other sp obj)
`;
}

// ── Generate AST/Decode.hs ──────────────────────────────────────────────
// FromJSON instance is now in Types.hs to avoid circular dependency.
// Decode.hs is kept as a stub for cabal module list compatibility.

function genDecode(_byDisc) {
  return `-- AUTO-GENERATED by codegen/gen-ast.js — DO NOT EDIT
-- FromJSON instance lives in AST.Types to avoid circular dependency.
-- This module is kept for backward compatibility.
module AST.Decode (module AST.Types) where

import AST.Types
`;
}

// ── Generate AST/Span.hs ───────────────────────────────────────────────

function genSpan() {
  return `{-# LANGUAGE DeriveGeneric #-}
{-# LANGUAGE StrictData #-}
-- AUTO-GENERATED by codegen/gen-ast.js — DO NOT EDIT
module AST.Span
  ( Span(..)
  , SourceLoc(..)
  , byteOffsetToLoc
  , buildLineIndex
  ) where

import GHC.Generics (Generic)
import qualified Data.ByteString as BS
import Data.Word (Word8)

-- | Byte-offset span from OXC parser.
data Span = Span
  { spanStart :: !Int
  , spanEnd   :: !Int
  } deriving (Show, Eq, Generic)

-- | 1-based line, 0-based column.
data SourceLoc = SourceLoc
  { locLine   :: !Int  -- ^ 1-based
  , locColumn :: !Int  -- ^ 0-based
  } deriving (Show, Eq)

-- | Precomputed index: byte offset of each line start.
-- Index ! 0 = 0 (line 1 starts at byte 0).
type LineIndex = [Int]

-- | Scan source bytes for newline positions. O(n) in source length.
buildLineIndex :: BS.ByteString -> LineIndex
buildLineIndex src = 0 : go 0 (BS.unpack src)
  where
    nl :: Word8
    nl = 0x0A  -- '\\n'
    go _ []     = []
    go i (b:bs)
      | b == nl   = (i + 1) : go (i + 1) bs
      | otherwise  = go (i + 1) bs

-- | Convert a byte offset to line:column using a precomputed LineIndex.
-- Binary search for the line, then column = offset - lineStart.
byteOffsetToLoc :: LineIndex -> Int -> SourceLoc
byteOffsetToLoc idx offset = go 1 idx
  where
    go lineNum []     = SourceLoc lineNum offset
    go lineNum [s]    = SourceLoc lineNum (offset - s)
    go lineNum (s:rest@(next:_))
      | offset < next = SourceLoc lineNum (offset - s)
      | otherwise     = go (lineNum + 1) rest
`;
}

// ── Main ────────────────────────────────────────────────────────────────

const { byDisc } = parseOxcTypes();
console.log(`Parsed ${byDisc.size} unique ESTree node types`);

writeFileSync(resolve(outDir, 'Types.hs'), genTypes(byDisc));
writeFileSync(resolve(outDir, 'Decode.hs'), genDecode(byDisc));
writeFileSync(resolve(outDir, 'Span.hs'), genSpan());

console.log('Generated:');
console.log('  src/AST/Types.hs');
console.log('  src/AST/Decode.hs');
console.log('  src/AST/Span.hs');
