//! Layer 0 — tag algebra (`Sealed`, `Tag`, `InvertibleTag`, `IdempotentTag`, `BoolTag`).
//!
//! Defines the sealed tag trait hierarchy that parameterizes the semi-naive
//! executor. `BoolTag` (set semantics, Gate A) plus the Gate C semirings
//! `CountTag` (i64, ×/+), `ConfTag` (u32 neg-log, saturating-+/min tropical), and
//! `Product<A, B>` (componentwise) — the spec §6 table. Invariants enforced here:
//! I4 (recursion is gated on `IdempotentTag` so non-idempotent tags such as
//! `CountTag` cannot appear in a recursive stratum — enforced by construction:
//! `CountTag` simply does NOT implement `IdempotentTag`, so the recursive executor
//! `Executor<T: IdempotentTag>` rejects it at compile time) and I6 (the tag trait is
//! sealed — no out-of-crate implementations).
//!
//! A tag is the *provenance weight* carried by a derived fact. The executor folds
//! tags with the semiring operations: `⊗` (`times`) combines the body tags of a
//! single derivation, `⊕` (`plus`) combines weights of independent derivations of
//! the same fact. `one()` is the multiplicative identity (a fact derived with no
//! body weight) and `zero()` is the additive identity (the absent fact). For the
//! semiring to drive sound semantics, `⊕` MUST be commutative, associative, and
//! exact; `⊗` MUST distribute over `⊕` with `one`/`zero` as the respective
//! identities. These laws are property-checked for `BoolTag` below.

/// Sealing trait (I6): only types defined in this crate may implement [`Tag`].
///
/// `Tag` requires `Sealed` as a supertrait, and `Sealed` is itself only
/// implementable from within `derive`, so the set of tags is closed. Adding a
/// new tag is a deliberate in-crate extension (spec I16 extension slot), never an
/// out-of-crate `impl`.
pub(crate) trait Sealed {}

/// A lawful semiring of provenance weights (spec §6).
///
/// `⊕` (`plus`) is commutative, associative, and exact with identity `zero()`;
/// `⊗` (`times`) is associative with identity `one()` and distributes over `⊕`.
/// Sealed via [`Sealed`] (I6). `Clone + Send + Sync` so weights can be carried
/// across the fixpoint's parallel join/fold workers.
pub trait Tag: Sealed + Clone + Send + Sync {
    /// Multiplicative identity: the weight of a derivation with no body
    /// contribution (`x ⊗ one() == x`).
    fn one() -> Self;

    /// Additive identity: the weight of the absent fact (`x ⊕ zero() == x`).
    fn zero() -> Self;

    /// `⊗` — combine the body weights of a single derivation. Associative with
    /// identity [`one`](Tag::one).
    fn times(&self, o: &Self) -> Self;

    /// `⊕` — combine the weights of independent derivations of the same fact.
    /// Commutative, associative, and EXACT, with identity [`zero`](Tag::zero).
    fn plus(&self, o: &Self) -> Self;
}

/// A tag that supports subtraction of weights (set-difference / negation,
/// incremental retraction). `a.plus(&b).minus(&b) == a` for weights produced by
/// the run.
pub trait InvertibleTag: Tag {
    /// `⊖` — remove the contribution `o` from `self`.
    fn minus(&self, o: &Self) -> Self;
}

/// In-crate marker for tags whose `⊕` is idempotent (`x ⊕ x == x`).
///
/// I4: recursion is gated on this marker. A predicate in a recursive stratum may
/// only carry an `IdempotentTag`, which guarantees the semi-naive fixpoint
/// reaches a finite least fixed point (non-idempotent tags such as `CountTag`
/// could grow without bound under recursion and so must not compile there).
pub trait IdempotentTag: Tag {}

/// The Boolean (set) semiring — the only tag for Gate A (spec §6 table).
///
/// Carrier is the unit type `()`: a fact is either present in the relation or
/// absent. Presence corresponds to the weight `one()`; the absent fact has weight
/// `zero()`. Because the carrier has a single inhabitant, both `⊗` and `⊕` are the
/// trivial constant on `()` (marked `—` in the spec table). `⊕` is idempotent
/// (set union), and the tag is invertible via set difference (`minus`), which
/// drives stratified negation. Distinct from `Count`/`Conf`/`Product`, which are
/// Gate C.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BoolTag(());

