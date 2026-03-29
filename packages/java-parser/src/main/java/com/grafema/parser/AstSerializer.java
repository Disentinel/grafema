package com.grafema.parser;

import com.github.javaparser.ast.*;
import com.github.javaparser.ast.body.*;
import com.github.javaparser.ast.expr.*;
import com.github.javaparser.ast.stmt.*;
import com.github.javaparser.ast.type.*;
import com.github.javaparser.ast.nodeTypes.NodeWithModifiers;
import com.github.javaparser.ast.modules.*;
import com.github.javaparser.Range;
import com.github.javaparser.Position;
import com.google.gson.*;

import java.util.List;
import java.util.stream.Collectors;

/**
 * Serializes JavaParser CompilationUnit to Grafema JSON AST format.
 * Each node has "type" discriminator + "span" + type-specific fields.
 */
public final class AstSerializer {

    private AstSerializer() {}

    // ── Top-level ───────────────────────────────────────────────────────

    public static JsonObject serialize(CompilationUnit cu) {
        JsonObject obj = new JsonObject();
        cu.getPackageDeclaration().ifPresent(pd ->
            obj.addProperty("package", pd.getNameAsString()));
        obj.add("imports", serializeImports(cu.getImports()));
        obj.add("types", serializeTypeDecls(cu.getTypes()));
        return obj;
    }

    // ── Imports ─────────────────────────────────────────────────────────

    private static JsonArray serializeImports(List<ImportDeclaration> imports) {
        JsonArray arr = new JsonArray();
        for (ImportDeclaration imp : imports) {
            JsonObject obj = new JsonObject();
            obj.addProperty("name", imp.getNameAsString());
            obj.addProperty("static", imp.isStatic());
            obj.addProperty("asterisk", imp.isAsterisk());
            obj.add("span", spanOf(imp));
            arr.add(obj);
        }
        return arr;
    }

    // ── Type declarations ───────────────────────────────────────────────

    private static JsonArray serializeTypeDecls(List<TypeDeclaration<?>> types) {
        JsonArray arr = new JsonArray();
        for (TypeDeclaration<?> td : types) {
            arr.add(serializeTypeDecl(td));
        }
        return arr;
    }

    private static JsonObject serializeTypeDecl(TypeDeclaration<?> td) {
        if (td instanceof ClassOrInterfaceDeclaration cid) {
            return cid.isInterface() ? serializeInterface(cid) : serializeClass(cid);
        } else if (td instanceof EnumDeclaration ed) {
            return serializeEnum(ed);
        } else if (td instanceof RecordDeclaration rd) {
            return serializeRecord(rd);
        } else if (td instanceof AnnotationDeclaration ad) {
            return serializeAnnotationDecl(ad);
        }
        // Unknown type declaration
        JsonObject obj = new JsonObject();
        obj.addProperty("type", "UnknownTypeDecl");
        obj.add("span", spanOf(td));
        return obj;
    }

    private static JsonObject serializeClass(ClassOrInterfaceDeclaration cid) {
        JsonObject obj = new JsonObject();
        obj.addProperty("type", "ClassDecl");
        obj.addProperty("name", cid.getNameAsString());
        obj.add("modifiers", serializeModifiers(cid));
        obj.add("typeParameters", serializeTypeParams(cid.getTypeParameters()));
        cid.getExtendedTypes().stream().findFirst().ifPresent(et ->
            obj.add("extends", serializeType(et)));
        obj.add("implements", serializeTypes(cid.getImplementedTypes()));
        obj.add("members", serializeMembers(cid.getMembers()));
        obj.add("annotations", serializeAnnotations(cid.getAnnotations()));
        obj.add("span", spanOf(cid));
        return obj;
    }

    private static JsonObject serializeInterface(ClassOrInterfaceDeclaration cid) {
        JsonObject obj = new JsonObject();
        obj.addProperty("type", "InterfaceDecl");
        obj.addProperty("name", cid.getNameAsString());
        obj.add("modifiers", serializeModifiers(cid));
        obj.add("typeParameters", serializeTypeParams(cid.getTypeParameters()));
        obj.add("extends", serializeTypes(cid.getExtendedTypes()));
        obj.add("members", serializeMembers(cid.getMembers()));
        obj.add("annotations", serializeAnnotations(cid.getAnnotations()));
        obj.add("span", spanOf(cid));
        return obj;
    }

