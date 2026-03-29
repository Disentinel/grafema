package com.grafema.parser

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import org.jetbrains.kotlin.com.intellij.psi.PsiElement
import org.jetbrains.kotlin.KtNodeTypes
import org.jetbrains.kotlin.lexer.KtTokens
import org.jetbrains.kotlin.psi.*
import org.jetbrains.kotlin.types.Variance

/**
 * Serializes Kotlin PSI tree (KtFile) to Grafema JSON AST format.
 * Each node has "type" discriminator + "span" + type-specific fields.
 */
object KotlinAstSerializer {

    // ── Top-level ───────────────────────────────────────────────────────

    fun serialize(file: KtFile): JsonObject {
        val obj = JsonObject()
        file.packageDirective?.let { pd ->
            if (pd.fqName.asString().isNotEmpty()) {
                obj.addProperty("package", pd.fqName.asString())
            }
        }
        obj.add("imports", serializeImports(file.importDirectives))
        obj.add("declarations", serializeDeclarations(file.declarations))
        return obj
    }

    // ── Imports ─────────────────────────────────────────────────────────

    private fun serializeImports(imports: List<KtImportDirective>): JsonArray {
        val arr = JsonArray()
        for (imp in imports) {
            val obj = JsonObject()
            obj.addProperty("name", imp.importedFqName?.asString() ?: "")
            obj.addProperty("alias", imp.aliasName)
            obj.addProperty("allUnder", imp.isAllUnder)
            obj.add("span", spanOf(imp))
            arr.add(obj)
        }
        return arr
    }

    // ── Declarations ────────────────────────────────────────────────────

    private fun serializeDeclarations(decls: List<KtDeclaration>): JsonArray {
        val arr = JsonArray()
        for (decl in decls) {
            arr.add(serializeDeclaration(decl))
        }
        return arr
    }

    private fun serializeDeclaration(decl: KtDeclaration): JsonObject {
        return when (decl) {
            is KtClass -> serializeClass(decl)
            is KtObjectDeclaration -> serializeObject(decl)
            is KtNamedFunction -> serializeFunction(decl)
            is KtProperty -> serializeProperty(decl)
            is KtTypeAlias -> serializeTypeAlias(decl)
            is KtClassInitializer -> serializeInitBlock(decl)
            is KtSecondaryConstructor -> serializeSecondaryConstructor(decl)
            is KtDestructuringDeclaration -> serializeDestructuringDecl(decl)
            is KtEnumEntry -> serializeEnumEntry(decl)
            else -> {
                val obj = JsonObject()
                obj.addProperty("type", "UnknownDecl")
                obj.add("span", spanOf(decl))
                obj
            }
        }
    }

    private fun serializeClass(cls: KtClass): JsonObject {
        val obj = JsonObject()
        obj.addProperty("type", "ClassDecl")
        obj.addProperty("name", cls.name ?: "")
        obj.add("modifiers", serializeModifiers(cls))
        obj.add("annotations", serializeAnnotations(cls))

        val kind = when {
            cls.isEnum() -> "enum"
            cls.isData() -> "data"
            cls.isSealed() -> "sealed"
            cls.isInner() -> "inner"
            cls.isAnnotation() -> "annotation"
            cls.isInterface() -> "interface"
            cls.hasModifier(KtTokens.VALUE_KEYWORD) -> "value"
            else -> "class"
        }
        obj.addProperty("kind", kind)

        obj.add("typeParameters", serializeTypeParameters(cls.typeParameters))
        obj.add("typeConstraints", serializeTypeConstraints(cls.typeConstraintList))

        // Supertype list
        val extends = JsonArray()
        val implements = JsonArray()
        for (entry in cls.superTypeListEntries) {
            when (entry) {
                is KtSuperTypeCallEntry -> {
                    val superObj = JsonObject()
                    superObj.add("type", serializeTypeReference(entry.typeReference))
                    superObj.add("args", serializeValueArguments(entry.valueArgumentList))
                    superObj.add("span", spanOf(entry))
                    extends.add(superObj)
                }
                is KtSuperTypeEntry -> {
                    implements.add(serializeTypeReference(entry.typeReference))
                }
                is KtDelegatedSuperTypeEntry -> {
                    val delObj = JsonObject()
                    delObj.add("type", serializeTypeReference(entry.typeReference))
                    entry.delegateExpression?.let { delObj.add("delegate", serializeExpr(it)) }
                    delObj.add("span", spanOf(entry))
                    implements.add(delObj)
                }
            }
        }
        if (extends.size() > 0) obj.add("extends", extends)
        if (implements.size() > 0) obj.add("implements", implements)

        // Primary constructor
        cls.primaryConstructor?.let { obj.add("primaryConstructor", serializePrimaryConstructor(it)) }

        // Members
        cls.body?.let { body ->
            obj.add("members", serializeDeclarations(body.declarations))
        }

        obj.add("span", spanOf(cls))
        return obj
    }

    private fun serializeObject(objDecl: KtObjectDeclaration): JsonObject {
        val obj = JsonObject()
        if (objDecl.isCompanion()) {
            obj.addProperty("type", "CompanionObjectDecl")
        } else {
            obj.addProperty("type", "ObjectDecl")
        }
        obj.addProperty("name", objDecl.name ?: "")
        obj.add("modifiers", serializeModifiers(objDecl))
        obj.add("annotations", serializeAnnotations(objDecl))

        // Supertypes
        val supertypes = JsonArray()
        for (entry in objDecl.superTypeListEntries) {
            when (entry) {
                is KtSuperTypeCallEntry -> {
                    val superObj = JsonObject()
                    superObj.add("type", serializeTypeReference(entry.typeReference))
                    superObj.add("args", serializeValueArguments(entry.valueArgumentList))
                    superObj.add("span", spanOf(entry))
                    supertypes.add(superObj)
                }
                is KtSuperTypeEntry -> {
                    supertypes.add(serializeTypeReference(entry.typeReference))
                }
                is KtDelegatedSuperTypeEntry -> {
                    val delObj = JsonObject()
                    delObj.add("type", serializeTypeReference(entry.typeReference))
                    entry.delegateExpression?.let { delObj.add("delegate", serializeExpr(it)) }
                    delObj.add("span", spanOf(entry))
                    supertypes.add(delObj)
                }
            }
        }
        if (supertypes.size() > 0) obj.add("supertypes", supertypes)

        objDecl.body?.let { body ->
            obj.add("members", serializeDeclarations(body.declarations))
        }

        obj.add("span", spanOf(objDecl))
        return obj
    }

