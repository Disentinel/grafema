/-
  Grafema Lean Analyzer — test fixture.
  Exercises every node type and edge type the extractor detects.
  Self-contained: no Mathlib dependency, only Lean 4 stdlib.
-/
import Init

/-! ## Nested namespaces -/

namespace Grafema.Test

/-! ## Universe-polymorphic class -/

universe u

/-- A minimal algebraic class for testing CLASS node + universe polymorphism. -/
class Monoid (α : Type u) where
  e : α
  op : α → α → α

/-! ## Instance (INSTANCE node + INSTANCE_OF edge) -/

instance natMonoid : Monoid Nat where
  e := 0
  op := Nat.add

/-! ## Structure extending another (EXTENDS edge) -/

structure Point where
  x : Nat
  y : Nat
  deriving Repr

structure Point3D extends Point where
  z : Nat
  deriving Repr

/-! ## Inductive with constructors (INDUCTIVE + CONSTRUCTOR + HAS_CONSTRUCTOR) -/

inductive Color where
  | red
  | green
  | blue
  deriving Repr, DecidableEq

/-! ## Definition (DEFINITION node + VALUE_USES edges) -/

def origin : Point3D :=
  { x := 0, y := 0, z := 0 }

def colorToNat (c : Color) : Nat :=
  match c with
  | .red   => 0
  | .green => 1
  | .blue  => 2

/-! ## Theorem with proof (THEOREM node + PROOF_USES edges) -/

theorem colorToNat_lt (c : Color) : colorToNat c < 3 := by
  cases c <;> simp [colorToNat]

/-! ## @[simp] lemma -/

@[simp]
theorem monoid_op_zero_left (n : Nat) : Monoid.op (α := Nat) 0 n = n := by
  simp [Monoid.op, natMonoid]

/-! ## @[ext] lemma -/

@[ext]
theorem Point.ext_iff (p q : Point) (hx : p.x = q.x) (hy : p.y = q.y) : p = q := by
  cases p; cases q; simp_all

/-! ## Another definition using universe polymorphism -/

def Monoid.fold {α : Type u} [Monoid α] (xs : List α) : α :=
  xs.foldl Monoid.op Monoid.e

/-! ## A second class extending the first (EXTENDS edge from class to class) -/

class CommMonoid (α : Type u) extends Monoid α where
  comm : ∀ (a b : α), op a b = op b a

end Grafema.Test