impl BoolTag {
    /// Construct the single inhabitant of the Boolean tag (a present fact).
    #[inline]
    pub const fn present() -> Self {
        BoolTag(())
    }
}

impl Sealed for BoolTag {}

impl Tag for BoolTag {
    #[inline]
    fn one() -> Self {
        BoolTag(())
    }

    #[inline]
    fn zero() -> Self {
        BoolTag(())
    }

    #[inline]
    fn times(&self, _o: &Self) -> Self {
        BoolTag(())
    }

    #[inline]
    fn plus(&self, _o: &Self) -> Self {
        BoolTag(())
    }
}

impl IdempotentTag for BoolTag {}

impl InvertibleTag for BoolTag {
    #[inline]
    fn minus(&self, _o: &Self) -> Self {
        BoolTag(())
    }
}

// ── CountTag — the counting semiring (i64, ×, +) ───────────────────

/// The counting semiring `(i64, ×, +)` (spec §6 table): each derived fact carries
/// the NUMBER of distinct derivations that produced it. `⊗` (`times`) multiplies the
/// body weights of one derivation; `⊕` (`plus`) sums the weights of independent
/// derivations. `one() = 1`, `zero() = 0`.
///
/// **NOT** [`IdempotentTag`] (`x ⊕ x = 2x ≠ x`): a count grows under recursion, so by
/// I4 it must never appear in a recursive stratum. This is enforced purely by the
/// absence of an `IdempotentTag` impl — the recursive executor's `T: IdempotentTag`
/// bound rejects `CountTag` at compile time (no runtime guard needed). It IS
/// [`InvertibleTag`] (subtraction), which is what makes incremental maintenance
/// possible: a retracted derivation `⊖`s its weight back out.
///
/// `times`/`plus`/`minus` saturate at the `i64` bounds: exact for every realistic
/// derivation count, and saturation (rather than a debug-build overflow panic or a
/// silent wrap) is the safe behavior at the extreme — `⊕` stays monotone, which is
/// what the distributivity and fold laws rely on.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CountTag(pub i64);

impl CountTag {
    /// Encode to the tag-payload bytes the segment format stores (8 LE bytes).
    #[inline]
    pub fn to_le_bytes(self) -> Vec<u8> {
        self.0.to_le_bytes().to_vec()
    }
    /// Decode from the tag-payload bytes; `None` on a wrong-length / corrupt payload.
    #[inline]
    pub fn from_le_bytes(b: &[u8]) -> Option<Self> {
        <[u8; 8]>::try_from(b).ok().map(i64::from_le_bytes).map(CountTag)
    }
}

impl Sealed for CountTag {}

impl Tag for CountTag {
    #[inline]
    fn one() -> Self {
        CountTag(1)
    }
    #[inline]
    fn zero() -> Self {
        CountTag(0)
    }
    #[inline]
    fn times(&self, o: &Self) -> Self {
        CountTag(self.0.saturating_mul(o.0))
    }
    #[inline]
    fn plus(&self, o: &Self) -> Self {
        CountTag(self.0.saturating_add(o.0))
    }
}

impl InvertibleTag for CountTag {
    #[inline]
    fn minus(&self, o: &Self) -> Self {
        CountTag(self.0.saturating_sub(o.0))
    }
}

// ── ConfTag — the tropical (min, +) confidence semiring ────────────

/// The tropical confidence semiring in NEG-LOG units (spec §6 table): the carrier is
/// `u32` where `0` is certain (`−log 1`) and `u32::MAX` is impossible (`−log 0`).
/// `⊗` (`times`) is saturating add — chaining evidence ADDS neg-log cost; `⊕` (`plus`)
/// is `min` — the most-confident (smallest neg-log) independent derivation wins.
/// `one() = 0` (certain), `zero() = u32::MAX` (impossible). This is the tropical
/// `(min, +)` semiring, `≅ (max, ×)` on `[0, 1]` via `−log`.
///
/// IS [`IdempotentTag`] (`min(x, x) = x`): `⊕` is idempotent and the chain is
/// monotone-decreasing on a finite integer carrier, so a `ConfTag` predicate
/// terminates under recursion (I4) — admissible in a recursive stratum, unlike
/// `CountTag`. NOT [`InvertibleTag`]: `min` has no inverse (you cannot recover the
/// second-best from the best), so confidence relations are rebuilt, not retracted.
///
/// I15: confidence is NEVER probability — these are neg-log units rendered as a
/// confidence value only at the API edge, never multiplied as probabilities.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ConfTag(pub u32);

