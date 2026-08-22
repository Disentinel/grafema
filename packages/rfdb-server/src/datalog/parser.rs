//! Simple Datalog parser
//!
//! Supports:
//! - Terms: variables (X, Y), constants ("foo"), wildcard (_)
//! - Atoms: predicate(arg1, arg2, ...)
//! - Literals: atom or \+ atom
//! - Rules: head :- body. or head.
//! - Programs: multiple rules

use crate::datalog::types::*;

/// Parse error
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    pub message: String,
    pub position: usize,
}

impl ParseError {
    fn new(message: &str, position: usize) -> Self {
        ParseError {
            message: message.to_string(),
            position,
        }
    }
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Parse error at {}: {}", self.position, self.message)
    }
}

impl std::error::Error for ParseError {}

/// Parser state
struct Parser<'a> {
    input: &'a str,
    pos: usize,
}

impl<'a> Parser<'a> {
    fn new(input: &'a str) -> Self {
        Parser { input, pos: 0 }
    }

    fn remaining(&self) -> &str {
        &self.input[self.pos..]
    }

    fn skip_whitespace(&mut self) {
        while self.pos < self.input.len() {
            let c = self.input[self.pos..].chars().next().unwrap();
            if c.is_whitespace() {
                self.pos += c.len_utf8();
            } else if self.remaining().starts_with("%") {
                // Skip comment to end of line
                while self.pos < self.input.len() {
                    let c = self.input[self.pos..].chars().next().unwrap();
                    self.pos += c.len_utf8();
                    if c == '\n' {
                        break;
                    }
                }
            } else {
                break;
            }
        }
    }

    fn peek(&mut self) -> Option<char> {
        self.skip_whitespace();
        self.remaining().chars().next()
    }

    fn expect(&mut self, expected: &str) -> Result<(), ParseError> {
        self.skip_whitespace();
        if self.remaining().starts_with(expected) {
            self.pos += expected.len();
            Ok(())
        } else {
            Err(ParseError::new(
                &format!("expected '{}'", expected),
                self.pos,
            ))
        }
    }

    fn parse_identifier(&mut self) -> Result<String, ParseError> {
        self.skip_whitespace();
        let start = self.pos;

        while self.pos < self.input.len() {
            let c = self.input[self.pos..].chars().next().unwrap();
            if c.is_alphanumeric() || c == '_' || c == ':' {
                self.pos += c.len_utf8();
            } else {
                break;
            }
        }

        if self.pos == start {
            return Err(ParseError::new("expected identifier", self.pos));
        }

        Ok(self.input[start..self.pos].to_string())
    }

    /// Parse a double-quoted string literal.
    ///
    /// Escape handling is LENIENT (Wave 14): a backslash followed by `"` or
    /// `\` is an escape sequence producing that character (so a literal
    /// double-quote CAN appear inside a string — required by quote-stripping
    /// rules over JS string literals, whose graph `name` keeps the raw source
    /// quoting). A backslash followed by anything else stays a literal
    /// backslash — pre-escape strings like `"C:\Users"` keep their meaning
    /// (only `\"` / `\\` sequences, previously impossible to express in the
    /// first case and degenerate in the second, change interpretation).
    fn parse_string(&mut self) -> Result<String, ParseError> {
        self.skip_whitespace();
        self.expect("\"")?;

        let start = self.pos;
        let mut value = String::new();
        while self.pos < self.input.len() {
            let c = self.input[self.pos..].chars().next().unwrap();
            if c == '"' {
                self.pos += 1; // consume closing quote
                return Ok(value);
            }
            if c == '\\' {
                let next = self.input[self.pos + 1..].chars().next();
                if matches!(next, Some('"') | Some('\\')) {
                    value.push(next.unwrap());
                    self.pos += 1 + next.unwrap().len_utf8();
                    continue;
                }
            }
            value.push(c);
            self.pos += c.len_utf8();
        }

        Err(ParseError::new("unterminated string", start))
    }

