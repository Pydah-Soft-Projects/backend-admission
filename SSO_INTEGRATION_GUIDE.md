# SSO Integration Guide for External Applications

This guide explains how external applications (portals) should integrate with the CRM Authentication Gateway to accept SSO tokens and automatically log in users.

## Overview

The CRM acts as a central authentication gateway. When a user clicks on a portal:
1. User authenticates with CRM (if not already logged in)
2. CRM generates an encrypted SSO token
3. User is redirected to the portal with the token as a query parameter
4. Portal validates the token and creates a local session

## Token Flow

```
User → CRM Login → Generate SSO Token → Redirect to Portal with Token
                                                      ↓
Portal receives token → Verify with CRM → Create Local Session
```

## Integration Steps

### 1. Receive Token from URL

When users are redirected from CRM, they arrive at your portal with a `token` query parameter:

```
https://your-portal.com/login?token=<encrypted_token>
```

**Example Implementation:**

```javascript
// React/Next.js Example
import { useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

function LoginPage() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  useEffect(() => {
    if (token) {
      handleSSOLogin(token);
    }
  }, [token]);

  // ... rest of your login page
}
```

```javascript
// Vanilla JavaScript Example
const urlParams = new URLSearchParams(window.location.search);
const token = urlParams.get('token');

if (token) {
  handleSSOLogin(token);
}
```

### 2. Verify Token with CRM Backend

Send the encrypted token to the CRM backend for verification:

**Endpoint:** `POST https://your-crm-backend.com/auth/verify-token`

**Request:**
```json
{
  "encryptedToken": "base64-encrypted-token-string"
}
```

**Response (Success):**
```json
{
  "success": true,
  "valid": true,
  "data": {
    "userId": "123",
    "portalId": "student-portal",
    "role": "admin",
    "expiresAt": "2026-01-27T13:00:00.000Z"
  }
}
```

**Response (Invalid/Expired):**
```json
{
  "success": false,
  "valid": false,
  "message": "Invalid or expired token"
}
```

**Example Implementation:**

```javascript
async function handleSSOLogin(encryptedToken) {
  try {
    const response = await fetch('https://your-crm-backend.com/auth/verify-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        encryptedToken: encryptedToken
      })
    });

    const result = await response.json();

    if (result.success && result.valid) {
      // Token is valid, create local session
      const userData = result.data;
      
      // Store user session (adjust based on your auth system)
      localStorage.setItem('user', JSON.stringify({
        id: userData.userId,
        role: userData.role,
        portalId: userData.portalId
      }));

      // Create session token or cookie
      await createLocalSession(userData);

      // Redirect to dashboard/home
      window.location.href = '/dashboard';
    } else {
      // Token invalid, show login form
      console.error('SSO token validation failed:', result.message);
      showLoginForm();
    }
  } catch (error) {
    console.error('SSO verification error:', error);
    // Fallback to normal login
    showLoginForm();
  }
}
```

### 3. Create Local Session

After token verification, create a local session in your application:

```javascript
async function createLocalSession(userData) {
  // Option 1: Create session via your backend
  const response = await fetch('/api/auth/sso-session', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      userId: userData.userId,
      role: userData.role,
      portalId: userData.portalId
    })
  });

  const session = await response.json();
  
  // Store session token
  localStorage.setItem('sessionToken', session.token);
  
  // Or set HTTP-only cookie (recommended)
  document.cookie = `sessionToken=${session.token}; path=/; secure; samesite=strict`;
}
```

### 4. Handle Token Expiry

SSO tokens are short-lived (default: 15 minutes). Handle expiry gracefully:

```javascript
function checkTokenExpiry(expiresAt) {
  const expiryTime = new Date(expiresAt).getTime();
  const currentTime = Date.now();
  
  if (currentTime >= expiryTime) {
    // Token expired, redirect back to CRM or show login
    window.location.href = 'https://crm-frontend.com/portals';
    return false;
  }
  return true;
}
```

### 5. Complete Integration Example

**React/Next.js Full Example:**

