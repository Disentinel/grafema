//! Aggregate accumulators for the Cypher `HashAggregate` operator.
//!
//! Each aggregate expression in a `RETURN` clause (e.g. `SUM(n.lineCount)`)
//! gets one [`AggAcc`] per output group. The accumulator is fed evaluated
//! argument values row-by-row via [`AggAcc::update`], then collapsed to a
//! single [`CypherValue`] via [`AggAcc::finalize`].
//!
//! Supported functions: `COUNT`, `SUM`, `AVG`, `MIN`, `MAX`. Any other
//! function name is rejected at construction time ([`AggAcc::new`]) so that an
//! unsupported aggregate fails loudly instead of silently returning a count
//! (the historical RFD-70 bug).
//!
//! NULL handling follows Cypher semantics: `COUNT(expr)` counts only non-NULL
//! values, `COUNT(*)` counts all rows, and `SUM`/`AVG`/`MIN`/`MAX` skip NULLs.

use super::values::CypherValue;
use super::CypherError;
use std::cmp::Ordering;

/// Is `name` (any case) one of the aggregate functions the executor implements?
///
/// This is the single source of truth for "aggregate vs scalar" — it MUST stay
/// in sync with the accepted set in [`AggAcc::new`]. The planner uses it to route
/// only aggregate calls through `HashAggregate` (and to reject unknown functions),
/// so a scalar function in `RETURN` is never silently treated as an aggregate.
pub fn is_aggregate_function(name: &str) -> bool {
    matches!(
        name.to_uppercase().as_str(),
        "COUNT" | "SUM" | "AVG" | "MIN" | "MAX"
    )
}

/// Per-aggregate, per-group accumulator state.
///
/// Constructed once per group from the aggregate's function name, updated for
/// every input row, then finalized into a single result value.
#[derive(Debug, Clone)]
pub enum AggAcc {
    /// `COUNT(expr)` / `COUNT(*)` — running row/non-null count.
    Count(i64),
    /// `SUM(expr)` — running numeric total. Stays integer until a float value
    /// is seen, then promotes to float (Cypher `SUM` returns Int iff every
    /// summed value was an Int).
    Sum {
        int_sum: i64,
        float_sum: f64,
        is_float: bool,
        any: bool,
    },
    /// `AVG(expr)` — running float sum and count of non-NULL numeric values.
    Avg { sum: f64, count: i64 },
    /// `MIN(expr)` — smallest non-NULL value seen so far.
    Min(Option<CypherValue>),
    /// `MAX(expr)` — largest non-NULL value seen so far.
    Max(Option<CypherValue>),
}

impl AggAcc {
    /// Build a fresh accumulator for an (already upper-cased) aggregate
    /// function name. Returns [`CypherError::Execution`] for any function the
    /// executor does not implement, so unsupported aggregates surface as an
    /// explicit error rather than silent wrong data.
    pub fn new(function: &str) -> Result<AggAcc, CypherError> {
        match function {
            "COUNT" => Ok(AggAcc::Count(0)),
            "SUM" => Ok(AggAcc::Sum {
                int_sum: 0,
                float_sum: 0.0,
                is_float: false,
                any: false,
            }),
            "AVG" => Ok(AggAcc::Avg { sum: 0.0, count: 0 }),
            "MIN" => Ok(AggAcc::Min(None)),
            "MAX" => Ok(AggAcc::Max(None)),
            other => Err(CypherError::Execution(format!(
                "Unsupported aggregate function: {}",
                other
            ))),
        }
    }

    /// Fold one input row into the accumulator.
    ///
    /// `value` is the evaluated aggregate argument for this row. `is_star`
    /// indicates the argument was `*` (only meaningful for `COUNT(*)`). NULL
    /// values are skipped by every function except `COUNT(*)`.
    pub fn update(&mut self, value: &CypherValue, is_star: bool) -> Result<(), CypherError> {
        match self {
            AggAcc::Count(c) => {
                if is_star || !matches!(value, CypherValue::Null) {
                    *c += 1;
                }
            }
            AggAcc::Sum {
                int_sum,
                float_sum,
                is_float,
                any,
            } => match value {
                CypherValue::Null => {}
                CypherValue::Int(i) => {
                    *any = true;
                    if *is_float {
                        *float_sum += *i as f64;
                    } else {
                        *int_sum += *i;
                    }
                }
                CypherValue::Float(f) => {
                    *any = true;
                    if !*is_float {
                        *is_float = true;
                        *float_sum = *int_sum as f64;
                    }
                    *float_sum += *f;
                }
                other => {
                    return Err(non_numeric_err("SUM", other));
                }
            },
            AggAcc::Avg { sum, count } => match value {
                CypherValue::Null => {}
                CypherValue::Int(i) => {
                    *sum += *i as f64;
                    *count += 1;
                }
                CypherValue::Float(f) => {
                    *sum += *f;
                    *count += 1;
                }
                other => {
                    return Err(non_numeric_err("AVG", other));
                }
            },
            AggAcc::Min(slot) => {
                update_extremum(slot, value, Ordering::Less, "MIN")?;
            }
            AggAcc::Max(slot) => {
                update_extremum(slot, value, Ordering::Greater, "MAX")?;
            }
        }
        Ok(())
    }