impl ConfTag {
    /// Certain (neg-log `0`) — the identity for `⊗`, i.e. [`Tag::one`].
    pub const CERTAIN: ConfTag = ConfTag(0);
    /// Impossible (neg-log `+∞ = u32::MAX`) — the identity for `⊕`, i.e. [`Tag::zero`].
    pub const IMPOSSIBLE: ConfTag = ConfTag(u32::MAX);
}

impl ConfTag {
    /// Encode to the tag-payload bytes the segment format stores (4 LE bytes).
    #[inline]
    pub fn to_le_bytes(self) -> Vec<u8> {
        self.0.to_le_bytes().to_vec()
    }
    /// Decode from the tag-payload bytes; `None` on a wrong-length / corrupt payload.
    #[inline]
    pub fn from_le_bytes(b: &[u8]) -> Option<Self> {
        <[u8; 4]>::try_from(b).ok().map(u32::from_le_bytes).map(ConfTag)
    }
}

impl Default for ConfTag {
    /// A present fact defaults to certain (`one()`), mirroring `BoolTag::default`'s
    /// "present" inhabitant.
    #[inline]
    fn default() -> Self {
        ConfTag::CERTAIN
    }
}

impl Sealed for ConfTag {}

impl Tag for ConfTag {
    #[inline]
    fn one() -> Self {
        ConfTag(0)
    }
    #[inline]
    fn zero() -> Self {
        ConfTag(u32::MAX)
    }
    #[inline]
    fn times(&self, o: &Self) -> Self {
        ConfTag(self.0.saturating_add(o.0))
    }
    #[inline]
    fn plus(&self, o: &Self) -> Self {
        ConfTag(self.0.min(o.0))
    }
}

impl IdempotentTag for ConfTag {}

// ── Product<A, B> — the componentwise product semiring ─────────────

/// The componentwise product of two semirings (spec §6 table): the carrier is the
/// pair `(A, B)` and every operation acts componentwise. Lawful by theorem (a product
/// of semirings is a semiring). The stdlib uses `Product<CountTag, ConfTag>` for
/// "count · confidence" facts.
///
/// The marker traits compose by AND: `Product<A, B>` is [`IdempotentTag`] iff BOTH `A`
/// and `B` are, and [`InvertibleTag`] iff both are — so `Product<CountTag, ConfTag>`
/// is neither idempotent (CountTag isn't) nor invertible (ConfTag isn't), and the
/// compile-time recursion gate (I4) follows automatically from the component bounds.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Product<A, B>(pub A, pub B);

impl<A: Sealed, B: Sealed> Sealed for Product<A, B> {}

impl<A: Tag, B: Tag> Tag for Product<A, B> {
    #[inline]
    fn one() -> Self {
        Product(A::one(), B::one())
    }
    #[inline]
    fn zero() -> Self {
        Product(A::zero(), B::zero())
    }
    #[inline]
    fn times(&self, o: &Self) -> Self {
        Product(self.0.times(&o.0), self.1.times(&o.1))
    }
    #[inline]
    fn plus(&self, o: &Self) -> Self {
        Product(self.0.plus(&o.0), self.1.plus(&o.1))
    }
}

impl<A: IdempotentTag, B: IdempotentTag> IdempotentTag for Product<A, B> {}

