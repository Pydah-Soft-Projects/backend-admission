# Complete Authentication Flow - CRM SSO System

## Table of Contents
1. [System Overview](#system-overview)
2. [Complete Authentication Flow](#complete-authentication-flow)
3. [Token Flow & Redirection](#token-flow--redirection)
4. [Admissions Application Integration](#admissions-application-integration)
5. [Code Examples](#code-examples)
6. [Testing the Flow](#testing-the-flow)

---

## System Overview

### Architecture Components

```
┌─────────────────┐         ┌──────────────────┐         ┌─────────────────┐
│  CRM Frontend   │         │   CRM Backend    │         │ Admissions App  │
│  (Port 5173)    │◄───────►│   (Port 3000)    │◄───────►│  (Port 3001)    │
│                 │         │                  │         │                 │
│ - Landing Page  │         │ - Auth API       │         │ - Login Page    │
│ - Portals Page  │         │ - Token Gen      │         │ - Dashboard     │
│ - Login Page    │         │ - Token Verify   │         │                 │
└─────────────────┘         └──────────────────┘         └─────────────────┘
                                      │
                                      ▼
                            ┌──────────────────┐
                            │   AWS RDS MySQL  │
                            │                  │
                            │ - student_db     │
                            │ - admissions_db │
                            └──────────────────┘
```

### Key URLs (Development)

- **CRM Frontend**: `http://localhost:5173`
- **CRM Backend**: `http://localhost:3000`
- **Admissions App**: `http://localhost:3001`

---

## Complete Authentication Flow

### Scenario 1: User Not Authenticated (First Time)

```
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 1: User Clicks Portal on CRM Frontend                          │
└─────────────────────────────────────────────────────────────────────┘

User Action:
  - Navigates to CRM Frontend (http://localhost:5173)
  - Clicks on "Admissions CRM" portal card

Frontend (PortalsPage.jsx):
  - handlePortalClick() is triggered
  - Checks localStorage for 'accessToken'
  - No token found → Calls onPortalClick() callback
  - App.jsx sets currentPage to 'login'
  - Login component is rendered with portalInfo
```

```
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 2: User Sees Login Page                                        │
└─────────────────────────────────────────────────────────────────────┘

Frontend (Login.jsx):
  - Login form displayed
  - Shows portal-specific styling (Admissions CRM color scheme)
  - User enters credentials:
    * Username/Email: user@example.com
    * Password: password123
```

```
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 3: User Submits Login Form                                     │
└─────────────────────────────────────────────────────────────────────┘

Frontend (Login.jsx - handleSubmit):
  1. Validates form (username & password required)
  2. Sets isLoading = true
  3. Calls: authAPI.login(username, password)

API Call:
  POST http://localhost:3000/auth/login
  Headers: { "Content-Type": "application/json" }
  Body: {
    "username": "user@example.com",
    "password": "password123"
  }
```

```
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 4: Backend Validates Credentials                               │
└─────────────────────────────────────────────────────────────────────┘

Backend (auth.controller.js → auth.service.js):

  1. Receives login request
  2. Validates input (username & password present)
  3. Calls validateCredentials(username, password)

  validateCredentials() checks BOTH databases:
  
  a) First checks student_database:
     - findUserByUsername(username)
     - Query: SELECT * FROM users WHERE username = ?
     - If found → uses student_database user
  
  b) If not found, checks admissions_db:
     - findAdmissionsUserByEmail(username)
     - Query: SELECT * FROM users WHERE email = ? AND is_active = 1
     - If found → uses admissions_db user
  
  4. Password Verification:
     - bcrypt.compare(password, user.password)
     - Returns true/false
  
  5. Get User Portals:
     - student_database: getUserPortals(userId)
     - admissions_db: Returns ['admissions-crm'] automatically
  
  6. Normalize User Object:
     - Maps role_name → role
     - Maps email/name → username
     - Adds databaseSource field
  
  7. Generate Tokens:
     - Access Token: JWT with userId, username, role, databaseSource
     - Refresh Token: JWT with userId, username
     - Expiry: 1h (access), 7d (refresh)

Response:
  {
    "success": true,
    "message": "Login successful",
    "data": {
      "user": {
        "id": "123",
        "username": "user@example.com",
        "email": "user@example.com",
        "role": "admin",
        "portals": ["admissions-crm"],
        "databaseSource": "admissions_db"
      },
      "tokens": {
        "accessToken": "eyJhbGc...",
        "refreshToken": "eyJhbGc..."
      }
    }
  }
```

```
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 5: Frontend Stores Tokens & Generates SSO Token               │
└─────────────────────────────────────────────────────────────────────┘

Frontend (Login.jsx):
  1. Receives login response
  2. Stores tokens in localStorage:
     - localStorage.setItem('accessToken', accessToken)
     - localStorage.setItem('refreshToken', refreshToken)
     - localStorage.setItem('user', JSON.stringify(user))
  
  3. Generates SSO Token for Portal:
     - Calls: authAPI.generatePortalToken(portalInfo.portalId)
     - Headers: { "Authorization": "Bearer <accessToken>" }
     - Body: { "portalId": "admissions-crm" }

Backend (auth.controller.js):
  1. Validates access token (authenticateToken middleware)
  2. Extracts userId, role, databaseSource from token
  3. Calls: generatePortalToken(userId, portalId, role, databaseSource)
  
  generatePortalToken():
    - Checks user has access to portal
    - Generates SSO JWT token (short-lived, 15 minutes)
    - Encrypts token using AES-256-GCM
    - Returns encrypted token

Response:
  {
    "success": true,
    "message": "Token generated successfully",
    "data": {
      "encryptedToken": "base64-encrypted-string",
      "portalId": "admissions-crm",
      "expiresIn": "15m"
    }
  }
```

```
┌─────────────────────────────────────────────────────────────────────┐
│ STEP 6: Redirect to Portal with Token                               │
└─────────────────────────────────────────────────────────────────────┘

Frontend (Login.jsx):
  1. Receives encrypted SSO token
  2. Constructs portal URL with token:
     const portalUrl = new URL(portalInfo.url);
     portalUrl.searchParams.set('token', encryptedToken);
     // Result: http://localhost:3001/login?token=<encrypted-token>
  
  3. Redirects user:
     window.location.href = portalUrl.toString();
     // Full redirect to: http://localhost:3001/login?token=...

User is now redirected to Admissions App with encrypted SSO token
```

---

### Scenario 2: User Already Authenticated

```
┌─────────────────────────────────────────────────────────────────────┐
│ User Clicks Portal (Already Logged In)                              │
└─────────────────────────────────────────────────────────────────────┘

Frontend (PortalsPage.jsx - handlePortalClick):
  1. Checks localStorage for 'accessToken'
  2. Token exists → Skips login page
  3. Directly calls: authAPI.generatePortalToken(portalId)
  4. Receives encrypted SSO token
  5. Redirects: window.location.href = portalUrl + '?token=' + token

No login page shown - seamless redirect!
```

---

## Token Flow & Redirection

### Token Types

1. **Access Token** (JWT)
   - Stored in: `localStorage.getItem('accessToken')`
   - Used for: Authenticating API requests to CRM backend
   - Expiry: 1 hour
   - Payload: `{ userId, username, role, databaseSource }`

2. **Refresh Token** (JWT)
   - Stored in: `localStorage.getItem('refreshToken')`
   - Used for: Refreshing access token (future implementation)
   - Expiry: 7 days

3. **SSO Token** (Encrypted JWT)
   - Generated on-demand when accessing portal
   - Encrypted with AES-256-GCM
   - Passed as URL query parameter: `?token=<encrypted-token>`
   - Expiry: 15 minutes
   - Payload: `{ userId, portalId, role, issuer: 'crm-auth-gateway' }`

### Redirection Flow

```
CRM Frontend                    CRM Backend                    Admissions App
     │                               │                               │
     │ 1. Click Portal               │                               │
     ├───────────────────────────────►│                               │
     │                               │                               │
     │ 2. Check Token                │                               │
     │    (if not exists)             │                               │
     │                               │                               │
     │ 3. Show Login                  │                               │
     │    (Login.jsx)                 │                               │
     │                               │                               │
     │ 4. POST /auth/login            │                               │
     ├───────────────────────────────►│                               │
     │                               │ 5. Validate Credentials       │
     │                               │    (Check both databases)     │
     │                               │                               │
     │ 6. Return Access Token         │                               │
     │◄───────────────────────────────┤                               │
     │                               │                               │
     │ 7. Store Token                 │                               │
     │    (localStorage)              │                               │
     │                               │                               │
     │ 8. POST /auth/generate-token   │                               │
     │    (with accessToken header)   │                               │
     ├───────────────────────────────►│                               │
     │                               │ 9. Generate SSO Token         │
     │                               │    Encrypt token              │
     │                               │                               │
     │ 10. Return Encrypted Token     │                               │
     │◄───────────────────────────────┤                               │
     │                               │                               │
     │ 11. Redirect with Token        │                               │
     │     http://localhost:3001/     │                               │
     │     login?token=...            │                               │
     ├───────────────────────────────────────────────────────────────►│
     │                               │                               │
     │                               │                               │ 12. Receive Token
     │                               │                               │    (from URL params)
     │                               │                               │
     │                               │                               │ 13. POST /auth/verify-token
     │                               │                               ├───────────────────────────►│
     │                               │                               │                               │
     │                               │                               │ 14. Decrypt & Verify Token
     │                               │                               │◄───────────────────────────┤
     │                               │                               │                               │
     │                               │                               │ 15. Create Local Session
     │                               │                               │    Redirect to Dashboard
     │                               │                               │                               │
```

---

## Admissions Application Integration

### Required Changes in Admissions App

The admissions application (`http://localhost:3001`) needs to implement SSO token handling on its login page.

### Step 1: Detect Token in URL

**File**: `app/auth/login/page.tsx` (or your login page)

```typescript
'use client';

import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';

const CRM_BACKEND_URL = 'http://localhost:3000';

export default function LoginPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [isVerifying, setIsVerifying] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    // Check for SSO token in URL
    const token = searchParams.get('token');
    
    if (token) {
      // Token found - verify and login
      handleSSOLogin(token);
    }
  }, [searchParams]);

  async function handleSSOLogin(encryptedToken: string) {
    setIsVerifying(true);
    setError(null);

    try {
      // Step 1: Verify token with CRM backend
      const verifyResponse = await fetch(`${CRM_BACKEND_URL}/auth/verify-token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ encryptedToken })
      });

      const verifyResult = await verifyResponse.json();

      if (!verifyResult.success || !verifyResult.valid) {
        throw new Error(verifyResult.message || 'Token validation failed');
      }

      const { userId, portalId, role, expiresAt } = verifyResult.data;

      // Step 2: Check token expiry
      const expiryTime = new Date(expiresAt).getTime();
      if (Date.now() >= expiryTime) {
        throw new Error('Token has expired');
      }

      // Step 3: Create local session in admissions app
      // Option A: Create session via your backend
      const sessionResponse = await fetch('/api/auth/sso-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId,
          role,
          portalId,
          ssoToken: encryptedToken
        })
      });

      if (!sessionResponse.ok) {
        throw new Error('Failed to create local session');
      }

      const sessionData = await sessionResponse.json();

      // Step 4: Store session (adjust based on your auth system)
      // If using cookies (like your current system):
      Cookies.set('token', sessionData.token, { expires: 7 });
      Cookies.set('user', JSON.stringify({
        id: userId,
        role: role,
        // Add other user fields as needed
      }), { expires: 7 });

      // Step 5: Redirect to dashboard
      router.push('/dashboard'); // or your dashboard route

    } catch (err: any) {
      console.error('SSO login error:', err);
      setError(err.message);
      // Remove token from URL
      router.replace('/auth/login');
    } finally {
      setIsVerifying(false);
    }
  }

  // Show loading state while verifying
  if (isVerifying) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Verifying authentication...</p>
        </div>
      </div>
    );
  }

  // Show error if verification failed
  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <p className="text-red-600 mb-4">{error}</p>
          <a 
            href="http://localhost:5173"
            className="text-blue-600 hover:underline"
          >
            Return to CRM Portal
          </a>
        </div>
      </div>
    );
  }

  // Normal login form (if no token)
  return (
    <div>
      {/* Your existing login form */}
    </div>
  );
}
```

### Step 2: Create SSO Session Endpoint (Backend)

**File**: `backend-admission/src/routes/auth.routes.js` (or your routes file)

```javascript
const express = require('express');
const router = express.Router();