    /// Collapse the accumulator into its result value.
    ///
    /// Empty/all-NULL groups follow Cypher conventions: `COUNT` → 0,
    /// `SUM` → 0, `AVG`/`MIN`/`MAX` → NULL.
    pub fn finalize(self) -> CypherValue {
        match self {
            AggAcc::Count(c) => CypherValue::Int(c),
            AggAcc::Sum {
                int_sum,
                float_sum,
                is_float,
                any,
            } => {
                if !any {
                    CypherValue::Int(0)
                } else if is_float {
                    CypherValue::Float(float_sum)
                } else {
                    CypherValue::Int(int_sum)
                }
            }
            AggAcc::Avg { sum, count } => {
                if count == 0 {
                    CypherValue::Null
                } else {
                    CypherValue::Float(sum / count as f64)
                }
            }
            AggAcc::Min(slot) | AggAcc::Max(slot) => slot.unwrap_or(CypherValue::Null),
        }
    }
}

/// Build the error returned when `SUM`/`AVG` receives a non-numeric, non-NULL
/// value (e.g. a string or node).
fn non_numeric_err(func: &str, got: &CypherValue) -> CypherError {
    CypherError::Execution(format!(
        "{} requires a numeric argument, got {}",
        func,
        type_name(got)
    ))
}

/// Update a `MIN`/`MAX` slot with a new value, keeping it if it compares in
/// the `keep` direction (`Less` for MIN, `Greater` for MAX). NULLs are
/// ignored; incomparable type mixes (e.g. number vs string) error.
fn update_extremum(
    slot: &mut Option<CypherValue>,
    value: &CypherValue,
    keep: Ordering,
    func: &str,
) -> Result<(), CypherError> {
    if matches!(value, CypherValue::Null) {
        return Ok(());
    }
    match slot {
        None => *slot = Some(value.clone()),
        Some(current) => match cypher_cmp(value, current) {
            Some(ord) => {
                if ord == keep {
                    *slot = Some(value.clone());
                }
            }
            None => {
                return Err(CypherError::Execution(format!(
                    "{} cannot compare values of different types: {} vs {}",
                    func,
                    type_name(value),
                    type_name(current)
                )));
            }
        },
    }
    Ok(())
}

/// Total ordering over the orderable Cypher scalar types (numbers and
/// strings). Numbers are compared as f64 across the Int/Float boundary.
/// Returns `None` for incomparable type pairs (e.g. number vs string) or any
/// non-orderable value (Bool, Node, Null).
fn cypher_cmp(a: &CypherValue, b: &CypherValue) -> Option<Ordering> {
    match (a, b) {
        (CypherValue::Int(x), CypherValue::Int(y)) => Some(x.cmp(y)),
        (CypherValue::Int(x), CypherValue::Float(y)) => (*x as f64).partial_cmp(y),
        (CypherValue::Float(x), CypherValue::Int(y)) => x.partial_cmp(&(*y as f64)),
        (CypherValue::Float(x), CypherValue::Float(y)) => x.partial_cmp(y),
        (CypherValue::Str(x), CypherValue::Str(y)) => Some(x.cmp(y)),
        _ => None,
    }
}

