//! Layer 0 — tag algebra (`Sealed`, `Tag`, `InvertibleTag`, `IdempotentTag`, `BoolTag`).
//!
//! Defines the sealed tag trait hierarchy that parameterizes the semi-naive
//! executor. Gate A ships only `BoolTag` (set semantics); `Count`/`Conf`/`Product`
//! tags are deferred to Gate C. Invariants enforced here: I4 (recursion is gated on
//! `IdempotentTag` so non-idempotent tags cannot appear in a recursive stratum) and
//! I6 (the tag trait is sealed — no out-of-crate implementations).
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
/// implementable from within `datalog2`, so the set of tags is closed. Adding a
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
    }
}