    fn parse_term(&mut self) -> Result<Term, ParseError> {
        self.skip_whitespace();

        let c = self.peek().ok_or_else(|| ParseError::new("unexpected end", self.pos))?;

        if c == '_' && !self.remaining()[1..].starts_with(|c: char| c.is_alphanumeric()) {
            self.pos += 1;
            Ok(Term::Wildcard)
        } else if c == '"' {
            let s = self.parse_string()?;
            Ok(Term::Const(s))
        } else if c.is_uppercase() {
            let name = self.parse_identifier()?;
            Ok(Term::Var(name))
        } else if c.is_lowercase() || c == '_' {
            // Could be a constant without quotes (like identifiers)
            let name = self.parse_identifier()?;
            // If it looks like a variable pattern but starts lowercase, treat as const
            Ok(Term::Const(name))
        } else if c.is_ascii_digit()
            || (c == '-' && self.remaining()[1..].starts_with(|d: char| d.is_ascii_digit()))
        {
            // Bare numeric literal → typed Int/Float (spec §5; not a string const, not an id).
            self.parse_number()
        } else {
            Err(ParseError::new(&format!("unexpected character '{}'", c), self.pos))
        }
    }

    /// Parse a bare numeric literal: optional leading `-`, digits, optional single `.` + digits.
    /// A `.` makes it a `Float`, otherwise an `Int`. The decision is at parse time so `0` and
    /// `"0"` stay distinct (typed literal vs string const, spec §5).
    fn parse_number(&mut self) -> Result<Term, ParseError> {
        self.skip_whitespace();
        let start = self.pos;
        if self.remaining().starts_with('-') {
            self.pos += 1;
        }
        let mut saw_dot = false;
        // Direct char walk (like `parse_identifier`) — NOT `peek()`, which skips whitespace and
        // would let a number span a space. A single interior `.` (with a digit after) makes it a
        // float; a trailing `.` (e.g. the rule terminator in `gt(A, 0).`) is left for the caller.
        while self.pos < self.input.len() {
            let c = self.input[self.pos..].chars().next().unwrap();
            if c.is_ascii_digit() {
                self.pos += 1;
            } else if c == '.'
                && !saw_dot
                && self.input[self.pos + 1..].starts_with(|d: char| d.is_ascii_digit())
            {
                saw_dot = true;
                self.pos += 1;
            } else {
                break;
            }
        }
        let text = &self.input[start..self.pos];
        if saw_dot {
            // Routed through the canonicalizing constructor (invariant V3): `-0.0`
            // normalizes to `+0.0`; NaN is unspellable as a literal.
            text.parse::<f64>()
                .map(|f| Term::Lit(crate::datalog::eval::Value::float(f)))
                .map_err(|_| ParseError::new("invalid float literal", start))
        } else {
            // i64 stays the fast path (bit-identical `Value::Int` for in-range
            // literals). An i64-OVERFLOWING literal — a hard "invalid integer literal"
            // ParseError before P1 — falls back to the arbitrary-precision constructor
            // (strictly widening: error → value; makes 2^68 representable, ROFL 24h
            // incident #3). `big_int_from_decimal` canonicalizes per V1/V2 and only
            // rejects non-digit shapes, which this branch never produces.
            match text.parse::<i64>() {
                Ok(i) => Ok(Term::Lit(crate::datalog::eval::Value::Int(i))),
                Err(_) => crate::datalog::eval::Value::big_int_from_decimal(text)
                    .map(Term::Lit)
                    .ok_or_else(|| ParseError::new("invalid integer literal", start)),
            }
        }
    }

    fn parse_atom(&mut self) -> Result<Atom, ParseError> {
        let predicate = self.parse_identifier()?;

        self.skip_whitespace();
        if self.peek() != Some('(') {
            // No args
            return Ok(Atom::new(&predicate, vec![]));
        }

        self.expect("(")?;

        let mut args = Vec::new();

        self.skip_whitespace();
        if self.peek() != Some(')') {
            args.push(self.parse_term()?);

            loop {
                self.skip_whitespace();
                if self.peek() == Some(',') {
                    self.expect(",")?;
                    args.push(self.parse_term()?);
                } else {
                    break;
                }
            }
        }

        self.expect(")")?;

        Ok(Atom::new(&predicate, args))
    }

    fn parse_literal(&mut self) -> Result<Literal, ParseError> {
        self.skip_whitespace();

        // Check for negation
        if self.remaining().starts_with("\\+") {
            self.pos += 2;
            self.skip_whitespace();
            let atom = self.parse_atom()?;
            Ok(Literal::Negative(atom))
        } else {
            let atom = self.parse_atom()?;
            Ok(Literal::Positive(atom))
        }
    }

