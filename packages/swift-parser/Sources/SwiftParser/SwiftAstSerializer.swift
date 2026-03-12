import Foundation
import SwiftSyntax

/// Serializes a SwiftSyntax tree to Grafema JSON AST format.
/// Each node has "type" discriminator + "span" + type-specific fields.
class SwiftAstSerializer {

    // MARK: - Top-level

    func serialize(tree: SourceFileSyntax, file: String) -> [String: Any] {
        var result: [String: Any] = [:]
        result["file"] = file

        // Imports
        var imports: [[String: Any]] = []
        for item in tree.statements {
            if let importDecl = item.item.as(ImportDeclSyntax.self) {
                imports.append(serializeImport(importDecl))
            }
        }
        result["imports"] = imports

        // Declarations (everything except imports)
        var declarations: [[String: Any]] = []
        for item in tree.statements {
            if item.item.is(ImportDeclSyntax.self) { continue }
            if let decl = serializeCodeBlockItem(item) {
                declarations.append(decl)
            }
        }
        result["declarations"] = declarations

        return result
    }

    // MARK: - Imports

    private func serializeImport(_ node: ImportDeclSyntax) -> [String: Any] {
        var result: [String: Any] = ["type": "ImportDecl"]
        let path = node.path.map { $0.name.text }.joined(separator: ".")
        result["name"] = path
        result["span"] = span(of: node)

        // Import kind (e.g., `import struct Foundation.URL`)
        if let importKind = node.importKindSpecifier {
            result["importKind"] = importKind.text
        }

        // Check for @_exported
        for attr in node.attributes {
            if let attrSyntax = attr.as(AttributeSyntax.self),
               attrSyntax.attributeName.description.trimmingCharacters(in: .whitespaces) == "_exported" {
                result["exported"] = true
            }
        }

        return result
    }

    // MARK: - Code Block Items

    private func serializeCodeBlockItem(_ item: CodeBlockItemSyntax) -> [String: Any]? {
        let syntax = item.item
        if let decl = syntax.as(DeclSyntax.self) {
            return serializeDecl(decl)
        } else if let stmt = syntax.as(StmtSyntax.self) {
            return serializeStmt(stmt)
        } else if let expr = syntax.as(ExprSyntax.self) {
            return serializeExpr(expr)
        }
        return nil
    }

    // MARK: - Declarations

    private func serializeDecl(_ decl: DeclSyntax) -> [String: Any]? {
        if let structDecl = decl.as(StructDeclSyntax.self) {
            return serializeStructDecl(structDecl)
        } else if let classDecl = decl.as(ClassDeclSyntax.self) {
            return serializeClassDecl(classDecl)
        } else if let enumDecl = decl.as(EnumDeclSyntax.self) {
            return serializeEnumDecl(enumDecl)
        } else if let protocolDecl = decl.as(ProtocolDeclSyntax.self) {
            return serializeProtocolDecl(protocolDecl)
        } else if let extensionDecl = decl.as(ExtensionDeclSyntax.self) {
            return serializeExtensionDecl(extensionDecl)
        } else if let funcDecl = decl.as(FunctionDeclSyntax.self) {
            return serializeFuncDecl(funcDecl)
        } else if let initDecl = decl.as(InitializerDeclSyntax.self) {
            return serializeInitDecl(initDecl)
        } else if let deinitDecl = decl.as(DeinitializerDeclSyntax.self) {
            return serializeDeinitDecl(deinitDecl)
        } else if let varDecl = decl.as(VariableDeclSyntax.self) {
            return serializeVarDecl(varDecl)
        } else if let subscriptDecl = decl.as(SubscriptDeclSyntax.self) {
            return serializeSubscriptDecl(subscriptDecl)
        } else if let typealiasDecl = decl.as(TypeAliasDeclSyntax.self) {
            return serializeTypeAliasDecl(typealiasDecl)
        } else if let actorDecl = decl.as(ActorDeclSyntax.self) {
            return serializeActorDecl(actorDecl)
        } else if let enumCaseDecl = decl.as(EnumCaseDeclSyntax.self) {
            return serializeEnumCaseDecl(enumCaseDecl)
        } else if let operatorDecl = decl.as(OperatorDeclSyntax.self) {
            return serializeOperatorDecl(operatorDecl)
        } else if let precedenceGroupDecl = decl.as(PrecedenceGroupDeclSyntax.self) {
            return serializePrecedenceGroupDecl(precedenceGroupDecl)
        } else if let associatedTypeDecl = decl.as(AssociatedTypeDeclSyntax.self) {
            return serializeAssociatedTypeDecl(associatedTypeDecl)
        } else if let macroDecl = decl.as(MacroDeclSyntax.self) {
            return serializeMacroDecl(macroDecl)
        } else if let macroExpDecl = decl.as(MacroExpansionDeclSyntax.self) {
            return serializeMacroExpansionDecl(macroExpDecl)
        } else if let ifConfigDecl = decl.as(IfConfigDeclSyntax.self) {
            return serializeIfConfigDecl(ifConfigDecl)
        }
        // Fallback for unknown declarations
        return ["type": "UnknownDecl", "text": String(decl.description.prefix(200)), "span": span(of: decl)]
    }

    // MARK: - Struct

    private func serializeStructDecl(_ node: StructDeclSyntax) -> [String: Any] {
        var result: [String: Any] = ["type": "StructDecl"]
        result["name"] = node.name.text
        result["span"] = span(of: node)
        result["modifiers"] = serializeModifiers(node.modifiers)
        result["genericParams"] = serializeGenericParams(node.genericParameterClause)
        result["inheritedTypes"] = serializeInheritedTypes(node.inheritanceClause)
        result["members"] = serializeMembers(node.memberBlock)
        result["attributes"] = serializeAttributes(node.attributes)
        if let whereClause = node.genericWhereClause {
            result["whereClause"] = serializeWhereClause(whereClause)
        }
        return result
    }

    // MARK: - Class

