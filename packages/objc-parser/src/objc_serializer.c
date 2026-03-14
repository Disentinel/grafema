#include "objc_serializer.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// Simple dynamic string buffer
typedef struct {
    char* data;
    size_t len;
    size_t cap;
} StringBuf;

static void buf_init(StringBuf* buf) {
    buf->cap = 4096;
    buf->data = malloc(buf->cap);
    buf->len = 0;
    buf->data[0] = '\0';
}

static void buf_append(StringBuf* buf, const char* str) {
    size_t slen = strlen(str);
    while (buf->len + slen + 1 > buf->cap) {
        buf->cap *= 2;
        buf->data = realloc(buf->data, buf->cap);
    }
    memcpy(buf->data + buf->len, str, slen);
    buf->len += slen;
    buf->data[buf->len] = '\0';
}

static void buf_append_escaped(StringBuf* buf, const char* str) {
    buf_append(buf, "\"");
    for (const char* p = str; *p; p++) {
        switch (*p) {
            case '"':  buf_append(buf, "\\\""); break;
            case '\\': buf_append(buf, "\\\\"); break;
            case '\n': buf_append(buf, "\\n"); break;
            case '\r': buf_append(buf, "\\r"); break;
            case '\t': buf_append(buf, "\\t"); break;
            default: {
                char c[2] = {*p, '\0'};
                buf_append(buf, c);
            }
        }
    }
    buf_append(buf, "\"");
}

static void buf_append_int(StringBuf* buf, int val) {
    char tmp[32];
    snprintf(tmp, sizeof(tmp), "%d", val);
    buf_append(buf, tmp);
}

static void append_span(StringBuf* buf, CXCursor cursor) {
    CXSourceRange range = clang_getCursorExtent(cursor);
    CXSourceLocation start = clang_getRangeStart(range);
    CXSourceLocation end = clang_getRangeEnd(range);
    unsigned sl, sc, el, ec;
    clang_getSpellingLocation(start, NULL, &sl, &sc, NULL);
    clang_getSpellingLocation(end, NULL, &el, &ec, NULL);
    buf_append(buf, "\"span\":{\"start\":{\"line\":");
    buf_append_int(buf, (int)sl);
    buf_append(buf, ",\"column\":");
    buf_append_int(buf, (int)(sc > 0 ? sc - 1 : 0));  // 0-based columns
    buf_append(buf, "},\"end\":{\"line\":");
    buf_append_int(buf, (int)el);
    buf_append(buf, ",\"column\":");
    buf_append_int(buf, (int)(ec > 0 ? ec - 1 : 0));
    buf_append(buf, "}}");
}

static const char* cursor_kind_to_type(enum CXCursorKind kind) {
    switch (kind) {
        case CXCursor_ObjCInterfaceDecl: return "ObjCInterfaceDecl";
        case CXCursor_ObjCProtocolDecl: return "ObjCProtocolDecl";
        case CXCursor_ObjCCategoryDecl: return "ObjCCategoryDecl";
        case CXCursor_ObjCImplementationDecl: return "ObjCImplementationDecl";
        case CXCursor_ObjCInstanceMethodDecl: return "ObjCInstanceMethodDecl";
        case CXCursor_ObjCClassMethodDecl: return "ObjCClassMethodDecl";
        case CXCursor_ObjCPropertyDecl: return "ObjCPropertyDecl";
        case CXCursor_ObjCProtocolRef: return "ObjCProtocolRef";
        case CXCursor_ObjCSuperClassRef: return "ObjCSuperClassRef";
        case CXCursor_ObjCMessageExpr: return "ObjCMessageExpr";
        case CXCursor_ObjCSynthesizeDecl: return "ObjCSynthesizeDecl";
        case CXCursor_InclusionDirective: return "InclusionDirective";
        case CXCursor_TypedefDecl: return "TypedefDecl";
        case CXCursor_EnumDecl: return "EnumDecl";
        case CXCursor_EnumConstantDecl: return "EnumConstantDecl";
        case CXCursor_FunctionDecl: return "FunctionDecl";
        case CXCursor_VarDecl: return "VarDecl";
        default: return NULL;  // Skip uninteresting cursors
    }
}

static enum CXChildVisitResult visit_cursor(CXCursor cursor, CXCursor parent, CXClientData data);

typedef struct {
    StringBuf* buf;
    int first_child;
    const char* filename;
} VisitorCtx;

static enum CXChildVisitResult visit_cursor(CXCursor cursor, CXCursor parent, CXClientData data) {
    (void)parent;
    VisitorCtx* ctx = (VisitorCtx*)data;
    enum CXCursorKind kind = clang_getCursorKind(cursor);
    const char* type = cursor_kind_to_type(kind);
    if (!type) return CXChildVisit_Recurse;  // Skip, but visit children

