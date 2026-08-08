export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Phase 0 ships the console transport only. Invitation links are printed to the
 * server log, which is enough to run the whole invite flow locally and in CI.
 *
 * Wiring a real SMTP transport is a phase-5 task; it goes here, behind the same
 * interface, so no caller changes. Deliberately not using a third-party email
 * SDK yet — every one of them wants to be initialised at module load and that
 * makes tests need network stubs.
 */
export interface Mailer {
  send(email: OutboundEmail): Promise<void>;
}

const consoleMailer: Mailer = {
  async send(email) {
    console.info(
      ['', '─── email ───────────────────────────────',
        `to:      ${email.to}`,
        `subject: ${email.subject}`,
        '',
        email.text,
        '─────────────────────────────────────────', ''].join('\n'),
    );
  },
};

/** Captures mail in memory so tests can assert on it without a transport. */
export class MemoryMailer implements Mailer {
  readonly sent: OutboundEmail[] = [];
  async send(email: OutboundEmail): Promise<void> {
    this.sent.push(email);
  }
}

let mailer: Mailer = consoleMailer;

export const getMailer = (): Mailer => mailer;

export const setMailer = (next: Mailer): void => {
  mailer = next;
};

export const appUrl = (): string =>
  (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