    private fun serializeFunction(func: KtNamedFunction): JsonObject {
        val obj = JsonObject()
        obj.addProperty("type", "FunDecl")
        obj.addProperty("name", func.name ?: "")
        obj.add("modifiers", serializeModifiers(func))
        obj.add("annotations", serializeAnnotations(func))
        obj.add("typeParameters", serializeTypeParameters(func.typeParameters))
        obj.add("typeConstraints", serializeTypeConstraints(func.typeConstraintList))

        func.receiverTypeReference?.let { obj.add("receiverType", serializeTypeReference(it)) }

        obj.add("params", serializeParameters(func.valueParameters))

        func.typeReference?.let { obj.add("returnType", serializeTypeReference(it)) }

        func.bodyExpression?.let { body ->
            obj.add("body", serializeExpr(body))
            if (!func.hasBlockBody()) {
                obj.addProperty("bodyKind", "expression")
            }
        }

        obj.add("span", spanOf(func))
        return obj
    }

    private fun serializeProperty(prop: KtProperty): JsonObject {
        val obj = JsonObject()
        obj.addProperty("type", "PropertyDecl")
        obj.addProperty("name", prop.name ?: "")
        obj.add("modifiers", serializeModifiers(prop))
        obj.add("annotations", serializeAnnotations(prop))
        obj.addProperty("isVar", prop.isVar)

        prop.typeReference?.let { obj.add("propertyType", serializeTypeReference(it)) }

        prop.initializer?.let { obj.add("initializer", serializeExpr(it)) }

        prop.getter?.let { getter ->
            val getterObj = JsonObject()
            getterObj.addProperty("kind", "get")
            getterObj.add("modifiers", serializeModifiers(getter))
            getterObj.add("annotations", serializeAnnotations(getter))
            getter.bodyExpression?.let { getterObj.add("body", serializeExpr(it)) }
            getter.returnTypeReference?.let { getterObj.add("returnType", serializeTypeReference(it)) }
            getterObj.add("span", spanOf(getter))
            obj.add("getter", getterObj)
        }

        prop.setter?.let { setter ->
            val setterObj = JsonObject()
            setterObj.addProperty("kind", "set")
            setterObj.add("modifiers", serializeModifiers(setter))
            setterObj.add("annotations", serializeAnnotations(setter))
            setter.parameter?.let { param ->
                val paramObj = JsonObject()
                paramObj.addProperty("name", param.name ?: "")
                param.typeReference?.let { paramObj.add("paramType", serializeTypeReference(it)) }
                paramObj.add("span", spanOf(param))
                setterObj.add("param", paramObj)
            }
            setter.bodyExpression?.let { setterObj.add("body", serializeExpr(it)) }
            setterObj.add("span", spanOf(setter))
            obj.add("setter", setterObj)
        }

        prop.delegateExpression?.let { obj.add("delegate", serializeExpr(it)) }

        obj.add("span", spanOf(prop))
        return obj
    }

    private fun serializeTypeAlias(alias: KtTypeAlias): JsonObject {
        val obj = JsonObject()
        obj.addProperty("type", "TypeAlias")
        obj.addProperty("name", alias.name ?: "")
        obj.add("modifiers", serializeModifiers(alias))
        obj.add("annotations", serializeAnnotations(alias))
        obj.add("typeParameters", serializeTypeParameters(alias.typeParameters))
        alias.getTypeReference()?.let { obj.add("aliasedType", serializeTypeReference(it)) }
        obj.add("span", spanOf(alias))
        return obj
    }

    private fun serializeInitBlock(init: KtClassInitializer): JsonObject {
        val obj = JsonObject()
        obj.addProperty("type", "InitBlock")
        init.body?.let { obj.add("body", serializeExpr(it)) }
        obj.add("span", spanOf(init))
        return obj
    }

    private fun serializePrimaryConstructor(ctor: KtPrimaryConstructor): JsonObject {
        val obj = JsonObject()
        obj.addProperty("type", "PrimaryConstructor")
        obj.add("modifiers", serializeModifiers(ctor))
        obj.add("annotations", serializeAnnotations(ctor))
        val params = JsonArray()
        for (param in ctor.valueParameters) {
            val paramObj = JsonObject()
            paramObj.addProperty("name", param.name ?: "")
            param.typeReference?.let { paramObj.add("paramType", serializeTypeReference(it)) }
            param.defaultValue?.let { paramObj.add("defaultValue", serializeExpr(it)) }
            paramObj.addProperty("hasValOrVar", param.hasValOrVar())
            if (param.valOrVarKeyword != null) {
                paramObj.addProperty("valOrVar", if (param.isMutable) "var" else "val")
            }
            paramObj.add("modifiers", serializeModifiers(param))
            paramObj.add("annotations", serializeAnnotations(param))
            paramObj.add("span", spanOf(param))
            params.add(paramObj)
        }
        obj.add("params", params)
        obj.add("span", spanOf(ctor))
        return obj
    }

    private fun serializeSecondaryConstructor(ctor: KtSecondaryConstructor): JsonObject {
        val obj = JsonObject()
        obj.addProperty("type", "SecondaryConstructor")
        obj.add("modifiers", serializeModifiers(ctor))
        obj.add("annotations", serializeAnnotations(ctor))
        obj.add("params", serializeParameters(ctor.valueParameters))

        val call = ctor.getDelegationCall()
        if (!call.isImplicit) {
            val delObj = JsonObject()
            delObj.addProperty("isThis", call.isCallToThis)
            delObj.add("args", serializeValueArguments(call.valueArgumentList))
            delObj.add("span", spanOf(call))
            obj.add("delegationCall", delObj)
        }

        ctor.bodyExpression?.let { obj.add("body", serializeExpr(it)) }
        obj.add("span", spanOf(ctor))
        return obj
    }