impl<A: InvertibleTag, B: InvertibleTag> InvertibleTag for Product<A, B> {
    #[inline]
    fn minus(&self, o: &Self) -> Self {
        Product(self.0.minus(&o.0), self.1.minus(&o.1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `BoolTag` has exactly one inhabitant, so every operation yields the same
    /// value — verified here so the law checks below are meaningful.
    #[test]
    fn single_inhabitant() {
        assert_eq!(BoolTag::one(), BoolTag::zero());
        assert_eq!(BoolTag::one(), BoolTag::present());
        assert_eq!(BoolTag::default(), BoolTag::present());
    }

    /// `⊕` identity: `x ⊕ zero() == x` and `zero() ⊕ x == x`.
    #[test]
    fn plus_identity() {
        let x = BoolTag::present();
        assert_eq!(x.plus(&BoolTag::zero()), x);
        assert_eq!(BoolTag::zero().plus(&x), x);
    }

    /// `⊗` identity: `x ⊗ one() == x` and `one() ⊗ x == x`.
    #[test]
    fn times_identity() {
        let x = BoolTag::present();
        assert_eq!(x.times(&BoolTag::one()), x);
        assert_eq!(BoolTag::one().times(&x), x);
    }

    /// `⊕` is commutative.
    #[test]
    fn plus_commutative() {
        let a = BoolTag::present();
        let b = BoolTag::one();
        assert_eq!(a.plus(&b), b.plus(&a));
    }

    /// `⊕` is associative.
    #[test]
    fn plus_associative() {
        let a = BoolTag::present();
        let b = BoolTag::one();
        let c = BoolTag::zero();
        assert_eq!(a.plus(&b).plus(&c), a.plus(&b.plus(&c)));
    }

    /// `⊗` is associative.
    #[test]
    fn times_associative() {
        let a = BoolTag::present();
        let b = BoolTag::one();
        let c = BoolTag::zero();
        assert_eq!(a.times(&b).times(&c), a.times(&b.times(&c)));
    }

    /// `⊕` is idempotent (`x ⊕ x == x`) — the property that makes `BoolTag` an
    /// [`IdempotentTag`] and so admissible in a recursive stratum (I4).
    #[test]
    fn plus_idempotent() {
        let x = BoolTag::present();
        assert_eq!(x.plus(&x), x);
    }

    /// `⊗` distributes over `⊕`: `a ⊗ (b ⊕ c) == (a ⊗ b) ⊕ (a ⊗ c)`.
    #[test]
    fn times_distributes_over_plus() {
        let a = BoolTag::present();
        let b = BoolTag::one();
        let c = BoolTag::zero();
        assert_eq!(a.times(&b.plus(&c)), a.times(&b).plus(&a.times(&c)));
    }

    /// Set-difference inverse: `(a ⊕ b) ⊖ b == a` for run-produced weights.
    #[test]
    fn minus_inverts_plus() {
        let a = BoolTag::present();
        let b = BoolTag::present();
        assert_eq!(a.plus(&b).minus(&b), a);
    }

    /// The marker traits are wired up so generic bounds resolve (I4 / invert).
    #[test]
    fn marker_bounds_hold() {
        fn assert_idempotent<T: IdempotentTag>() {}
        fn assert_invertible<T: InvertibleTag>() {}
        assert_idempotent::<BoolTag>();
        assert_invertible::<BoolTag>();
        // Gate C semirings: ConfTag is idempotent (admissible in recursion, I4);
        // CountTag is invertible (incremental maintenance). Product composes the markers
        // by AND — Product<CountTag, CountTag> is invertible; Product<BoolTag, ConfTag> is
        // both idempotent and invertible... no: ConfTag is NOT invertible, so only the
        // idempotent bound holds for Product<BoolTag, ConfTag>.
        assert_idempotent::<ConfTag>();
        assert_invertible::<CountTag>();
        assert_idempotent::<Product<BoolTag, ConfTag>>();
        assert_invertible::<Product<BoolTag, CountTag>>();
        assert_idempotent::<Product<BoolTag, BoolTag>>();
        assert_invertible::<Product<CountTag, BoolTag>>();
        // NOTE: `assert_idempotent::<CountTag>()` and `assert_invertible::<ConfTag>()` must
        // NOT compile — that compile-time rejection IS the I4 / non-invertibility guarantee.
    }

    // ── Gate C semiring law gates (I6: lawful semirings only) ───────

    /// The full semiring law battery over a set of sample weights: `⊕`/`⊗` identities,
    /// the zero-annihilates-`⊗` law, `⊕` commutativity + associativity, `⊗`
    /// associativity, and BOTH-sided distributivity of `⊗` over `⊕`. Checking over a
    /// representative value set (not a single inhabitant) is what makes these meaningful
    /// for the multi-valued Gate C carriers.
    fn check_semiring_laws<T: Tag + PartialEq + std::fmt::Debug>(samples: &[T]) {
        for a in samples {
            assert_eq!(a.plus(&T::zero()), *a, "⊕ identity (right)");
            assert_eq!(T::zero().plus(a), *a, "⊕ identity (left)");
            assert_eq!(a.times(&T::one()), *a, "⊗ identity (right)");
            assert_eq!(T::one().times(a), *a, "⊗ identity (left)");
            // 0 annihilates ⊗ (a genuine semiring law: a ⊗ 0 = 0 = 0 ⊗ a).
            assert_eq!(a.times(&T::zero()), T::zero(), "zero annihilates ⊗ (right)");
            assert_eq!(T::zero().times(a), T::zero(), "zero annihilates ⊗ (left)");
        }
        for a in samples {
            for b in samples {
                assert_eq!(a.plus(b), b.plus(a), "⊕ commutative");
                for c in samples {
                    assert_eq!(a.plus(b).plus(c), a.plus(&b.plus(c)), "⊕ associative");
                    assert_eq!(a.times(b).times(c), a.times(&b.times(c)), "⊗ associative");
                    assert_eq!(
                        a.times(&b.plus(c)),
                        a.times(b).plus(&a.times(c)),
                        "⊗ distributes over ⊕ (left)"
                    );
                    assert_eq!(
                        b.plus(c).times(a),
                        b.times(a).plus(&c.times(a)),
                        "⊗ distributes over ⊕ (right)"
                    );
                }
            }
        }
    }

    #[test]
    fn count_tag_obeys_semiring_laws() {
        let s: Vec<CountTag> = [0, 1, 2, 3, 7, 12].into_iter().map(CountTag).collect();
        check_semiring_laws(&s);
        // ⊕ is genuinely additive (NOT idempotent): two derivations of one fact count twice.
        assert_eq!(CountTag(3).plus(&CountTag(3)), CountTag(6));
        assert_ne!(CountTag(3).plus(&CountTag(3)), CountTag(3));
        // ⊗ multiplies; one()/zero() are 1/0.
        assert_eq!(CountTag(4).times(&CountTag(5)), CountTag(20));
        assert_eq!(CountTag::one(), CountTag(1));
        assert_eq!(CountTag::zero(), CountTag(0));
        // Invertible: a retracted derivation subtracts its weight back out.
        assert_eq!(CountTag(7).plus(&CountTag(3)).minus(&CountTag(3)), CountTag(7));
    }

    #[test]
    fn conf_tag_obeys_tropical_semiring_laws() {
        // Include the identities (CERTAIN=0, IMPOSSIBLE=MAX) and the saturation boundary.
        let s: Vec<ConfTag> = [0u32, 1, 5, 100, 1000, u32::MAX]
            .into_iter()
            .map(ConfTag)
            .collect();
        check_semiring_laws(&s);
        // Tropical: ⊕ = min (best derivation wins), ⊗ = saturating add (evidence chains).
        assert_eq!(ConfTag(5).plus(&ConfTag(8)), ConfTag(5));
        assert_eq!(ConfTag(5).times(&ConfTag(8)), ConfTag(13));
        assert_eq!(ConfTag::one(), ConfTag::CERTAIN);
        assert_eq!(ConfTag::zero(), ConfTag::IMPOSSIBLE);
        // ⊕ is idempotent (min(x,x)=x) → admissible under recursion (I4).
        assert_eq!(ConfTag(42).plus(&ConfTag(42)), ConfTag(42));
        // ⊗ saturates at the impossible bound rather than wrapping.
        assert_eq!(ConfTag(u32::MAX).times(&ConfTag(1)), ConfTag(u32::MAX));
    }

    #[test]
    fn product_tag_obeys_semiring_laws_componentwise() {
        // count · confidence — the stdlib product (spec §6 Notes).
        let s: Vec<Product<CountTag, ConfTag>> = [(0i64, 0u32), (1, 5), (2, 100), (3, u32::MAX)]
            .into_iter()
            .map(|(c, p)| Product(CountTag(c), ConfTag(p)))
            .collect();
        check_semiring_laws(&s);
        // Each operation acts componentwise.
        let x = Product(CountTag(2), ConfTag(5));
        let y = Product(CountTag(3), ConfTag(8));
        assert_eq!(x.plus(&y), Product(CountTag(5), ConfTag(5))); // + on counts, min on conf
        assert_eq!(x.times(&y), Product(CountTag(6), ConfTag(13))); // × on counts, + on conf
        assert_eq!(
            Product::<CountTag, ConfTag>::one(),
            Product(CountTag(1), ConfTag(0))
        );
        assert_eq!(
            Product::<CountTag, ConfTag>::zero(),
            Product(CountTag(0), ConfTag(u32::MAX))
        );
    }
}
