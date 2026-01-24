# SQL Migration Setup - Quick Start Guide

## ✅ What's Been Set Up

### 1. Folder Structure
```
src/
├── models/              # MongoDB models (KEEP - existing)
├── models-sql/          # MySQL models (NEW)
│   └── User.model.js    # ✅ Created
├── controllers/         # MongoDB controllers (KEEP - existing)
├── controllers-sql/     # MySQL controllers (NEW - to be created)
├── config/
│   └── database.js      # MongoDB connection (KEEP)
├── config-sql/          # MySQL configuration (NEW)
│   ├── database.js      # ✅ Created
│   ├── schema.sql       # ✅ Created (partial)
│   └── README.md        # ✅ Created
├── scripts/             # MongoDB scripts (KEEP)
└── scripts-sql/         # MySQL scripts (NEW)
    └── seedSuperAdmin.js # ✅ Created
```

### 2. Dependencies
- ✅ `mysql2` added to package.json
- ✅ `uuid` already present
- ✅ `bcryptjs` already present

### 3. Configuration Files
- ✅ MySQL connection pool (`config-sql/database.js`)
- ✅ Initial schema file (`config-sql/schema.sql`)
- ✅ Seed script (`scripts-sql/seedSuperAdmin.js`)
- ✅ User model example (`models-sql/User.model.js`)

### 4. Documentation
- ✅ `MIGRATION_TO_SQL.md` - Updated for MySQL
- ✅ `MIGRATION_PHASES.md` - Phase-wise migration plan
- ✅ `MYSQL_CONVERSION_GUIDE.md` - PostgreSQL to MySQL conversion reference
- ✅ `SQL_MIGRATION_SETUP.md` - This file

## 🚀 Next Steps

### Step 1: Configure Environment Variables

Add to `.env`:
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

### Step 2: Install Dependencies

```bash
npm install
```

### Step 3: Create Database Schema

Connect to your RDS instance and run:

```bash
# Option 1: Using MySQL client
mysql -h your-rds-endpoint -u your_user -p admissions_db < src/config-sql/schema.sql

# Option 2: Connect and run manually
mysql -h your-rds-endpoint -u your_user -p
```

Then in MySQL:
```sql
CREATE DATABASE IF NOT EXISTS admissions_db 
CHARACTER SET utf8mb4 
COLLATE utf8mb4_unicode_ci;

USE admissions_db;

-- Copy and paste contents from src/config-sql/schema.sql
```

### Step 4: Test Connection

```bash
# Test database connection
node -e "import('./src/config-sql/database.js').then(db => db.default().then(() => process.exit(0)))"
```

### Step 5: Seed Super Admin

```bash
npm run seed:sql
```

This creates:
- Email: `admin@leadtracker.com`
- Password: `Admin@123`

**⚠️ Change password after first login!**

## 📋 Phase 1: Model Migration (Current Phase)

### Models to Create (in order):

1. ✅ **User** - Done
2. ⏳ **Course** - Next
3. ⏳ **Branch** - Next
4. ⏳ **Lead** - Complex, many relationships
5. ⏳ **Joining** - Complex, nested data
6. ⏳ **Admission** - Similar to Joining
7. ⏳ **PaymentTransaction**
8. ⏳ **PaymentConfig**
9. ⏳ **PaymentGatewayConfig**
10. ⏳ **Communication**
11. ⏳ **MessageTemplate**
12. ⏳ **ActivityLog**
13. ⏳ **Notification**
14. ⏳ **NotificationConfig**
15. ⏳ **PushSubscription**
16. ⏳ **ShortUrl**
17. ⏳ **ImportJob**
18. ⏳ **DeleteJob**
19. ⏳ **AdmissionSequence**
20. ⏳ **LeadStatusLog** (related table)

### Model Creation Template

Use `User.model.js` as a template. Each model should have:

```javascript
import { getPool } from '../config-sql/database.js';
import { v4 as uuidv4 } from 'uuid';

class ModelName {
  constructor(data) {
    // Map database columns to model properties
  }

  static async findById(id) { }
  static async findAll(filters = {}) { }
  static async create(data) { }
  async save() { }
  async delete() { }
}

export default ModelName;
```

## 📋 Phase 2: Controller Migration (After Models)

### Controllers to Create:

1. ⏳ **auth.controller.js**
2. ⏳ **user.controller.js**
3. ⏳ **lead.controller.js** - Most complex
4. ⏳ **joining.controller.js**
5. ⏳ **admission.controller.js**
6. ⏳ **course.controller.js**
7. ⏳ **payment.controller.js**
8. ⏳ **communication.controller.js**
9. ⏳ **notification.controller.js**
10. ⏳ **report.controller.js**
11. ⏳ **manager.controller.js**
12. ⏳ **utm.controller.js**

## 🔧 Development Workflow

### Working with SQL Models

```javascript
// Import SQL model
import User from './models-sql/User.model.js';

// Find user
const user = await User.findByEmail('admin@leadtracker.com');

// Create user
const newUser = await User.create({
  name: 'John Doe',
  email: 'john@example.com',
  password: 'password123',
  roleName: 'User'
});

// Update user
user.name = 'Jane Doe';
await user.save();

// Delete user
await user.delete();
```

### Testing Models

Create test files in a `tests/` directory:

```javascript
// tests/models-sql/User.test.js
import User from '../../src/models-sql/User.model.js';

// Test CRUD operations
```

## 📚 Documentation Reference

- **Full Migration Guide**: `MIGRATION_TO_SQL.md`
- **Phase Plan**: `MIGRATION_PHASES.md`
- **MySQL Conversion**: `MYSQL_CONVERSION_GUIDE.md`
- **Config Setup**: `src/config-sql/README.md`

## ⚠️ Important Notes

1. **No Data Migration**: Starting fresh with SQL database
2. **Keep MongoDB Code**: Don't delete existing MongoDB code
3. **Separate Folders**: SQL code in `-sql` folders
4. **API Compatibility**: Endpoints remain the same
5. **UUID Generation**: All UUIDs generated in application
6. **Encryption**: Handled at application level (same as MongoDB)

## 🐛 Troubleshooting

### Connection Issues
- Check RDS security group allows your IP
- Verify endpoint, port, and credentials
- Test SSL connection

### Schema Issues
- Ensure database charset is `utf8mb4`
- Check foreign key constraints
- Verify indexes are created

### Model Issues
- Check UUID generation
- Verify JSON field handling
- Test encryption/decryption

## 📞 Support

For questions or issues:
1. Check documentation files
2. Review MySQL conversion guide
3. Test with User model as reference
4. Verify database connection first

---

**Status**: Phase 1 - Model Migration (In Progress)
**Next**: Create Course and Branch models