    private fun serializeEnumEntry(entry: KtEnumEntry): JsonObject {
        val obj = JsonObject()
        obj.addProperty("type", "EnumEntry")
        obj.addProperty("name", entry.name ?: "")
        obj.add("annotations", serializeAnnotations(entry))

        val initList = entry.initializerList
        if (initList != null) {
            for (initializer in initList.initializers) {
                if (initializer is KtSuperTypeCallEntry) {
                    obj.add("args", serializeValueArguments(initializer.valueArgumentList))
                }
            }
        }

        entry.body?.let { body ->
            obj.add("members", serializeDeclarations(body.declarations))
        }

        obj.add("span", spanOf(entry))
        return obj
    }

    // ── Expressions ─────────────────────────────────────────────────────

    private fun serializeExpr(expr: KtExpression): JsonObject {
        return when (expr) {
            is KtBlockExpression -> serializeBlock(expr)
            is KtCallExpression -> serializeCallExpr(expr)
            is KtDotQualifiedExpression -> serializeDotQualified(expr)
            is KtSafeQualifiedExpression -> serializeSafeCall(expr)
            is KtBinaryExpressionWithTypeRHS -> serializeBinaryWithType(expr)
            is KtIsExpression -> serializeIsExpr(expr)
            is KtBinaryExpression -> serializeBinaryExpr(expr)
            is KtPrefixExpression -> serializePrefixExpr(expr)
            is KtPostfixExpression -> serializePostfixExpr(expr)
            is KtIfExpression -> serializeIfExpr(expr)
            is KtWhenExpression -> serializeWhenExpr(expr)
            is KtWhileExpression -> serializeWhileExpr(expr)
            is KtDoWhileExpression -> serializeDoWhileExpr(expr)
            is KtForExpression -> serializeForExpr(expr)
            is KtTryExpression -> serializeTryExpr(expr)
            is KtReturnExpression -> serializeReturn(expr)
            is KtThrowExpression -> serializeThrow(expr)
            is KtBreakExpression -> serializeBreak(expr)
            is KtContinueExpression -> serializeContinue(expr)
            is KtStringTemplateExpression -> serializeStringTemplate(expr)
            is KtLambdaExpression -> serializeLambda(expr)
            is KtParenthesizedExpression -> serializeParenthesized(expr)
            is KtConstantExpression -> serializeConstant(expr)
            is KtNameReferenceExpression -> serializeNameRef(expr)
            is KtThisExpression -> serializeThis(expr)
            is KtSuperExpression -> serializeSuper(expr)
            is KtObjectLiteralExpression -> serializeObjectLiteral(expr)
            is KtClassLiteralExpression -> serializeClassLiteral(expr)
            is KtArrayAccessExpression -> serializeArrayAccess(expr)
            is KtDestructuringDeclaration -> serializeDestructuringDecl(expr)
            is KtProperty -> serializeProperty(expr)
            is KtAnnotatedExpression -> serializeAnnotatedExpr(expr)
            is KtLabeledExpression -> serializeLabeledExpr(expr)
            is KtCollectionLiteralExpression -> serializeCollectionLiteral(expr)
            is KtCallableReferenceExpression -> serializeCallableRef(expr)
            else -> {
                val obj = JsonObject()
                obj.addProperty("type", "ExprUnknown")
                obj.addProperty("text", expr.text.take(100))
                obj.add("span", spanOf(expr))
                obj
            }
        }
    }

    private fun serializeBlock(block: KtBlockExpression): JsonObject {
        val obj = JsonObject()
        obj.addProperty("type", "BlockStmt")
        val stmts = JsonArray()
        for (stmt in block.statements) {
            stmts.add(serializeExpr(stmt))
        }
        obj.add("stmts", stmts)
        obj.add("span", spanOf(block))
        return obj
    }

    private fun serializeCallExpr(call: KtCallExpression): JsonObject {
        val obj = JsonObject()
        val callee = call.calleeExpression
        val name = callee?.text ?: ""
        val isConstructor = name.isNotEmpty() && name[0].isUpperCase()

        if (isConstructor) {
            obj.addProperty("type", "ObjectCreationExpr")
            val classTypeObj = JsonObject()
            classTypeObj.addProperty("type", "SimpleType")
            classTypeObj.addProperty("name", name)
            classTypeObj.addProperty("nullable", false)
            classTypeObj.add("typeArgs", JsonArray())
            classTypeObj.add("span", spanOf(callee ?: call))
            obj.add("classType", classTypeObj)
        } else {
            obj.addProperty("type", "CallExpr")
            obj.addProperty("name", name)
        }

        obj.add("args", serializeValueArguments(call.valueArgumentList))
        obj.add("typeArgs", serializeTypeArguments(call.typeArgumentList))

        for (lambdaArg in call.lambdaArguments) {
            val lambdaExpr = lambdaArg.getLambdaExpression()
            if (lambdaExpr != null) {
                obj.add("trailingLambda", serializeLambda(lambdaExpr))
            }
        }

        obj.add("span", spanOf(call))
        return obj
    }

    private fun serializeDotQualified(expr: KtDotQualifiedExpression): JsonObject {
        val selector = expr.selectorExpression
        if (selector is KtCallExpression) {
            val obj = JsonObject()
            val name = selector.calleeExpression?.text ?: ""
            obj.addProperty("type", "CallExpr")
            obj.addProperty("name", name)
            obj.add("scope", serializeExpr(expr.receiverExpression))
            obj.add("args", serializeValueArguments(selector.valueArgumentList))
            obj.add("typeArgs", serializeTypeArguments(selector.typeArgumentList))
            for (lambdaArg in selector.lambdaArguments) {
                val lambdaExpr = lambdaArg.getLambdaExpression()
                if (lambdaExpr != null) {
                    obj.add("trailingLambda", serializeLambda(lambdaExpr))
                }
            }
            obj.add("span", spanOf(expr))
            return obj
        }

        val obj = JsonObject()
        obj.addProperty("type", "PropertyAccessExpr")
        obj.add("scope", serializeExpr(expr.receiverExpression))
        obj.addProperty("name", selector?.text ?: "")
        obj.add("span", spanOf(expr))
        return obj
    }