// Add this new route
router.post('/sso-session', async (req, res) => {
  try {
    const { userId, role, portalId, ssoToken } = req.body;

    // Optional: Verify the SSO token again for extra security
    const verifyResponse = await fetch('http://localhost:3000/auth/verify-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ encryptedToken: ssoToken })
    });

    const verifyResult = await verifyResponse.json();

    if (!verifyResult.success) {
      return res.status(401).json({ 
        success: false,
        error: 'Invalid SSO token' 
      });
    }

    // Find user in admissions database
    const pool = getPool();
    const [users] = await pool.execute(
      'SELECT id, name, email, role_name, is_manager, designation, permissions, is_active FROM users WHERE id = ? AND is_active = 1',
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({ 
        success: false,
        error: 'User not found in admissions database' 
      });
    }

    const userData = users[0];

    // Format user object (match your existing format)
    const user = {
      id: userData.id,
      name: userData.name,
      email: userData.email,
      roleName: userData.role_name,
      isManager: userData.is_manager === 1,
      designation: userData.designation,
      permissions: userData.permissions ? JSON.parse(userData.permissions) : {},
      isActive: userData.is_active === 1,
    };

    // Generate local session token (using your existing token generation)
    const token = generateToken(user.id);

    res.json({
      success: true,
      token: token,
      user: user
    });
  } catch (error) {
    console.error('SSO session creation error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to create session' 
    });
  }
});