    private func serializeClassDecl(_ node: ClassDeclSyntax) -> [String: Any] {
        var result: [String: Any] = ["type": "ClassDecl"]
        result["name"] = node.name.text
        result["span"] = span(of: node)
        result["modifiers"] = serializeModifiers(node.modifiers)
        result["genericParams"] = serializeGenericParams(node.genericParameterClause)
        result["inheritedTypes"] = serializeInheritedTypes(node.inheritanceClause)
        result["members"] = serializeMembers(node.memberBlock)
        result["attributes"] = serializeAttributes(node.attributes)
        if let whereClause = node.genericWhereClause {
            result["whereClause"] = serializeWhereClause(whereClause)
        }
        return result
    }

    // MARK: - Enum

    private func serializeEnumDecl(_ node: EnumDeclSyntax) -> [String: Any] {
        var result: [String: Any] = ["type": "EnumDecl"]
        result["name"] = node.name.text
        result["span"] = span(of: node)
        result["modifiers"] = serializeModifiers(node.modifiers)
        result["genericParams"] = serializeGenericParams(node.genericParameterClause)
        result["inheritedTypes"] = serializeInheritedTypes(node.inheritanceClause)
        result["members"] = serializeMembers(node.memberBlock)
        result["attributes"] = serializeAttributes(node.attributes)
        return result
    }

    // MARK: - Protocol

    private func serializeProtocolDecl(_ node: ProtocolDeclSyntax) -> [String: Any] {
        var result: [String: Any] = ["type": "ProtocolDecl"]
        result["name"] = node.name.text
        result["span"] = span(of: node)
        result["modifiers"] = serializeModifiers(node.modifiers)
        result["inheritedTypes"] = serializeInheritedTypes(node.inheritanceClause)
        result["members"] = serializeMembers(node.memberBlock)
        result["attributes"] = serializeAttributes(node.attributes)
        return result
    }

    // MARK: - Extension

    private func serializeExtensionDecl(_ node: ExtensionDeclSyntax) -> [String: Any] {
        var result: [String: Any] = ["type": "ExtensionDecl"]
        result["extendedType"] = serializeType(node.extendedType)
        result["span"] = span(of: node)
        result["modifiers"] = serializeModifiers(node.modifiers)
        result["inheritedTypes"] = serializeInheritedTypes(node.inheritanceClause)
        result["members"] = serializeMembers(node.memberBlock)
        result["attributes"] = serializeAttributes(node.attributes)
        if let whereClause = node.genericWhereClause {
            result["whereClause"] = serializeWhereClause(whereClause)
        }
        return result
    }

    // MARK: - Function

    private func serializeFuncDecl(_ node: FunctionDeclSyntax) -> [String: Any] {
        var result: [String: Any] = ["type": "FuncDecl"]
        result["name"] = node.name.text
        result["span"] = span(of: node)
        result["modifiers"] = serializeModifiers(node.modifiers)
        result["genericParams"] = serializeGenericParams(node.genericParameterClause)
        result["params"] = serializeParams(node.signature.parameterClause)
        result["attributes"] = serializeAttributes(node.attributes)

        if let returnType = node.signature.returnClause {
            result["returnType"] = serializeType(returnType.type)
        }

        if let body = node.body {
            result["body"] = serializeCodeBlock(body)
        }

        // Async / throws
        let effectSpecifiers = node.signature.effectSpecifiers
        if effectSpecifiers?.asyncSpecifier != nil {
            result["isAsync"] = true
        }
        if effectSpecifiers?.throwsClause != nil {
            result["throws"] = true
        }

        if let whereClause = node.genericWhereClause {
            result["whereClause"] = serializeWhereClause(whereClause)
        }

        return result
    }

    // MARK: - Initializer

    private func serializeInitDecl(_ node: InitializerDeclSyntax) -> [String: Any] {
        var result: [String: Any] = ["type": "InitDecl"]
        result["span"] = span(of: node)
        result["modifiers"] = serializeModifiers(node.modifiers)
        result["params"] = serializeParams(node.signature.parameterClause)
        result["attributes"] = serializeAttributes(node.attributes)
        result["isOptional"] = node.optionalMark != nil

        if let body = node.body {
            result["body"] = serializeCodeBlock(body)
        }

        let effectSpecifiers = node.signature.effectSpecifiers
        if effectSpecifiers?.asyncSpecifier != nil {
            result["isAsync"] = true
        }
        if effectSpecifiers?.throwsClause != nil {
            result["throws"] = true
        }

        return result
    }

    // MARK: - Deinitializer

    private func serializeDeinitDecl(_ node: DeinitializerDeclSyntax) -> [String: Any] {
        var result: [String: Any] = ["type": "DeinitDecl"]
        result["span"] = span(of: node)
        result["attributes"] = serializeAttributes(node.attributes)
        if let body = node.body {
            result["body"] = serializeCodeBlock(body)
        }
        return result
    }

    // MARK: - Variable / Property

    private func serializeVarDecl(_ node: VariableDeclSyntax) -> [String: Any] {
        var result: [String: Any] = ["type": "VarDecl"]
        result["span"] = span(of: node)
        result["modifiers"] = serializeModifiers(node.modifiers)
        result["attributes"] = serializeAttributes(node.attributes)
        result["bindingSpecifier"] = node.bindingSpecifier.text  // "let" or "var"

        var bindings: [[String: Any]] = []
        for binding in node.bindings {
            var b: [String: Any] = [:]
            b["pattern"] = serializePattern(binding.pattern)
            if let typeAnnotation = binding.typeAnnotation {
                b["type"] = serializeType(typeAnnotation.type)
            }
            if let initializer = binding.initializer {
                b["initializer"] = serializeExpr(initializer.value)
            }
            if let accessorBlock = binding.accessorBlock {
                b["accessors"] = serializeAccessorBlock(accessorBlock)
            }
            b["span"] = span(of: binding)
            bindings.append(b)
        }
        result["bindings"] = bindings

        return result
    }

    // MARK: - Subscript

    private func serializeSubscriptDecl(_ node: SubscriptDeclSyntax) -> [String: Any] {
        var result: [String: Any] = ["type": "SubscriptDecl"]
        result["span"] = span(of: node)
        result["modifiers"] = serializeModifiers(node.modifiers)
        result["params"] = serializeParams(node.parameterClause)
        result["returnType"] = serializeType(node.returnClause.type)
        result["attributes"] = serializeAttributes(node.attributes)
        result["genericParams"] = serializeGenericParams(node.genericParameterClause)
        result["accessors"] = serializeAccessorBlock(node.accessorBlock)
        return result
    }