    private fun serializeSafeCall(expr: KtSafeQualifiedExpression): JsonObject {
        val obj = JsonObject()
        val selector = expr.selectorExpression
        if (selector is KtCallExpression) {
            obj.addProperty("type", "SafeCallExpr")
            obj.add("scope", serializeExpr(expr.receiverExpression))
            obj.addProperty("name", selector.calleeExpression?.text ?: "")
            obj.add("args", serializeValueArguments(selector.valueArgumentList))
            obj.add("span", spanOf(expr))
        } else {
            obj.addProperty("type", "PropertyAccessExpr")
            obj.add("scope", serializeExpr(expr.receiverExpression))
            obj.addProperty("name", selector?.text ?: "")
            obj.add("span", spanOf(expr))
        }
        return obj
    }

    private fun serializeBinaryExpr(expr: KtBinaryExpression): JsonObject {
        val op = expr.operationToken
        val opText = expr.operationReference.text

        // Elvis operator
        if (op == KtTokens.ELVIS) {
            val obj = JsonObject()
            obj.addProperty("type", "ElvisExpr")
            expr.left?.let { obj.add("left", serializeExpr(it)) }
            expr.right?.let { obj.add("right", serializeExpr(it)) }
            obj.add("span", spanOf(expr))
            return obj
        }

        // Range operators
        if (op == KtTokens.RANGE || opText == "..<") {
            val obj = JsonObject()
            obj.addProperty("type", "RangeExpr")
            expr.left?.let { obj.add("left", serializeExpr(it)) }
            expr.right?.let { obj.add("right", serializeExpr(it)) }
            obj.addProperty("operator", opText)
            obj.add("span", spanOf(expr))
            return obj
        }

        // Assignment operators
        if (op == KtTokens.EQ || op == KtTokens.PLUSEQ || op == KtTokens.MINUSEQ ||
            op == KtTokens.MULTEQ || op == KtTokens.DIVEQ || op == KtTokens.PERCEQ) {
            val obj = JsonObject()
            obj.addProperty("type", "AssignExpr")
            expr.left?.let { obj.add("target", serializeExpr(it)) }
            obj.addProperty("operator", opText)
            expr.right?.let { obj.add("value", serializeExpr(it)) }
            obj.add("span", spanOf(expr))
            return obj
        }

        // in / !in operators
        if (op == KtTokens.IN_KEYWORD || op == KtTokens.NOT_IN) {
            val obj = JsonObject()
            obj.addProperty("type", "InExpr")
            expr.left?.let { obj.add("left", serializeExpr(it)) }
            expr.right?.let { obj.add("right", serializeExpr(it)) }
            obj.addProperty("negated", op == KtTokens.NOT_IN)
            obj.add("span", spanOf(expr))
            return obj
        }

        // General binary
        val obj = JsonObject()
        obj.addProperty("type", "BinaryExpr")
        expr.left?.let { obj.add("left", serializeExpr(it)) }
        obj.addProperty("operator", opText)
        expr.right?.let { obj.add("right", serializeExpr(it)) }
        obj.add("span", spanOf(expr))
        return obj
    }

    private fun serializePrefixExpr(expr: KtPrefixExpression): JsonObject {
        val obj = JsonObject()
        obj.addProperty("type", "UnaryExpr")
        obj.addProperty("operator", expr.operationReference.text)
        obj.addProperty("prefix", true)
        expr.baseExpression?.let { obj.add("expr", serializeExpr(it)) }
        obj.add("span", spanOf(expr))
        return obj
    }

    private fun serializePostfixExpr(expr: KtPostfixExpression): JsonObject {
        val op = expr.operationToken

        // Not-null assertion (!!)
        if (op == KtTokens.EXCLEXCL) {
            val obj = JsonObject()
            obj.addProperty("type", "NotNullAssertExpr")
            expr.baseExpression?.let { obj.add("expr", serializeExpr(it)) }
            obj.add("span", spanOf(expr))
            return obj
        }

        val obj = JsonObject()
        obj.addProperty("type", "UnaryExpr")
        obj.addProperty("operator", expr.operationReference.text)
        obj.addProperty("prefix", false)
        expr.baseExpression?.let { obj.add("expr", serializeExpr(it)) }
        obj.add("span", spanOf(expr))
        return obj
    }

    private fun serializeIfExpr(expr: KtIfExpression): JsonObject {
        val obj = JsonObject()
        val isExpression = expr.`else` != null && expr.parent !is KtBlockExpression
        obj.addProperty("type", if (isExpression) "ConditionalExpr" else "IfStmt")
        expr.condition?.let { obj.add("condition", serializeExpr(it)) }
        expr.then?.let { obj.add("then", serializeExpr(it)) }
        expr.`else`?.let { obj.add("else", serializeExpr(it)) }
        obj.add("span", spanOf(expr))
        return obj
    }

    private fun serializeWhenExpr(expr: KtWhenExpression): JsonObject {
        val obj = JsonObject()
        obj.addProperty("type", "WhenExpr")
        expr.subjectExpression?.let { obj.add("subject", serializeExpr(it)) }
        val entries = JsonArray()
        for (entry in expr.entries) {
            val entryObj = JsonObject()
            entryObj.addProperty("isElse", entry.isElse)
            val conditions = JsonArray()
            for (condition in entry.conditions) {
                conditions.add(serializeWhenCondition(condition))
            }
            entryObj.add("conditions", conditions)
            entry.expression?.let { entryObj.add("body", serializeExpr(it)) }
            entryObj.add("span", spanOf(entry))
            entries.add(entryObj)
        }
        obj.add("entries", entries)
        obj.add("span", spanOf(expr))
        return obj
    }

