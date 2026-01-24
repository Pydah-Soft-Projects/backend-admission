# SQL Migration Setup Guide

## Amazon RDS MySQL Configuration

### Prerequisites
1. Amazon RDS MySQL 8.0+ instance created
2. Database and user credentials available
3. Security group configured to allow connections

### Environment Variables

Add to `.env` file:

```env
# Amazon RDS MySQL Configuration
DB_TYPE=mysql
DB_HOST=your-rds-endpoint.region.rds.amazonaws.com
DB_PORT=3306
DB_NAME=admissions_db
DB_USER=your_db_user
DB_PASSWORD=your_db_password
DB_SSL=true

# Connection Pool Settings
DB_POOL_MIN=2
DB_POOL_MAX=10
DB_POOL_IDLE_TIMEOUT=30000

# Database Settings
DB_CHARSET=utf8mb4
DB_TIMEZONE=+00:00
```

### Installation

1. Install dependencies:
```bash
npm install mysql2
```

2. Test database connection:
```bash
node -e "import('./config-sql/database.js').then(db => db.default())"
```

### Schema Creation

1. Connect to your RDS instance:
```bash
mysql -h your-rds-endpoint -u your_user -p
```

2. Create database (if not exists):
```sql
CREATE DATABASE IF NOT EXISTS admissions_db 
CHARACTER SET utf8mb4 
COLLATE utf8mb4_unicode_ci;
```

3. Use the database:
```sql
USE admissions_db;
```

4. Run schema file:
```bash
mysql -h your-rds-endpoint -u your_user -p admissions_db < src/config-sql/schema.sql
```

Or execute the SQL file contents directly in MySQL client.

### Running Scripts

**Seed Super Admin:**
```bash
npm run seed:sql
```

This will create a Super Admin user:
- Email: `admin@leadtracker.com`
- Password: `Admin@123`

**⚠️ Change the password after first login!**

### Connection Pool

The database connection uses a connection pool managed by `mysql2`. The pool:
- Maintains multiple connections for better performance
- Automatically handles connection lifecycle
- Supports SSL for secure connections to RDS

### Troubleshooting

**Connection Timeout:**
- Check RDS security group allows your IP
- Verify endpoint, port, and credentials
- Check SSL configuration

**Authentication Error:**
- Verify username and password
- Check user has proper permissions
- Ensure database exists

**SSL Error:**
- Set `DB_SSL=false` for testing (not recommended for production)
- Verify SSL certificate if using custom CA

### Next Steps

1. ✅ Database connection configured
2. ✅ Schema created
3. ✅ User model created
4. ⏳ Create remaining models
5. ⏳ Create controllers
6. ⏳ Update routes
