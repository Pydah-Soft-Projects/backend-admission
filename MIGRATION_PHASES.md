# Migration Phases - MongoDB to MySQL (Amazon RDS)

## Overview

This document outlines the phase-wise migration strategy from MongoDB to Amazon RDS MySQL. The migration is done in phases to minimize risk and allow gradual transition.

## Phase Structure

### Phase 1: Model Migration ✅
- Create SQL models in `src/models-sql/`
- Set up database connection
- Create database schema
- Update scripts for SQL

### Phase 2: Controller Migration
- Create SQL controllers in `src/controllers-sql/`
- Update routes to use SQL controllers
- Maintain API compatibility

## Folder Structure

```
backend-admission/
├── src/
│   ├── models/              # MongoDB models (KEEP - existing)
│   ├── models-sql/           # MySQL models (NEW)
│   ├── controllers/          # MongoDB controllers (KEEP - existing)
│   ├── controllers-sql/      # MySQL controllers (NEW)
│   ├── config/
│   │   └── database.js       # MongoDB connection (KEEP)
│   ├── config-sql/
│   │   ├── database.js       # MySQL connection (NEW)
│   │   └── schema.sql       # MySQL schema (NEW)
│   ├── scripts/              # MongoDB scripts (KEEP)
│   └── scripts-sql/          # MySQL scripts (NEW)
```

## Phase 1: Model Migration

### Step 1.1: Database Setup
- [x] Create MySQL connection config (`config-sql/database.js`)
- [x] Add mysql2 dependency to package.json
- [x] Update .env with RDS MySQL credentials

### Step 1.2: Create Initial Schema
- [x] Create schema.sql file
- [ ] Create all table definitions (in progress)
- [ ] Run schema creation script

### Step 1.3: Model Creation
- [x] Create User model (`models-sql/User.model.js`)
- [ ] Create Lead model
- [ ] Create Joining model
- [ ] Create Admission model
- [ ] Create Course model
- [ ] Create Branch model
- [ ] Create PaymentTransaction model
- [ ] Create PaymentConfig model
- [ ] Create PaymentGatewayConfig model
- [ ] Create Communication model
- [ ] Create MessageTemplate model
- [ ] Create ActivityLog model
- [ ] Create Notification model
- [ ] Create NotificationConfig model
- [ ] Create PushSubscription model
- [ ] Create ShortUrl model
- [ ] Create ImportJob model
- [ ] Create DeleteJob model
- [ ] Create AdmissionSequence model

### Step 1.4: Scripts Migration
- [x] Create seedSuperAdmin script (`scripts-sql/seedSuperAdmin.js`)
- [ ] Update other scripts as needed

### Step 1.5: Testing
- [ ] Test database connection
- [ ] Test User model CRUD operations
- [ ] Test seed script
- [ ] Verify all models work correctly

## Phase 2: Controller Migration

### Step 2.1: Controller Creation
- [ ] Create auth controller (SQL)
- [ ] Create user controller (SQL)
- [ ] Create lead controller (SQL)
- [ ] Create joining controller (SQL)
- [ ] Create admission controller (SQL)
- [ ] Create course controller (SQL)
- [ ] Create payment controller (SQL)
- [ ] Create communication controller (SQL)
- [ ] Create notification controller (SQL)
- [ ] Create report controller (SQL)
- [ ] Create manager controller (SQL)
- [ ] Create utm controller (SQL)

### Step 2.2: Route Updates
- [ ] Update routes to use SQL controllers conditionally
- [ ] Add feature flag for SQL/MongoDB switch
- [ ] Test all endpoints

### Step 2.3: Testing
- [ ] Integration tests for all endpoints
- [ ] Performance testing
- [ ] Load testing

## Environment Variables

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
DB_CHARSET=utf8mb4
DB_TIMEZONE=+00:00

# Connection Pool Settings
DB_POOL_MIN=2
DB_POOL_MAX=10
DB_POOL_IDLE_TIMEOUT=30000
```

## Running SQL Scripts

```bash
# Seed Super Admin (SQL)
npm run seed:sql

# Run schema creation (manual)
mysql -h your-rds-endpoint -u your_user -p admissions_db < src/config-sql/schema.sql
```

## Notes

- MongoDB code remains intact - no deletion
- SQL code in separate folders
- Can run both systems in parallel during transition
- API endpoints remain the same
- Frontend requires no changes