    private fun serializeWhenCondition(condition: KtWhenCondition): JsonObject {
        val obj = JsonObject()
        when (condition) {
            is KtWhenConditionWithExpression -> {
                obj.addProperty("type", "ExprCondition")
                condition.expression?.let { obj.add("expr", serializeExpr(it)) }
            }
            is KtWhenConditionInRange -> {
                obj.addProperty("type", "InRangeCondition")
                obj.addProperty("negated", condition.isNegated)
                condition.rangeExpression?.let { obj.add("range", serializeExpr(it)) }
            }
            is KtWhenConditionIsPattern -> {
                obj.addProperty("type", "IsPatternCondition")
                obj.addProperty("negated", condition.isNegated)
                condition.typeReference?.let { obj.add("checkType", serializeTypeReference(it)) }
            }
            else -> {
                obj.addProperty("type", "UnknownCondition")
            }
        }
        obj.add("span", spanOf(condition))
        return obj
    }

    private fun serializeWhileExpr(expr: KtWhileExpression): JsonObject {
        val obj = JsonObject()
        obj.addProperty("type", "WhileStmt")
        expr.condition?.let { obj.add("condition", serializeExpr(it)) }
        expr.body?.let { obj.add("body", serializeExpr(it)) }
        obj.add("span", spanOf(expr))
        return obj
    }

    private fun serializeDoWhileExpr(expr: KtDoWhileExpression): JsonObject {
        val obj = JsonObject()
        obj.addProperty("type", "DoStmt")
        expr.condition?.let { obj.add("condition", serializeExpr(it)) }
        expr.body?.let { obj.add("body", serializeExpr(it)) }
        obj.add("span", spanOf(expr))
        return obj
    }

    private fun serializeForExpr(expr: KtForExpression): JsonObject {
        val obj = JsonObject()
        obj.addProperty("type", "ForStmt")
        expr.loopParameter?.let { param ->
            val paramObj = JsonObject()
            if (param.destructuringDeclaration != null) {
                val entries = param.destructuringDeclaration!!.entries
                val entryNames = entries.map { it.name ?: "_" }
                paramObj.addProperty("name", "(${entryNames.joinToString(", ")})")
                param.typeReference?.let { paramObj.add("varType", serializeTypeReference(it)) }
            } else {
                paramObj.addProperty("name", param.name ?: "")
                param.typeReference?.let { paramObj.add("varType", serializeTypeReference(it)) }
            }
            paramObj.add("span", spanOf(param))
            obj.add("variable", paramObj)
        }
        expr.loopRange?.let { obj.add("iterable", serializeExpr(it)) }
        expr.body?.let { obj.add("body", serializeExpr(it)) }
        obj.add("span", spanOf(expr))
        return obj
    }

    private fun serializeTryExpr(expr: KtTryExpression): JsonObject {
        val obj = JsonObject()
        obj.addProperty("type", "TryStmt")
        obj.add("tryBlock", serializeExpr(expr.tryBlock))
        val catches = JsonArray()
        for (clause in expr.catchClauses) {
            val catchObj = JsonObject()
            clause.catchParameter?.let { param ->
                catchObj.addProperty("paramName", param.name ?: "")
                param.typeReference?.let { catchObj.add("paramType", serializeTypeReference(it)) }
            }
            clause.catchBody?.let { catchObj.add("body", serializeExpr(it)) }
            catchObj.add("span", spanOf(clause))
            catches.add(catchObj)
        }
        obj.add("catches", catches)
        expr.finallyBlock?.let { fb ->
            fb.finalExpression?.let { obj.add("finally", serializeExpr(it)) }
        }
        obj.add("span", spanOf(expr))
        return obj
    }

    private fun serializeReturn(expr: KtReturnExpression): JsonObject {
        val obj = JsonObject()
        obj.addProperty("type", "ReturnStmt")
        expr.returnedExpression?.let { obj.add("expr", serializeExpr(it)) }
        expr.getLabelName()?.let { obj.addProperty("label", it) }
        obj.add("span", spanOf(expr))
        return obj
    }

    private fun serializeThrow(expr: KtThrowExpression): JsonObject {
        val obj = JsonObject()
        obj.addProperty("type", "ThrowStmt")
        expr.thrownExpression?.let { obj.add("expr", serializeExpr(it)) }
        obj.add("span", spanOf(expr))
        return obj
    }

    private fun serializeBreak(expr: KtBreakExpression): JsonObject {
        val obj = JsonObject()
        obj.addProperty("type", "BreakStmt")
        expr.getLabelName()?.let { obj.addProperty("label", it) }
        obj.add("span", spanOf(expr))
        return obj
    }

    private fun serializeContinue(expr: KtContinueExpression): JsonObject {
        val obj = JsonObject()
        obj.addProperty("type", "ContinueStmt")
        expr.getLabelName()?.let { obj.addProperty("label", it) }
        obj.add("span", spanOf(expr))
        return obj
    }

    private fun serializeStringTemplate(expr: KtStringTemplateExpression): JsonObject {
        val obj = JsonObject()
        obj.addProperty("type", "StringTemplateExpr")
        val parts = JsonArray()
        for (entry in expr.entries) {
            val partObj = JsonObject()
            when (entry) {
                is KtLiteralStringTemplateEntry -> {
                    partObj.addProperty("type", "literal")
                    partObj.addProperty("value", entry.text)
                }
                is KtSimpleNameStringTemplateEntry -> {
                    partObj.addProperty("type", "reference")
                    partObj.addProperty("name", entry.expression?.text ?: "")
                }
                is KtBlockStringTemplateEntry -> {
                    partObj.addProperty("type", "block")
                    entry.expression?.let { partObj.add("expr", serializeExpr(it)) }
                }
                is KtEscapeStringTemplateEntry -> {
                    partObj.addProperty("type", "escape")
                    partObj.addProperty("value", entry.unescapedValue)
                }
            }
            partObj.add("span", spanOf(entry))
            parts.add(partObj)
        }
        obj.add("parts", parts)
        obj.add("span", spanOf(expr))
        return obj
    }