```javascript
'use client';

import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';

const SSO_LOGIN_URL = 'https://your-crm-backend.com/auth/verify-token';
const CRM_FRONTEND_URL = 'https://crm-frontend.com';

export default function LoginPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [isVerifying, setIsVerifying] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const token = searchParams.get('token');
    
    if (token) {
      verifyAndLogin(token);
    }
  }, [searchParams]);

  async function verifyAndLogin(encryptedToken) {
    setIsVerifying(true);
    setError(null);

    try {
      // Step 1: Verify token with CRM backend
      const verifyResponse = await fetch(SSO_LOGIN_URL, {
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

      const { userId, role, portalId, expiresAt } = verifyResult.data;

      // Step 2: Check token expiry
      const expiryTime = new Date(expiresAt).getTime();
      if (Date.now() >= expiryTime) {
        throw new Error('Token has expired');
      }

      // Step 3: Create local session via your backend
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

      // Step 4: Store session and redirect
      localStorage.setItem('user', JSON.stringify({
        id: userId,
        role,
        portalId
      }));
      localStorage.setItem('sessionToken', sessionData.token);

      // Redirect to dashboard
      router.push('/dashboard');

    } catch (err) {
      console.error('SSO login error:', err);
      setError(err.message);
      // Remove token from URL
      router.replace('/login');
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

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <p className="text-red-600 mb-4">{error}</p>
          <a 
            href={CRM_FRONTEND_URL}
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

## Backend Integration (Node.js/Express Example)

If your portal has its own backend, create an endpoint to handle SSO session creation:

```javascript
// routes/auth.js
const express = require('express');
const router = express.Router();

router.post('/sso-session', async (req, res) => {
  try {
    const { userId, role, portalId, ssoToken } = req.body;

    // Verify the SSO token again (optional, for extra security)
    const verifyResponse = await fetch('https://your-crm-backend.com/auth/verify-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ encryptedToken: ssoToken })
    });

    const verifyResult = await verifyResponse.json();

    if (!verifyResult.success) {
      return res.status(401).json({ error: 'Invalid SSO token' });
    }

    // Create local session in your database
    const sessionToken = await createUserSession({
      userId,
      role,
      portalId,
      loginMethod: 'sso'
    });

    res.json({
      success: true,
      token: sessionToken,
      user: {
        id: userId,
        role,
        portalId
      }
    });
  } catch (error) {
    console.error('SSO session creation error:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

module.exports = router;
```

## Security Considerations

1. **HTTPS Only**: Always use HTTPS for token transmission
2. **Token Expiry**: Tokens expire in 15 minutes by default
3. **One-Time Use**: Consider implementing token blacklisting after use
4. **Validate on Backend**: Always verify tokens on your backend, not just frontend
5. **Secure Storage**: Store session tokens securely (HTTP-only cookies preferred)

## Testing

1. **Test Token Verification:**
   ```bash
   curl -X POST https://your-crm-backend.com/auth/verify-token \
     -H "Content-Type: application/json" \
     -d '{"encryptedToken":"your-test-token"}'
   ```

2. **Test Full Flow:**
   - Login to CRM
   - Click on portal
   - Verify redirect includes token
   - Check token validation
   - Confirm session creation

## Troubleshooting

### Token Not Received
- Check URL parameters are being parsed correctly
- Verify redirect from CRM includes token parameter

### Token Validation Fails
- Ensure CRM backend URL is correct
- Check token hasn't expired
- Verify network connectivity

### Session Not Created
- Check backend endpoint is working
- Verify user data is being stored correctly
- Check for CORS issues

## Portal-Specific Configuration

Each portal should:
1. Accept `token` query parameter on login page
2. Verify token with CRM backend
3. Create local session
4. Redirect to dashboard/home

## Support

For issues or questions:
- CRM Backend API: `https://your-crm-backend.com`
- CRM Frontend: `https://crm-frontend.com`
- API Documentation: See `README_IMPLEMENTATION.md`





Accept token parameter: Read token from URL query string
Verify token: Call POST /auth/verify-token with encrypted token
Create session: Create local session after successful verification
Redirect user: Redirect to dashboard/home after login
