import { z } from 'zod';

export const loginSchema = z.object({
  identifier: z.string().min(1, 'Enter your email or login ID.').max(320),
  password: z.string().min(1, 'Enter your password.').max(200),
});

export const changePasswordSchema = z.object({
  current_password: z.string().min(1).max(200),
  new_password: z.string().min(1).max(200),
});

export const acceptInvitationSchema = z.object({
  display_name: z.string().trim().min(1, 'Enter your name.').max(120),
  password: z.string().min(1).max(200),
});

export const createInvitationSchema = z.object({
  email: z.string().trim().email('Enter a valid email address.').max(320),
  role: z.enum(['educator', 'school_admin']).default('educator'),
});

export const createStudentSchema = z.object({
  display_name: z.string().trim().min(1, 'Enter the student name.').max(120),
  login_id: z
    .string()
    .trim()
    .min(3)
    .max(64)
    .regex(/^[a-zA-Z0-9._-]+$/, 'Login IDs may use letters, numbers, dots, dashes and underscores.')
    .optional(),
});