    // Check if this cursor belongs to our file (skip system headers)
    CXSourceLocation loc = clang_getCursorLocation(cursor);
    if (clang_Location_isInSystemHeader(loc)) return CXChildVisit_Continue;

    CXString name = clang_getCursorSpelling(cursor);
    const char* nameStr = clang_getCString(name);

    // For message expressions, fall back to referenced method name if spelling is empty
    CXString displayName = {0};
    int usedDisplayName = 0;
    if (kind == CXCursor_ObjCMessageExpr && (!nameStr || nameStr[0] == '\0')) {
        clang_disposeString(name);
        CXCursor referenced = clang_getCursorReferenced(cursor);
        if (!clang_Cursor_isNull(referenced)) {
            displayName = clang_getCursorSpelling(referenced);
        } else {
            displayName = clang_getCursorDisplayName(cursor);
        }
        nameStr = clang_getCString(displayName);
        usedDisplayName = 1;
    }

    if (!ctx->first_child) buf_append(ctx->buf, ",");
    ctx->first_child = 0;

    buf_append(ctx->buf, "{\"type\":");
    buf_append_escaped(ctx->buf, type);
    buf_append(ctx->buf, ",\"name\":");
    buf_append_escaped(ctx->buf, nameStr ? nameStr : "");
    buf_append(ctx->buf, ",");
    append_span(ctx->buf, cursor);

    // Type-specific fields
    if (kind == CXCursor_ObjCPropertyDecl) {
        CXType propType = clang_getCursorType(cursor);
        CXString typeStr = clang_getTypeSpelling(propType);
        buf_append(ctx->buf, ",\"propertyType\":");
        buf_append_escaped(ctx->buf, clang_getCString(typeStr));
        clang_disposeString(typeStr);

        // Nullability
        enum CXTypeNullabilityKind nullability = clang_Type_getNullability(propType);
        if (nullability == CXTypeNullability_NonNull) {
            buf_append(ctx->buf, ",\"nullability\":\"nonnull\"");
        } else if (nullability == CXTypeNullability_Nullable) {
            buf_append(ctx->buf, ",\"nullability\":\"nullable\"");
        }
    }

    if (kind == CXCursor_ObjCInstanceMethodDecl || kind == CXCursor_ObjCClassMethodDecl) {
        CXType retType = clang_getCursorResultType(cursor);
        CXString retStr = clang_getTypeSpelling(retType);
        buf_append(ctx->buf, ",\"returnType\":");
        buf_append_escaped(ctx->buf, clang_getCString(retStr));
        buf_append(ctx->buf, ",\"isClassMethod\":");
        buf_append(ctx->buf, kind == CXCursor_ObjCClassMethodDecl ? "true" : "false");
        clang_disposeString(retStr);
    }

    if (kind == CXCursor_ObjCMessageExpr) {
        CXString selector = clang_getCursorSpelling(cursor);
        const char* selStr = clang_getCString(selector);
        if (!selStr || selStr[0] == '\0') {
            clang_disposeString(selector);
            // Fall back to referenced method declaration's name
            CXCursor referenced = clang_getCursorReferenced(cursor);
            if (!clang_Cursor_isNull(referenced)) {
                selector = clang_getCursorSpelling(referenced);
            } else {
                selector = clang_getCursorDisplayName(cursor);
            }
            selStr = clang_getCString(selector);
        }
        buf_append(ctx->buf, ",\"selector\":");
        buf_append_escaped(ctx->buf, selStr ? selStr : "");
        clang_disposeString(selector);
    }

    // Visit children
    buf_append(ctx->buf, ",\"children\":[");
    VisitorCtx childCtx = { ctx->buf, 1, ctx->filename };
    clang_visitChildren(cursor, visit_cursor, &childCtx);
    buf_append(ctx->buf, "]");

    buf_append(ctx->buf, "}");

    if (usedDisplayName) {
        clang_disposeString(displayName);
    } else {
        clang_disposeString(name);
    }
    return CXChildVisit_Continue;
}

char* serialize_translation_unit(CXTranslationUnit tu, const char* filename) {
    StringBuf buf;
    buf_init(&buf);

    buf_append(&buf, "{\"file\":");
    buf_append_escaped(&buf, filename);
    buf_append(&buf, ",\"declarations\":[");

    CXCursor rootCursor = clang_getTranslationUnitCursor(tu);
    VisitorCtx ctx = { &buf, 1, filename };
    clang_visitChildren(rootCursor, visit_cursor, &ctx);

    buf_append(&buf, "]}");

    return buf.data;
}