    // MARK: - TypeAlias

    private func serializeTypeAliasDecl(_ node: TypeAliasDeclSyntax) -> [String: Any] {
        var result: [String: Any] = ["type": "TypeAliasDecl"]
        result["name"] = node.name.text
        result["span"] = span(of: node)
        result["modifiers"] = serializeModifiers(node.modifiers)
        result["targetType"] = serializeType(node.initializer.value)
        result["attributes"] = serializeAttributes(node.attributes)
        result["genericParams"] = serializeGenericParams(node.genericParameterClause)
        return result
    }

    // MARK: - Actor

    private func serializeActorDecl(_ node: ActorDeclSyntax) -> [String: Any] {
        var result: [String: Any] = ["type": "ActorDecl"]
        result["name"] = node.name.text
        result["span"] = span(of: node)
        result["modifiers"] = serializeModifiers(node.modifiers)
        result["genericParams"] = serializeGenericParams(node.genericParameterClause)
        result["inheritedTypes"] = serializeInheritedTypes(node.inheritanceClause)
        result["members"] = serializeMembers(node.memberBlock)
        result["attributes"] = serializeAttributes(node.attributes)
        return result
    }

    // MARK: - Enum Case

    private func serializeEnumCaseDecl(_ node: EnumCaseDeclSyntax) -> [String: Any] {
        var result: [String: Any] = ["type": "EnumCaseDecl"]
        result["span"] = span(of: node)
        result["attributes"] = serializeAttributes(node.attributes)

        var elements: [[String: Any]] = []
        for element in node.elements {
            var e: [String: Any] = [:]
            e["name"] = element.name.text
            if let rawValue = element.rawValue {
                e["rawValue"] = serializeExpr(rawValue.value)
            }
            if let paramClause = element.parameterClause {
                var params: [[String: Any]] = []
                for param in paramClause.parameters {
                    var p: [String: Any] = [:]
                    if let firstName = param.firstName {
                        p["label"] = firstName.text
                    }
                    p["type"] = serializeType(param.type)
                    if let defaultValue = param.defaultValue {
                        p["defaultValue"] = serializeExpr(defaultValue.value)
                    }
                    params.append(p)
                }
                e["associatedValues"] = params
            }
            e["span"] = span(of: element)
            elements.append(e)
        }
        result["elements"] = elements

        return result
    }

    // MARK: - Operator & Precedence Group

    private func serializeOperatorDecl(_ node: OperatorDeclSyntax) -> [String: Any] {
        var result: [String: Any] = ["type": "OperatorDecl"]
        result["name"] = node.name.text
        result["span"] = span(of: node)
        result["fixity"] = node.fixitySpecifier.text
        if let group = node.operatorPrecedenceAndTypes {
            result["precedenceGroup"] = group.description.trimmingCharacters(in: .whitespaces)
        }
        return result
    }

    private func serializePrecedenceGroupDecl(_ node: PrecedenceGroupDeclSyntax) -> [String: Any] {
        var result: [String: Any] = ["type": "PrecedenceGroupDecl"]
        result["name"] = node.name.text
        result["span"] = span(of: node)
        return result
    }

    // MARK: - Associated Type

    private func serializeAssociatedTypeDecl(_ node: AssociatedTypeDeclSyntax) -> [String: Any] {
        var result: [String: Any] = ["type": "AssociatedTypeDecl"]
        result["name"] = node.name.text
        result["span"] = span(of: node)
        result["modifiers"] = serializeModifiers(node.modifiers)
        result["attributes"] = serializeAttributes(node.attributes)
        if let inheritanceClause = node.inheritanceClause {
            result["inheritedTypes"] = serializeInheritedTypes(inheritanceClause)
        }
        if let defaultType = node.initializer {
            result["defaultType"] = serializeType(defaultType.value)
        }
        if let whereClause = node.genericWhereClause {
            result["whereClause"] = serializeWhereClause(whereClause)
        }
        return result
    }

    // MARK: - Macro

    private func serializeMacroDecl(_ node: MacroDeclSyntax) -> [String: Any] {
        ["type": "MacroDecl", "name": node.name.text, "span": span(of: node)]
    }

    private func serializeMacroExpansionDecl(_ node: MacroExpansionDeclSyntax) -> [String: Any] {
        ["type": "MacroExpansionDecl", "macroName": node.macroName.text, "span": span(of: node)]
    }

    // MARK: - IfConfig (#if ... #endif)

