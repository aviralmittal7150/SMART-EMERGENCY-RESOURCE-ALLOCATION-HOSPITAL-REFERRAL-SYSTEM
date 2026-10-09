// server/routes/auth.js
// Authentication API — POST /api/v1/auth/login

import express from 'express';
import bcrypt from 'bcryptjs';
import { generateToken } from '../middleware/auth.js';

const router = express.Router();

// Demo credentials — in production these would be stored in SystemUser table (hashed)
const DEMO_USERS = [
  {
    user_id:    'USER-ADM-001',
    username:   'admin',
    password:   'admin123',
    role:       'ADMIN',
    hospital_id: null,
    display_name: 'Command Center Admin'
  },
  {
    user_id:    'USER-HSP-101',
    username:   'apex_desk',
    password:   'hospital123',
    role:       'HOSPITAL_DESK',
    hospital_id: 'H-101',
    display_name: 'Apex City Trauma — Emergency Desk'
  },
  {
    user_id:    'USER-HSP-102',
    username:   'stjude_desk',
    password:   'hospital123',
    role:       'HOSPITAL_DESK',
    hospital_id: 'H-102',
    display_name: 'St. Jude Metro General — Emergency Desk'
  },
  {
    user_id:    'USER-HSP-103',
    username:   'fortis_desk',
    password:   'hospital123',
    role:       'HOSPITAL_DESK',
    hospital_id: 'H-103',
    display_name: 'Fortis Cardiac & Neuro — Emergency Desk'
  },
  {
    user_id:    'USER-HSP-104',
    username:   'memorial_desk',
    password:   'hospital123',
    role:       'HOSPITAL_DESK',
    hospital_id: 'H-104',
    display_name: 'Memorial Community — Emergency Desk'
  },
  {
    user_id:    'USER-HSP-105',
    username:   'maxlife_desk',
    password:   'hospital123',
    role:       'HOSPITAL_DESK',
    hospital_id: 'H-105',
    display_name: 'Max Life Emergency — Emergency Desk'
  },
  {
    user_id:    'USER-EMS-001',
    username:   'UNIT-402',
    password:   'paramedic123',
    role:       'PARAMEDIC',
    hospital_id: null,
    display_name: 'Paramedic Unit 402'
  },
  {
    user_id:    'USER-EMS-002',
    username:   'UNIT-601',
    password:   'paramedic123',
    role:       'PARAMEDIC',
    hospital_id: null,
    display_name: 'Paramedic Unit 601'
  }
];

/**
 * POST /api/v1/auth/login
 * Body: { username, password }
 * Returns: { token, user }
 */
router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const user = DEMO_USERS.find(u => u.username === username && u.password === password);

  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials. Please check username and password.' });
  }

  const tokenPayload = {
    user_id:     user.user_id,
    username:    user.username,
    role:        user.role,
    hospital_id: user.hospital_id,
    display_name: user.display_name
  };

  const token = generateToken(tokenPayload);

  return res.status(200).json({
    success: true,
    token,
    user: {
      user_id:      user.user_id,
      username:     user.username,
      role:         user.role,
      hospital_id:  user.hospital_id,
      display_name: user.display_name
    },
    expires_in: '8h'
  });
});

/**
 * GET /api/v1/auth/me
 * Returns current user profile from JWT
 */
import { authenticate } from '../middleware/auth.js';
router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

export default router;