    private fun serializeLambda(expr: KtLambdaExpression): JsonObject {
        val obj = JsonObject()
        obj.addProperty("type", "LambdaExpr")
        val funcLiteral = expr.functionLiteral
        val params = JsonArray()
        for (param in funcLiteral.valueParameters) {
            val paramObj = JsonObject()
            paramObj.addProperty("name", param.name ?: "")
            param.typeReference?.let { paramObj.add("paramType", serializeTypeReference(it)) }
            if (param.destructuringDeclaration != null) {
                paramObj.addProperty("isDestructuring", true)
                val entries = JsonArray()
                for (entry in param.destructuringDeclaration!!.entries) {
                    val entryObj = JsonObject()
                    entryObj.addProperty("name", entry.name ?: "_")
                    entry.typeReference?.let { entryObj.add("paramType", serializeTypeReference(it)) }
                    entryObj.add("span", spanOf(entry))
                    entries.add(entryObj)
                }
                paramObj.add("destructuringEntries", entries)
            }
            paramObj.add("span", spanOf(param))
            params.add(paramObj)
        }
        obj.add("params", params)
        funcLiteral.bodyExpression?.let { obj.add("body", serializeExpr(it)) }
        obj.add("span", spanOf(expr))
        return obj
    }

    private fun serializeParenthesized(expr: KtParenthesizedExpression): JsonObject {
        val obj = JsonObject()
        obj.addProperty("type", "EnclosedExpr")
        expr.expression?.let { obj.add("inner", serializeExpr(it)) }
        obj.add("span", spanOf(expr))
        return obj
    }

    private fun serializeConstant(expr: KtConstantExpression): JsonObject {
        val obj = JsonObject()
        obj.addProperty("type", "LiteralExpr")
        val elementType = expr.node.elementType
        val literalType: String = when (elementType) {
            KtNodeTypes.INTEGER_CONSTANT -> "int"
            KtNodeTypes.FLOAT_CONSTANT -> "float"
            KtNodeTypes.CHARACTER_CONSTANT -> "char"
            KtNodeTypes.BOOLEAN_CONSTANT -> "boolean"
            KtNodeTypes.NULL -> "null"
            else -> "unknown"
        }
        obj.addProperty("literalType", literalType)
        obj.addProperty("value", expr.text)
        obj.add("span", spanOf(expr))
        return obj
    }

    private fun serializeNameRef(expr: KtNameReferenceExpression): JsonObject {
        val obj = JsonObject()
        // Handle true, false, null as literals when they appear as name references
        val name = expr.getReferencedName()
        if (name == "true" || name == "false") {
            obj.addProperty("type", "LiteralExpr")
            obj.addProperty("literalType", "boolean")
            obj.addProperty("value", name)
        } else if (name == "null") {
            obj.addProperty("type", "LiteralExpr")
            obj.addProperty("literalType", "null")
            obj.addProperty("value", "null")
        } else {
            obj.addProperty("type", "NameExpr")
            obj.addProperty("name", name)
        }
        obj.add("span", spanOf(expr))
        return obj
    }

    private fun serializeThis(expr: KtThisExpression): JsonObject {
        val obj = JsonObject()
        obj.addProperty("type", "ThisExpr")
        expr.getLabelName()?.let { obj.addProperty("qualifier", it) }
        obj.add("span", spanOf(expr))
        return obj
    }

    private fun serializeSuper(expr: KtSuperExpression): JsonObject {
        val obj = JsonObject()
        obj.addProperty("type", "SuperExpr")
        expr.getLabelName()?.let { obj.addProperty("qualifier", it) }
        expr.superTypeQualifier?.let { obj.addProperty("superTypeQualifier", it.text) }
        obj.add("span", spanOf(expr))
        return obj
    }

    private fun serializeBinaryWithType(expr: KtBinaryExpressionWithTypeRHS): JsonObject {
        val obj = JsonObject()
        val opText = expr.operationReference.text
        if (opText == "as" || opText == "as?") {
            obj.addProperty("type", "CastExpr")
            obj.add("expr", serializeExpr(expr.left))
            expr.right?.let { obj.add("castType", serializeTypeReference(it)) }
            obj.addProperty("safe", opText == "as?")
        } else {
            obj.addProperty("type", "BinaryExprWithType")
            obj.add("left", serializeExpr(expr.left))
            obj.addProperty("operator", opText)
            expr.right?.let { obj.add("rightType", serializeTypeReference(it)) }
        }
        obj.add("span", spanOf(expr))
        return obj
    }

    private fun serializeIsExpr(expr: KtIsExpression): JsonObject {
        val obj = JsonObject()
        obj.addProperty("type", "IsExpr")
        obj.add("expr", serializeExpr(expr.leftHandSide))
        expr.typeReference?.let { obj.add("checkType", serializeTypeReference(it)) }
        obj.addProperty("negated", expr.isNegated)
        obj.add("span", spanOf(expr))
        return obj
    }

    private fun serializeObjectLiteral(expr: KtObjectLiteralExpression): JsonObject {
        val obj = JsonObject()
        obj.addProperty("type", "ObjectLiteralExpr")
        obj.add("declaration", serializeObject(expr.objectDeclaration))
        obj.add("span", spanOf(expr))
        return obj
    }

    private fun serializeClassLiteral(expr: KtClassLiteralExpression): JsonObject {
        val obj = JsonObject()
        obj.addProperty("type", "ClassLiteralExpr")
        expr.receiverExpression?.let { obj.add("receiver", serializeExpr(it)) }
        obj.add("span", spanOf(expr))
        return obj
    }

    private fun serializeArrayAccess(expr: KtArrayAccessExpression): JsonObject {
        val obj = JsonObject()
        obj.addProperty("type", "ArrayAccessExpr")
        expr.arrayExpression?.let { obj.add("array", serializeExpr(it)) }
        val indices = JsonArray()
        for (index in expr.indexExpressions) {
            indices.add(serializeExpr(index))
        }
        obj.add("indices", indices)
        obj.add("span", spanOf(expr))
        return obj
    }

    private fun serializeDestructuringDecl(decl: KtDestructuringDeclaration): JsonObject {
        val obj = JsonObject()
        obj.addProperty("type", "DestructuringDecl")
        val entries = JsonArray()
        for (entry in decl.entries) {
            val entryObj = JsonObject()
            entryObj.addProperty("name", entry.name ?: "_")
            entry.typeReference?.let { entryObj.add("entryType", serializeTypeReference(it)) }
            entryObj.add("span", spanOf(entry))
            entries.add(entryObj)
        }
        obj.add("entries", entries)
        decl.initializer?.let { obj.add("initializer", serializeExpr(it)) }
        obj.add("span", spanOf(decl))
        return obj
    }

