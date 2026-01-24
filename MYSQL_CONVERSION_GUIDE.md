# MySQL Conversion Guide - PostgreSQL to MySQL

This document provides a quick reference for converting PostgreSQL schemas to MySQL (Amazon RDS) syntax.

## Key Conversion Patterns

### 1. Data Types

| PostgreSQL | MySQL | Notes |
|-----------|-------|-------|
| `UUID` | `CHAR(36)` | Store UUID as string, generate in application |
| `TIMESTAMP WITH TIME ZONE` | `DATETIME` | Use DATETIME for application timestamps |
| `JSONB` | `JSON` | MySQL 5.7+ supports JSON type |
| `SERIAL` / `BIGSERIAL` | `AUTO_INCREMENT` | For auto-incrementing IDs |
| `TEXT` | `TEXT` | Same |
| `VARCHAR(n)` | `VARCHAR(n)` | Same |
| `BOOLEAN` | `BOOLEAN` or `TINYINT(1)` | MySQL uses TINYINT(1) internally |
| `DECIMAL(p,s)` | `DECIMAL(p,s)` | Same |

### 2. Primary Keys

**PostgreSQL:**
```sql
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
```

**MySQL:**
```sql
id CHAR(36) PRIMARY KEY
-- Generate UUID in application using uuid package
```

### 3. Foreign Keys

**PostgreSQL:**
```sql
user_id UUID REFERENCES users(id) ON DELETE SET NULL
```

**MySQL:**
```sql
user_id CHAR(36) NULL,
FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
```

### 4. Timestamps

**PostgreSQL:**
```sql
created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
```

**MySQL:**
```sql
created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
```

### 5. JSON Fields

**PostgreSQL:**
```sql
permissions JSONB DEFAULT '{}'::jsonb
```

**MySQL:**
```sql
permissions JSON DEFAULT (JSON_OBJECT())
```

### 6. Indexes

**PostgreSQL:**
```sql
CREATE INDEX idx_name ON table(column);
CREATE INDEX idx_name ON table(column) WHERE column IS NOT NULL; -- Partial
CREATE INDEX idx_name ON table USING GIN (json_column); -- GIN for JSONB
```

**MySQL:**
```sql
CREATE INDEX idx_name ON table(column);
CREATE INDEX idx_name ON table(column); -- NULLs handled automatically
-- For JSON: Use generated columns or full-text indexes
FULLTEXT INDEX idx_name (column1, column2, ...); -- Full-text search
```

### 7. Full-Text Search

**PostgreSQL:**
```sql
CREATE INDEX idx_fulltext ON table USING GIN (
    to_tsvector('english', column1 || ' ' || column2)
);
```

**MySQL:**
```sql
FULLTEXT INDEX idx_fulltext (column1, column2, ...);
-- Query: WHERE MATCH(column1, column2) AGAINST('search term')
```

### 8. Table Engine and Charset

**PostgreSQL:**
```sql
-- No explicit engine/charset needed
```

**MySQL:**
```sql
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

### 9. CHECK Constraints

**PostgreSQL:**
```sql
status VARCHAR(50) CHECK (status IN ('draft', 'pending', 'approved'))
```

**MySQL:**
```sql
status VARCHAR(50) CHECK (status IN ('draft', 'pending', 'approved'))
-- MySQL 8.0+ supports CHECK constraints
```

### 10. Unique Constraints

**PostgreSQL:**
```sql
UNIQUE(column1, column2)
UNIQUE(column1, column2) WHERE condition -- Partial unique
```

**MySQL:**
```sql
UNIQUE KEY uk_name (column1, column2)
-- For partial unique, use unique index with WHERE (MySQL 8.0+)
-- Or handle in application logic
```

## Complete Table Example

### PostgreSQL Version:
```sql
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    permissions JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_users_email ON users(email);
```

### MySQL Version:
```sql
CREATE TABLE users (
    id CHAR(36) PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    permissions JSON DEFAULT (JSON_OBJECT()),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

## Query Differences

### JSON Queries

**PostgreSQL:**
```sql
SELECT * FROM table WHERE data->>'key' = 'value';
SELECT * FROM table WHERE data @> '{"key": "value"}';
```

**MySQL:**
```sql
SELECT * FROM table WHERE JSON_EXTRACT(data, '$.key') = 'value';
SELECT * FROM table WHERE data->>'$.key' = 'value'; -- MySQL 5.7+
SELECT * FROM table WHERE JSON_CONTAINS(data, '{"key": "value"}');
```

### Full-Text Search

**PostgreSQL:**
```sql
SELECT * FROM table WHERE to_tsvector('english', column) @@ plainto_tsquery('english', 'search term');
```

**MySQL:**
```sql
SELECT * FROM table WHERE MATCH(column) AGAINST('search term' IN NATURAL LANGUAGE MODE);
```

### UUID Generation

**PostgreSQL:**
```sql
INSERT INTO table (id, ...) VALUES (gen_random_uuid(), ...);
```

**MySQL:**
```javascript
// In application code
import { v4 as uuidv4 } from 'uuid';
const id = uuidv4(); // Generate in Node.js
await pool.execute('INSERT INTO table (id, ...) VALUES (?, ...)', [id, ...]);
```

## Migration Checklist

When converting each table:

- [ ] Replace `UUID` with `CHAR(36)`
- [ ] Replace `TIMESTAMP WITH TIME ZONE` with `DATETIME`
- [ ] Replace `JSONB` with `JSON`
- [ ] Remove `DEFAULT gen_random_uuid()` (generate in app)
- [ ] Add `ON UPDATE CURRENT_TIMESTAMP` to `updated_at`
- [ ] Move indexes into CREATE TABLE or use separate statements
- [ ] Add `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
- [ ] Convert GIN indexes to appropriate MySQL indexes
- [ ] Convert full-text search to `FULLTEXT INDEX`
- [ ] Test all constraints work correctly

## Notes

1. **UUID Generation**: All UUIDs must be generated in the application using the `uuid` package
2. **JSON Support**: MySQL JSON type is available from 5.7+, RDS MySQL 8.0+ fully supports it
3. **Full-Text Search**: MySQL full-text search works differently - test queries carefully
4. **Indexes**: MySQL automatically handles NULLs in indexes, no need for partial indexes in most cases
5. **Transactions**: Both support transactions, syntax is similar
6. **Connection Pooling**: Use `mysql2` connection pooling (already configured)

## Reference Files

- Complete MySQL schema: `src/config-sql/schema.sql`
- Database connection: `src/config-sql/database.js`
- Example model: `src/models-sql/User.model.js`
