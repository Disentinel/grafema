//! Recursive descent parser for a Cypher subset.
//!
//! Follows the same structural pattern as `src/datalog/parser.rs`:
//! a `Parser` struct tracking position in the input string, with
//! `skip_whitespace`, `peek`, `expect` helpers.
//!
//! Supported grammar:
//! ```text
//! query      = MATCH pattern [WHERE expr] RETURN return_items
//!              [ORDER BY order_items] [LIMIT int]
//! pattern    = node_pat (rel_pat node_pat)*
//! node_pat   = '(' [ident] [':' label]* ['{' props '}'] ')'
//! rel_pat    = '-' '[' [ident] [':' type ('|' type)*] [length] ']' '->'
//!            | '<-' '[' ... ']' '-'
//!            | '-' '[' ... ']' '-'
//! length     = '*' [int] '..' [int]
//! expr       = or_expr
//! or_expr    = and_expr (OR and_expr)*
//! and_expr   = not_expr (AND not_expr)*
//! not_expr   = NOT not_expr | cmp_expr
//! cmp_expr   = add_expr (('=' | '<>' | '<' | '>' | '<=' | '>=') add_expr
//!            | CONTAINS add_expr | STARTS WITH add_expr | ENDS WITH add_expr
//!            | IS NULL | IS NOT NULL)?
//! add_expr   = primary
//! primary    = literal | ident '.' ident | ident '(' args ')' | ident | '(' expr ')'
//! ```

use crate::cypher::ast::*;

/// Parse error with message and byte offset.
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

