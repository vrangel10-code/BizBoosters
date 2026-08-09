/**
 * Bootstraps the first school and its first school_admin.
 *
 * Every other educator account arrives by invitation, and an invitation needs
 * an existing admin to send it — so the first admin has to be created out of
 * band. This script is that path, and it is the only one.
 *
 *   pnpm admin:create --school "Northgate High" --email head@school.edu --name "Sam Okafor"
 *
 * Omit --password and one is generated and printed. Run it against production
 * once, at setup; a deployment without it has no way in.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { PrismaClient } from '@prisma/client';
import { hashPassword, assertPasswordAllowed } from '../src/server/auth/password';
import { generateRandomPassword, normalizeIdentifier } from '../src/server/auth/identifiers';

const prisma = new PrismaClient();

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const schoolName = String(args.school ?? (await prompt('School name: '))).trim();
  const emailRaw = String(args.email ?? (await prompt('Admin email: '))).trim();
  const displayName = String(args.name ?? (await prompt('Admin full name: '))).trim();
  const timezone = String(args.timezone ?? 'UTC').trim();

  if (!schoolName) throw new Error('A school name is required.');
  if (!emailRaw.includes('@')) throw new Error('A valid admin email is required.');
  if (!displayName) throw new Error('An admin name is required.');

  const email = normalizeIdentifier(emailRaw);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new Error(`An account already exists for ${email}.`);
  }

  const generated = typeof args.password !== 'string';
  const password = generated ? generateRandomPassword() + '-admin' : String(args.password);
  assertPasswordAllowed({ password, isStudent: false, forbidden: [email, displayName] });

  const passwordHash = await hashPassword(password);

  const { school, admin } = await prisma.$transaction(async (tx) => {
    const createdSchool = await tx.school.create({
      data: { name: schoolName, timezone },
    });

    const createdAdmin = await tx.user.create({
      data: {
        schoolId: createdSchool.id,
        role: 'school_admin',
        displayName,
        email,
        passwordHash,
        // A generated password is a temporary credential and must be replaced;
        // one the operator chose themselves does not need forcing.
        mustChangePassword: generated,
      },
    });

    await tx.auditLog.create({
      data: {
        action: 'admin.bootstrap_created',
        actorUserId: createdAdmin.id,
        targetUserId: createdAdmin.id,
        payload: { school_id: createdSchool.id, via: 'cli' },
      },
    });

    return { school: createdSchool, admin: createdAdmin };
  });

  const lines = [
    '',
    'School and administrator created.',
    '',
    `  School     ${school.name}  (${school.id})`,
    `  Admin      ${admin.displayName} <${admin.email}>`,
    `  Password   ${generated ? password : '(the one you supplied)'}`,
    '',
  ];
  if (generated) {
    lines.push('  This password is shown once and must be changed at first login.', '');
  }
  lines.push('Sign in, then invite educators from the admin area.', '');
  console.info(lines.join('\n'));
}

main()
  .catch((error: unknown) => {
    console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