    private static JsonObject serializeEnum(EnumDeclaration ed) {
        JsonObject obj = new JsonObject();
        obj.addProperty("type", "EnumDecl");
        obj.addProperty("name", ed.getNameAsString());
        obj.add("modifiers", serializeModifiers(ed));
        obj.add("implements", serializeTypes(ed.getImplementedTypes()));
        JsonArray constants = new JsonArray();
        for (EnumConstantDeclaration ecd : ed.getEntries()) {
            constants.add(serializeEnumConstant(ecd));
        }
        obj.add("constants", constants);
        obj.add("members", serializeMembers(ed.getMembers()));
        obj.add("annotations", serializeAnnotations(ed.getAnnotations()));
        obj.add("span", spanOf(ed));
        return obj;
    }

    private static JsonObject serializeRecord(RecordDeclaration rd) {
        JsonObject obj = new JsonObject();
        obj.addProperty("type", "RecordDecl");
        obj.addProperty("name", rd.getNameAsString());
        obj.add("modifiers", serializeModifiers(rd));
        obj.add("typeParameters", serializeTypeParams(rd.getTypeParameters()));
        obj.add("implements", serializeTypes(rd.getImplementedTypes()));
        JsonArray components = new JsonArray();
        for (Parameter p : rd.getParameters()) {
            components.add(serializeParameter(p));
        }
        obj.add("components", components);
        obj.add("members", serializeMembers(rd.getMembers()));
        obj.add("annotations", serializeAnnotations(rd.getAnnotations()));
        obj.add("span", spanOf(rd));
        return obj;
    }

    private static JsonObject serializeAnnotationDecl(AnnotationDeclaration ad) {
        JsonObject obj = new JsonObject();
        obj.addProperty("type", "AnnotationDecl");
        obj.addProperty("name", ad.getNameAsString());
        obj.add("modifiers", serializeModifiers(ad));
        obj.add("members", serializeMembers(ad.getMembers()));
        obj.add("span", spanOf(ad));
        return obj;
    }

    // ── Members ─────────────────────────────────────────────────────────

    private static JsonArray serializeMembers(List<BodyDeclaration<?>> members) {
        JsonArray arr = new JsonArray();
        for (BodyDeclaration<?> bd : members) {
            arr.add(serializeMember(bd));
        }
        return arr;
    }