    private fun serializeAnnotatedExpr(expr: KtAnnotatedExpression): JsonObject {
        val obj = JsonObject()
        obj.addProperty("type", "AnnotatedExpr")
        obj.add("annotations", serializeAnnotations(expr))
        expr.baseExpression?.let { obj.add("expr", serializeExpr(it)) }
        obj.add("span", spanOf(expr))
        return obj
    }

    private fun serializeLabeledExpr(expr: KtLabeledExpression): JsonObject {
        val obj = JsonObject()
        obj.addProperty("type", "LabeledExpr")
        obj.addProperty("label", expr.getLabelName() ?: "")
        expr.baseExpression?.let { obj.add("expr", serializeExpr(it)) }
        obj.add("span", spanOf(expr))
        return obj
    }

    private fun serializeCollectionLiteral(expr: KtCollectionLiteralExpression): JsonObject {
        val obj = JsonObject()
        obj.addProperty("type", "CollectionLiteralExpr")
        val elements = JsonArray()
        for (element in expr.getInnerExpressions()) {
            elements.add(serializeExpr(element))
        }
        obj.add("elements", elements)
        obj.add("span", spanOf(expr))
        return obj
    }

    private fun serializeCallableRef(expr: KtCallableReferenceExpression): JsonObject {
        val obj = JsonObject()
        obj.addProperty("type", "CallableRefExpr")
        expr.receiverExpression?.let { obj.add("receiver", serializeExpr(it)) }
        obj.addProperty("name", expr.callableReference.getReferencedName())
        obj.add("span", spanOf(expr))
        return obj
    }

    // ── Types ───────────────────────────────────────────────────────────

    private fun serializeTypeReference(typeRef: KtTypeReference?): JsonObject {
        if (typeRef == null) {
            val obj = JsonObject()
            obj.addProperty("type", "TypeUnknown")
            return obj
        }
        return serializeTypeElement(typeRef.typeElement, typeRef)
    }

    private fun serializeTypeElement(typeElement: KtTypeElement?, source: PsiElement): JsonObject {
        if (typeElement == null) {
            val obj = JsonObject()
            obj.addProperty("type", "TypeUnknown")
            obj.add("span", spanOf(source))
            return obj
        }
        return when (typeElement) {
            is KtUserType -> serializeUserType(typeElement, source)
            is KtNullableType -> {
                val obj = JsonObject()
                obj.addProperty("type", "NullableType")
                obj.add("inner", serializeTypeElement(typeElement.innerType, source))
                obj.add("span", spanOf(source))
                obj
            }
            is KtFunctionType -> {
                val obj = JsonObject()
                obj.addProperty("type", "FunctionType")
                typeElement.receiverTypeReference?.let { obj.add("receiverType", serializeTypeReference(it)) }
                val paramTypes = JsonArray()
                for (param in typeElement.parameters) {
                    param.typeReference?.let { paramTypes.add(serializeTypeReference(it)) }
                }
                obj.add("paramTypes", paramTypes)
                typeElement.returnTypeReference?.let { obj.add("returnType", serializeTypeReference(it)) }
                obj.add("span", spanOf(source))
                obj
            }
            is KtDynamicType -> {
                val obj = JsonObject()
                obj.addProperty("type", "DynamicType")
                obj.add("span", spanOf(source))
                obj
            }
            is KtIntersectionType -> {
                val obj = JsonObject()
                obj.addProperty("type", "IntersectionType")
                val types = JsonArray()
                typeElement.getLeftTypeRef()?.let { types.add(serializeTypeReference(it)) }
                typeElement.getRightTypeRef()?.let { types.add(serializeTypeReference(it)) }
                obj.add("types", types)
                obj.add("span", spanOf(source))
                obj
            }
            else -> {
                val obj = JsonObject()
                obj.addProperty("type", "TypeUnknown")
                obj.add("span", spanOf(source))
                obj
            }
        }
    }

    private fun serializeUserType(userType: KtUserType, source: PsiElement): JsonObject {
        val obj = JsonObject()
        obj.addProperty("type", "ClassType")
        obj.addProperty("name", userType.referencedName ?: "")

        userType.qualifier?.let { qualifier ->
            obj.addProperty("scope", buildQualifiedName(qualifier))
        }

        val typeArgs = JsonArray()
        userType.typeArguments.forEach { projection ->
            val argObj = JsonObject()
            if (projection.projectionKind == KtProjectionKind.STAR) {
                argObj.addProperty("type", "StarProjection")
            } else {
                projection.typeReference?.let {
                    argObj.add("type", serializeTypeReference(it))
                }
                when (projection.projectionKind) {
                    KtProjectionKind.IN -> argObj.addProperty("variance", "in")
                    KtProjectionKind.OUT -> argObj.addProperty("variance", "out")
                    else -> {}
                }
            }
            argObj.add("span", spanOf(projection))
            typeArgs.add(argObj)
        }
        if (typeArgs.size() > 0) obj.add("typeArgs", typeArgs)

        obj.add("span", spanOf(source))
        return obj
    }

    private fun buildQualifiedName(userType: KtUserType): String {
        val qualifier = userType.qualifier
        val name = userType.referencedName ?: ""
        return if (qualifier != null) {
            "${buildQualifiedName(qualifier)}.$name"
        } else {
            name
        }
    }

    // ── Parameters ──────────────────────────────────────────────────────

    private fun serializeParameters(params: List<KtParameter>): JsonArray {
        val arr = JsonArray()
        for (param in params) {
            arr.add(serializeParameter(param))
        }
        return arr
    }

    private fun serializeParameter(param: KtParameter): JsonObject {
        val obj = JsonObject()
        obj.addProperty("name", param.name ?: "")
        param.typeReference?.let { obj.add("paramType", serializeTypeReference(it)) }
        param.defaultValue?.let { obj.add("defaultValue", serializeExpr(it)) }
        obj.addProperty("isVarArg", param.isVarArg)
        obj.add("modifiers", serializeModifiers(param))
        obj.add("annotations", serializeAnnotations(param))
        obj.add("span", spanOf(param))
        return obj
    }

    // ── Type parameters ─────────────────────────────────────────────────

