-- | Source location extraction from GHC AST nodes.
--
-- Wraps ghc-lib-parser's SrcSpan\/Located types to provide a clean
-- interface for the analyzer. GHC uses 1-based lines and 1-based columns;
-- this module converts columns to 0-based to match Grafema convention
-- (1-based lines, 0-based columns).
--
-- All functions return full spans (startLine, startCol, endLine, endCol).
module Loc
  ( getLoc       -- :: GenLocated SrcSpanAnnA a -> (Int, Int, Int, Int)
  , getLocN      -- :: GenLocated SrcSpanAnnN a -> (Int, Int, Int, Int)
  , getSrcSpan   -- :: SrcSpan -> Maybe (Int, Int, Int, Int)
  ) where

import GHC.Types.SrcLoc
  ( SrcSpan(..)
  , RealSrcSpan
  , GenLocated(..)
  , srcSpanStartLine
  , srcSpanStartCol
  , srcSpanEndLine
  , srcSpanEndCol
  )
import GHC.Parser.Annotation (SrcSpanAnnA, SrcSpanAnnN, locA)

-- | Extract full span (startLine, startCol, endLine, endCol) from a located
-- AST node annotated with 'SrcSpanAnnA' (most AST nodes).
-- Lines are 1-based, columns are 0-based (converted from GHC's 1-based).
-- Returns (0, 0, 0, 0) for nodes with no real source location.
getLoc :: GenLocated SrcSpanAnnA a -> (Int, Int, Int, Int)
getLoc (L ann _) =
  case locA ann of
    RealSrcSpan rss _ -> fromReal rss
    UnhelpfulSpan _   -> (0, 0, 0, 0)

-- | Extract full span (startLine, startCol, endLine, endCol) from a located
-- AST node annotated with 'SrcSpanAnnN' (identifiers: function names, variable names).
-- Lines are 1-based, columns are 0-based (converted from GHC's 1-based).
-- Returns (0, 0, 0, 0) for nodes with no real source location.
getLocN :: GenLocated SrcSpanAnnN a -> (Int, Int, Int, Int)
getLocN (L ann _) =
  case locA ann of
    RealSrcSpan rss _ -> fromReal rss
    UnhelpfulSpan _   -> (0, 0, 0, 0)

-- | Extract full span from a raw SrcSpan.
-- Returns Nothing for UnhelpfulSpan.
getSrcSpan :: SrcSpan -> Maybe (Int, Int, Int, Int)
getSrcSpan (RealSrcSpan rss _) = Just (fromReal rss)
getSrcSpan (UnhelpfulSpan _)   = Nothing

-- | Convert a RealSrcSpan to (startLine, startCol, endLine, endCol) with 0-based columns.
fromReal :: RealSrcSpan -> (Int, Int, Int, Int)
fromReal rss =
  ( srcSpanStartLine rss
  , srcSpanStartCol rss - 1
  , srcSpanEndLine rss
  , srcSpanEndCol rss - 1
  )
