//! C/C++ parser: .c/.cpp/.h/.hpp files -> JSON AST using `clang-sys` (libclang FFI).
//!
//! Parses C/C++ source files into a JSON representation of the AST suitable for
//! Grafema's analysis pipeline. Uses libclang via the `clang-sys` crate with
//! runtime dynamic loading.
//!
//! Each AST node carries:
//! - `kind`: CXCursorKind mapped to a human-readable string
//! - `name`: cursor spelling (identifier name)
//! - `line`, `column`, `endLine`, `endColumn`: source location
//! - `children`: nested AST nodes
//! - Kind-specific fields (returnType, isStatic, access, etc.)

use anyhow::{Context, Result};
use clang_sys::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::path::{Path, PathBuf};
use std::ptr;

// ---------------------------------------------------------------------------
// CompileCommandsDb: compile_commands.json support
// ---------------------------------------------------------------------------

/// A single compile command entry.
#[derive(Debug, Clone)]
pub struct CompileCommand {
    /// Working directory for the compilation
    pub directory: PathBuf,
    /// Compiler arguments
    pub arguments: Vec<String>,
}

/// Parsed compile_commands.json database.
#[derive(Debug)]
pub struct CompileCommandsDb {
    entries: HashMap<PathBuf, CompileCommand>,
}

impl CompileCommandsDb {
    /// Load and parse a compile_commands.json file.
    pub fn load(path: &Path) -> Result<Self> {
        let content = std::fs::read_to_string(path)
            .with_context(|| format!("Failed to read compile_commands.json at {}", path.display()))?;
        let entries_json: Vec<Value> = serde_json::from_str(&content)
            .with_context(|| format!("Failed to parse compile_commands.json at {}", path.display()))?;

        let mut entries = HashMap::new();
        for entry in entries_json {
            let file = entry.get("file")
                .and_then(|v| v.as_str())
                .map(PathBuf::from);
            let directory = entry.get("directory")
                .and_then(|v| v.as_str())
                .map(PathBuf::from);

            if let (Some(file), Some(directory)) = (file, directory) {
                // Normalize file path: if relative, resolve against directory
                let abs_file = if file.is_relative() {
                    directory.join(&file)
                } else {
                    file
                };

                let arguments = if let Some(args) = entry.get("arguments").and_then(|v| v.as_array()) {
                    args.iter()
                        .filter_map(|a| a.as_str().map(String::from))
                        .collect()
                } else if let Some(command) = entry.get("command").and_then(|v| v.as_str()) {
                    shell_split(command)
                } else {
                    Vec::new()
                };

                entries.insert(abs_file, CompileCommand { directory, arguments });
            }
        }

        Ok(CompileCommandsDb { entries })
    }

    /// Get filtered compiler arguments for a specific file.
    ///
    /// Extracts only flags relevant for parsing: -I, -D, -std=, -isystem, -include.
    pub fn get_args(&self, file: &Path) -> Vec<String> {
        let canonical = file.canonicalize().unwrap_or_else(|_| file.to_path_buf());
        let cmd = self.entries.get(&canonical)
            .or_else(|| self.entries.get(file));

        match cmd {
            Some(cmd) => {
                let mut filtered = Vec::new();
                let mut iter = cmd.arguments.iter().peekable();
                while let Some(arg) = iter.next() {
                    if arg.starts_with("-I") || arg.starts_with("-D") || arg.starts_with("-std=") {
                        filtered.push(arg.clone());
                    } else if arg == "-isystem" || arg == "-include" {
                        filtered.push(arg.clone());
                        if let Some(next) = iter.next() {
                            filtered.push(next.clone());
                        }
                    } else if arg.starts_with("-isystem") || arg.starts_with("-include") {
                        filtered.push(arg.clone());
                    }
                }
                filtered
            }
            None => Vec::new(),
        }
    }
}