    private fun serializeTypeParameters(typeParams: List<KtTypeParameter>): JsonArray {
        val arr = JsonArray()
        for (tp in typeParams) {
            val obj = JsonObject()
            obj.addProperty("name", tp.name ?: "")
            tp.extendsBound?.let { obj.add("upperBound", serializeTypeReference(it)) }
            when (tp.variance) {
                Variance.IN_VARIANCE -> obj.addProperty("variance", "in")
                Variance.OUT_VARIANCE -> obj.addProperty("variance", "out")
                else -> {}
            }
            obj.addProperty("reified", tp.hasModifier(KtTokens.REIFIED_KEYWORD))
            obj.add("span", spanOf(tp))
            arr.add(obj)
        }
        return arr
    }

    private fun serializeTypeConstraints(constraintList: KtTypeConstraintList?): JsonArray {
        val arr = JsonArray()
        if (constraintList == null) return arr
        for (constraint in constraintList.constraints) {
            val obj = JsonObject()
            obj.addProperty("name", constraint.subjectTypeParameterName?.text ?: "")
            constraint.boundTypeReference?.let { obj.add("bound", serializeTypeReference(it)) }
            obj.add("span", spanOf(constraint))
            arr.add(obj)
        }
        return arr
    }

    // ── Value arguments ─────────────────────────────────────────────────

    private fun serializeValueArguments(argList: KtValueArgumentList?): JsonArray {
        val arr = JsonArray()
        if (argList == null) return arr
        for (arg in argList.arguments) {
            arg.getArgumentExpression()?.let { arr.add(serializeExpr(it)) }
        }
        return arr
    }

    // ── Type arguments ──────────────────────────────────────────────────

    private fun serializeTypeArguments(argList: KtTypeArgumentList?): JsonArray {
        val arr = JsonArray()
        if (argList == null) return arr
        for (arg in argList.arguments) {
            if (arg.projectionKind == KtProjectionKind.STAR) {
                val obj = JsonObject()
                obj.addProperty("type", "StarProjection")
                obj.add("span", spanOf(arg))
                arr.add(obj)
            } else {
                arg.typeReference?.let { arr.add(serializeTypeReference(it)) }
            }
        }
        return arr
    }

    // ── Modifiers ───────────────────────────────────────────────────────

    private fun serializeModifiers(element: KtModifierListOwner): JsonArray {
        val arr = JsonArray()
        val modifierList = element.modifierList ?: return arr

        val allModifiers = listOf(
            KtTokens.PUBLIC_KEYWORD, KtTokens.PRIVATE_KEYWORD, KtTokens.PROTECTED_KEYWORD,
            KtTokens.INTERNAL_KEYWORD, KtTokens.OPEN_KEYWORD, KtTokens.FINAL_KEYWORD,
            KtTokens.ABSTRACT_KEYWORD, KtTokens.SEALED_KEYWORD, KtTokens.DATA_KEYWORD,
            KtTokens.INLINE_KEYWORD, KtTokens.VALUE_KEYWORD, KtTokens.INNER_KEYWORD,
            KtTokens.COMPANION_KEYWORD, KtTokens.SUSPEND_KEYWORD, KtTokens.INFIX_KEYWORD,
            KtTokens.OPERATOR_KEYWORD, KtTokens.TAILREC_KEYWORD, KtTokens.EXTERNAL_KEYWORD,
            KtTokens.OVERRIDE_KEYWORD, KtTokens.LATEINIT_KEYWORD, KtTokens.CONST_KEYWORD,
            KtTokens.CROSSINLINE_KEYWORD, KtTokens.NOINLINE_KEYWORD, KtTokens.REIFIED_KEYWORD,
            KtTokens.EXPECT_KEYWORD, KtTokens.ACTUAL_KEYWORD, KtTokens.ANNOTATION_KEYWORD,
            KtTokens.ENUM_KEYWORD, KtTokens.VARARG_KEYWORD, KtTokens.FUN_KEYWORD
        )

        for (modifier in allModifiers) {
            if (modifierList.hasModifier(modifier)) {
                arr.add(modifier.value)
            }
        }
        return arr
    }

    // ── Annotations ─────────────────────────────────────────────────────

    private fun serializeAnnotations(element: KtAnnotated): JsonArray {
        val arr = JsonArray()
        for (entry in element.annotationEntries) {
            arr.add(serializeAnnotation(entry))
        }
        return arr
    }

    private fun serializeAnnotation(entry: KtAnnotationEntry): JsonObject {
        val obj = JsonObject()
        obj.addProperty("type", "Annotation")
        val name = entry.typeReference?.text ?: ""
        obj.addProperty("name", name)

        entry.useSiteTarget?.let { obj.addProperty("useSiteTarget", it.text) }

        val args = serializeValueArguments(entry.valueArgumentList)
        if (args.size() > 0) {
            obj.add("args", args)
        }

        obj.add("span", spanOf(entry))
        return obj
    }

    // ── Span helpers ────────────────────────────────────────────────────

    private fun spanOf(element: PsiElement): JsonObject {
        val span = JsonObject()
        val document = element.containingFile?.viewProvider?.document
        if (document != null) {
            val startOffset = element.textRange.startOffset
            val endOffset = element.textRange.endOffset
            val startLine = document.getLineNumber(startOffset) + 1 // 1-based
            val startCol = startOffset - document.getLineStartOffset(document.getLineNumber(startOffset)) // 0-based
            val endLine = document.getLineNumber(endOffset) + 1
            val endCol = endOffset - document.getLineStartOffset(document.getLineNumber(endOffset))

            val start = JsonObject()
            start.addProperty("line", startLine)
            start.addProperty("col", startCol)
            val end = JsonObject()
            end.addProperty("line", endLine)
            end.addProperty("col", endCol)
            span.add("start", start)
            span.add("end", end)
        } else {
            val start = JsonObject()
            start.addProperty("line", 1 as Number)
            start.addProperty("col", 0 as Number)
            val end = JsonObject()
            end.addProperty("line", 1 as Number)
            end.addProperty("col", 0 as Number)
            span.add("start", start)
            span.add("end", end)
        }
        return span
    }
}
