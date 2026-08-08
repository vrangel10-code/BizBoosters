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

// ─── Phase 1 ────────────────────────────────────────────────────────────────

export const createRoomSchema = z.object({
  name: z.string().trim().min(1, 'Enter a room name.').max(120),
  draw_cost_tokens: z.number().int().positive().max(10_000).optional(),
});

export const updateRoomSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  draw_cost_tokens: z.number().int().positive().max(10_000).optional(),
  trades_enabled: z.boolean().optional(),
  trade_ratio: z.number().int().min(2).max(20).optional(),
  students_see_odds: z.boolean().optional(),
  low_stock_threshold: z.number().int().min(0).max(100_000).optional(),
  expected_version: z.number().int().positive().optional(),
});

export const addStudentsSchema = z.object({
  student_ids: z.array(z.string().uuid()).min(1).max(200),
});

export const importRosterSchema = z.object({
  csv: z.string().min(1, 'Paste at least one student.').max(100_000),
});

export const awardTokensSchema = z.object({
  enrollment_ids: z.array(z.string().uuid()).min(1, 'Select at least one student.').max(500),
  amount: z.number().int().positive('An award must be a positive number of tokens.').max(100_000),
  note: z.string().trim().max(500).optional(),
});

export const adjustTokensSchema = z
  .object({
    enrollment_id: z.string().uuid(),
    delta: z.number().int().optional(),
    target_balance: z.number().int().min(0).optional(),
    // Mandatory by product rule, not just by schema: an adjustment without a
    // reason is unanswerable later.
    note: z.string().trim().min(1, 'A reason is required when adjusting tokens.').max(500),
  })
  .refine((value) => (value.delta === undefined) !== (value.target_balance === undefined), {
    message: 'Provide either a delta or a target balance, not both.',
  });
