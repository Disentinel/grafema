# REG-259: Architecture: Package-specific analyzer plugins structure

## Problem

Current DatabaseAnalyzer is too abstract — detects only `db.query()`/`db.execute()` patterns that don't match real-world packages.

Each package has its own API:
- `npm/sqlite3`: `db.run()`, `db.get()`, `db.all()`
- `npm/prisma`: `prisma.user.create()`, `prisma.$queryRaw()`
- `npm/pg`: `pool.query()`, `client.query()`
- `npm/sequelize`: `Model.findAll()`, `Model.create()`
- `maven/jdbc`: `statement.executeQuery()`, `preparedStatement.executeUpdate()`

## Proposed Structure

```
plugins/
  packages/
    npm/
      sqlite3/
        Sqlite3Analyzer.ts
      prisma/
        PrismaAnalyzer.ts
      pg/
        PostgresAnalyzer.ts
    maven/
      jdbc/
        JDBCAnalyzer.ts
    pypi/
      sqlalchemy/
        SQLAlchemyAnalyzer.ts
```

## Design Questions

1. Plugin naming: `npm-sqlite3` vs `npm/sqlite3` directory structure?
2. Config syntax: How to enable in config.yaml?
3. Auto-detection: Should plugins auto-activate based on package.json dependencies?
4. Deprecation: Remove abstract DatabaseAnalyzer or keep as fallback?

## Blocks

- REG-260: Create npm/sqlite3 analyzer plugin (depends on this architecture)