/// Parser state: input string + current byte position.
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
            } else if self.remaining().starts_with("//") {
                // Skip line comment
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

    /// Check if the remaining input starts with `kw` (case-insensitive)
    /// followed by a non-alphanumeric character (word boundary).
    fn keyword_ahead(&mut self, kw: &str) -> bool {
        self.skip_whitespace();
        let rem = self.remaining();
        if rem.len() < kw.len() {
            return false;
        }
        if !rem[..kw.len()].eq_ignore_ascii_case(kw) {
            return false;
        }
        // Must be followed by non-alphanumeric (word boundary) or end of input
        if rem.len() == kw.len() {
            return true;
        }
        let next_char = rem[kw.len()..].chars().next().unwrap();
        !next_char.is_alphanumeric() && next_char != '_'
    }

    /// Consume a keyword (case-insensitive) or return an error.
    fn expect_keyword(&mut self, kw: &str) -> Result<(), ParseError> {
        if self.keyword_ahead(kw) {
            self.pos += kw.len();
            Ok(())
        } else {
            Err(ParseError::new(
                &format!("expected keyword '{}'", kw),
                self.pos,
            ))
        }
    }

    /// Consume an exact string (case-sensitive) or return an error.
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

    /// Parse an identifier: [a-zA-Z_][a-zA-Z0-9_]*
    fn parse_identifier(&mut self) -> Result<String, ParseError> {
        self.skip_whitespace();
        let start = self.pos;

        // First char: letter or underscore
        if let Some(c) = self.remaining().chars().next() {
            if c.is_alphabetic() || c == '_' {
                self.pos += c.len_utf8();
            } else {
                return Err(ParseError::new("expected identifier", self.pos));
            }
        } else {
            return Err(ParseError::new("expected identifier", self.pos));
        }

        // Subsequent: alphanumeric or underscore
        while self.pos < self.input.len() {
            let c = self.input[self.pos..].chars().next().unwrap();
            if c.is_alphanumeric() || c == '_' {
                self.pos += c.len_utf8();
            } else {
                break;
            }
        }

        Ok(self.input[start..self.pos].to_string())
    }

    /// Parse a label name: [a-zA-Z_][a-zA-Z0-9_:]*
    /// Labels may contain colons for namespaced types like "http:route".
    fn parse_label(&mut self) -> Result<String, ParseError> {
        self.skip_whitespace();
        let start = self.pos;

        // First char: letter or underscore
        if let Some(c) = self.remaining().chars().next() {
            if c.is_alphabetic() || c == '_' {
                self.pos += c.len_utf8();
            } else {
                return Err(ParseError::new("expected label", self.pos));
            }
        } else {
            return Err(ParseError::new("expected label", self.pos));
        }

        // Subsequent: alphanumeric, underscore, or colon (for namespaced types)
        while self.pos < self.input.len() {
            let c = self.input[self.pos..].chars().next().unwrap();
            if c.is_alphanumeric() || c == '_' || c == ':' {
                self.pos += c.len_utf8();
            } else {
                break;
            }
        }

        Ok(self.input[start..self.pos].to_string())
    }

    /// Parse a single-quoted or double-quoted string.
    fn parse_string(&mut self) -> Result<String, ParseError> {
        self.skip_whitespace();
        let quote = match self.remaining().chars().next() {
            Some('\'') => '\'',
            Some('"') => '"',
            _ => return Err(ParseError::new("expected string literal", self.pos)),
        };
        self.pos += 1; // consume opening quote

        let start = self.pos;
        while self.pos < self.input.len() {
            let c = self.input[self.pos..].chars().next().unwrap();
            if c == '\\' {
                // Skip escaped character
                self.pos += c.len_utf8();
                if self.pos < self.input.len() {
                    let escaped = self.input[self.pos..].chars().next().unwrap();
                    self.pos += escaped.len_utf8();
                }
            } else if c == quote {
                let value = self.input[start..self.pos].to_string();
                self.pos += 1; // consume closing quote
                return Ok(value);
            } else {
                self.pos += c.len_utf8();
            }
        }

        Err(ParseError::new("unterminated string", start))
    }

    /// Parse an integer literal.
    fn parse_integer(&mut self) -> Result<i64, ParseError> {
        self.skip_whitespace();
        let start = self.pos;
        let mut has_sign = false;

        // Optional sign
        if let Some(c) = self.remaining().chars().next() {
            if c == '-' || c == '+' {
                self.pos += 1;
                has_sign = true;
            }
        }

        let digit_start = self.pos;
        while self.pos < self.input.len() {
            let c = self.input[self.pos..].chars().next().unwrap();
            if c.is_ascii_digit() {
                self.pos += 1;
            } else {
                break;
            }
        }

        if self.pos == digit_start {
            return Err(ParseError::new("expected integer", start));
        }

        let _ = has_sign; // used by sign consumption above
        self.input[start..self.pos]
            .parse::<i64>()
            .map_err(|_| ParseError::new("invalid integer", start))
    }

    /// Parse a number (integer or float).
    fn parse_number(&mut self) -> Result<Expr, ParseError> {
        self.skip_whitespace();
        let start = self.pos;

        // Optional sign
        if let Some(c) = self.remaining().chars().next() {
            if c == '-' || c == '+' {
                self.pos += 1;
            }
        }

        let digit_start = self.pos;
        while self.pos < self.input.len() {
            let c = self.input[self.pos..].chars().next().unwrap();
            if c.is_ascii_digit() {
                self.pos += 1;
            } else {
                break;
            }
        }

        if self.pos == digit_start {
            return Err(ParseError::new("expected number", start));
        }

        // Check for decimal point
        let is_float = if self.pos < self.input.len() {
            let c = self.input[self.pos..].chars().next().unwrap();
            if c == '.' {
                self.pos += 1;
                while self.pos < self.input.len() {
                    let c = self.input[self.pos..].chars().next().unwrap();
                    if c.is_ascii_digit() {
                        self.pos += 1;
                    } else {
                        break;
                    }
                }
                true
            } else {
                false
            }
        } else {
            false
        };

        let text = &self.input[start..self.pos];
        if is_float {
            let f = text
                .parse::<f64>()
                .map_err(|_| ParseError::new("invalid float", start))?;
            Ok(Expr::Literal(CypherLiteral::Float(f)))
        } else {
            let i = text
                .parse::<i64>()
                .map_err(|_| ParseError::new("invalid integer", start))?;
            Ok(Expr::Literal(CypherLiteral::Int(i)))
        }
    }

    // ========================================================================
    // Query parsing
    // ========================================================================

    /// Top-level: MATCH pattern [WHERE expr] RETURN items [ORDER BY ...] [LIMIT n]
    fn parse_query(&mut self) -> Result<CypherQuery, ParseError> {
        self.expect_keyword("MATCH")?;
        let pattern = self.parse_pattern_chain()?;
        let match_clause = MatchClause { pattern };

        let where_clause = if self.keyword_ahead("WHERE") {
            self.expect_keyword("WHERE")?;
            Some(self.parse_expr()?)
        } else {
            None
        };

        self.expect_keyword("RETURN")?;
        let return_clause = self.parse_return_clause()?;

        let order_by = if self.keyword_ahead("ORDER") {
            self.expect_keyword("ORDER")?;
            self.expect_keyword("BY")?;
            Some(self.parse_order_items()?)
        } else {
            None
        };

        let limit = if self.keyword_ahead("LIMIT") {
            self.expect_keyword("LIMIT")?;
            Some(self.parse_integer()? as u64)
        } else {
            None
        };

        Ok(CypherQuery {
            match_clause,
            where_clause,
            return_clause,
            order_by,
            limit,
        })
    }

    // ========================================================================
    // Pattern parsing
    // ========================================================================

    /// Parse a pattern chain: node_pat (rel_pat node_pat)*
    fn parse_pattern_chain(&mut self) -> Result<PatternChain, ParseError> {
        let start = self.parse_node_pattern()?;
        let mut segments = Vec::new();

        loop {
            self.skip_whitespace();
            // Check if a relationship pattern follows: '-' or '<-'
            let rem = self.remaining();
            if rem.starts_with('-') || rem.starts_with('<') {
                let rel = self.parse_rel_pattern()?;
                let node = self.parse_node_pattern()?;
                segments.push((rel, node));
            } else {
                break;
            }
        }

        Ok(PatternChain { start, segments })
    }

    /// Parse a node pattern: '(' [variable] [':' label]* ['{' props '}'] ')'
    fn parse_node_pattern(&mut self) -> Result<NodePattern, ParseError> {
        self.expect("(")?;

        let mut variable = None;
        let mut labels = Vec::new();
        let mut properties = Vec::new();

        self.skip_whitespace();
        // Check what follows: ')', ':', '{', or identifier
        if let Some(c) = self.remaining().chars().next() {
            if c == ')' {
                // empty node pattern
            } else if c == ':' {
                // no variable, label follows
            } else if c == '{' {
                // no variable, properties follow
            } else {
                // variable name
                variable = Some(self.parse_identifier()?);
            }
        }

        // Parse labels
        loop {
            self.skip_whitespace();
            if let Some(':') = self.remaining().chars().next() {
                self.pos += 1;
                labels.push(self.parse_label()?);
            } else {
                break;
            }
        }

        // Parse inline properties
        self.skip_whitespace();
        if let Some('{') = self.remaining().chars().next() {
            self.pos += 1;
            properties = self.parse_inline_properties()?;
            self.expect("}")?;
        }

        self.expect(")")?;

        Ok(NodePattern {
            variable,
            labels,
            properties,
        })
    }

    /// Parse inline properties: key: value, key: value
    fn parse_inline_properties(&mut self) -> Result<Vec<(String, Expr)>, ParseError> {
        let mut props = Vec::new();

        self.skip_whitespace();
        if let Some('}') = self.remaining().chars().next() {
            return Ok(props);
        }

        loop {
            let key = self.parse_identifier()?;
            self.expect(":")?;
            let value = self.parse_primary()?;
            props.push((key, value));

            self.skip_whitespace();
            if let Some(',') = self.remaining().chars().next() {
                self.pos += 1;
            } else {
                break;
            }
        }

        Ok(props)
    }

    /// Parse a relationship pattern.
    ///
    /// Forms:
    /// - `-[...]->`  (outgoing)
    /// - `<-[...]- ` (incoming)
    /// - `-[...]-`   (bidirectional)
    fn parse_rel_pattern(&mut self) -> Result<RelPattern, ParseError> {
        self.skip_whitespace();

        let incoming_start = self.remaining().starts_with("<-");
        if incoming_start {
            // <-[...]-
            self.pos += 2; // consume '<-'
        } else {
            self.expect("-")?;
        }

        // Parse bracket contents
        let (variable, rel_types, length) = if self.peek() == Some('[') {
            self.expect("[")?;
            let (var, types, len) = self.parse_rel_bracket_contents()?;
            self.expect("]")?;
            (var, types, len)
        } else {
            (None, Vec::new(), None)
        };

        // Determine direction from closing
        self.skip_whitespace();
        let direction = if incoming_start {
            // Already consumed '<-', now expect '-'
            self.expect("-")?;
            Direction::Incoming
        } else if self.remaining().starts_with("->") {
            self.pos += 2;
            Direction::Outgoing
        } else if self.remaining().starts_with('-') {
            self.pos += 1;
            Direction::Both
        } else {
            return Err(ParseError::new(
                "expected '->' or '-' after relationship pattern",
                self.pos,
            ));
        };

        Ok(RelPattern {
            variable,
            rel_types,
            direction,
            length,
        })
    }

    /// Parse the contents inside [...] of a relationship pattern.
    /// [variable :TYPE|TYPE2 *min..max]
    fn parse_rel_bracket_contents(
        &mut self,
    ) -> Result<(Option<String>, Vec<String>, Option<(u32, u32)>), ParseError> {
        let mut variable = None;
        let mut rel_types = Vec::new();
        let mut length = None;

        self.skip_whitespace();
        // Check for variable or ':' or '*' or ']'
        if let Some(c) = self.remaining().chars().next() {
            if c == ']' {
                return Ok((variable, rel_types, length));
            }
            if c != ':' && c != '*' {
                // Must be a variable
                variable = Some(self.parse_identifier()?);
            }
        }

        // Parse relationship types
        self.skip_whitespace();
        if let Some(':') = self.remaining().chars().next() {
            self.pos += 1;
            rel_types.push(self.parse_label()?);

            // Multiple types with |
            loop {
                self.skip_whitespace();
                if let Some('|') = self.remaining().chars().next() {
                    self.pos += 1;
                    rel_types.push(self.parse_label()?);
                } else {
                    break;
                }
            }
        }

        // Parse variable-length: *min..max
        self.skip_whitespace();
        if let Some('*') = self.remaining().chars().next() {
            self.pos += 1;
            length = Some(self.parse_var_length()?);
        }

        Ok((variable, rel_types, length))
    }

    /// Parse variable-length specifier after '*': min..max
    fn parse_var_length(&mut self) -> Result<(u32, u32), ParseError> {
        self.skip_whitespace();
        let min = if self.remaining().chars().next().map(|c| c.is_ascii_digit()) == Some(true) {
            self.parse_integer()? as u32
        } else {
            1 // default min
        };

        self.expect("..")?;

        self.skip_whitespace();
        let max = if self.remaining().chars().next().map(|c| c.is_ascii_digit()) == Some(true) {
            self.parse_integer()? as u32
        } else {
            10 // default max
        };

        Ok((min, max))
    }

    // ========================================================================
    // RETURN clause
    // ========================================================================

    fn parse_return_clause(&mut self) -> Result<ReturnClause, ParseError> {
        let mut items = Vec::new();
        items.push(self.parse_return_item()?);

        loop {
            self.skip_whitespace();
            if let Some(',') = self.remaining().chars().next() {
                self.pos += 1;
                items.push(self.parse_return_item()?);
            } else {
                break;
            }
        }

        Ok(ReturnClause { items })
    }

    fn parse_return_item(&mut self) -> Result<ReturnItem, ParseError> {
        let expr = self.parse_expr()?;

        let alias = if self.keyword_ahead("AS") {
            self.expect_keyword("AS")?;
            Some(self.parse_identifier()?)
        } else {
            None
        };

        Ok(ReturnItem { expr, alias })
    }

    // ========================================================================
    // ORDER BY
    // ========================================================================

    fn parse_order_items(&mut self) -> Result<Vec<(Expr, SortDir)>, ParseError> {
        let mut items = Vec::new();
        items.push(self.parse_order_item()?);

        loop {
            self.skip_whitespace();
            if let Some(',') = self.remaining().chars().next() {
                self.pos += 1;
                items.push(self.parse_order_item()?);
            } else {
                break;
            }
        }

        Ok(items)
    }

    fn parse_order_item(&mut self) -> Result<(Expr, SortDir), ParseError> {
        let expr = self.parse_expr()?;

        let dir = if self.keyword_ahead("DESC") {
            self.expect_keyword("DESC")?;
            SortDir::Desc
        } else if self.keyword_ahead("ASC") {
            self.expect_keyword("ASC")?;
            SortDir::Asc
        } else {
            SortDir::Asc
        };

        Ok((expr, dir))
    }

    // ========================================================================
    // Expression parsing (precedence climbing)
    // ========================================================================

    fn parse_expr(&mut self) -> Result<Expr, ParseError> {
        self.parse_or_expr()
    }

    fn parse_or_expr(&mut self) -> Result<Expr, ParseError> {
        let mut left = self.parse_and_expr()?;

        loop {
            if self.keyword_ahead("OR") {
                self.expect_keyword("OR")?;
                let right = self.parse_and_expr()?;
                left = Expr::Or(Box::new(left), Box::new(right));
            } else {
                break;
            }
        }

        Ok(left)
    }

    fn parse_and_expr(&mut self) -> Result<Expr, ParseError> {
        let mut left = self.parse_not_expr()?;

        loop {
            if self.keyword_ahead("AND") {
                self.expect_keyword("AND")?;
                let right = self.parse_not_expr()?;
                left = Expr::And(Box::new(left), Box::new(right));
            } else {
                break;
            }
        }

        Ok(left)
    }

    fn parse_not_expr(&mut self) -> Result<Expr, ParseError> {
        if self.keyword_ahead("NOT") {
            self.expect_keyword("NOT")?;
            let inner = self.parse_not_expr()?;
            Ok(Expr::Not(Box::new(inner)))
        } else {
            self.parse_comparison()
        }
    }

    fn parse_comparison(&mut self) -> Result<Expr, ParseError> {
        let left = self.parse_primary()?;

        self.skip_whitespace();

        // Check for IS NULL / IS NOT NULL
        if self.keyword_ahead("IS") {
            let saved = self.pos;
            self.expect_keyword("IS")?;
            if self.keyword_ahead("NOT") {
                self.expect_keyword("NOT")?;
                self.expect_keyword("NULL")?;
                return Ok(Expr::IsNotNull(Box::new(left)));
            } else if self.keyword_ahead("NULL") {
                self.expect_keyword("NULL")?;
                return Ok(Expr::IsNull(Box::new(left)));
            } else {
                // Restore position — not IS NULL/IS NOT NULL
                self.pos = saved;
            }
        }

        // Check for CONTAINS
        if self.keyword_ahead("CONTAINS") {
            self.expect_keyword("CONTAINS")?;
            let right = self.parse_primary()?;
            return Ok(Expr::Contains(Box::new(left), Box::new(right)));
        }

        // Check for STARTS WITH
        if self.keyword_ahead("STARTS") {
            self.expect_keyword("STARTS")?;
            self.expect_keyword("WITH")?;
            let right = self.parse_primary()?;
            return Ok(Expr::StartsWith(Box::new(left), Box::new(right)));
        }

        // Check for ENDS WITH
        if self.keyword_ahead("ENDS") {
            self.expect_keyword("ENDS")?;
            self.expect_keyword("WITH")?;
            let right = self.parse_primary()?;
            return Ok(Expr::EndsWith(Box::new(left), Box::new(right)));
        }

        // Check for comparison operators
        let rem = self.remaining();
        if rem.starts_with("<>") {
            self.pos += 2;
            let right = self.parse_primary()?;
            return Ok(Expr::BinaryOp(
                Box::new(left),
                BinOp::Neq,
                Box::new(right),
            ));
        }
        if rem.starts_with("<=") {
            self.pos += 2;
            let right = self.parse_primary()?;
            return Ok(Expr::BinaryOp(
                Box::new(left),
                BinOp::Lte,
                Box::new(right),
            ));
        }
        if rem.starts_with(">=") {
            self.pos += 2;
            let right = self.parse_primary()?;
            return Ok(Expr::BinaryOp(
                Box::new(left),
                BinOp::Gte,
                Box::new(right),
            ));
        }
        if rem.starts_with('=') {
            self.pos += 1;
            let right = self.parse_primary()?;
            return Ok(Expr::BinaryOp(
                Box::new(left),
                BinOp::Eq,
                Box::new(right),
            ));
        }
        if rem.starts_with('<') {
            self.pos += 1;
            let right = self.parse_primary()?;
            return Ok(Expr::BinaryOp(
                Box::new(left),
                BinOp::Lt,
                Box::new(right),
            ));
        }
        if rem.starts_with('>') {
            self.pos += 1;
            let right = self.parse_primary()?;
            return Ok(Expr::BinaryOp(
                Box::new(left),
                BinOp::Gt,
                Box::new(right),
            ));
        }

        Ok(left)
    }

    fn parse_primary(&mut self) -> Result<Expr, ParseError> {
        self.skip_whitespace();

        let c = self.peek().ok_or_else(|| ParseError::new("unexpected end of input", self.pos))?;

        // Star
        if c == '*' {
            self.pos += 1;
            return Ok(Expr::Star);
        }

        // String literal
        if c == '\'' || c == '"' {
            let s = self.parse_string()?;
            return Ok(Expr::Literal(CypherLiteral::Str(s)));
        }

        // Parenthesized expression
        if c == '(' {
            self.pos += 1;
            let expr = self.parse_expr()?;
            self.expect(")")?;
            return Ok(expr);
        }

        // Number
        if c.is_ascii_digit() || (c == '-' && self.remaining().len() > 1 && self.remaining()[1..].starts_with(|c: char| c.is_ascii_digit())) {
            return self.parse_number();
        }

        // Boolean / NULL / identifier / property / function
        if c.is_alphabetic() || c == '_' {
            // Check for TRUE / FALSE / NULL keywords
            if self.keyword_ahead("TRUE") {
                self.expect_keyword("TRUE")?;
                return Ok(Expr::Literal(CypherLiteral::Bool(true)));
            }
            if self.keyword_ahead("FALSE") {
                self.expect_keyword("FALSE")?;
                return Ok(Expr::Literal(CypherLiteral::Bool(false)));
            }
            if self.keyword_ahead("NULL") {
                self.expect_keyword("NULL")?;
                return Ok(Expr::Literal(CypherLiteral::Null));
            }

            let ident = self.parse_identifier()?;

            self.skip_whitespace();
            // Property access: ident.prop
            if self.remaining().starts_with('.') {
                self.pos += 1;
                let prop = self.parse_identifier()?;
                return Ok(Expr::Property(ident, prop));
            }

            // Function call: ident(args)
            if self.remaining().starts_with('(') {
                self.pos += 1;
                let mut args = Vec::new();
                self.skip_whitespace();
                if self.remaining().starts_with(')') {
                    self.pos += 1;
                } else {
                    args.push(self.parse_expr()?);
                    loop {
                        self.skip_whitespace();
                        if self.remaining().starts_with(',') {
                            self.pos += 1;
                            args.push(self.parse_expr()?);
                        } else {
                            break;
                        }
                    }
                    self.expect(")")?;
                }
                // Normalize function name to uppercase for consistency
                return Ok(Expr::FunctionCall(ident.to_uppercase(), args));
            }

            // Plain variable reference
            return Ok(Expr::Variable(ident));
        }

        Err(ParseError::new(
            &format!("unexpected character '{}'", c),
            self.pos,
        ))
    }
}

// ============================================================================
// Public API
// ============================================================================

/// Parse a Cypher query string into an AST.
pub fn parse_cypher(input: &str) -> Result<CypherQuery, ParseError> {
    let mut parser = Parser::new(input);
    let query = parser.parse_query()?;
    parser.skip_whitespace();
    if parser.pos < parser.input.len() {
        return Err(ParseError::new(
            &format!("unexpected input after query: '{}'", parser.remaining()),
            parser.pos,
        ));
    }
    Ok(query)
}