/// Human-readable type label for error messages.
fn type_name(v: &CypherValue) -> &'static str {
    match v {
        CypherValue::Null => "NULL",
        CypherValue::Bool(_) => "Bool",
        CypherValue::Int(_) => "Int",
        CypherValue::Float(_) => "Float",
        CypherValue::Str(_) => "String",
        CypherValue::Node { .. } => "Node",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fold a slice of values through a freshly-constructed accumulator.
    fn fold(func: &str, values: &[CypherValue]) -> Result<CypherValue, CypherError> {
        let mut acc = AggAcc::new(func)?;
        for v in values {
            acc.update(v, false)?;
        }
        Ok(acc.finalize())
    }

    #[test]
    fn unsupported_function_rejected_at_construction() {
        assert!(AggAcc::new("STDDEV").is_err());
        assert!(AggAcc::new("COLLECT").is_err());
    }

    #[test]
    fn sum_of_ints_stays_int() {
        let r = fold(
            "SUM",
            &[
                CypherValue::Int(1),
                CypherValue::Int(2),
                CypherValue::Int(3),
            ],
        )
        .unwrap();
        assert_eq!(r, CypherValue::Int(6));
    }

    #[test]
    fn sum_mixed_int_and_float_promotes_to_float() {
        let r = fold(
            "SUM",
            &[
                CypherValue::Int(1),
                CypherValue::Float(2.5),
                CypherValue::Int(1),
            ],
        )
        .unwrap();
        assert_eq!(r, CypherValue::Float(4.5));
    }

    #[test]
    fn sum_skips_nulls() {
        let r = fold(
            "SUM",
            &[CypherValue::Int(5), CypherValue::Null, CypherValue::Int(5)],
        )
        .unwrap();
        assert_eq!(r, CypherValue::Int(10));
    }

    #[test]
    fn sum_of_all_nulls_is_zero() {
        let r = fold("SUM", &[CypherValue::Null, CypherValue::Null]).unwrap();
        assert_eq!(r, CypherValue::Int(0));
    }

    #[test]
    fn sum_of_non_numeric_errors() {
        assert!(fold("SUM", &[CypherValue::Str("x".into())]).is_err());
    }

    #[test]
    fn avg_of_all_nulls_is_null() {
        let r = fold("AVG", &[CypherValue::Null]).unwrap();
        assert_eq!(r, CypherValue::Null);
    }

    #[test]
    fn avg_computes_float_mean() {
        let r = fold("AVG", &[CypherValue::Int(1), CypherValue::Int(2)]).unwrap();
        assert_eq!(r, CypherValue::Float(1.5));
    }

    #[test]
    fn min_max_over_numbers() {
        let vals = [
            CypherValue::Int(3),
            CypherValue::Float(1.5),
            CypherValue::Int(7),
        ];
        assert_eq!(fold("MIN", &vals).unwrap(), CypherValue::Float(1.5));
        assert_eq!(fold("MAX", &vals).unwrap(), CypherValue::Int(7));
    }

    #[test]
    fn min_max_over_strings() {
        let vals = [
            CypherValue::Str("banana".into()),
            CypherValue::Str("apple".into()),
            CypherValue::Str("cherry".into()),
        ];
        assert_eq!(
            fold("MIN", &vals).unwrap(),
            CypherValue::Str("apple".into())
        );
        assert_eq!(
            fold("MAX", &vals).unwrap(),
            CypherValue::Str("cherry".into())
        );
    }

    #[test]
    fn min_max_of_all_nulls_is_null() {
        assert_eq!(
            fold("MIN", &[CypherValue::Null]).unwrap(),
            CypherValue::Null
        );
        assert_eq!(
            fold("MAX", &[CypherValue::Null]).unwrap(),
            CypherValue::Null
        );
    }

    #[test]
    fn min_skips_nulls_among_values() {
        let r = fold(
            "MIN",
            &[
                CypherValue::Null,
                CypherValue::Int(4),
                CypherValue::Null,
                CypherValue::Int(2),
            ],
        )
        .unwrap();
        assert_eq!(r, CypherValue::Int(2));
    }

    #[test]
    fn min_of_incomparable_types_errors() {
        // Int vs String cannot be ordered → explicit error, not a wrong winner.
        let r = fold("MIN", &[CypherValue::Int(1), CypherValue::Str("a".into())]);
        assert!(r.is_err());
    }

    #[test]
    fn count_star_counts_all_rows_including_nulls() {
        let mut acc = AggAcc::new("COUNT").unwrap();
        acc.update(&CypherValue::Null, true).unwrap();
        acc.update(&CypherValue::Int(1), true).unwrap();
        assert_eq!(acc.finalize(), CypherValue::Int(2));
    }

    #[test]
    fn count_expr_skips_nulls() {
        let mut acc = AggAcc::new("COUNT").unwrap();
        acc.update(&CypherValue::Null, false).unwrap();
        acc.update(&CypherValue::Int(1), false).unwrap();
        assert_eq!(acc.finalize(), CypherValue::Int(1));
    }
}