    private static JsonObject serializeMember(BodyDeclaration<?> bd) {
        if (bd instanceof MethodDeclaration md) {
            return serializeMethod(md);
        } else if (bd instanceof ConstructorDeclaration cd) {
            return serializeConstructor(cd);
        } else if (bd instanceof FieldDeclaration fd) {
            return serializeField(fd);
        } else if (bd instanceof EnumConstantDeclaration ecd) {
            return serializeEnumConstant(ecd);
        } else if (bd instanceof InitializerDeclaration id) {
            return serializeInitializer(id);
        } else if (bd instanceof AnnotationMemberDeclaration amd) {
            return serializeAnnotationMember(amd);
        } else if (bd instanceof CompactConstructorDeclaration ccd) {
            return serializeCompactConstructor(ccd);
        } else if (bd instanceof TypeDeclaration<?> td) {
            // Nested type declaration → wrap as NestedTypeMember
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "NestedTypeMember");
            obj.add("typeDecl", serializeTypeDecl(td));
            obj.add("span", spanOf(td));
            return obj;
        }
        JsonObject obj = new JsonObject();
        obj.addProperty("type", "MemberUnknown");
        obj.add("span", spanOf(bd));
        return obj;
    }

    private static JsonObject serializeMethod(MethodDeclaration md) {
        JsonObject obj = new JsonObject();
        obj.addProperty("type", "MethodDecl");
        obj.addProperty("name", md.getNameAsString());
        obj.add("modifiers", serializeModifiers(md));
        obj.add("typeParameters", serializeTypeParams(md.getTypeParameters()));
        obj.add("returnType", serializeType(md.getType()));
        obj.add("params", serializeParameters(md.getParameters()));
        obj.add("throws", serializeTypes(md.getThrownExceptions()));
        md.getBody().ifPresent(body -> obj.add("body", serializeStmt(body)));
        obj.add("annotations", serializeAnnotations(md.getAnnotations()));
        obj.add("span", spanOf(md));
        return obj;
    }

    private static JsonObject serializeConstructor(ConstructorDeclaration cd) {
        JsonObject obj = new JsonObject();
        obj.addProperty("type", "ConstructorDecl");
        obj.addProperty("name", cd.getNameAsString());
        obj.add("modifiers", serializeModifiers(cd));
        obj.add("typeParameters", serializeTypeParams(cd.getTypeParameters()));
        obj.add("params", serializeParameters(cd.getParameters()));
        obj.add("throws", serializeTypes(cd.getThrownExceptions()));
        obj.add("body", serializeStmt(cd.getBody()));
        obj.add("annotations", serializeAnnotations(cd.getAnnotations()));
        obj.add("span", spanOf(cd));
        return obj;
    }

    private static JsonObject serializeCompactConstructor(CompactConstructorDeclaration ccd) {
        JsonObject obj = new JsonObject();
        obj.addProperty("type", "CompactConstructorDecl");
        obj.addProperty("name", ccd.getNameAsString());
        obj.add("modifiers", serializeModifiers(ccd));
        obj.add("body", serializeStmt(ccd.getBody()));
        obj.add("annotations", serializeAnnotations(ccd.getAnnotations()));
        obj.add("span", spanOf(ccd));
        return obj;
    }

    private static JsonObject serializeField(FieldDeclaration fd) {
        JsonObject obj = new JsonObject();
        obj.addProperty("type", "FieldDecl");
        obj.add("modifiers", serializeModifiers(fd));
        // All variables share the same declared type
        obj.add("fieldType", serializeType(fd.getCommonType()));
        JsonArray vars = new JsonArray();
        for (VariableDeclarator vd : fd.getVariables()) {
            vars.add(serializeVariable(vd));
        }
        obj.add("variables", vars);
        obj.add("annotations", serializeAnnotations(fd.getAnnotations()));
        obj.add("span", spanOf(fd));
        return obj;
    }

    private static JsonObject serializeVariable(VariableDeclarator vd) {
        JsonObject obj = new JsonObject();
        obj.addProperty("name", vd.getNameAsString());
        obj.add("varType", serializeType(vd.getType()));
        vd.getInitializer().ifPresent(init -> obj.add("init", serializeExpr(init)));
        obj.add("span", spanOf(vd));
        return obj;
    }

    private static JsonObject serializeEnumConstant(EnumConstantDeclaration ecd) {
        JsonObject obj = new JsonObject();
        obj.addProperty("type", "EnumConstant");
        obj.addProperty("name", ecd.getNameAsString());
        obj.add("args", serializeExprs(ecd.getArguments()));
        if (!ecd.getClassBody().isEmpty()) {
            obj.add("classBody", serializeMembers(ecd.getClassBody()));
        }
        obj.add("annotations", serializeAnnotations(ecd.getAnnotations()));
        obj.add("span", spanOf(ecd));
        return obj;
    }

    private static JsonObject serializeInitializer(InitializerDeclaration id) {
        JsonObject obj = new JsonObject();
        obj.addProperty("type", "InitializerDecl");
        obj.addProperty("isStatic", id.isStatic());
        obj.add("body", serializeStmt(id.getBody()));
        obj.add("span", spanOf(id));
        return obj;
    }

    private static JsonObject serializeAnnotationMember(AnnotationMemberDeclaration amd) {
        JsonObject obj = new JsonObject();
        obj.addProperty("type", "AnnotationMember");
        obj.addProperty("name", amd.getNameAsString());
        obj.add("returnType", serializeType(amd.getType()));
        amd.getDefaultValue().ifPresent(dv -> obj.add("defaultValue", serializeExpr(dv)));
        obj.add("span", spanOf(amd));
        return obj;
    }

    // ── Statements ──────────────────────────────────────────────────────

    private static JsonObject serializeStmt(Statement stmt) {
        if (stmt instanceof ExpressionStmt es) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "ExprStmt");
            obj.add("expr", serializeExpr(es.getExpression()));
            obj.add("span", spanOf(stmt));
            return obj;
        } else if (stmt instanceof BlockStmt bs) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "BlockStmt");
            JsonArray stmts = new JsonArray();
            for (Statement s : bs.getStatements()) {
                stmts.add(serializeStmt(s));
            }
            obj.add("stmts", stmts);
            obj.add("span", spanOf(stmt));
            return obj;
        } else if (stmt instanceof ReturnStmt rs) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "ReturnStmt");
            rs.getExpression().ifPresent(e -> obj.add("expr", serializeExpr(e)));
            obj.add("span", spanOf(stmt));
            return obj;
        } else if (stmt instanceof ThrowStmt ts) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "ThrowStmt");
            obj.add("expr", serializeExpr(ts.getExpression()));
            obj.add("span", spanOf(stmt));
            return obj;
        } else if (stmt instanceof IfStmt is) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "IfStmt");
            obj.add("condition", serializeExpr(is.getCondition()));
            obj.add("then", serializeStmt(is.getThenStmt()));
            is.getElseStmt().ifPresent(e -> obj.add("else", serializeStmt(e)));
            obj.add("span", spanOf(stmt));
            return obj;
        } else if (stmt instanceof SwitchStmt ss) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "SwitchStmt");
            obj.add("selector", serializeExpr(ss.getSelector()));
            JsonArray entries = new JsonArray();
            for (SwitchEntry se : ss.getEntries()) {
                entries.add(serializeSwitchEntry(se));
            }
            obj.add("entries", entries);
            obj.add("span", spanOf(stmt));
            return obj;
        } else if (stmt instanceof WhileStmt ws) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "WhileStmt");
            obj.add("condition", serializeExpr(ws.getCondition()));
            obj.add("body", serializeStmt(ws.getBody()));
            obj.add("span", spanOf(stmt));
            return obj;
        } else if (stmt instanceof DoStmt ds) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "DoStmt");
            obj.add("condition", serializeExpr(ds.getCondition()));
            obj.add("body", serializeStmt(ds.getBody()));
            obj.add("span", spanOf(stmt));
            return obj;
        } else if (stmt instanceof ForStmt fs) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "ForStmt");
            obj.add("init", serializeExprs(fs.getInitialization()));
            fs.getCompare().ifPresent(c -> obj.add("condition", serializeExpr(c)));
            obj.add("update", serializeExprs(fs.getUpdate()));
            obj.add("body", serializeStmt(fs.getBody()));
            obj.add("span", spanOf(stmt));
            return obj;
        } else if (stmt instanceof ForEachStmt fes) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "ForEachStmt");
            // getVariable() returns VariableDeclarationExpr; extract first VariableDeclarator
            obj.add("variable", serializeVariable(fes.getVariable().getVariables().get(0)));
            obj.add("iterable", serializeExpr(fes.getIterable()));
            obj.add("body", serializeStmt(fes.getBody()));
            obj.add("span", spanOf(stmt));
            return obj;
        } else if (stmt instanceof TryStmt ts) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "TryStmt");
            JsonArray resources = new JsonArray();
            for (Expression r : ts.getResources()) {
                resources.add(serializeExpr(r));
            }
            obj.add("resources", resources);
            obj.add("tryBlock", serializeStmt(ts.getTryBlock()));
            JsonArray catches = new JsonArray();
            for (CatchClause cc : ts.getCatchClauses()) {
                catches.add(serializeCatchClause(cc));
            }
            obj.add("catches", catches);
            ts.getFinallyBlock().ifPresent(fb -> obj.add("finally", serializeStmt(fb)));
            obj.add("span", spanOf(stmt));
            return obj;
        } else if (stmt instanceof BreakStmt bs) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "BreakStmt");
            bs.getLabel().ifPresent(l -> obj.addProperty("label", l.asString()));
            obj.add("span", spanOf(stmt));
            return obj;
        } else if (stmt instanceof ContinueStmt cs) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "ContinueStmt");
            cs.getLabel().ifPresent(l -> obj.addProperty("label", l.asString()));
            obj.add("span", spanOf(stmt));
            return obj;
        } else if (stmt instanceof YieldStmt ys) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "YieldStmt");
            obj.add("expr", serializeExpr(ys.getExpression()));
            obj.add("span", spanOf(stmt));
            return obj;
        } else if (stmt instanceof SynchronizedStmt ss) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "SynchronizedStmt");
            obj.add("expr", serializeExpr(ss.getExpression()));
            obj.add("body", serializeStmt(ss.getBody()));
            obj.add("span", spanOf(stmt));
            return obj;
        } else if (stmt instanceof LabeledStmt ls) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "LabeledStmt");
            obj.addProperty("label", ls.getLabel().asString());
            obj.add("stmt", serializeStmt(ls.getStatement()));
            obj.add("span", spanOf(stmt));
            return obj;
        } else if (stmt instanceof AssertStmt as2) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "AssertStmt");
            obj.add("check", serializeExpr(as2.getCheck()));
            as2.getMessage().ifPresent(m -> obj.add("message", serializeExpr(m)));
            obj.add("span", spanOf(stmt));
            return obj;
        } else if (stmt instanceof LocalClassDeclarationStmt lcds) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "LocalClassStmt");
            obj.add("classDecl", serializeTypeDecl(lcds.getClassDeclaration()));
            obj.add("span", spanOf(stmt));
            return obj;
        } else if (stmt instanceof LocalRecordDeclarationStmt lrds) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "LocalRecordStmt");
            obj.add("recordDecl", serializeTypeDecl(lrds.getRecordDeclaration()));
            obj.add("span", spanOf(stmt));
            return obj;
        } else if (stmt instanceof ExplicitConstructorInvocationStmt ecis) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "ExplicitConstructorInvocationStmt");
            obj.addProperty("isThis", ecis.isThis());
            obj.add("args", serializeExprs(ecis.getArguments()));
            ecis.getExpression().ifPresent(e -> obj.add("expr", serializeExpr(e)));
            obj.add("span", spanOf(stmt));
            return obj;
        } else if (stmt instanceof EmptyStmt) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "EmptyStmt");
            obj.add("span", spanOf(stmt));
            return obj;
        }
        // Fallback for unhandled statement types
        JsonObject obj = new JsonObject();
        obj.addProperty("type", "StmtUnknown");
        obj.add("span", spanOf(stmt));
        return obj;
    }

    private static JsonObject serializeSwitchEntry(SwitchEntry se) {
        JsonObject obj = new JsonObject();
        obj.add("labels", serializeExprs(se.getLabels()));
        JsonArray stmts = new JsonArray();
        for (Statement s : se.getStatements()) {
            stmts.add(serializeStmt(s));
        }
        obj.add("stmts", stmts);
        obj.addProperty("isDefault", se.getLabels().isEmpty());
        obj.add("span", spanOf(se));
        return obj;
    }

    private static JsonObject serializeCatchClause(CatchClause cc) {
        JsonObject obj = new JsonObject();
        obj.add("param", serializeParameter(cc.getParameter()));
        obj.add("body", serializeStmt(cc.getBody()));
        obj.add("span", spanOf(cc));
        return obj;
    }

    // ── Expressions ─────────────────────────────────────────────────────

    private static JsonArray serializeExprs(List<? extends Expression> exprs) {
        JsonArray arr = new JsonArray();
        for (Expression e : exprs) {
            arr.add(serializeExpr(e));
        }
        return arr;
    }

    private static JsonObject serializeExpr(Expression expr) {
        if (expr instanceof MethodCallExpr mce) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "MethodCallExpr");
            obj.addProperty("name", mce.getNameAsString());
            mce.getScope().ifPresent(s -> obj.add("scope", serializeExpr(s)));
            obj.add("args", serializeExprs(mce.getArguments()));
            obj.add("typeArgs", serializeTypes(mce.getTypeArguments().orElse(null)));
            obj.add("span", spanOf(expr));
            return obj;
        } else if (expr instanceof ObjectCreationExpr oce) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "ObjectCreationExpr");
            obj.add("classType", serializeType(oce.getType()));
            obj.add("args", serializeExprs(oce.getArguments()));
            obj.add("typeArgs", serializeTypes(oce.getTypeArguments().orElse(null)));
            oce.getAnonymousClassBody().ifPresent(body ->
                obj.add("anonymousClassBody", serializeMembers(body)));
            obj.add("span", spanOf(expr));
            return obj;
        } else if (expr instanceof FieldAccessExpr fae) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "FieldAccessExpr");
            obj.add("scope", serializeExpr(fae.getScope()));
            obj.addProperty("name", fae.getNameAsString());
            obj.add("span", spanOf(expr));
            return obj;
        } else if (expr instanceof ArrayAccessExpr aae) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "ArrayAccessExpr");
            obj.add("name", serializeExpr(aae.getName()));
            obj.add("index", serializeExpr(aae.getIndex()));
            obj.add("span", spanOf(expr));
            return obj;
        } else if (expr instanceof NameExpr ne) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "NameExpr");
            obj.addProperty("name", ne.getNameAsString());
            obj.add("span", spanOf(expr));
            return obj;
        } else if (expr instanceof AssignExpr ae) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "AssignExpr");
            obj.add("target", serializeExpr(ae.getTarget()));
            obj.addProperty("operator", ae.getOperator().asString());
            obj.add("value", serializeExpr(ae.getValue()));
            obj.add("span", spanOf(expr));
            return obj;
        } else if (expr instanceof BinaryExpr be) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "BinaryExpr");
            obj.add("left", serializeExpr(be.getLeft()));
            obj.addProperty("operator", be.getOperator().asString());
            obj.add("right", serializeExpr(be.getRight()));
            obj.add("span", spanOf(expr));
            return obj;
        } else if (expr instanceof UnaryExpr ue) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "UnaryExpr");
            obj.addProperty("operator", ue.getOperator().asString());
            obj.addProperty("prefix", ue.isPrefix());
            obj.add("expr", serializeExpr(ue.getExpression()));
            obj.add("span", spanOf(expr));
            return obj;
        } else if (expr instanceof ConditionalExpr ce) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "ConditionalExpr");
            obj.add("condition", serializeExpr(ce.getCondition()));
            obj.add("then", serializeExpr(ce.getThenExpr()));
            obj.add("else", serializeExpr(ce.getElseExpr()));
            obj.add("span", spanOf(expr));
            return obj;
        } else if (expr instanceof CastExpr cas) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "CastExpr");
            obj.add("castType", serializeType(cas.getType()));
            obj.add("expr", serializeExpr(cas.getExpression()));
            obj.add("span", spanOf(expr));
            return obj;
        } else if (expr instanceof InstanceOfExpr ioe) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "InstanceOfExpr");
            obj.add("expr", serializeExpr(ioe.getExpression()));
            obj.add("checkType", serializeType(ioe.getType()));
            ioe.getPattern().ifPresent(p -> {
                JsonObject pat = new JsonObject();
                pat.addProperty("type", "PatternExpr");
                if (p instanceof com.github.javaparser.ast.expr.TypePatternExpr tpe) {
                    pat.addProperty("name", tpe.getNameAsString());
                    pat.add("patType", serializeType(tpe.getType()));
                }
                pat.add("span", spanOf(p));
                obj.add("pattern", pat);
            });
            obj.add("span", spanOf(expr));
            return obj;
        } else if (expr instanceof LambdaExpr le) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "LambdaExpr");
            obj.add("params", serializeParameters(le.getParameters()));
            obj.addProperty("isEnclosingParameters", le.isEnclosingParameters());
            // Lambda body can be an expression or a block statement
            if (le.getBody() instanceof ExpressionStmt es) {
                obj.add("body", serializeExpr(es.getExpression()));
                obj.addProperty("bodyKind", "expression");
            } else {
                obj.add("body", serializeStmt(le.getBody()));
                obj.addProperty("bodyKind", "block");
            }
            obj.add("span", spanOf(expr));
            return obj;
        } else if (expr instanceof MethodReferenceExpr mre) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "MethodRefExpr");
            obj.add("scope", serializeExpr(mre.getScope()));
            obj.addProperty("identifier", mre.getIdentifier());
            obj.add("span", spanOf(expr));
            return obj;
        } else if (expr instanceof ThisExpr te) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "ThisExpr");
            te.getTypeName().ifPresent(tn -> obj.addProperty("qualifier", tn.asString()));
            obj.add("span", spanOf(expr));
            return obj;
        } else if (expr instanceof SuperExpr se) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "SuperExpr");
            se.getTypeName().ifPresent(tn -> obj.addProperty("qualifier", tn.asString()));
            obj.add("span", spanOf(expr));
            return obj;
        } else if (expr instanceof ArrayCreationExpr ace) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "ArrayCreationExpr");
            obj.add("elementType", serializeType(ace.getElementType()));
            JsonArray levels = new JsonArray();
            for (ArrayCreationLevel level : ace.getLevels()) {
                if (level.getDimension().isPresent()) {
                    levels.add(serializeExpr(level.getDimension().get()));
                } else {
                    levels.add(JsonNull.INSTANCE);
                }
            }
            obj.add("levels", levels);
            ace.getInitializer().ifPresent(init -> obj.add("initializer", serializeExpr(init)));
            obj.add("span", spanOf(expr));
            return obj;
        } else if (expr instanceof ArrayInitializerExpr aie) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "ArrayInitExpr");
            obj.add("values", serializeExprs(aie.getValues()));
            obj.add("span", spanOf(expr));
            return obj;
        } else if (expr instanceof ClassExpr ce) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "ClassExpr");
            obj.add("classType", serializeType(ce.getType()));
            obj.add("span", spanOf(expr));
            return obj;
        } else if (expr instanceof EnclosedExpr ee) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "EnclosedExpr");
            obj.add("inner", serializeExpr(ee.getInner()));
            obj.add("span", spanOf(expr));
            return obj;
        } else if (expr instanceof TextBlockLiteralExpr tble) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "TextBlockExpr");
            obj.addProperty("value", tble.getValue());
            obj.add("span", spanOf(expr));
            return obj;
        } else if (expr instanceof SwitchExpr se) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "SwitchExpr");
            obj.add("selector", serializeExpr(se.getSelector()));
            JsonArray entries = new JsonArray();
            for (SwitchEntry entry : se.getEntries()) {
                entries.add(serializeSwitchEntry(entry));
            }
            obj.add("entries", entries);
            obj.add("span", spanOf(expr));
            return obj;
        } else if (expr instanceof VariableDeclarationExpr vde) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "VariableDeclarationExpr");
            obj.add("modifiers", serializeModifiers(vde));
            JsonArray vars = new JsonArray();
            for (VariableDeclarator vd : vde.getVariables()) {
                vars.add(serializeVariable(vd));
            }
            obj.add("variables", vars);
            obj.add("span", spanOf(expr));
            return obj;
        }
        // Literals
        else if (expr instanceof IntegerLiteralExpr ile) {
            return serializeLiteral("int", ile.getValue(), expr);
        } else if (expr instanceof LongLiteralExpr lle) {
            return serializeLiteral("long", lle.getValue(), expr);
        } else if (expr instanceof DoubleLiteralExpr dle) {
            return serializeLiteral("double", dle.getValue(), expr);
        } else if (expr instanceof StringLiteralExpr sle) {
            return serializeLiteral("string", sle.getValue(), expr);
        } else if (expr instanceof CharLiteralExpr cle) {
            return serializeLiteral("char", cle.getValue(), expr);
        } else if (expr instanceof BooleanLiteralExpr ble) {
            return serializeLiteral("boolean", String.valueOf(ble.getValue()), expr);
        } else if (expr instanceof NullLiteralExpr) {
            return serializeLiteral("null", "null", expr);
        }

        // Fallback
        JsonObject obj = new JsonObject();
        obj.addProperty("type", "ExprUnknown");
        obj.add("span", spanOf(expr));
        return obj;
    }

    private static JsonObject serializeLiteral(String literalType, String value, Expression expr) {
        JsonObject obj = new JsonObject();
        obj.addProperty("type", "LiteralExpr");
        obj.addProperty("literalType", literalType);
        obj.addProperty("value", value);
        obj.add("span", spanOf(expr));
        return obj;
    }

    // ── Types ───────────────────────────────────────────────────────────

    private static JsonArray serializeTypes(List<? extends Type> types) {
        JsonArray arr = new JsonArray();
        if (types == null) return arr;
        for (Type t : types) {
            arr.add(serializeType(t));
        }
        return arr;
    }

    private static JsonObject serializeType(Type type) {
        if (type instanceof ClassOrInterfaceType cit) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "ClassType");
            obj.addProperty("name", cit.getNameAsString());
            cit.getScope().ifPresent(s -> obj.addProperty("scope", s.asString()));
            obj.add("typeArgs", serializeTypes(cit.getTypeArguments().orElse(null)));
            obj.add("span", spanOf(type));
            return obj;
        } else if (type instanceof PrimitiveType pt) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "PrimitiveType");
            obj.addProperty("name", pt.asString());
            obj.add("span", spanOf(type));
            return obj;
        } else if (type instanceof ArrayType at) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "ArrayType");
            obj.add("componentType", serializeType(at.getComponentType()));
            obj.add("span", spanOf(type));
            return obj;
        } else if (type instanceof VoidType) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "VoidType");
            obj.add("span", spanOf(type));
            return obj;
        } else if (type instanceof WildcardType wt) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "WildcardType");
            wt.getExtendedType().ifPresent(et -> obj.add("extends", serializeType(et)));
            wt.getSuperType().ifPresent(st -> obj.add("super", serializeType(st)));
            obj.add("span", spanOf(type));
            return obj;
        } else if (type instanceof TypeParameter tp) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "TypeParam");
            obj.addProperty("name", tp.getNameAsString());
            obj.add("bounds", serializeTypes(tp.getTypeBound()));
            obj.add("span", spanOf(type));
            return obj;
        } else if (type instanceof UnionType ut) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "UnionType");
            obj.add("types", serializeTypes(ut.getElements()));
            obj.add("span", spanOf(type));
            return obj;
        } else if (type instanceof IntersectionType it) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "IntersectionType");
            obj.add("types", serializeTypes(it.getElements()));
            obj.add("span", spanOf(type));
            return obj;
        } else if (type instanceof VarType) {
            JsonObject obj = new JsonObject();
            obj.addProperty("type", "VarType");
            obj.add("span", spanOf(type));
            return obj;
        }
        JsonObject obj = new JsonObject();
        obj.addProperty("type", "TypeUnknown");
        obj.add("span", spanOf(type));
        return obj;
    }

    // ── Parameters ──────────────────────────────────────────────────────

    private static JsonArray serializeParameters(List<Parameter> params) {
        JsonArray arr = new JsonArray();
        for (Parameter p : params) {
            arr.add(serializeParameter(p));
        }
        return arr;
    }

    private static JsonObject serializeParameter(Parameter p) {
        JsonObject obj = new JsonObject();
        obj.addProperty("name", p.getNameAsString());
        obj.add("paramType", serializeType(p.getType()));
        obj.addProperty("isFinal", p.isFinal());
        obj.addProperty("isVarArgs", p.isVarArgs());
        obj.add("annotations", serializeAnnotations(p.getAnnotations()));
        obj.add("span", spanOf(p));
        return obj;
    }

    // ── Type parameters ─────────────────────────────────────────────────

    private static JsonArray serializeTypeParams(List<TypeParameter> tps) {
        JsonArray arr = new JsonArray();
        if (tps == null) return arr;
        for (TypeParameter tp : tps) {
            JsonObject obj = new JsonObject();
            obj.addProperty("name", tp.getNameAsString());
            obj.add("bounds", serializeTypes(tp.getTypeBound()));
            obj.add("span", spanOf(tp));
            arr.add(obj);
        }
        return arr;
    }

    // ── Modifiers ───────────────────────────────────────────────────────

    @SuppressWarnings("unchecked")
    private static JsonArray serializeModifiers(Object node) {
        JsonArray arr = new JsonArray();
        if (node instanceof NodeWithModifiers<?> nwm) {
            for (Modifier m : nwm.getModifiers()) {
                arr.add(m.getKeyword().asString());
            }
        }
        return arr;
    }

    // ── Annotations ─────────────────────────────────────────────────────

    private static JsonArray serializeAnnotations(List<AnnotationExpr> annotations) {
        JsonArray arr = new JsonArray();
        for (AnnotationExpr ae : annotations) {
            arr.add(serializeAnnotation(ae));
        }
        return arr;
    }

    private static JsonObject serializeAnnotation(AnnotationExpr ae) {
        JsonObject obj = new JsonObject();
        if (ae instanceof MarkerAnnotationExpr) {
            obj.addProperty("type", "MarkerAnnotation");
            obj.addProperty("name", ae.getNameAsString());
        } else if (ae instanceof NormalAnnotationExpr nae) {
            obj.addProperty("type", "NormalAnnotation");
            obj.addProperty("name", nae.getNameAsString());
            JsonArray pairs = new JsonArray();
            for (MemberValuePair mvp : nae.getPairs()) {
                JsonObject pair = new JsonObject();
                pair.addProperty("key", mvp.getNameAsString());
                pair.add("value", serializeExpr(mvp.getValue()));
                pairs.add(pair);
            }
            obj.add("members", pairs);
        } else if (ae instanceof SingleMemberAnnotationExpr smae) {
            obj.addProperty("type", "SingleMemberAnnotation");
            obj.addProperty("name", smae.getNameAsString());
            obj.add("value", serializeExpr(smae.getMemberValue()));
        } else {
            obj.addProperty("type", "AnnotationUnknown");
            obj.addProperty("name", ae.getNameAsString());
        }
        obj.add("span", spanOf(ae));
        return obj;
    }

    // ── Span helpers ────────────────────────────────────────────────────

    private static JsonObject spanOf(com.github.javaparser.ast.Node node) {
        JsonObject span = new JsonObject();
        if (node.getRange().isPresent()) {
            Range r = node.getRange().get();
            span.add("start", posOf(r.begin));
            span.add("end", posOf(r.end));
        } else {
            span.add("start", posOf(new Position(1, 1)));
            span.add("end", posOf(new Position(1, 1)));
        }
        return span;
    }

    private static JsonObject posOf(Position pos) {
        JsonObject p = new JsonObject();
        p.addProperty("line", pos.line);         // 1-based
        p.addProperty("col", pos.column - 1);    // Convert JavaParser 1-based col to 0-based
        return p;
    }
}