    private func serializeIfConfigDecl(_ node: IfConfigDeclSyntax) -> [String: Any] {
        var result: [String: Any] = ["type": "IfConfigDecl"]
        result["span"] = span(of: node)
        var clauses: [[String: Any]] = []
        for clause in node.clauses {
            var c: [String: Any] = [:]
            if let condition = clause.condition {
                c["condition"] = condition.description.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            if let elements = clause.elements {
                switch elements {
                case .statements(let stmts):
                    c["statements"] = stmts.compactMap { serializeCodeBlockItem($0) }
                case .decls(let decls):
                    c["declarations"] = decls.compactMap { serializeDecl(DeclSyntax($0.decl)) }
                default:
                    c["raw"] = String(elements.description.prefix(200))
                }
            }
            clauses.append(c)
        }
        result["clauses"] = clauses
        return result
    }

    // MARK: - Expressions

    private func serializeExpr(_ expr: ExprSyntax) -> [String: Any] {
        if let call = expr.as(FunctionCallExprSyntax.self) {
            return serializeCallExpr(call)
        } else if let memberAccess = expr.as(MemberAccessExprSyntax.self) {
            return serializeMemberAccessExpr(memberAccess)
        } else if let closure = expr.as(ClosureExprSyntax.self) {
            return serializeClosureExpr(closure)
        } else if let awaitExpr = expr.as(AwaitExprSyntax.self) {
            return serializeAwaitExpr(awaitExpr)
        } else if let tryExpr = expr.as(TryExprSyntax.self) {
            return serializeTryExpr(tryExpr)
        } else if let forceUnwrap = expr.as(ForceUnwrapExprSyntax.self) {
            return serializeForceUnwrapExpr(forceUnwrap)
        } else if let optionalChaining = expr.as(OptionalChainingExprSyntax.self) {
            return serializeOptionalChainingExpr(optionalChaining)
        } else if let assignment = expr.as(InfixOperatorExprSyntax.self) {
            return serializeInfixExpr(assignment)
        } else if let prefix = expr.as(PrefixOperatorExprSyntax.self) {
            return serializePrefixExpr(prefix)
        } else if let postfix = expr.as(PostfixOperatorExprSyntax.self) {
            return serializePostfixExpr(postfix)
        } else if let ternary = expr.as(TernaryExprSyntax.self) {
            return serializeTernaryExpr(ternary)
        } else if let asExpr = expr.as(AsExprSyntax.self) {
            return serializeAsExpr(asExpr)
        } else if let isExpr = expr.as(IsExprSyntax.self) {
            return serializeIsExpr(isExpr)
        } else if let tuple = expr.as(TupleExprSyntax.self) {
            return serializeTupleExpr(tuple)
        } else if let array = expr.as(ArrayExprSyntax.self) {
            return serializeArrayExpr(array)
        } else if let dict = expr.as(DictionaryExprSyntax.self) {
            return serializeDictExpr(dict)
        } else if let string = expr.as(StringLiteralExprSyntax.self) {
            return ["type": "StringLiteral", "value": string.segments.description, "span": span(of: string)]
        } else if let int = expr.as(IntegerLiteralExprSyntax.self) {
            return ["type": "IntLiteral", "value": int.literal.text, "span": span(of: int)]
        } else if let float = expr.as(FloatLiteralExprSyntax.self) {
            return ["type": "FloatLiteral", "value": float.literal.text, "span": span(of: float)]
        } else if let bool = expr.as(BooleanLiteralExprSyntax.self) {
            return ["type": "BoolLiteral", "value": bool.literal.text == "true", "span": span(of: bool)]
        } else if let nilLit = expr.as(NilLiteralExprSyntax.self) {
            return ["type": "NilLiteral", "span": span(of: nilLit)]
        } else if let declRef = expr.as(DeclReferenceExprSyntax.self) {
            return ["type": "DeclRef", "name": declRef.baseName.text, "span": span(of: declRef)]
        } else if let superExpr = expr.as(SuperExprSyntax.self) {
            return ["type": "SuperExpr", "span": span(of: superExpr)]
        } else if let keyPath = expr.as(KeyPathExprSyntax.self) {
            return serializeKeyPathExpr(keyPath)
        } else if let ifExpr = expr.as(IfExprSyntax.self) {
            return serializeIfExpr(ifExpr)
        } else if let switchExpr = expr.as(SwitchExprSyntax.self) {
            return serializeSwitchExpr(switchExpr)
        } else if let subscriptExpr = expr.as(SubscriptCallExprSyntax.self) {
            return serializeSubscriptCallExpr(subscriptExpr)
        } else if let macroExpansion = expr.as(MacroExpansionExprSyntax.self) {
            return ["type": "MacroExpansionExpr", "macroName": macroExpansion.macroName.text, "span": span(of: macroExpansion)]
        }
        // Fallback
        return ["type": "UnknownExpr", "text": String(expr.description.prefix(100)), "span": span(of: expr)]
    }

    // MARK: - Call Expression

    private func serializeCallExpr(_ node: FunctionCallExprSyntax) -> [String: Any] {
        var result: [String: Any] = ["type": "CallExpr"]
        result["callee"] = serializeExpr(node.calledExpression)
        result["span"] = span(of: node)

        var args: [[String: Any]] = []
        for arg in node.arguments {
            var a: [String: Any] = [:]
            if let label = arg.label {
                a["label"] = label.text
            }
            a["value"] = serializeExpr(arg.expression)
            args.append(a)
        }
        result["arguments"] = args

        if let trailingClosure = node.trailingClosure {
            result["trailingClosure"] = serializeClosureExpr(trailingClosure)
        }

        if !node.additionalTrailingClosures.isEmpty {
            result["additionalTrailingClosures"] = node.additionalTrailingClosures.map { tc in
                var r: [String: Any] = [:]
                r["label"] = tc.label.text
                r["closure"] = serializeClosureExpr(tc.closure)
                return r
            }
        }

        return result
    }

    // MARK: - Member Access

    private func serializeMemberAccessExpr(_ node: MemberAccessExprSyntax) -> [String: Any] {
        var result: [String: Any] = ["type": "MemberAccessExpr"]
        result["member"] = node.declName.baseName.text
        result["span"] = span(of: node)
        if let base = node.base {
            result["base"] = serializeExpr(base)
        }
        return result
    }

    // MARK: - Closure

    private func serializeClosureExpr(_ node: ClosureExprSyntax) -> [String: Any] {
        var result: [String: Any] = ["type": "ClosureExpr"]
        result["span"] = span(of: node)

        if let sig = node.signature {
            // Capture list
            if let captureItems = sig.capture {
                result["captureList"] = captureItems.items.map { item in
                    var c: [String: Any] = [:]
                    if let specifier = item.specifier {
                        c["specifier"] = specifier.text
                    }
                    c["expression"] = serializeExpr(item.expression)
                    return c
                }
            }
            // Parameters
            if let params = sig.parameterClause {
                switch params {
                case .simpleInput(let list):
                    result["params"] = list.map { ["name": $0.name.text] as [String: Any] }
                case .parameterClause(let clause):
                    result["params"] = clause.parameters.map { param in
                        var p: [String: Any] = [:]
                        p["name"] = param.secondName?.text ?? param.firstName.text
                        if param.secondName != nil {
                            p["label"] = param.firstName.text
                        }
                        if let type = param.type {
                            p["type"] = serializeType(type)
                        }
                        return p
                    }
                }
            }
            // Return type
            if let returnClause = sig.returnClause {
                result["returnType"] = serializeType(returnClause.type)
            }
        }

        result["body"] = serializeCodeBlockStatements(node.statements)
        return result
    }

    // MARK: - Await / Try / Force Unwrap / Optional Chaining

    private func serializeAwaitExpr(_ node: AwaitExprSyntax) -> [String: Any] {
        ["type": "AwaitExpr", "expression": serializeExpr(node.expression), "span": span(of: node)]
    }

    private func serializeTryExpr(_ node: TryExprSyntax) -> [String: Any] {
        var result: [String: Any] = ["type": "TryExpr"]
        result["expression"] = serializeExpr(node.expression)
        result["span"] = span(of: node)
        if let mark = node.questionOrExclamationMark {
            result["tryKind"] = mark.text == "?" ? "optional" : "force"
        } else {
            result["tryKind"] = "standard"
        }
        return result
    }

    private func serializeForceUnwrapExpr(_ node: ForceUnwrapExprSyntax) -> [String: Any] {
        ["type": "ForceUnwrapExpr", "expression": serializeExpr(node.expression), "span": span(of: node)]
    }

    private func serializeOptionalChainingExpr(_ node: OptionalChainingExprSyntax) -> [String: Any] {
        ["type": "OptionalChainingExpr", "expression": serializeExpr(node.expression), "span": span(of: node)]
    }

    // MARK: - Operators

    private func serializeInfixExpr(_ node: InfixOperatorExprSyntax) -> [String: Any] {
        var result: [String: Any] = ["type": "InfixExpr"]
        result["left"] = serializeExpr(node.leftOperand)
        result["operator"] = serializeExpr(node.operator)
        result["right"] = serializeExpr(node.rightOperand)
        result["span"] = span(of: node)
        return result
    }

    private func serializePrefixExpr(_ node: PrefixOperatorExprSyntax) -> [String: Any] {
        ["type": "PrefixExpr", "operator": node.operator.text, "expression": serializeExpr(node.expression), "span": span(of: node)]
    }

    private func serializePostfixExpr(_ node: PostfixOperatorExprSyntax) -> [String: Any] {
        ["type": "PostfixExpr", "operator": node.operator.text, "expression": serializeExpr(node.expression), "span": span(of: node)]
    }

    // MARK: - Ternary / As / Is

    private func serializeTernaryExpr(_ node: TernaryExprSyntax) -> [String: Any] {
        ["type": "TernaryExpr",
         "condition": serializeExpr(node.condition),
         "thenExpr": serializeExpr(node.thenExpression),
         "elseExpr": serializeExpr(node.elseExpression),
         "span": span(of: node)]
    }

    private func serializeAsExpr(_ node: AsExprSyntax) -> [String: Any] {
        var result: [String: Any] = ["type": "AsExpr"]
        result["expression"] = serializeExpr(node.expression)
        result["targetType"] = serializeType(node.type)
        result["span"] = span(of: node)
        if let mark = node.questionOrExclamationMark {
            result["castKind"] = mark.text == "?" ? "conditional" : "forced"
        } else {
            result["castKind"] = "bridging"
        }
        return result
    }

    private func serializeIsExpr(_ node: IsExprSyntax) -> [String: Any] {
        ["type": "IsExpr", "expression": serializeExpr(node.expression),
         "checkedType": serializeType(node.type), "span": span(of: node)]
    }

    // MARK: - Collections

    private func serializeTupleExpr(_ node: TupleExprSyntax) -> [String: Any] {
        var result: [String: Any] = ["type": "TupleExpr", "span": span(of: node)]
        result["elements"] = node.elements.map { elem in
            var e: [String: Any] = [:]
            if let label = elem.label {
                e["label"] = label.text
            }
            e["value"] = serializeExpr(elem.expression)
            return e
        }
        return result
    }

    private func serializeArrayExpr(_ node: ArrayExprSyntax) -> [String: Any] {
        ["type": "ArrayExpr",
         "elements": node.elements.map { serializeExpr($0.expression) },
         "span": span(of: node)]
    }

    private func serializeDictExpr(_ node: DictionaryExprSyntax) -> [String: Any] {
        var result: [String: Any] = ["type": "DictExpr", "span": span(of: node)]
        switch node.content {
        case .colon:
            result["elements"] = [] as [[String: Any]]
        case .elements(let elements):
            result["elements"] = elements.map { elem in
                ["key": serializeExpr(elem.key), "value": serializeExpr(elem.value)] as [String: Any]
            }
        }
        return result
    }

    // MARK: - KeyPath

    private func serializeKeyPathExpr(_ node: KeyPathExprSyntax) -> [String: Any] {
        var result: [String: Any] = ["type": "KeyPathExpr", "span": span(of: node)]
        if let root = node.root {
            result["root"] = serializeType(root)
        }
        result["components"] = node.components.map { comp in
            var c: [String: Any] = [:]
            if let property = comp.component.as(KeyPathPropertyComponentSyntax.self) {
                c["kind"] = "property"
                c["name"] = property.declName.baseName.text
            } else if let sub = comp.component.as(KeyPathSubscriptComponentSyntax.self) {
                c["kind"] = "subscript"
                c["arguments"] = sub.arguments.map { arg in
                    var a: [String: Any] = [:]
                    if let label = arg.label { a["label"] = label.text }
                    a["value"] = serializeExpr(arg.expression)
                    return a
                }
            } else if comp.component.is(KeyPathOptionalComponentSyntax.self) {
                c["kind"] = "optional"
            }
            return c
        }
        return result
    }

    // MARK: - If Expression (Swift 5.9+)

    private func serializeIfExpr(_ node: IfExprSyntax) -> [String: Any] {
        var result: [String: Any] = ["type": "IfExpr", "span": span(of: node)]
        result["conditions"] = serializeConditions(node.conditions)
        result["body"] = serializeCodeBlock(node.body)
        if let elseBody = node.elseBody {
            switch elseBody {
            case .ifExpr(let elseIf):
                result["elseBody"] = serializeIfExpr(elseIf)
            case .codeBlock(let block):
                result["elseBody"] = serializeCodeBlock(block)
            }
        }
        return result
    }

    // MARK: - Switch Expression

    private func serializeSwitchExpr(_ node: SwitchExprSyntax) -> [String: Any] {
        var result: [String: Any] = ["type": "SwitchExpr", "span": span(of: node)]
        result["subject"] = serializeExpr(node.subject)
        result["cases"] = node.cases.compactMap { caseItem -> [String: Any]? in
            if let switchCase = caseItem.as(SwitchCaseSyntax.self) {
                var c: [String: Any] = [:]
                switch switchCase.label {
                case .case(let caseLabel):
                    c["kind"] = "case"
                    c["items"] = caseLabel.caseItems.map { item in
                        var ci: [String: Any] = [:]
                        ci["pattern"] = serializePattern(item.pattern)
                        if let whereClause = item.whereClause {
                            ci["whereClause"] = serializeExpr(whereClause.condition)
                        }
                        return ci
                    }
                case .default:
                    c["kind"] = "default"
                }
                c["body"] = serializeCodeBlockStatements(switchCase.statements)
                return c
            }
            return nil
        }
        return result
    }

    // MARK: - Subscript Call

    private func serializeSubscriptCallExpr(_ node: SubscriptCallExprSyntax) -> [String: Any] {
        var result: [String: Any] = ["type": "SubscriptCallExpr", "span": span(of: node)]
        result["callee"] = serializeExpr(node.calledExpression)
        result["arguments"] = node.arguments.map { arg in
            var a: [String: Any] = [:]
            if let label = arg.label { a["label"] = label.text }
            a["value"] = serializeExpr(arg.expression)
            return a
        }
        return result
    }

    // MARK: - Statements

    private func serializeStmt(_ stmt: StmtSyntax) -> [String: Any]? {
        if let ifStmt = stmt.as(IfExprSyntax.self) {
            // In statement position, IfExprSyntax is an if statement
            return serializeIfStmt(ifStmt)
        } else if let guardStmt = stmt.as(GuardStmtSyntax.self) {
            return serializeGuardStmt(guardStmt)
        } else if let forStmt = stmt.as(ForStmtSyntax.self) {
            return serializeForStmt(forStmt)
        } else if let whileStmt = stmt.as(WhileStmtSyntax.self) {
            return serializeWhileStmt(whileStmt)
        } else if let repeatStmt = stmt.as(RepeatStmtSyntax.self) {
            return serializeRepeatStmt(repeatStmt)
        } else if let switchStmt = stmt.as(SwitchExprSyntax.self) {
            return serializeSwitchStmt(switchStmt)
        } else if let doStmt = stmt.as(DoStmtSyntax.self) {
            return serializeDoStmt(doStmt)
        } else if let returnStmt = stmt.as(ReturnStmtSyntax.self) {
            return serializeReturnStmt(returnStmt)
        } else if let throwStmt = stmt.as(ThrowStmtSyntax.self) {
            return serializeThrowStmt(throwStmt)
        } else if let deferStmt = stmt.as(DeferStmtSyntax.self) {
            return serializeDeferStmt(deferStmt)
        } else if let breakStmt = stmt.as(BreakStmtSyntax.self) {
            return ["type": "BreakStmt", "label": breakStmt.label?.text as Any, "span": span(of: breakStmt)]
        } else if let continueStmt = stmt.as(ContinueStmtSyntax.self) {
            return ["type": "ContinueStmt", "label": continueStmt.label?.text as Any, "span": span(of: continueStmt)]
        } else if let fallThroughStmt = stmt.as(FallThroughStmtSyntax.self) {
            return ["type": "FallthroughStmt", "span": span(of: fallThroughStmt)]
        } else if let yieldStmt = stmt.as(YieldStmtSyntax.self) {
            return ["type": "YieldStmt", "span": span(of: yieldStmt)]
        } else if let exprStmt = stmt.as(ExpressionStmtSyntax.self) {
            return serializeExpr(exprStmt.expression)
        } else if let labeledStmt = stmt.as(LabeledStmtSyntax.self) {
            var result = serializeStmt(labeledStmt.statement) ?? ["type": "UnknownStmt"]
            result["label"] = labeledStmt.label.text
            return result
        }
        return ["type": "UnknownStmt", "text": String(stmt.description.prefix(100)), "span": span(of: stmt)]
    }

    // MARK: - If Statement

    private func serializeIfStmt(_ node: IfExprSyntax) -> [String: Any] {
        var result: [String: Any] = ["type": "IfStmt", "span": span(of: node)]
        result["conditions"] = serializeConditions(node.conditions)
        result["body"] = serializeCodeBlock(node.body)
        if let elseBody = node.elseBody {
            switch elseBody {
            case .ifExpr(let elseIf):
                result["elseBody"] = serializeIfStmt(elseIf)
            case .codeBlock(let block):
                result["elseBody"] = serializeCodeBlock(block)
            }
        }
        return result
    }

    // MARK: - Guard

    private func serializeGuardStmt(_ node: GuardStmtSyntax) -> [String: Any] {
        var result: [String: Any] = ["type": "GuardStmt", "span": span(of: node)]
        result["conditions"] = serializeConditions(node.conditions)
        result["body"] = serializeCodeBlock(node.body)
        return result
    }

    // MARK: - For-in

    private func serializeForStmt(_ node: ForStmtSyntax) -> [String: Any] {
        var result: [String: Any] = ["type": "ForInStmt", "span": span(of: node)]
        result["pattern"] = serializePattern(node.pattern)
        result["sequence"] = serializeExpr(node.sequence)
        result["body"] = serializeCodeBlock(node.body)
        if let whereClause = node.whereClause {
            result["whereClause"] = serializeExpr(whereClause.condition)
        }
        return result
    }

    // MARK: - While / Repeat-While

    private func serializeWhileStmt(_ node: WhileStmtSyntax) -> [String: Any] {
        var result: [String: Any] = ["type": "WhileStmt", "span": span(of: node)]
        result["conditions"] = serializeConditions(node.conditions)
        result["body"] = serializeCodeBlock(node.body)
        return result
    }

    private func serializeRepeatStmt(_ node: RepeatStmtSyntax) -> [String: Any] {
        ["type": "RepeatWhileStmt",
         "body": serializeCodeBlock(node.body),
         "condition": serializeExpr(node.condition),
         "span": span(of: node)]
    }

    // MARK: - Switch

    private func serializeSwitchStmt(_ node: SwitchExprSyntax) -> [String: Any] {
        serializeSwitchExpr(node)  // Same structure
    }

    // MARK: - Do-Catch

    private func serializeDoStmt(_ node: DoStmtSyntax) -> [String: Any] {
        var result: [String: Any] = ["type": "DoStmt", "span": span(of: node)]
        result["body"] = serializeCodeBlock(node.body)
        result["catchClauses"] = node.catchClauses.map { clause in
            var c: [String: Any] = [:]
            c["items"] = clause.catchItems.map { item in
                var ci: [String: Any] = [:]
                if let pattern = item.pattern {
                    ci["pattern"] = serializePattern(pattern)
                }
                if let whereClause = item.whereClause {
                    ci["whereClause"] = serializeExpr(whereClause.condition)
                }
                return ci
            }
            c["body"] = serializeCodeBlock(clause.body)
            return c
        }
        return result
    }

    // MARK: - Return / Throw / Defer

    private func serializeReturnStmt(_ node: ReturnStmtSyntax) -> [String: Any] {
        var result: [String: Any] = ["type": "ReturnStmt", "span": span(of: node)]
        if let expr = node.expression {
            result["expression"] = serializeExpr(expr)
        }
        return result
    }

    private func serializeThrowStmt(_ node: ThrowStmtSyntax) -> [String: Any] {
        ["type": "ThrowStmt", "expression": serializeExpr(node.expression), "span": span(of: node)]
    }

    private func serializeDeferStmt(_ node: DeferStmtSyntax) -> [String: Any] {
        ["type": "DeferStmt", "body": serializeCodeBlock(node.body), "span": span(of: node)]
    }

    // MARK: - Conditions

    private func serializeConditions(_ conditions: ConditionElementListSyntax) -> [[String: Any]] {
        conditions.map { condition in
            switch condition.condition {
            case .expression(let expr):
                return ["kind": "expression", "expression": serializeExpr(expr)]
            case .availability(let avail):
                return ["kind": "availability", "text": avail.description.trimmingCharacters(in: .whitespaces)]
            case .optionalBinding(let binding):
                var result: [String: Any] = ["kind": "optionalBinding"]
                result["bindingSpecifier"] = binding.bindingSpecifier.text  // "let" or "var"
                result["pattern"] = serializePattern(binding.pattern)
                if let typeAnnotation = binding.typeAnnotation {
                    result["type"] = serializeType(typeAnnotation.type)
                }
                if let initializer = binding.initializer {
                    result["initializer"] = serializeExpr(initializer.value)
                }
                return result
            case .matchingPattern(let matching):
                return ["kind": "matchingPattern",
                        "pattern": serializePattern(matching.pattern),
                        "expression": serializeExpr(matching.initializer.value)]
            }
        }
    }

    // MARK: - Patterns

    private func serializePattern(_ pattern: PatternSyntax) -> [String: Any] {
        if let ident = pattern.as(IdentifierPatternSyntax.self) {
            return ["kind": "identifier", "name": ident.identifier.text]
        } else if let tuple = pattern.as(TuplePatternSyntax.self) {
            return ["kind": "tuple", "elements": tuple.elements.map { serializePattern($0.pattern) }]
        } else if pattern.is(WildcardPatternSyntax.self) {
            return ["kind": "wildcard"]
        } else if let expr = pattern.as(ExpressionPatternSyntax.self) {
            return ["kind": "expression", "expression": serializeExpr(expr.expression)]
        } else if let valueBinding = pattern.as(ValueBindingPatternSyntax.self) {
            return ["kind": "valueBinding",
                    "bindingSpecifier": valueBinding.bindingSpecifier.text,
                    "pattern": serializePattern(valueBinding.pattern)]
        } else if let isType = pattern.as(IsTypePatternSyntax.self) {
            return ["kind": "isType", "type": serializeType(isType.type)]
        }
        return ["kind": "unknown", "text": pattern.description.trimmingCharacters(in: .whitespaces)]
    }

    // MARK: - Types

    private func serializeType(_ type: TypeSyntax) -> [String: Any] {
        if let simple = type.as(IdentifierTypeSyntax.self) {
            var result: [String: Any] = ["kind": "simple", "name": simple.name.text]
            if let genericArgs = simple.genericArgumentClause {
                result["genericArgs"] = genericArgs.arguments.map { serializeType($0.argument) }
            }
            return result
        } else if let optional = type.as(OptionalTypeSyntax.self) {
            return ["kind": "optional", "wrappedType": serializeType(optional.wrappedType)]
        } else if let iuo = type.as(ImplicitlyUnwrappedOptionalTypeSyntax.self) {
            return ["kind": "implicitlyUnwrappedOptional", "wrappedType": serializeType(iuo.wrappedType)]
        } else if let array = type.as(ArrayTypeSyntax.self) {
            return ["kind": "array", "elementType": serializeType(array.element)]
        } else if let dict = type.as(DictionaryTypeSyntax.self) {
            return ["kind": "dictionary", "keyType": serializeType(dict.key), "valueType": serializeType(dict.value)]
        } else if let funcType = type.as(FunctionTypeSyntax.self) {
            var result: [String: Any] = ["kind": "function"]
            result["params"] = funcType.parameters.map { serializeType($0.type) }
            result["returnType"] = serializeType(funcType.returnClause.type)
            if funcType.effectSpecifiers?.asyncSpecifier != nil { result["isAsync"] = true }
            if funcType.effectSpecifiers?.throwsClause != nil { result["throws"] = true }
            return result
        } else if let tuple = type.as(TupleTypeSyntax.self) {
            return ["kind": "tuple", "elements": tuple.elements.map { elem in
                var e: [String: Any] = ["type": serializeType(elem.type)]
                if let name = elem.secondName ?? elem.firstName { e["name"] = name.text }
                return e
            }]
        } else if let composition = type.as(CompositionTypeSyntax.self) {
            return ["kind": "composition", "types": composition.elements.map { serializeType($0.type) }]
        } else if let some = type.as(SomeOrAnyTypeSyntax.self) {
            return ["kind": some.someOrAnySpecifier.text, "constraint": serializeType(some.constraint)]
        } else if let metatype = type.as(MetatypeTypeSyntax.self) {
            return ["kind": "metatype", "baseType": serializeType(metatype.baseType),
                    "metatypeSpecifier": metatype.metatypeSpecifier.text]
        } else if let attributed = type.as(AttributedTypeSyntax.self) {
            var result = serializeType(attributed.baseType)
            var attrs: [String] = []
            for attr in attributed.attributes {
                if let attrSyntax = attr.as(AttributeSyntax.self) {
                    attrs.append(attrSyntax.attributeName.description.trimmingCharacters(in: .whitespaces))
                }
            }
            if !attrs.isEmpty { result["typeAttributes"] = attrs }
            if let firstSpecifier = attributed.specifiers.first {
                result["specifier"] = firstSpecifier.description.trimmingCharacters(in: .whitespaces)
            }
            return result
        } else if let member = type.as(MemberTypeSyntax.self) {
            return ["kind": "member", "baseType": serializeType(member.baseType), "name": member.name.text]
        } else if let classRestriction = type.as(ClassRestrictionTypeSyntax.self) {
            return ["kind": "classRestriction", "span": span(of: classRestriction)]
        } else if let packExpansion = type.as(PackExpansionTypeSyntax.self) {
            return ["kind": "packExpansion", "patternType": serializeType(packExpansion.repetitionPattern)]
        } else if let packElement = type.as(PackElementTypeSyntax.self) {
            return ["kind": "packElement", "type": serializeType(packElement.pack)]
        } else if let suppressed = type.as(SuppressedTypeSyntax.self) {
            return ["kind": "suppressed", "type": serializeType(suppressed.type)]
        }
        return ["kind": "unknown", "text": type.description.trimmingCharacters(in: .whitespaces)]
    }

    // MARK: - Helpers

    private func serializeModifiers(_ modifiers: DeclModifierListSyntax) -> [String] {
        modifiers.map { mod in
            if let detail = mod.detail {
                return "\(mod.name.text)(\(detail.detail.text))"
            }
            return mod.name.text
        }
    }

    private func serializeGenericParams(_ clause: GenericParameterClauseSyntax?) -> [[String: Any]] {
        guard let clause = clause else { return [] }
        return clause.parameters.map { param in
            var p: [String: Any] = ["name": param.name.text]
            if let inheritedType = param.inheritedType {
                p["constraint"] = serializeType(inheritedType)
            }
            if param.eachKeyword != nil {
                p["isParameterPack"] = true
            }
            return p
        }
    }

    private func serializeInheritedTypes(_ clause: InheritanceClauseSyntax?) -> [[String: Any]] {
        guard let clause = clause else { return [] }
        return clause.inheritedTypes.map { item in
            ["type": serializeType(item.type)]
        }
    }

    private func serializeMembers(_ block: MemberBlockSyntax) -> [[String: Any]] {
        block.members.compactMap { member in
            serializeDecl(member.decl)
        }
    }

    private func serializeParams(_ clause: FunctionParameterClauseSyntax) -> [[String: Any]] {
        clause.parameters.map { param in
            var p: [String: Any] = [:]
            p["firstName"] = param.firstName.text
            if let secondName = param.secondName {
                p["secondName"] = secondName.text
            }
            p["type"] = serializeType(param.type)
            if let defaultValue = param.defaultValue {
                p["defaultValue"] = serializeExpr(defaultValue.value)
            }
            p["isVariadic"] = param.ellipsis != nil
            p["span"] = span(of: param)
            return p
        }
    }

    private func serializeAttributes(_ attrs: AttributeListSyntax) -> [[String: Any]] {
        attrs.compactMap { attr -> [String: Any]? in
            if let attrSyntax = attr.as(AttributeSyntax.self) {
                var result: [String: Any] = [:]
                result["name"] = attrSyntax.attributeName.description.trimmingCharacters(in: .whitespaces)
                if let args = attrSyntax.arguments {
                    result["arguments"] = args.description.trimmingCharacters(in: .whitespaces)
                }
                return result
            }
            return nil
        }
    }

    private func serializeWhereClause(_ clause: GenericWhereClauseSyntax) -> [[String: Any]] {
        clause.requirements.map { req in
            switch req.requirement {
            case .conformanceRequirement(let conf):
                return ["kind": "conformance",
                        "leftType": serializeType(conf.leftType),
                        "rightType": serializeType(conf.rightType)]
            case .sameTypeRequirement(let same):
                return ["kind": "sameType",
                        "leftType": serializeType(same.leftType),
                        "rightType": serializeType(same.rightType)]
            case .layoutRequirement(let layout):
                return ["kind": "layout", "type": serializeType(layout.type),
                        "layoutSpecifier": layout.layoutSpecifier.text]
            }
        }
    }

    private func serializeAccessorBlock(_ block: AccessorBlockSyntax?) -> [[String: Any]] {
        guard let block = block else { return [] }
        switch block.accessors {
        case .accessors(let list):
            return list.map { accessor in
                var result: [String: Any] = ["kind": accessor.accessorSpecifier.text]
                if let body = accessor.body {
                    result["body"] = serializeCodeBlockStatements(body.statements)
                }
                if let effectSpecifiers = accessor.effectSpecifiers {
                    if effectSpecifiers.asyncSpecifier != nil { result["isAsync"] = true }
                    if effectSpecifiers.throwsClause != nil { result["throws"] = true }
                }
                return result
            }
        case .getter(let body):
            return [["kind": "get", "body": serializeCodeBlockStatements(body)]]
        }
    }

    private func serializeCodeBlock(_ block: CodeBlockSyntax) -> [String: Any] {
        ["statements": serializeCodeBlockStatements(block.statements)]
    }

    private func serializeCodeBlockStatements(_ stmts: CodeBlockItemListSyntax) -> [[String: Any]] {
        stmts.compactMap { serializeCodeBlockItem($0) }
    }

    // MARK: - Span

    private func span(of node: some SyntaxProtocol) -> [String: Any] {
        let converter = SourceLocationConverter(fileName: "", tree: node.root)
        let start = converter.location(for: node.positionAfterSkippingLeadingTrivia)
        let end = converter.location(for: node.endPositionBeforeTrailingTrivia)
        return [
            "start": ["line": start.line, "column": start.column - 1],
            "end": ["line": end.line, "column": end.column - 1]
        ]
    }
}
