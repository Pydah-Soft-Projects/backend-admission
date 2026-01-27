# Login Flow Documentation

## Table of Contents
1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Frontend Login Flow](#frontend-login-flow)
4. [Backend Authentication Flow](#backend-authentication-flow)
5. [Token Generation & Management](#token-generation--management)
6. [Protected Routes & Middleware](#protected-routes--middleware)
7. [Session Management](#session-management)
8. [Error Handling](#error-handling)
9. [Security Features](#security-features)
10. [Role-Based Access Control](#role-based-access-control)
11. [Complete Flow Diagram](#complete-flow-diagram)
12. [Code References](#code-references)

---

## Overview

This application implements a JWT (JSON Web Token) based authentication system with role-based access control. The authentication flow involves:

- **Frontend**: Next.js application with React components
- **Backend**: Express.js REST API with MySQL database
- **Authentication**: JWT tokens stored in HTTP-only cookies (client-side)
- **Password Security**: bcrypt hashing for password storage
- **Session Management**: Client-side cookie storage with 7-day expiration

---

## Architecture

### Components

1. **Frontend (`frontend-admission/`)**
   - Login page: `app/auth/login/page.tsx`
   - Auth utilities: `lib/auth.ts`
   - API client: `lib/api.ts`
   - Route guards: Layout components in `app/*/layout.tsx`

2. **Backend (`backend-admission/`)**
   - Auth controller: `src/controllers/auth.controller.js`
   - Auth routes: `src/routes/auth.routes.js`
   - Auth middleware: `src/middleware/auth.middleware.js`
   - Token generator: `src/utils/generateToken.js`
   - Database: MySQL (Amazon RDS)

---

## Frontend Login Flow

### 1. User Access Login Page

**File**: `frontend-admission/app/auth/login/page.tsx`

- User navigates to `/auth/login`
- Login form is displayed with email and password fields
- Form validation is handled by `react-hook-form` with `zod` schema validation

**Validation Rules**:
```typescript
const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});
```

### 2. Form Submission

When user submits the login form:

1. **Form Validation**: Client-side validation runs first
2. **API Call**: `authAPI.login(data)` is called with email and password
3. **Loading State**: UI shows loading indicator during request

**Code Flow**:
```typescript
const onSubmit = async (data: LoginFormData) => {
  setIsLoading(true);
  setError(null);
  
  try {
    const response = await authAPI.login(data);
    // Process response...
  } catch (err) {
    // Handle errors...
  }
};
```

### 3. API Request

**File**: `frontend-admission/lib/api.ts`

The `authAPI.login()` function:
- Makes a POST request to `/api/auth/login`
- Sends credentials as JSON in request body
- Uses axios instance configured with base URL

**Request Structure**:
```typescript
POST /api/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "password123"
}
```

### 4. Response Processing

Upon successful login, the backend returns:
```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": "123",
      "name": "John Doe",
      "email": "user@example.com",
      "roleName": "Counsellor",
      "isManager": false,
      "permissions": {},
      // ... other user fields
    }
  }
}
```

### 5. Store Authentication Data

**File**: `frontend-admission/lib/auth.ts`

The frontend stores authentication data in cookies:

```typescript
auth.setAuth(token, user);
```

This function:
- Stores JWT token in cookie with key `token` (7-day expiration)
- Stores user object in cookie with key `user` (7-day expiration)
- Uses `js-cookie` library for cookie management

### 6. Role-Based Redirect

After storing auth data, user is redirected based on their role:

```typescript
if (user.roleName === 'Super Admin' || user.roleName === 'Sub Super Admin') {
  router.push('/superadmin/dashboard');
} else if (user.isManager) {
  router.push('/manager/dashboard');
} else {
  router.push('/user/dashboard');
}
```

---

## Backend Authentication Flow

### 1. Route Registration

**File**: `backend-admission/src/routes/auth.routes.js`

Login route is registered as a public endpoint:
```javascript
router.post('/login', login);
```

**File**: `backend-admission/src/server.js`

Auth routes are mounted at `/api/auth`:
```javascript
app.use('/api/auth', authRoutes);
```

### 2. Login Controller

**File**: `backend-admission/src/controllers/auth.controller.js`

The `login` function handles the authentication process:

#### Step 1: Input Validation
```javascript
const { email, password } = req.body;

if (!email || !password) {
  return errorResponse(res, 'Please provide email and password', 400);
}
```

#### Step 2: Database Connection
```javascript
pool = getPool(); // Get MySQL connection pool
```

#### Step 3: User Lookup
```javascript
const normalizedEmail = email.toLowerCase().trim();
const [users] = await pool.execute(
  'SELECT id, name, email, password, role_name, managed_by, is_manager, designation, permissions, is_active, created_at, updated_at FROM users WHERE email = ?',
  [normalizedEmail]
);
```

**Key Points**:
- Email is normalized (lowercase, trimmed) for case-insensitive matching
- Query retrieves all necessary user fields including hashed password

#### Step 4: User Existence Check
```javascript
if (!users || users.length === 0) {
  return errorResponse(res, 'Invalid credentials', 401);
}
```

**Security Note**: Returns generic "Invalid credentials" message to prevent user enumeration attacks.

#### Step 5: Account Status Check
```javascript
if (userData.is_active === 0 || userData.is_active === false || userData.is_active === null) {
  return errorResponse(res, 'Your account has been deactivated', 403);
}
```

#### Step 6: Password Verification
```javascript
const isMatch = await bcrypt.compare(password, userData.password);

if (!isMatch) {
  return errorResponse(res, 'Invalid credentials', 401);
}
```

**Security**:
- Uses `bcrypt.compare()` for secure password comparison
- Prevents timing attacks
- Returns generic error message

#### Step 7: Permissions Parsing
```javascript
let permissions = {};
if (userData.permissions) {
  if (typeof userData.permissions === 'string') {
    permissions = JSON.parse(userData.permissions);
  } else if (typeof userData.permissions === 'object') {
    permissions = userData.permissions;
  }
}
```

#### Step 8: User Object Formatting
```javascript
const user = {
  id: userData.id,
  _id: userData.id, // Backward compatibility
  name: userData.name,
  email: userData.email,
  roleName: userData.role_name,
  managedBy: userData.managed_by,
  isManager: userData.is_manager === 1 || userData.is_manager === true,
  designation: userData.designation,
  permissions,
  isActive: userData.is_active === 1 || userData.is_active === true,
  createdAt: userData.created_at,
  updatedAt: userData.updated_at,
};
```

**Note**: Converts database snake_case to camelCase for frontend consistency.

#### Step 9: Token Generation
```javascript
const token = generateToken(user.id);
```

#### Step 10: Success Response
```javascript
return successResponse(res, {
  token,
  user,
}, 'Login successful', 200);
```

---

## Token Generation & Management

### Token Generation

**File**: `backend-admission/src/utils/generateToken.js`

```javascript
export const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE || '7d',
  });
};
```

**Token Structure**:
- **Payload**: Contains user `id`
- **Secret**: Uses `JWT_SECRET` from environment variables
- **Expiration**: Default 7 days (configurable via `JWT_EXPIRE`)

**Token Format**:
```
Header.Payload.Signature
```

Example payload:
```json
{
  "id": "123",
  "iat": 1234567890,
  "exp": 1235173890
}
```

### Token Storage

**Frontend**: Cookies (client-side)
- **Token Key**: `token`
- **User Key**: `user`
- **Expiration**: 7 days
- **Storage**: Browser cookies (accessible via `js-cookie`)

### Token Usage

**Request Interceptor** (`frontend-admission/lib/api.ts`):
```typescript
api.interceptors.request.use(
  (config) => {
    const token = Cookies.get('token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  }
);
```

All authenticated API requests automatically include:
```
Authorization: Bearer <token>
```

---

## Protected Routes & Middleware

### Backend Middleware

**File**: `backend-admission/src/middleware/auth.middleware.js`

#### `protect` Middleware

This middleware is applied to protected routes:

```javascript
export const protect = async (req, res, next) => {
  // 1. Extract token from Authorization header
  let token;
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return errorResponse(res, 'Not authorized to access this route', 401);
  }

  // 2. Verify token
  const decoded = jwt.verify(token, process.env.JWT_SECRET);

  // 3. Fetch user from database
  const [users] = await pool.execute(
    'SELECT id, name, email, role_name, ... FROM users WHERE id = ?',
    [decoded.id]
  );

  // 4. Check user exists and is active
  if (users.length === 0) {
    return errorResponse(res, 'User not found', 404);
  }

  if (!req.user.isActive) {
    return errorResponse(res, 'User account is inactive', 403);
  }

  // 5. Attach user to request object
  req.user = { /* formatted user object */ };

  // 6. Continue to next middleware/route handler
  next();
};
```

**Usage Example**:
```javascript
router.get('/me', protect, getMe);
router.use(protect); // Apply to all routes in router
```

#### `isSuperAdmin` Middleware

Checks if user has Super Admin privileges:

```javascript
export const isSuperAdmin = (req, res, next) => {
  if (!req.user) {
    return errorResponse(res, 'Not authenticated', 401);
  }

  if (!hasElevatedAdminPrivileges(req.user.roleName)) {
    return errorResponse(res, 'Access denied. Super Admin only', 403);
  }

  next();
};
```

### Frontend Route Protection

#### Layout-Based Guards

**File**: `frontend-admission/app/user/layout.tsx`

```typescript
useEffect(() => {
  const user = auth.getUser();
  if (!user) {
    router.replace('/auth/login');
    return;
  }

  // Role-based redirect
  if (user.roleName === 'Super Admin' || user.roleName === 'Sub Super Admin') {
    router.replace('/superadmin/dashboard');
    return;
  }

  setCurrentUser(user);
  setIsReady(true);
}, [router]);
```

**Similar guards exist in**:
- `app/superadmin/layout.tsx`
- `app/manager/layout.tsx`

#### API Response Interceptor

**File**: `frontend-admission/lib/api.ts`

```typescript
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      // Unauthorized - clear token and redirect to login
      Cookies.remove('token');
      Cookies.remove('user');
      if (typeof window !== 'undefined') {
        window.location.href = '/auth/login';
      }
    }
    return Promise.reject(error);
  }
);
```

**Behavior**:
- Automatically handles 401 Unauthorized responses
- Clears authentication cookies
- Redirects to login page

---

## Session Management

### Client-Side Session

**Storage Mechanism**: Browser Cookies

**Cookie Configuration**:
- **Token Cookie**: `token` (JWT string)
- **User Cookie**: `user` (JSON stringified user object)
- **Expiration**: 7 days
- **Access**: Available to JavaScript (not HTTP-only)

**File**: `frontend-admission/lib/auth.ts`

```typescript
export const auth = {
  setAuth: (token: string, user: User) => {
    Cookies.set(TOKEN_KEY, token, { expires: 7 });
    Cookies.set(USER_KEY, JSON.stringify(user), { expires: 7 });
  },

  getToken: (): string | undefined => {
    return Cookies.get(TOKEN_KEY);
  },

  getUser: (): User | null => {
    const userStr = Cookies.get(USER_KEY);
    if (!userStr) return null;
    try {
      return JSON.parse(userStr) as User;
    } catch {
      return null;
    }
  },

  isAuthenticated: (): boolean => {
    return !!Cookies.get(TOKEN_KEY);
  },

  clearAuth: () => {
    Cookies.remove(TOKEN_KEY);
    Cookies.remove(USER_KEY);
  },

  logout: () => {
    auth.clearAuth();
    if (typeof window !== 'undefined') {
      window.location.href = '/auth/login';
    }
  },
};
```

### Session Validation

**Backend**: Token is validated on every protected route request
- Token signature is verified
- Token expiration is checked
- User is fetched from database
- User active status is verified

**Frontend**: Token presence is checked on:
- Page loads (layout components)
- API requests (interceptor adds token)
- Navigation (route guards)

---

## Error Handling

### Frontend Error Handling

**Login Page** (`frontend-admission/app/auth/login/page.tsx`):

```typescript
catch (err: any) {
  console.error('Login error:', err);
  const errorMessage = 
    err.response?.data?.message || 
    err.message || 
    'Login failed. Please check your credentials and try again.';
  setError(errorMessage);
}
```

**Error Display**:
- Errors are displayed in a styled error banner
- User-friendly messages are shown
- Technical details are logged to console

### Backend Error Handling

**Login Controller** (`backend-admission/src/controllers/auth.controller.js`):

**Error Scenarios**:

1. **Missing Credentials** (400):
   ```javascript
   if (!email || !password) {
     return errorResponse(res, 'Please provide email and password', 400);
   }
   ```

2. **Database Connection Error** (500):
   ```javascript
   catch (error) {
     return errorResponse(res, 'Database connection failed', 500);
   }
   ```

3. **User Not Found** (401):
   ```javascript
   if (!users || users.length === 0) {
     return errorResponse(res, 'Invalid credentials', 401);
   }
   ```

4. **Account Inactive** (403):
   ```javascript
   if (userData.is_active === 0) {
     return errorResponse(res, 'Your account has been deactivated', 403);
   }
   ```

5. **Invalid Password** (401):
   ```javascript
   if (!isMatch) {
     return errorResponse(res, 'Invalid credentials', 401);
   }
   ```

6. **Server Error** (500):
   ```javascript
   catch (error) {
     return errorResponse(res, error.message || 'Login failed', 500);
   }
   ```

**Response Format**:
```json
{
  "success": false,
  "message": "Error message",
  "data": null
}
```

---

## Security Features

### 1. Password Security

- **Hashing**: Passwords are hashed using `bcrypt`
- **Comparison**: Uses `bcrypt.compare()` for secure password verification
- **Storage**: Only hashed passwords are stored in database

### 2. Token Security

- **JWT Signing**: Tokens are signed with secret key
- **Expiration**: Tokens expire after 7 days (configurable)
- **Verification**: Token signature is verified on every request
- **Secret**: Uses environment variable `JWT_SECRET`

### 3. Input Validation

- **Email Normalization**: Email is lowercased and trimmed
- **SQL Injection Prevention**: Uses parameterized queries
- **Schema Validation**: Frontend uses Zod for input validation

### 4. Error Messages

- **Generic Errors**: Returns "Invalid credentials" for both wrong email and wrong password
- **Prevents Enumeration**: Doesn't reveal if email exists in system

### 5. Account Status Checks

- **Active Status**: Verifies user account is active before login
- **Database Verification**: User existence and status checked on every token validation

### 6. HTTPS Recommendation

- **Production**: Should use HTTPS to protect tokens in transit
- **Cookies**: Consider HTTP-only cookies for additional security

---

## Role-Based Access Control

### User Roles

1. **Super Admin**: Full system access
2. **Sub Super Admin**: Elevated admin privileges
3. **Manager**: Team management capabilities
4. **Regular User**: Standard user access

### Role-Based Redirects

**After Login**:
- Super Admin / Sub Super Admin → `/superadmin/dashboard`
- Manager → `/manager/dashboard`
- Regular User → `/user/dashboard`

**Route Guards**:
- Each role has dedicated layout with role checks
- Unauthorized access attempts redirect to appropriate dashboard
- API endpoints use middleware for role-based access

### Permission System

**Structure**:
- Permissions stored as JSON in database
- Parsed and attached to user object
- Available for future fine-grained access control

**Current Implementation**:
- Super Admin has elevated privileges
- Permission-based checks are prepared for future use

---

## Complete Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        LOGIN FLOW                                │
└─────────────────────────────────────────────────────────────────┘

1. USER ACCESSES LOGIN PAGE
   └─> /auth/login
   └─> Login form displayed

2. USER SUBMITS CREDENTIALS
   └─> Frontend validation (Zod schema)
   └─> POST /api/auth/login
   └─> { email, password }

3. BACKEND PROCESSING
   │
   ├─> Input Validation
   │   └─> Check email & password present
   │
   ├─> Database Connection
   │   └─> Get MySQL connection pool
   │
   ├─> User Lookup
   │   └─> Normalize email (lowercase, trim)
   │   └─> SELECT * FROM users WHERE email = ?
   │
   ├─> User Existence Check
   │   └─> If not found → 401 "Invalid credentials"
   │
   ├─> Account Status Check
   │   └─> If inactive → 403 "Account deactivated"
   │
   ├─> Password Verification
   │   └─> bcrypt.compare(password, hashedPassword)
   │   └─> If mismatch → 401 "Invalid credentials"
   │
   ├─> Permissions Parsing
   │   └─> Parse JSON permissions from database
   │
   ├─> User Object Formatting
   │   └─> Convert snake_case to camelCase
   │
   ├─> Token Generation
   │   └─> jwt.sign({ id }, JWT_SECRET, { expiresIn: '7d' })
   │
   └─> Success Response
       └─> { success: true, data: { token, user } }

4. FRONTEND PROCESSING
   │
   ├─> Extract Token & User
   │   └─> response.data.token
   │   └─> response.data.user
   │
   ├─> Store in Cookies
   │   └─> Cookies.set('token', token, { expires: 7 })
   │   └─> Cookies.set('user', JSON.stringify(user), { expires: 7 })
   │
   └─> Role-Based Redirect
       ├─> Super Admin → /superadmin/dashboard
       ├─> Manager → /manager/dashboard
       └─> Regular User → /user/dashboard

5. SUBSEQUENT REQUESTS
   │
   ├─> Request Interceptor
   │   └─> Read token from cookie
   │   └─> Add Authorization: Bearer <token>
   │
   ├─> Backend Middleware (protect)
   │   ├─> Extract token from header
   │   ├─> Verify JWT signature
   │   ├─> Check expiration
   │   ├─> Fetch user from database
   │   ├─> Verify user is active
   │   └─> Attach user to req.user
   │
   └─> Route Handler
       └─> Access req.user for user data
```

---

## Code References

### Frontend Files

| File | Purpose |
|------|---------|
| `frontend-admission/app/auth/login/page.tsx` | Login page component |
| `frontend-admission/lib/auth.ts` | Authentication utilities (cookies, user management) |
| `frontend-admission/lib/api.ts` | API client with interceptors |
| `frontend-admission/app/user/layout.tsx` | User route guard |
| `frontend-admission/app/manager/layout.tsx` | Manager route guard |
| `frontend-admission/app/superadmin/layout.tsx` | Super Admin route guard |

### Backend Files

| File | Purpose |
|------|---------|
| `backend-admission/src/controllers/auth.controller.js` | Login, getMe, logout controllers |
| `backend-admission/src/routes/auth.routes.js` | Auth route definitions |
| `backend-admission/src/middleware/auth.middleware.js` | Authentication & authorization middleware |
| `backend-admission/src/utils/generateToken.js` | JWT token generation |
| `backend-admission/src/server.js` | Express app setup & route mounting |

### Database Schema

**Users Table** (MySQL):
```sql
CREATE TABLE users (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  role_name VARCHAR(100),
  managed_by VARCHAR(36),
  is_manager BOOLEAN DEFAULT FALSE,
  designation VARCHAR(255),
  permissions JSON,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

---

## Additional Endpoints

### GET /api/auth/me

**Purpose**: Get current authenticated user

**Authentication**: Required (uses `protect` middleware)

**Response**:
```json
{
  "success": true,
  "data": {
    "id": "123",
    "name": "John Doe",
    "email": "user@example.com",
    "roleName": "Counsellor",
    // ... other user fields
  },
  "message": "User retrieved successfully"
}
```

### POST /api/auth/logout

**Purpose**: Logout user (client-side token removal)

**Authentication**: Required (uses `protect` middleware)

**Response**:
```json
{
  "success": true,
  "data": null,
  "message": "Logged out successfully"
}
```

**Note**: Since JWT is stateless, logout is primarily handled client-side by removing cookies. Backend endpoint exists for future token blacklisting if needed.

---

## Environment Variables

### Backend

| Variable | Purpose | Example |
|----------|---------|---------|
| `JWT_SECRET` | Secret key for signing JWT tokens | `your-secret-key-here` |
| `JWT_EXPIRE` | Token expiration time | `7d` (default) |
| `DB_HOST` | MySQL database host | `your-db-host.rds.amazonaws.com` |
| `DB_NAME` | Database name | `admissions_db` |
| `DB_USER` | Database username | `admin` |
| `DB_PASSWORD` | Database password | `password` |

### Frontend

| Variable | Purpose | Example |
|----------|---------|---------|
| `NEXT_PUBLIC_API_URL` | Backend API base URL | `http://localhost:5000/api` |

---

## Troubleshooting

### Common Issues

1. **"Invalid credentials" on correct login**
   - Check database connection
   - Verify user exists in database
   - Check password hashing matches

2. **Token not being sent in requests**
   - Verify cookies are set correctly
   - Check request interceptor is working
   - Ensure token cookie exists

3. **401 Unauthorized on protected routes**
   - Verify token is valid and not expired
   - Check JWT_SECRET matches between token generation and verification
   - Ensure user exists and is active in database

4. **Redirect loops**
   - Check route guards in layout components
   - Verify authentication state checks
   - Ensure cookies are accessible

---

## Future Enhancements

1. **Token Refresh**: Implement refresh token mechanism
2. **HTTP-Only Cookies**: Move token storage to HTTP-only cookies
3. **Token Blacklisting**: Add token revocation on logout
4. **Multi-Factor Authentication**: Add MFA support
5. **Session Management**: Add active session tracking
6. **Rate Limiting**: Add login attempt rate limiting
7. **Password Reset**: Implement password reset flow
8. **Remember Me**: Add "remember me" functionality with longer token expiration

---

## Conclusion

This login flow implements a secure, JWT-based authentication system with:

- ✅ Secure password hashing (bcrypt)
- ✅ JWT token-based authentication
- ✅ Role-based access control
- ✅ Protected routes (frontend & backend)
- ✅ Session management via cookies
- ✅ Comprehensive error handling
- ✅ Security best practices

The system is designed to be scalable and maintainable, with clear separation of concerns between frontend and backend components.
