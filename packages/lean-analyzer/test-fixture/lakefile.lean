import Lake
open Lake DSL

package testFixture where
  leanOptions := #[⟨`autoImplicit, false⟩]

@[default_target]
lean_lib TestFixture where
  srcDir := "."
