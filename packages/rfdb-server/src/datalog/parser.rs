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

    fn parse_string(&mut self) -> Result<String, ParseError> {
        self.skip_whitespace();
        self.expect("\"")?;

        let start = self.pos;
        while self.pos < self.input.len() {
            let c = self.input[self.pos..].chars().next().unwrap();
            if c == '"' {
                let value = self.input[start..self.pos].to_string();
                self.pos += 1; // consume closing quote
                return Ok(value);
            }
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
        } else {
            Err(ParseError::new(&format!("unexpected character '{}'", c), self.pos))
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