    fn parse_rule(&mut self) -> Result<Rule, ParseError> {
        let head = self.parse_atom()?;

        self.skip_whitespace();

        // Check for :- (rule with body) or . (fact)
        if self.remaining().starts_with(":-") {
            self.pos += 2;

            let mut body = Vec::new();
            body.push(self.parse_literal()?);

            loop {
                self.skip_whitespace();
                if self.peek() == Some(',') {
                    self.expect(",")?;
                    body.push(self.parse_literal()?);
                } else {
                    break;
                }
            }

            self.expect(".")?;
            Ok(Rule::new(head, body))
        } else {
            self.expect(".")?;
            Ok(Rule::fact(head))
        }
    }

    fn parse_program(&mut self) -> Result<Program, ParseError> {
        let mut rules = Vec::new();

        loop {
            self.skip_whitespace();
            if self.pos >= self.input.len() {
                break;
            }
            rules.push(self.parse_rule()?);
        }

        Ok(Program::new(rules))
    }

    /// Parse a query (conjunction of literals without rule head)
    /// Supports: single atom OR comma-separated atoms
    /// Example: "node(X, \"type\"), attr(X, \"url\", U)"
    fn parse_query(&mut self) -> Result<Vec<Literal>, ParseError> {
        let mut body = Vec::new();

        body.push(self.parse_literal()?);

        loop {
            self.skip_whitespace();
            if self.peek() == Some(',') {
                self.expect(",")?;
                body.push(self.parse_literal()?);
            } else {
                break;
            }
        }

        Ok(body)
    }
}

// ============================================================================
// Public API
// ============================================================================

/// Parse a single term
pub fn parse_term(input: &str) -> Result<Term, ParseError> {
    let mut parser = Parser::new(input);
    parser.parse_term()
}

/// Parse a single atom
pub fn parse_atom(input: &str) -> Result<Atom, ParseError> {
    let mut parser = Parser::new(input);
    parser.parse_atom()
}

/// Parse a single literal
pub fn parse_literal(input: &str) -> Result<Literal, ParseError> {
    let mut parser = Parser::new(input);
    parser.parse_literal()
}

/// Parse a single rule
pub fn parse_rule(input: &str) -> Result<Rule, ParseError> {
    let mut parser = Parser::new(input);
    parser.parse_rule()
}

/// Parse a complete program
pub fn parse_program(input: &str) -> Result<Program, ParseError> {
    let mut parser = Parser::new(input);
    parser.parse_program()
}

/// Parse a query (conjunction of literals)
///
/// Supports single atoms or comma-separated conjunctions:
/// - `node(X, "type")` - single atom
/// - `node(X, "type"), attr(X, "url", U)` - conjunction
///
/// Unlike `parse_atom`, this supports conjunctions without requiring
/// a full rule definition.
pub fn parse_query(input: &str) -> Result<Vec<Literal>, ParseError> {
    let mut parser = Parser::new(input);
    let result = parser.parse_query()?;
    parser.skip_whitespace();
    if parser.pos < parser.input.len() {
        return Err(ParseError::new(
            &format!("unexpected input after query: '{}'", parser.remaining()),
            parser.pos,
        ));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn const_of(t: &Term) -> &str {
        match t {
            Term::Const(s) => s,
            other => panic!("expected Const, got {other:?}"),
        }
    }

    /// Wave 14 — lenient escape sequences in string literals: `\"` and `\\`
    /// decode to the bare character; any other backslash stays literal
    /// (pre-escape behavior for strings like "C:\Users" is preserved).
    #[test]
    fn string_literal_escapes_are_lenient() {
        let a = parse_atom(r#"p("a\"b")"#).expect("escaped quote parses");
        assert_eq!(const_of(&a.args()[0]), "a\"b");

        let a = parse_atom(r#"p("a\\b")"#).expect("escaped backslash parses");
        assert_eq!(const_of(&a.args()[0]), "a\\b");

        // Lone backslash before a non-escapable char stays literal.
        let a = parse_atom(r#"p("C:\Users")"#).expect("non-escape backslash parses");
        assert_eq!(const_of(&a.args()[0]), "C:\\Users");

        // A bare double-quote literal — the quote-strip use case.
        let a = parse_atom(r#"sw(X, "\"")"#).expect("single dquote literal parses");
        assert_eq!(const_of(&a.args()[1]), "\"");

        // Unterminated string (escape eats the closer) still errors.
        assert!(parse_atom(r#"p("abc\")"#).is_err());
    }
}
