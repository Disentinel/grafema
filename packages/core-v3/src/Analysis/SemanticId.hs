{-# LANGUAGE OverloadedStrings #-}
-- Semantic ID v2: file->TYPE->name[in:parent,h:xxxx]
module Analysis.SemanticId
  ( semanticId
  , contentHash
  , makeModuleId
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import Data.Bits (xor, (.&.), shiftR)
import Data.Char (intToDigit)
import Data.Word (Word32)

-- | Generate a v2 semantic ID.
--
-- Format:
--   file->TYPE->name                          unique in scope
--   file->TYPE->name[in:parent]               nested, unique
--   file->TYPE->name[in:parent,h:xxxx]        disambiguated by content hash
semanticId :: Text -> Text -> Text -> Maybe Text -> Maybe Text -> Text
semanticId file nodeType name mbParent mbHash =
  let base = file <> "->" <> nodeType <> "->" <> name
      brackets = case (mbParent, mbHash) of
        (Nothing, Nothing) -> ""
        (Just p, Nothing)  -> "[in:" <> p <> "]"
        (Nothing, Just h)  -> "[h:" <> h <> "]"
        (Just p, Just h)   -> "[in:" <> p <> ",h:" <> h <> "]"
  in base <> brackets

-- | FNV-1a 16-bit content hash → 4 hex chars.
-- Input: list of (key, value) pairs, joined as "k:v|k:v|...".
contentHash :: [(Text, Text)] -> Text
contentHash hints =
  let input = T.intercalate "|" [ k <> ":" <> v | (k, v) <- hints ]
      hash32 = fnv1a input
      truncated = hash32 .&. 0xffff
  in hexPad4 truncated

-- | Module ID (unchanged format: MODULE#file).
makeModuleId :: Text -> Text
makeModuleId file = "MODULE#" <> file

-- ── Internal ──────────────────────────────────────────────────────────────

-- | FNV-1a 32-bit hash.
fnv1a :: Text -> Word32
fnv1a = T.foldl' step 0x811c9dc5
  where
    step :: Word32 -> Char -> Word32
    step h c = (h `xor` fromIntegral (fromEnum c)) * 0x01000193

-- | Format lower 16 bits of Word32 as 4 hex characters (zero-padded).
hexPad4 :: Word32 -> Text
hexPad4 w = T.pack
  [ intToDigit (fromIntegral (shiftR w 12 .&. 0xf))
  , intToDigit (fromIntegral (shiftR w 8 .&. 0xf))
  , intToDigit (fromIntegral (shiftR w 4 .&. 0xf))
  , intToDigit (fromIntegral (w .&. 0xf))
  ]