module.exports = router;
```

### Step 3: Update API Configuration

**File**: `frontend-admission/lib/api.ts` (or your API config)

Add CRM backend URL constant:

```typescript
export const CRM_BACKEND_URL = process.env.NEXT_PUBLIC_CRM_BACKEND_URL || 'http://localhost:3000';
```

### Step 4: Handle Token in Existing Login Flow

Modify your existing login page to check for token **before** showing the login form:

```typescript
// At the top of your login component
useEffect(() => {
  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get('token');
  
  if (token) {
    // Handle SSO login (use code from Step 1)
    handleSSOLogin(token);
  } else {
    // Show normal login form
    setIsReady(true);
  }
}, []);
```

---

## Code Examples

### Complete SSO Integration Example

**Full Login Page with SSO Support:**

```typescript
'use client';

import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Cookies from 'js-cookie';

const CRM_BACKEND_URL = 'http://localhost:3000';
const CRM_FRONTEND_URL = 'http://localhost:5173';

export default function LoginPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [isVerifying, setIsVerifying] = useState(false);
  const [error, setError] = useState(null);
  const [showLoginForm, setShowLoginForm] = useState(false);

  useEffect(() => {
    const token = searchParams.get('token');
    
    if (token) {
      handleSSOLogin(token);
    } else {
      setShowLoginForm(true);
    }
  }, [searchParams]);

  async function handleSSOLogin(encryptedToken: string) {
    setIsVerifying(true);
    setError(null);

    try {
      // Verify token with CRM backend
      const verifyResponse = await fetch(`${CRM_BACKEND_URL}/auth/verify-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ encryptedToken })
      });

      const verifyResult = await verifyResponse.json();

      if (!verifyResult.success || !verifyResult.valid) {
        throw new Error(verifyResult.message || 'Token validation failed');
      }

      const { userId, role, expiresAt } = verifyResult.data;

      // Check expiry
      if (Date.now() >= new Date(expiresAt).getTime()) {
        throw new Error('Token has expired');
      }

      // Create local session
      const sessionResponse = await fetch('/api/auth/sso-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, role, ssoToken: encryptedToken })
      });

      if (!sessionResponse.ok) {
        throw new Error('Failed to create session');
      }

      const { token, user } = await sessionResponse.json();

      // Store session
      Cookies.set('token', token, { expires: 7 });
      Cookies.set('user', JSON.stringify(user), { expires: 7 });

      // Redirect based on role
      if (user.roleName === 'Super Admin' || user.roleName === 'Sub Super Admin') {
        router.push('/superadmin/dashboard');
      } else if (user.isManager) {
        router.push('/manager/dashboard');
      } else {
        router.push('/user/dashboard');
      }

    } catch (err: any) {
      console.error('SSO login error:', err);
      setError(err.message);
      setShowLoginForm(true);
      // Remove token from URL
      router.replace('/auth/login');
    } finally {
      setIsVerifying(false);
    }
  }

  if (isVerifying) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Verifying authentication...</p>
        </div>
      </div>
    );
  }

  if (error && !showLoginForm) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <p className="text-red-600 mb-4">{error}</p>
          <a href={CRM_FRONTEND_URL} className="text-blue-600 hover:underline">
            Return to CRM Portal
          </a>
        </div>
      </div>
    );
  }

  // Your existing login form
  return (
    <div>
      {/* Your existing login form code */}
    </div>
  );
}
```

---

## Testing the Flow

### Test Scenario 1: New User Login

1. **Start all services:**
   ```bash
   # Terminal 1: CRM Backend
   cd crm-backend
   npm run dev
   
   # Terminal 2: CRM Frontend
   cd crm-frontend
   npm run dev
   
   # Terminal 3: Admissions App
   cd admissions-app
   npm run dev
   ```

2. **Test Flow:**
   - Open `http://localhost:5173`
   - Navigate to Portals page
   - Click "Admissions CRM"
   - Should redirect to login page
   - Enter credentials (from admissions_db)
   - Should redirect to `http://localhost:3001/login?token=...`
   - Admissions app should verify token and log user in

### Test Scenario 2: Already Authenticated

1. **Login once:**
   - Complete login flow from Scenario 1
   - User is now logged into CRM

2. **Click portal again:**
   - Navigate to Portals page
   - Click "Admissions CRM"
   - Should **skip login page** and redirect directly with token

### Test Scenario 3: Token Verification

**Using cURL:**

```bash
# First, get an encrypted token (from browser network tab or generate one)

# Verify token
curl -X POST http://localhost:3000/auth/verify-token \
  -H "Content-Type: application/json" \
  -d '{"encryptedToken":"your-encrypted-token-here"}'
```

---

## Summary of Changes Needed in Admissions App

### ✅ Required Changes

1. **Login Page (`app/auth/login/page.tsx`):**
   - ✅ Check for `token` query parameter
   - ✅ Call CRM backend `/auth/verify-token`
   - ✅ Create local session after verification
   - ✅ Redirect to dashboard

2. **Backend Route (`routes/auth.routes.js`):**
   - ✅ Add `POST /api/auth/sso-session` endpoint
   - ✅ Verify SSO token with CRM backend
   - ✅ Find user in admissions database
   - ✅ Generate local session token
   - ✅ Return token and user data

3. **Environment Variables:**
   ```env
   NEXT_PUBLIC_CRM_BACKEND_URL=http://localhost:3000
   ```

### 🔄 Optional Enhancements

1. **Error Handling:**
   - Show user-friendly error messages
   - Redirect back to CRM on failure
   - Log errors for debugging

2. **Loading States:**
   - Show loading spinner during token verification
   - Prevent form submission during verification

3. **Token Cleanup:**
   - Remove token from URL after processing
   - Clear token from URL on error

---

## Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    COMPLETE SSO FLOW                            │
└─────────────────────────────────────────────────────────────────┘

1. USER CLICKS PORTAL
   └─> CRM Frontend (PortalsPage)
   └─> Check localStorage for accessToken
   │
   ├─> Token EXISTS → Generate SSO Token → Redirect
   │
   └─> Token NOT EXISTS → Show Login Page

2. USER LOGS IN
   └─> Login.jsx submits credentials
   └─> POST /auth/login
   └─> Backend checks BOTH databases:
       ├─> student_database (by username)
       └─> admissions_db (by email)
   └─> Returns accessToken + user data
   └─> Frontend stores in localStorage

3. GENERATE SSO TOKEN
   └─> POST /auth/generate-token
   └─> Backend generates encrypted SSO token
   └─> Returns encryptedToken

4. REDIRECT TO PORTAL
   └─> window.location.href = portalUrl + '?token=' + encryptedToken
   └─> User lands on: http://localhost:3001/login?token=...

5. PORTAL VERIFIES TOKEN
   └─> Admissions app detects token in URL
   └─> POST /auth/verify-token (to CRM backend)
   └─> CRM decrypts and verifies token
   └─> Returns user data (userId, role, etc.)

6. CREATE LOCAL SESSION
   └─> POST /api/auth/sso-session (to admissions backend)
   └─> Admissions backend finds user in database
   └─> Generates local session token
   └─> Returns token + user

7. USER LOGGED IN
   └─> Store session in cookies
   └─> Redirect to dashboard
   └─> User is now authenticated in admissions app
```

---

## Security Considerations

1. **Token Expiry**: SSO tokens expire in 15 minutes
2. **HTTPS**: Use HTTPS in production
3. **Token Encryption**: Tokens are encrypted with AES-256-GCM
4. **Database Source Tracking**: System tracks which database user came from
5. **Portal Access Control**: Users only get access to authorized portals

---

## Troubleshooting

### Token Not Received
- Check URL parameters: `new URLSearchParams(window.location.search).get('token')`
- Verify redirect includes token parameter

### Token Verification Fails
- Check CRM backend is running on port 3000
- Verify token hasn't expired (15 minutes)
- Check network connectivity

### Session Not Created
- Verify `/api/auth/sso-session` endpoint exists
- Check user exists in admissions database
- Verify token format is correct

---

## Next Steps

1. Implement SSO token handling in admissions app login page
2. Create SSO session endpoint in admissions backend
3. Test complete flow end-to-end
4. Update production URLs when deploying
