# Privacy Notice — BizBoosters

> **DRAFT — NOT LEGAL ADVICE.**
>
> This is a factually accurate description of what the software actually does,
> written so a lawyer has something concrete to work from. It is **not** a
> reviewed privacy notice and must not be published as one.
>
> A qualified adviser needs to check it against the law where you operate
> before any school uses this with real children. At minimum that means FERPA
> and COPPA in the United States, UK GDPR and the Age Appropriate Design Code
> in the UK, GDPR Article 8 in the EU, and the PDPA in Singapore. Which apply
> depends on where your schools and your servers are, and the answer changes
> what this document has to say.
>
> Placeholders in `[BRACKETS]` need real values.

**Last updated:** [DATE] · **Operator:** [LEGAL ENTITY], [ADDRESS] ·
**Contact:** [PRIVACY@EXAMPLE.COM]

## Who this is for

BizBoosters is used by schools. The school decides which children use it and
what they do with it. In data-protection terms the **school is the controller**
and **[LEGAL ENTITY] is the processor**: we hold data on the school's
instructions and do not decide what it is used for.

Parents and guardians with questions should contact the school first. The
school can obtain, correct or delete their child's data at any time, and we
give it the tools to do so without needing us.

## What we hold about a student

This is the complete list. The software cannot store anything else about a
student because there is nowhere to put it.

| Data | Why |
| --- | --- |
| Display name | So the teacher and the student can tell accounts apart |
| Login ID | To sign in. Assigned by the school; it may be a school student number |
| Password (hashed with Argon2id) | To sign in. The password itself is never stored and cannot be recovered |
| Rooms they belong to | To show the right class |
| Token balance and every change to it | The point of the product, and so a disputed score can be answered |
| Cards held, drawn, used and returned | The point of the product |
| Activity history within a room | So students and teachers can see what happened |
| Sign-in times, and the IP address of a sign-in | Security: detecting and rate-limiting attacks |

**We do not collect:** email addresses for students, dates of birth, home
addresses, phone numbers, photographs, biometrics, location, free-text
profiles, or anything about a student's life outside the room.

**There are no third-party analytics, advertising, or tracking scripts on any
page.** Nothing about a child is shared with anyone for any purpose other than
running the service for their school.

## What we hold about a teacher

Name, email address, hashed password, which rooms they teach, actions they took
(awarding tokens, resetting a password, resetting a deck), sign-in times and
sign-in IP addresses.

Actions taken on a student's account are recorded. This protects the teacher as
much as the student: it is the record of who did what, and when.

## Cookies

One cookie, `bb_session`, holding an opaque session identifier. It is strictly
necessary to keep someone signed in, is `HttpOnly` and `SameSite=Lax`, and is
`Secure` in production. There are no analytics, advertising or preference
cookies, so there is nothing to consent to and no cookie banner.

Sessions expire after **2 hours** for students and **12 hours** for teachers.
Student sessions are deliberately short because classroom devices are shared.

## How long we keep things

| Data | Retention |
| --- | --- |
| Active room data | While the room is in use |
| Archived room data | [18 MONTHS] after archiving, then deleted after a human review |
| Student accounts | Until the school deletes them |
| Expired sessions | Swept 7 days after expiry |
| Security logs (sign-ins, lockouts) | [12 MONTHS] |
| Backups | [30 DAYS] |

Deletion means deletion. When a school erases a student, the rows are removed —
not flagged as hidden. Backups are the exception: a deleted student may persist
in a backup until that backup ages out, which is [30 DAYS].

## Rights

Through the school, at any time, without contacting us:

- **See everything** held about a child — a complete export in one click.
- **Correct** a name or a token balance.
- **Delete** a child entirely, or a whole room.

For anything the school cannot do itself, contact [PRIVACY@EXAMPLE.COM]. We aim
to respond within [30 DAYS].

## Where data lives

Servers in [REGION], hosted by [HOSTING PROVIDER]. Sub-processors:

| Sub-processor | Purpose | Location |
| --- | --- | --- |
| [DATABASE HOST] | Database hosting | [REGION] |
| [OBJECT STORAGE] | Card images | [REGION] |
| [EMAIL PROVIDER] | Teacher invitation and password-reset emails | [REGION] |

Card images are teacher-supplied artwork. No student data is stored with them.

## Security

Passwords hashed with Argon2id. Session tokens stored only as SHA-256 hashes,
so a database leak does not hand out live sessions. Rate limiting and account
lockout on sign-in. TLS in transit. Access to production data restricted to
[WHO], and administrative actions on student accounts are recorded.

We are a small operation and say so plainly: we do not hold SOC 2 or ISO 27001
certification. [ADJUST IF THIS CHANGES.]

## Breaches

If personal data is exposed, we will notify affected schools without undue
delay and within [72 HOURS] of becoming aware, with what happened, what data
was involved, and what we are doing about it. Schools remain responsible for
notifying parents and regulators as their law requires.

## Changes

Material changes will be notified to schools by email at least [30 DAYS] before
they take effect.
