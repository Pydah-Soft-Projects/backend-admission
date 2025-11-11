# Lead Management Tracker - Backend API

## Setup Instructions

### 1. Install Dependencies
```bash
npm install
```

### 2. Environment Variables
Create a `.env` file in the root directory:
```env
PORT=5000
NODE_ENV=development
MONGODB_URI=mongodb://localhost:27017/lead-tracker
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production
JWT_EXPIRE=7d
CORS_ORIGIN=http://localhost:3000
```

### 3. Start MongoDB
Make sure MongoDB is running on your system. If using MongoDB Atlas, update the `MONGODB_URI` in `.env`.

### 4. Seed Super Admin User
```bash
node src/scripts/seedSuperAdmin.js
```

This will create:
- Super Admin role
- Super Admin user (email: `admin@leadtracker.com`, password: `Admin@123`)

**⚠️ Important: Change the password after first login!**

### 5. Run the Server

Development mode (with auto-reload):
```bash
npm run dev
```

Production mode:
```bash
npm start
```

Server will run on `http://localhost:5000`

## API Endpoints

### Authentication
- `POST /api/auth/login` - Login user
- `GET /api/auth/me` - Get current user (Protected)
- `POST /api/auth/logout` - Logout user (Protected)

### Users (Super Admin Only)
- `GET /api/users` - Get all users
- `GET /api/users/:id` - Get single user
- `POST /api/users` - Create new user
- `PUT /api/users/:id` - Update user
- `DELETE /api/users/:id` - Delete user

### Roles (Super Admin Only)
- `GET /api/roles` - Get all roles
- `GET /api/roles/:id` - Get single role
- `POST /api/roles` - Create new role
- `PUT /api/roles/:id` - Update role
- `DELETE /api/roles/:id` - Delete role

## Project Structure

```
backend/
├── src/
│   ├── config/
│   │   └── database.js          # MongoDB connection
│   ├── controllers/
│   │   ├── auth.controller.js   # Authentication logic
│   │   ├── user.controller.js   # User CRUD logic
│   │   └── role.controller.js   # Role CRUD logic
│   ├── middleware/
│   │   ├── auth.middleware.js   # JWT & RBAC middleware
│   │   └── error.middleware.js   # Error handling
│   ├── models/
│   │   ├── User.model.js        # User schema
│   │   └── Role.model.js         # Role schema
│   ├── routes/
│   │   ├── auth.routes.js        # Auth routes
│   │   ├── user.routes.js        # User routes
│   │   └── role.routes.js        # Role routes
│   ├── scripts/
│   │   └── seedSuperAdmin.js     # Seed script
│   ├── utils/
│   │   ├── generateToken.js      # JWT token generation
│   │   └── response.util.js      # Response helpers
│   └── server.js                 # Main server file
├── .env.example                  # Environment variables template
└── package.json
```

## Features

- ✅ JWT-based authentication
- ✅ Role-based access control (RBAC)
- ✅ Password hashing with bcrypt
- ✅ Input validation
- ✅ Error handling
- ✅ MongoDB with Mongoose
- ✅ CORS enabled
- ✅ RESTful API design

## Security Features

- Password hashing with bcrypt
- JWT token authentication
- Role-based access control
- Input validation
- Error handling
- Protected routes

