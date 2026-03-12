module Main where

import Test.Hspec

main :: IO ()
main = hspec $ do
  describe "cpp-analyzer" $ do
    it "placeholder" $ do
      True `shouldBe` True