/// Simple shell-like argument splitting (handles quotes).
fn shell_split(command: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_single_quote = false;
    let mut in_double_quote = false;
    let mut escape_next = false;

    for ch in command.chars() {
        if escape_next {
            current.push(ch);
            escape_next = false;
            continue;
        }
        match ch {
            '\\' if !in_single_quote => escape_next = true,
            '\'' if !in_double_quote => in_single_quote = !in_single_quote,
            '"' if !in_single_quote => in_double_quote = !in_double_quote,
            ' ' | '\t' if !in_single_quote && !in_double_quote => {
                if !current.is_empty() {
                    args.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(ch),
        }
    }
    if !current.is_empty() {
        args.push(current);
    }
    args
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Parse a C/C++ source file at `path` and return a JSON AST value.
///
/// Uses libclang via FFI to parse the file and walk the cursor tree.
/// When `compile_commands` is provided, uses the file-specific flags from it.
pub fn parse_cpp_file(
    path: &Path,
    compile_commands: Option<&CompileCommandsDb>,
) -> Result<Value> {
    let source = std::fs::read_to_string(path)
        .with_context(|| format!("Failed to read C/C++ source file {}", path.display()))?;

    let filename = path.display().to_string();

    let mut args = compile_commands
        .map(|db| db.get_args(path))
        .unwrap_or_default();

    // Add default language mode if no -x or -std= flag is set
    let has_lang_flag = args.iter().any(|a| a.starts_with("-x") || a.starts_with("-std="));
    if !has_lang_flag {
        let is_c_file = path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e == "c")
            .unwrap_or(false);
        if is_c_file {
            args.extend_from_slice(&["-std=c11".to_string(), "-xc".to_string()]);
        } else {
            args.extend_from_slice(&["-std=c++17".to_string(), "-xc++".to_string()]);
        }
    }

    parse_cpp_source(&source, &filename, &args)
}

/// Parse C/C++ source text directly and return a JSON AST value.
///
/// The `filename` is used for diagnostics and to determine default language mode.
/// The `args` are passed directly to clang (e.g., `-std=c++17`, `-I/path`).
pub fn parse_cpp_source(source: &str, filename: &str, args: &[String]) -> Result<Value> {
    ensure_libclang_loaded()?;
    unsafe { parse_cpp_source_unsafe(source, filename, args) }
}

/// Ensure libclang is loaded exactly once (runtime feature requires explicit load).
fn ensure_libclang_loaded() -> Result<()> {
    use std::sync::Once;
    static INIT: Once = Once::new();
    static mut INIT_ERR: Option<String> = None;

    INIT.call_once(|| {
        // clang-sys `load()!` macro is not usable here; use the function form
        if let Err(e) = clang_sys::load() {
            unsafe { INIT_ERR = Some(format!("Failed to load libclang: {e}")); }
        }
    });

    unsafe {
        if let Some(ref err) = INIT_ERR {
            anyhow::bail!("{err}");
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Unsafe FFI implementation
// ---------------------------------------------------------------------------

unsafe fn parse_cpp_source_unsafe(
    source: &str,
    filename: &str,
    args: &[String],
) -> Result<Value> {
    // Create index (excludeDeclarationsFromPCH=0, displayDiagnostics=0)
    let index = clang_createIndex(0, 0);
    if index.is_null() {
        anyhow::bail!("Failed to create clang index");
    }

    // Prepare filename and args as C strings
    let c_filename = CString::new(filename)
        .with_context(|| format!("Invalid filename for clang: {filename}"))?;

    let c_args: Vec<CString> = args.iter()
        .map(|a| CString::new(a.as_str()).unwrap_or_else(|_| CString::new("").unwrap()))
        .collect();
    let c_arg_ptrs: Vec<*const i8> = c_args.iter().map(|a| a.as_ptr()).collect();

    // Create an unsaved file so we can parse from memory
    let c_source = CString::new(source)
        .unwrap_or_else(|_| CString::new("").unwrap());
    let unsaved = CXUnsavedFile {
        Filename: c_filename.as_ptr(),
        Contents: c_source.as_ptr(),
        Length: source.len() as u64,
    };

    // Parse with detailed preprocessing record for macro tracking
    let options = CXTranslationUnit_DetailedPreprocessingRecord;
    let tu = clang_parseTranslationUnit(
        index,
        c_filename.as_ptr(),
        if c_arg_ptrs.is_empty() { ptr::null() } else { c_arg_ptrs.as_ptr() },
        c_arg_ptrs.len() as i32,
        &unsaved as *const CXUnsavedFile as *mut CXUnsavedFile,
        1,
        options,
    );

    if tu.is_null() {
        clang_disposeIndex(index);
        anyhow::bail!("Failed to parse translation unit for {filename}");
    }

    // Get root cursor and walk the tree
    let root_cursor = clang_getTranslationUnitCursor(tu);
    let children = visit_children(root_cursor, tu);

    // Build the top-level AST object
    let ast = json!({
        "kind": "TranslationUnit",
        "name": filename,
        "children": children,
    });

    // Cleanup
    clang_disposeTranslationUnit(tu);
    clang_disposeIndex(index);

    Ok(ast)
}

// ---------------------------------------------------------------------------
// Cursor visitor
// ---------------------------------------------------------------------------

/// Visit all children of a cursor, filtering to main file only.
unsafe fn visit_children(cursor: CXCursor, tu: CXTranslationUnit) -> Vec<Value> {
    struct VisitorData {
        children: Vec<Value>,
        tu: CXTranslationUnit,
    }

    extern "C" fn visitor_callback(
        cursor: CXCursor,
        _parent: CXCursor,
        client_data: CXClientData,
    ) -> CXChildVisitResult {
        unsafe {
            let data = &mut *(client_data as *mut VisitorData);

            // Filter to main file only
            let location = clang_getCursorLocation(cursor);
            if clang_Location_isFromMainFile(location) == 0 {
                return CXChildVisit_Continue;
            }

            let node = cursor_to_json(cursor, data.tu);
            data.children.push(node);

            CXChildVisit_Continue
        }
    }

    let mut data = VisitorData {
        children: Vec::new(),
        tu,
    };

    clang_visitChildren(
        cursor,
        visitor_callback,
        &mut data as *mut VisitorData as CXClientData,
    );

    data.children
}

/// Visit all direct children of a cursor (does not filter by main file).
unsafe fn visit_children_recursive(cursor: CXCursor, tu: CXTranslationUnit) -> Vec<Value> {
    struct VisitorData {
        children: Vec<Value>,
        tu: CXTranslationUnit,
    }

    extern "C" fn visitor_callback(
        cursor: CXCursor,
        _parent: CXCursor,
        client_data: CXClientData,
    ) -> CXChildVisitResult {
        unsafe {
            let data = &mut *(client_data as *mut VisitorData);
            let node = cursor_to_json(cursor, data.tu);
            data.children.push(node);
            CXChildVisit_Continue
        }
    }

    let mut data = VisitorData {
        children: Vec::new(),
        tu,
    };

    clang_visitChildren(
        cursor,
        visitor_callback,
        &mut data as *mut VisitorData as CXClientData,
    );

    data.children
}

// ---------------------------------------------------------------------------
// CXCursor -> JSON conversion
// ---------------------------------------------------------------------------

/// Convert a CXCursor to a JSON node with kind-specific fields.
unsafe fn cursor_to_json(cursor: CXCursor, tu: CXTranslationUnit) -> Value {
    let kind = clang_getCursorKind(cursor);
    let kind_str = cursor_kind_to_string(kind);
    let name = cx_string_to_string(clang_getCursorSpelling(cursor));

    // Get source location
    let location = clang_getCursorLocation(cursor);
    let mut file: CXFile = ptr::null_mut();
    let mut line: u32 = 0;
    let mut column: u32 = 0;
    let mut _offset: u32 = 0;
    clang_getExpansionLocation(location, &mut file, &mut line, &mut column, &mut _offset);

    // Get source range end
    let extent = clang_getCursorExtent(cursor);
    let end_loc = clang_getRangeEnd(extent);
    let mut _end_file: CXFile = ptr::null_mut();
    let mut end_line: u32 = 0;
    let mut end_column: u32 = 0;
    let mut _end_offset: u32 = 0;
    clang_getExpansionLocation(end_loc, &mut _end_file, &mut end_line, &mut end_column, &mut _end_offset);

    // Build children
    let children = visit_children_recursive(cursor, tu);

    // Start with base fields
    let mut node = json!({
        "kind": kind_str,
        "name": name,
        "line": line,
        "column": column,
        "endLine": end_line,
        "endColumn": end_column,
    });

    // Add children only if non-empty
    if !children.is_empty() {
        node["children"] = json!(children);
    }

    // Add kind-specific fields
    add_kind_specific_fields(&mut node, cursor, kind, tu);

    // Extract named fields from children based on cursor kind
    add_named_fields(&mut node, kind_str);

    node
}

/// Add kind-specific metadata fields to a JSON node.
unsafe fn add_kind_specific_fields(
    node: &mut Value,
    cursor: CXCursor,
    kind: CXCursorKind,
    tu: CXTranslationUnit,
) {
    match kind {
        // Function/Method declarations
        CXCursor_FunctionDecl | CXCursor_CXXMethod => {
            let result_type = clang_getCursorResultType(cursor);
            node["returnType"] = json!(cx_string_to_string(clang_getTypeSpelling(result_type)));
            node["isStatic"] = json!(clang_CXXMethod_isStatic(cursor) != 0);
            node["isInline"] = json!(clang_Cursor_isFunctionInlined(cursor) != 0);
            node["isVirtual"] = json!(clang_CXXMethod_isVirtual(cursor) != 0);
            node["isConst"] = json!(clang_CXXMethod_isConst(cursor) != 0);
            node["isPureVirtual"] = json!(clang_CXXMethod_isPureVirtual(cursor) != 0);
            node["storageClass"] = json!(storage_class_to_string(clang_Cursor_getStorageClass(cursor)));
            node["access"] = json!(access_specifier_to_string(clang_getCXXAccessSpecifier(cursor)));

            // Check variadic
            let cursor_type = clang_getCursorType(cursor);
            node["isVariadic"] = json!(clang_isFunctionTypeVariadic(cursor_type) != 0);
        }

        // Variable declarations
        CXCursor_VarDecl => {
            let var_type = clang_getCursorType(cursor);
            node["type"] = json!(cx_string_to_string(clang_getTypeSpelling(var_type)));
            node["storageClass"] = json!(storage_class_to_string(clang_Cursor_getStorageClass(cursor)));
            node["isConst"] = json!(clang_isConstQualifiedType(var_type) != 0);
        }

        // Parameter declarations
        CXCursor_ParmDecl => {
            let param_type = clang_getCursorType(cursor);
            node["type"] = json!(cx_string_to_string(clang_getTypeSpelling(param_type)));
        }

        // Field declarations
        CXCursor_FieldDecl => {
            let field_type = clang_getCursorType(cursor);
            node["type"] = json!(cx_string_to_string(clang_getTypeSpelling(field_type)));
            node["access"] = json!(access_specifier_to_string(clang_getCXXAccessSpecifier(cursor)));
            node["isMutable"] = json!(clang_CXXField_isMutable(cursor) != 0);
            // Check for bit field
            let bit_width = clang_getFieldDeclBitWidth(cursor);
            if bit_width >= 0 {
                node["bitWidth"] = json!(bit_width);
            }
        }

        // Class/Struct declarations
        CXCursor_ClassDecl | CXCursor_StructDecl => {
            node["access"] = json!(access_specifier_to_string(clang_getCXXAccessSpecifier(cursor)));
            node["isAnonymous"] = json!(clang_Cursor_isAnonymous(cursor) != 0);
            node["isAbstract"] = json!(clang_CXXRecord_isAbstract(cursor) != 0);
        }

        // Enum declarations
        CXCursor_EnumDecl => {
            let enum_type = clang_getEnumDeclIntegerType(cursor);
            node["underlyingType"] = json!(cx_string_to_string(clang_getTypeSpelling(enum_type)));
            // Check scoped enum (enum class)
            node["isScoped"] = json!(clang_EnumDecl_isScoped(cursor) != 0);
        }

        // Enum constant
        CXCursor_EnumConstantDecl => {
            let value = clang_getEnumConstantDeclValue(cursor);
            node["value"] = json!(value);
        }

        // Namespace
        CXCursor_Namespace => {
            node["isAnonymous"] = json!(clang_Cursor_isAnonymous(cursor) != 0);
            node["isInline"] = json!(clang_Cursor_isInlineNamespace(cursor) != 0);
        }

        // Typedef / Type alias
        CXCursor_TypedefDecl | CXCursor_TypeAliasDecl => {
            let underlying = clang_getTypedefDeclUnderlyingType(cursor);
            node["underlyingType"] = json!(cx_string_to_string(clang_getTypeSpelling(underlying)));
        }

        // Constructor
        CXCursor_Constructor => {
            node["access"] = json!(access_specifier_to_string(clang_getCXXAccessSpecifier(cursor)));
            node["isExplicit"] = json!(clang_CXXConstructor_isConvertingConstructor(cursor) == 0);
            node["isDefaulted"] = json!(clang_CXXMethod_isDefaulted(cursor) != 0);
            node["isCopy"] = json!(clang_CXXConstructor_isCopyConstructor(cursor) != 0);
            node["isMove"] = json!(clang_CXXConstructor_isMoveConstructor(cursor) != 0);
        }

        // Destructor
        CXCursor_Destructor => {
            node["isVirtual"] = json!(clang_CXXMethod_isVirtual(cursor) != 0);
            node["isDefaulted"] = json!(clang_CXXMethod_isDefaulted(cursor) != 0);
            node["access"] = json!(access_specifier_to_string(clang_getCXXAccessSpecifier(cursor)));
        }

        // Conversion function
        CXCursor_ConversionFunction => {
            let conv_type = clang_getCursorResultType(cursor);
            node["conversionType"] = json!(cx_string_to_string(clang_getTypeSpelling(conv_type)));
            node["access"] = json!(access_specifier_to_string(clang_getCXXAccessSpecifier(cursor)));
        }

        // Using directive (using namespace X)
        CXCursor_UsingDirective => {
            let referenced = clang_getCursorReferenced(cursor);
            if !clang_Cursor_isNull(referenced) != 0 {
                node["namespace"] = json!(cx_string_to_string(clang_getCursorSpelling(referenced)));
            }
        }

        // Using declaration
        CXCursor_UsingDeclaration => {
            let referenced = clang_getCursorReferenced(cursor);
            if !clang_Cursor_isNull(referenced) != 0 {
                node["target"] = json!(cx_string_to_string(clang_getCursorSpelling(referenced)));
            }
        }

        // Base specifier (inheritance)
        CXCursor_CXXBaseSpecifier => {
            let base_type = clang_getCursorType(cursor);
            node["baseName"] = json!(cx_string_to_string(clang_getTypeSpelling(base_type)));
            node["access"] = json!(access_specifier_to_string(clang_getCXXAccessSpecifier(cursor)));
            node["isVirtual"] = json!(clang_isVirtualBase(cursor) != 0);
        }

        // Access specifier
        CXCursor_CXXAccessSpecifier => {
            node["access"] = json!(access_specifier_to_string(clang_getCXXAccessSpecifier(cursor)));
        }

        // Call expression
        CXCursor_CallExpr => {
            let referenced = clang_getCursorReferenced(cursor);
            if clang_Cursor_isNull(referenced) == 0 {
                node["callee"] = json!(cx_string_to_string(clang_getCursorSpelling(referenced)));
            }
        }

        // Member reference expression
        CXCursor_MemberRefExpr => {
            let referenced = clang_getCursorReferenced(cursor);
            if clang_Cursor_isNull(referenced) == 0 {
                node["member"] = json!(cx_string_to_string(clang_getCursorSpelling(referenced)));
            }
        }

        // Declaration reference expression
        CXCursor_DeclRefExpr => {
            let referenced = clang_getCursorReferenced(cursor);
            if clang_Cursor_isNull(referenced) == 0 {
                node["ref"] = json!(cx_string_to_string(clang_getCursorSpelling(referenced)));
            }
        }

        // Binary/Unary operators — extract operator text from tokens
        CXCursor_BinaryOperator | CXCursor_CompoundAssignOperator => {
            if let Some(op) = extract_operator_token(cursor, tu, true) {
                node["operator"] = json!(op);
            }
        }
        CXCursor_UnaryOperator => {
            if let Some(op) = extract_operator_token(cursor, tu, false) {
                node["operator"] = json!(op);
            }
        }

        // C-style and C++ casts
        CXCursor_CStyleCastExpr => {
            let cast_type = clang_getCursorType(cursor);
            node["targetType"] = json!(cx_string_to_string(clang_getTypeSpelling(cast_type)));
        }

        // C++ named casts
        CXCursor_CXXStaticCastExpr | CXCursor_CXXDynamicCastExpr
        | CXCursor_CXXReinterpretCastExpr | CXCursor_CXXConstCastExpr => {
            let cast_type = clang_getCursorType(cursor);
            node["targetType"] = json!(cx_string_to_string(clang_getTypeSpelling(cast_type)));
        }

        // new/delete expressions
        CXCursor_CXXNewExpr => {
            let alloc_type = clang_getCursorType(cursor);
            node["type"] = json!(cx_string_to_string(clang_getTypeSpelling(alloc_type)));
        }
        CXCursor_CXXDeleteExpr => {
            // isArray is available through type analysis
        }

        // Lambda expression
        CXCursor_LambdaExpr => {
            // Captures and parameters are in children
        }

        // Preprocessor directives
        CXCursor_MacroDefinition => {
            node["isFunctionLike"] = json!(clang_Cursor_isMacroFunctionLike(cursor) != 0);
        }
        CXCursor_MacroExpansion => {
            let referenced = clang_getCursorReferenced(cursor);
            if clang_Cursor_isNull(referenced) == 0 {
                node["macroName"] = json!(cx_string_to_string(clang_getCursorSpelling(referenced)));
            } else {
                node["macroName"] = json!(cx_string_to_string(clang_getCursorSpelling(cursor)));
            }
        }
        CXCursor_InclusionDirective => {
            let included_file = clang_getIncludedFile(cursor);
            if !included_file.is_null() {
                node["path"] = json!(cx_string_to_string(clang_getFileName(included_file)));
            }
        }

        // Control flow
        CXCursor_GotoStmt => {
            let label_cursor = clang_getCursorReferenced(cursor);
            if clang_Cursor_isNull(label_cursor) == 0 {
                node["label"] = json!(cx_string_to_string(clang_getCursorSpelling(label_cursor)));
            }
        }
        CXCursor_LabelStmt => {
            node["label"] = json!(cx_string_to_string(clang_getCursorSpelling(cursor)));
        }

        // Template parameters
        CXCursor_TemplateTypeParameter | CXCursor_NonTypeTemplateParameter
        | CXCursor_TemplateTemplateParameter => {
            // Name is already captured in the base fields
        }

        // Catch statement
        CXCursor_CXXCatchStmt => {
            // The caught type is in the first child (VarDecl)
        }

        // Friend declaration
        CXCursor_FriendDecl => {
            // Friend details are in children
        }

        // Attribute cursors: C++11 [[...]], __attribute__((...)), final, override
        CXCursor_UnexposedAttr | CXCursor_AnnotateAttr | CXCursor_WarnUnusedResultAttr
        | CXCursor_CXXFinalAttr | CXCursor_CXXOverrideAttr => {
            // Get the spelling for the attribute name
            let spelling = cx_string_to_string(clang_getCursorSpelling(cursor));
            if !spelling.is_empty() {
                node["attributeName"] = json!(spelling);
            }
        }

        _ => {
            // No additional fields for other cursor kinds
        }
    }
}

// ---------------------------------------------------------------------------
// Operator extraction from tokens
// ---------------------------------------------------------------------------

/// Binary/unary operator symbols that libclang tokenizes as punctuation.
const BINARY_OPS: &[&str] = &[
    "<<=", ">>=", "&&", "||", "==", "!=", "<=", ">=", "<<", ">>", "+=", "-=",
    "*=", "/=", "%=", "&=", "|=", "^=", "->", "<=>",
    "+", "-", "*", "/", "%", "&", "|", "^", "<", ">", "=", ",",
];

const UNARY_OPS: &[&str] = &["++", "--", "!", "~", "*", "&", "-", "+"];

/// Extract the operator token from a BinaryOperator/UnaryOperator cursor using
/// libclang's token API.
///
/// For binary operators, we look for the punctuation token between the two children.
/// For unary operators, we look for the punctuation token that is the operator.
unsafe fn extract_operator_token(
    cursor: CXCursor,
    tu: CXTranslationUnit,
    is_binary: bool,
) -> Option<String> {
    let range = clang_getCursorExtent(cursor);
    let mut tokens: *mut CXToken = ptr::null_mut();
    let mut num_tokens: u32 = 0;
    clang_tokenize(tu, range, &mut tokens, &mut num_tokens);

    if tokens.is_null() || num_tokens == 0 {
        return None;
    }

    let ops = if is_binary { BINARY_OPS } else { UNARY_OPS };
    let mut result = None;

    // For binary: find the operator token that matches a known operator.
    // For multi-token operators like <<=, we need to check longer matches first,
    // which our ops list already handles (sorted by length descending).
    // Strategy: collect all punctuation tokens, try to match from longest to shortest.
    let mut punctuation_tokens = Vec::new();
    for i in 0..num_tokens {
        let token = *tokens.add(i as usize);
        let kind = clang_getTokenKind(token);
        if kind == CXToken_Punctuation {
            let spelling = cx_string_to_string(clang_getTokenSpelling(tu, token));
            punctuation_tokens.push(spelling);
        }
    }

    if is_binary {
        // For binary operators, find the operator among punctuation tokens.
        // Skip parentheses and brackets, find the first matching operator.
        for tok in &punctuation_tokens {
            if ops.contains(&tok.as_str()) && tok != "(" && tok != ")" && tok != "[" && tok != "]" {
                result = Some(tok.clone());
                break;
            }
        }
    } else {
        // For unary operators, the operator is typically the first or last punctuation token
        for tok in &punctuation_tokens {
            if ops.contains(&tok.as_str()) {
                result = Some(tok.clone());
                break;
            }
        }
    }

    clang_disposeTokens(tu, tokens, num_tokens);
    result
}

// ---------------------------------------------------------------------------
// Named field extraction from children
// ---------------------------------------------------------------------------

/// Helper to get a child's "kind" field as &str.
fn child_kind<'a>(child: &'a Value) -> Option<&'a str> {
    child.get("kind").and_then(|k| k.as_str())
}

/// Extract named fields from the `children` array based on the node's kind.
///
/// This enriches the flat `children` array with semantically named fields
/// (e.g., `body`, `params`, `condition`, `lhs`, `rhs`) that the Haskell
/// analyzer expects via `lookupNodeField` / `lookupNodesField`.
///
/// The `children` array is preserved for backwards compatibility.
fn add_named_fields(node: &mut Value, kind_str: &str) {
    // Get children as an array; if absent, nothing to extract
    let children: Vec<Value> = match node.get("children").and_then(|c| c.as_array()) {
        Some(arr) => arr.clone(),
        None => return,
    };

    match kind_str {
        // -------------------------------------------------------------------
        // Declarations
        // -------------------------------------------------------------------
        "FunctionDecl" | "MethodDecl" | "ConstructorDecl" | "DestructorDecl"
        | "ConversionDecl" => {
            let params: Vec<&Value> = children.iter()
                .filter(|c| child_kind(c) == Some("ParamDecl"))
                .collect();
            node["params"] = json!(params);

            if let Some(body) = children.iter().find(|c| child_kind(c) == Some("CompoundStmt")) {
                node["body"] = body.clone();
            }

            // Constructor initializer list
            if kind_str == "ConstructorDecl" {
                let initializers: Vec<&Value> = children.iter()
                    .filter(|c| {
                        child_kind(c).map_or(false, |k| k.starts_with("MemberRef"))
                    })
                    .collect();
                if !initializers.is_empty() {
                    node["initializerList"] = json!(initializers);
                }
            }
        }

        "VarDecl" => {
            // init: first child that is NOT TypeRef/TemplateRef
            if let Some(init) = children.iter().find(|c| {
                let k = child_kind(c);
                k != Some("TypeRef") && k != Some("TemplateRef")
            }) {
                node["init"] = init.clone();
            }
        }

        // -------------------------------------------------------------------
        // Statements
        // -------------------------------------------------------------------
        "IfStmt" => {
            // libclang children order: [condition, then-body, else-body?]
            // C++17 if-init: first child is DeclStmt before condition
            let first_is_decl = children.first()
                .map_or(false, |c| child_kind(c) == Some("DeclStmt"));

            if first_is_decl && children.len() >= 3 {
                // C++17 if with init-statement
                node["init"] = children[0].clone();
                node["condition"] = children[1].clone();
                node["then"] = children[2].clone();
                if children.len() >= 4 {
                    node["else"] = children[3].clone();
                }
            } else if children.len() >= 2 {
                node["condition"] = children[0].clone();
                node["then"] = children[1].clone();
                if children.len() >= 3 {
                    node["else"] = children[2].clone();
                }
            } else if children.len() == 1 {
                node["condition"] = children[0].clone();
            }
        }

        "ForStmt" => {
            // children order: [init, condition, increment, body]
            if children.len() >= 1 { node["init"] = children[0].clone(); }
            if children.len() >= 2 { node["condition"] = children[1].clone(); }
            if children.len() >= 3 { node["increment"] = children[2].clone(); }
            if children.len() >= 4 { node["body"] = children[3].clone(); }
        }

        "WhileStmt" => {
            // [condition, body]
            if children.len() >= 1 { node["condition"] = children[0].clone(); }
            if children.len() >= 2 { node["body"] = children[1].clone(); }
        }

        "DoStmt" => {
            // [body, condition]
            if children.len() >= 1 { node["body"] = children[0].clone(); }
            if children.len() >= 2 { node["condition"] = children[1].clone(); }
        }

        "SwitchStmt" => {
            // Possibly [init-DeclStmt, condition, body-CompoundStmt]
            let first_is_decl = children.first()
                .map_or(false, |c| child_kind(c) == Some("DeclStmt"));

            if first_is_decl && children.len() >= 2 {
                node["init"] = children[0].clone();
                // condition is next non-DeclStmt
                node["condition"] = children[1].clone();
                if let Some(body) = children.iter().find(|c| child_kind(c) == Some("CompoundStmt")) {
                    node["body"] = body.clone();
                }
            } else {
                // First non-DeclStmt is condition
                if let Some(cond) = children.iter().find(|c| child_kind(c) != Some("DeclStmt")) {
                    node["condition"] = cond.clone();
                }
                if let Some(body) = children.iter().find(|c| child_kind(c) == Some("CompoundStmt")) {
                    node["body"] = body.clone();
                }
            }
        }

        "CaseStmt" => {
            // [value, statement]
            if children.len() >= 1 { node["value"] = children[0].clone(); }
        }

        "ReturnStmt" => {
            // [expr?]
            if children.len() >= 1 { node["expr"] = children[0].clone(); }
        }

        "RangeForStmt" => {
            // [declaration, range, body]
            if children.len() >= 1 { node["declaration"] = children[0].clone(); }
            if children.len() >= 2 { node["range"] = children[1].clone(); }
            if children.len() >= 3 { node["body"] = children[2].clone(); }
        }

        "GotoStmt" => {
            // stmt field with label reference — label is already extracted in add_kind_specific_fields
            if children.len() >= 1 { node["stmt"] = children[0].clone(); }
        }

        "LabelStmt" => {
            // stmt field with the labeled statement
            if children.len() >= 1 { node["stmt"] = children[0].clone(); }
        }

        // -------------------------------------------------------------------
        // Expressions
        // -------------------------------------------------------------------
        "CallExpr" => {
            if !children.is_empty() {
                // First child is the callee expression
                node["callee"] = children[0].clone();

                // For member calls, if first child is MemberRefExpr, extract receiver name
                if child_kind(&children[0]) == Some("MemberRefExpr") {
                    if let Some(receiver_children) = children[0].get("children").and_then(|c| c.as_array()) {
                        if !receiver_children.is_empty() {
                            // Set receiver as the name/spelling of the receiver object
                            let receiver_name = receiver_children[0]
                                .get("name")
                                .and_then(|n| n.as_str())
                                .unwrap_or("<obj>");
                            node["receiver"] = json!(receiver_name);
                        }
                    }
                }

                // args: all children after the 1st
                if children.len() > 1 {
                    let args: Vec<&Value> = children[1..].iter().collect();
                    node["args"] = json!(args);
                }
            }
        }

        "BinaryOperator" | "CompoundAssignOperator" => {
            if children.len() >= 1 { node["lhs"] = children[0].clone(); }
            if children.len() >= 2 { node["rhs"] = children[1].clone(); }
        }

        "UnaryOperator" => {
            if children.len() >= 1 { node["operand"] = children[0].clone(); }
        }

        "ConditionalOperator" => {
            // [condition, then, else]
            if children.len() >= 1 { node["condition"] = children[0].clone(); }
            if children.len() >= 2 { node["then"] = children[1].clone(); }
            if children.len() >= 3 { node["else"] = children[2].clone(); }
        }

        "CStyleCastExpr" | "StaticCastExpr" | "DynamicCastExpr" | "ReinterpretCastExpr"
        | "ConstCastExpr" | "FunctionalCastExpr" => {
            // expr: the casted expression (first child)
            if children.len() >= 1 { node["expr"] = children[0].clone(); }
        }

        "NewExpr" => {
            // args: all children (constructor arguments)
            if !children.is_empty() {
                let args: Vec<&Value> = children.iter().collect();
                node["args"] = json!(args);
            }
        }

        "DeleteExpr" => {
            if children.len() >= 1 { node["operand"] = children[0].clone(); }
        }

        "MemberRefExpr" => {
            // base: first child (the object being accessed)
            if children.len() >= 1 { node["base"] = children[0].clone(); }
        }

        "ArraySubscriptExpr" => {
            if children.len() >= 1 { node["array"] = children[0].clone(); }
            if children.len() >= 2 { node["index"] = children[1].clone(); }
        }

        "ParenExpr" => {
            if children.len() >= 1 { node["inner"] = children[0].clone(); }
        }

        "InitListExpr" => {
            let elements: Vec<&Value> = children.iter().collect();
            node["elements"] = json!(elements);
        }

        "UnaryExpr" => {
            // sizeof/alignof
            if children.len() >= 1 { node["operand"] = children[0].clone(); }
        }

        "ThrowExpr" => {
            if children.len() >= 1 { node["operand"] = children[0].clone(); }
        }

        // -------------------------------------------------------------------
        // Error flow
        // -------------------------------------------------------------------
        "TryStmt" => {
            if let Some(body) = children.iter().find(|c| child_kind(c) == Some("CompoundStmt")) {
                node["body"] = body.clone();
            }
            let catches: Vec<&Value> = children.iter()
                .filter(|c| child_kind(c) == Some("CatchStmt"))
                .collect();
            if !catches.is_empty() {
                node["catches"] = json!(catches);
            }
        }

        "CatchStmt" => {
            if let Some(body) = children.iter().find(|c| child_kind(c) == Some("CompoundStmt")) {
                node["body"] = body.clone();
            }
            // caughtType: first VarDecl child (the exception variable)
            if let Some(var) = children.iter().find(|c| child_kind(c) == Some("VarDecl")) {
                if let Some(t) = var.get("type").and_then(|v| v.as_str()) {
                    node["caughtType"] = json!(t);
                }
            }
        }

        // -------------------------------------------------------------------
        // Lambdas
        // -------------------------------------------------------------------
        "LambdaExpr" => {
            if let Some(body) = children.iter().find(|c| child_kind(c) == Some("CompoundStmt")) {
                node["body"] = body.clone();
            }
            let params: Vec<&Value> = children.iter()
                .filter(|c| child_kind(c) == Some("ParamDecl"))
                .collect();
            if !params.is_empty() {
                node["params"] = json!(params);
            }
        }

        // -------------------------------------------------------------------
        // Templates
        // -------------------------------------------------------------------
        "ClassTemplate" | "FunctionTemplate" => {
            let template_params: Vec<&Value> = children.iter()
                .filter(|c| {
                    let k = child_kind(c);
                    k == Some("TemplateTypeParam")
                        || k == Some("TemplateNonTypeParam")
                        || k == Some("TemplateTemplateParam")
                })
                .collect();
            if !template_params.is_empty() {
                node["templateParams"] = json!(template_params);
            }

            // declaration: the actual class/function child (if nested)
            if let Some(decl) = children.iter().find(|c| {
                let k = child_kind(c);
                k == Some("ClassDecl") || k == Some("StructDecl")
                    || k == Some("FunctionDecl") || k == Some("MethodDecl")
            }) {
                node["declaration"] = decl.clone();
            }

            // FunctionTemplate: libclang often inlines the function's children
            // (params + body) directly rather than nesting a FunctionDecl.
            // Extract params and body for the analyzer.
            if kind_str == "FunctionTemplate" {
                let params: Vec<&Value> = children.iter()
                    .filter(|c| child_kind(c) == Some("ParamDecl"))
                    .collect();
                if !params.is_empty() {
                    node["params"] = json!(params);
                }
                if let Some(body) = children.iter().find(|c| child_kind(c) == Some("CompoundStmt")) {
                    node["body"] = body.clone();
                }
            }
        }

        _ => {
            // No named fields for other kinds
        }
    }
}

// ---------------------------------------------------------------------------
// Helper: CXCursorKind -> string
// ---------------------------------------------------------------------------

/// Map a CXCursorKind to a human-readable string.
fn cursor_kind_to_string(kind: CXCursorKind) -> &'static str {
    match kind {
        // Declarations
        CXCursor_UnexposedDecl => "UnexposedDecl",
        CXCursor_StructDecl => "StructDecl",
        CXCursor_UnionDecl => "UnionDecl",
        CXCursor_ClassDecl => "ClassDecl",
        CXCursor_EnumDecl => "EnumDecl",
        CXCursor_FieldDecl => "FieldDecl",
        CXCursor_EnumConstantDecl => "EnumConstantDecl",
        CXCursor_FunctionDecl => "FunctionDecl",
        CXCursor_VarDecl => "VarDecl",
        CXCursor_ParmDecl => "ParamDecl",
        CXCursor_TypedefDecl => "TypedefDecl",
        CXCursor_CXXMethod => "MethodDecl",
        CXCursor_Namespace => "Namespace",
        CXCursor_LinkageSpec => "LinkageSpec",
        CXCursor_Constructor => "ConstructorDecl",
        CXCursor_Destructor => "DestructorDecl",
        CXCursor_ConversionFunction => "ConversionDecl",
        CXCursor_TemplateTypeParameter => "TemplateTypeParam",
        CXCursor_NonTypeTemplateParameter => "TemplateNonTypeParam",
        CXCursor_TemplateTemplateParameter => "TemplateTemplateParam",
        CXCursor_FunctionTemplate => "FunctionTemplate",
        CXCursor_ClassTemplate => "ClassTemplate",
        CXCursor_ClassTemplatePartialSpecialization => "ClassTemplatePartialSpec",
        CXCursor_NamespaceAlias => "NamespaceAlias",
        CXCursor_UsingDirective => "UsingDirective",
        CXCursor_UsingDeclaration => "UsingDeclaration",
        CXCursor_TypeAliasDecl => "TypeAliasDecl",
        CXCursor_CXXAccessSpecifier => "AccessSpecifier",
        CXCursor_TypeAliasTemplateDecl => "TypeAliasTemplateDecl",
        CXCursor_StaticAssert => "StaticAssert",
        CXCursor_FriendDecl => "FriendDecl",

        // References
        CXCursor_TypeRef => "TypeRef",
        CXCursor_CXXBaseSpecifier => "BaseSpecifier",
        CXCursor_TemplateRef => "TemplateRef",
        CXCursor_NamespaceRef => "NamespaceRef",
        CXCursor_MemberRef => "MemberRef",
        CXCursor_LabelRef => "LabelRef",
        CXCursor_OverloadedDeclRef => "OverloadedDeclRef",
        CXCursor_VariableRef => "VariableRef",

        // Expressions
        CXCursor_DeclRefExpr => "DeclRefExpr",
        CXCursor_MemberRefExpr => "MemberRefExpr",
        CXCursor_CallExpr => "CallExpr",
        CXCursor_BlockExpr => "BlockExpr",
        CXCursor_IntegerLiteral => "IntegerLiteral",
        CXCursor_FloatingLiteral => "FloatingLiteral",
        CXCursor_ImaginaryLiteral => "ImaginaryLiteral",
        CXCursor_StringLiteral => "StringLiteral",
        CXCursor_CharacterLiteral => "CharacterLiteral",
        CXCursor_ParenExpr => "ParenExpr",
        CXCursor_UnaryOperator => "UnaryOperator",
        CXCursor_ArraySubscriptExpr => "ArraySubscriptExpr",
        CXCursor_BinaryOperator => "BinaryOperator",
        CXCursor_CompoundAssignOperator => "CompoundAssignOperator",
        CXCursor_ConditionalOperator => "ConditionalOperator",
        CXCursor_CStyleCastExpr => "CStyleCastExpr",
        CXCursor_CompoundLiteralExpr => "CompoundLiteralExpr",
        CXCursor_InitListExpr => "InitListExpr",
        CXCursor_AddrLabelExpr => "AddrLabelExpr",
        CXCursor_StmtExpr => "StmtExpr",
        CXCursor_GenericSelectionExpr => "GenericSelectionExpr",
        CXCursor_CXXStaticCastExpr => "StaticCastExpr",
        CXCursor_CXXDynamicCastExpr => "DynamicCastExpr",
        CXCursor_CXXReinterpretCastExpr => "ReinterpretCastExpr",
        CXCursor_CXXConstCastExpr => "ConstCastExpr",
        CXCursor_CXXFunctionalCastExpr => "FunctionalCastExpr",
        CXCursor_CXXTypeidExpr => "TypeidExpr",
        CXCursor_CXXBoolLiteralExpr => "BoolLiteral",
        CXCursor_CXXNullPtrLiteralExpr => "NullPtrLiteral",
        CXCursor_CXXThisExpr => "ThisExpr",
        CXCursor_CXXThrowExpr => "ThrowExpr",
        CXCursor_CXXNewExpr => "NewExpr",
        CXCursor_CXXDeleteExpr => "DeleteExpr",
        CXCursor_UnaryExpr => "UnaryExpr",
        CXCursor_PackExpansionExpr => "PackExpansionExpr",
        CXCursor_SizeOfPackExpr => "SizeOfPackExpr",
        CXCursor_LambdaExpr => "LambdaExpr",

        // Statements
        CXCursor_UnexposedStmt => "UnexposedStmt",
        CXCursor_LabelStmt => "LabelStmt",
        CXCursor_CompoundStmt => "CompoundStmt",
        CXCursor_CaseStmt => "CaseStmt",
        CXCursor_DefaultStmt => "DefaultStmt",
        CXCursor_IfStmt => "IfStmt",
        CXCursor_SwitchStmt => "SwitchStmt",
        CXCursor_WhileStmt => "WhileStmt",
        CXCursor_DoStmt => "DoStmt",
        CXCursor_ForStmt => "ForStmt",
        CXCursor_GotoStmt => "GotoStmt",
        CXCursor_IndirectGotoStmt => "IndirectGotoStmt",
        CXCursor_ContinueStmt => "ContinueStmt",
        CXCursor_BreakStmt => "BreakStmt",
        CXCursor_ReturnStmt => "ReturnStmt",
        // CXCursor_AsmStmt and CXCursor_GCCAsmStmt are aliases (same value)
        CXCursor_AsmStmt => "AsmStmt",
        CXCursor_MSAsmStmt => "MSAsmStmt",
        CXCursor_CXXForRangeStmt => "RangeForStmt",
        CXCursor_CXXCatchStmt => "CatchStmt",
        CXCursor_CXXTryStmt => "TryStmt",
        CXCursor_NullStmt => "NullStmt",
        CXCursor_DeclStmt => "DeclStmt",

        // Preprocessor
        CXCursor_PreprocessingDirective => "PreprocessingDirective",
        CXCursor_MacroDefinition => "MacroDefinition",
        CXCursor_MacroExpansion => "MacroExpansion",
        CXCursor_InclusionDirective => "IncludeDirective",

        // Unexposed / other
        CXCursor_UnexposedExpr => "UnexposedExpr",
        CXCursor_TranslationUnit => "TranslationUnit",
        CXCursor_UnexposedAttr
        | CXCursor_CXXFinalAttr
        | CXCursor_CXXOverrideAttr
        | CXCursor_AnnotateAttr
        | CXCursor_WarnUnusedResultAttr => "Attribute",

        _ => "Unknown",
    }
}

// ---------------------------------------------------------------------------
// Helper: CX_StorageClass -> string
// ---------------------------------------------------------------------------

fn storage_class_to_string(sc: CX_StorageClass) -> &'static str {
    match sc {
        CX_SC_None => "none",
        CX_SC_Extern => "extern",
        CX_SC_Static => "static",
        CX_SC_PrivateExtern => "private_extern",
        CX_SC_Register => "register",
        CX_SC_Auto => "auto",
        _ => "unknown",
    }
}

// ---------------------------------------------------------------------------
// Helper: CX_CXXAccessSpecifier -> string
// ---------------------------------------------------------------------------

fn access_specifier_to_string(access: CX_CXXAccessSpecifier) -> &'static str {
    match access {
        CX_CXXPublic => "public",
        CX_CXXProtected => "protected",
        CX_CXXPrivate => "private",
        _ => "none",
    }
}

// ---------------------------------------------------------------------------
// Helper: CXString -> String
// ---------------------------------------------------------------------------

/// Convert a CXString to a Rust String (and dispose the CXString).
unsafe fn cx_string_to_string(cx_str: CXString) -> String {
    let c_str = clang_getCString(cx_str);
    let result = if c_str.is_null() {
        String::new()
    } else {
        CStr::from_ptr(c_str).to_string_lossy().into_owned()
    };
    clang_disposeString(cx_str);
    result
}

// ---------------------------------------------------------------------------
// Helper: detect if a file is C (not C++)
// ---------------------------------------------------------------------------

/// Returns true if the file extension indicates plain C (not C++).
pub fn is_c_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e == "c")
        .unwrap_or(false)
}
