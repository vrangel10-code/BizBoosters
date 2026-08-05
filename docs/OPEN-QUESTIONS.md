# Open questions and gaps

Everything here is either (a) a decision only you can make, or (b) something the
brief does not cover that a deployed classroom app will need. Each has a
recommended default so nothing blocks the build.

## A. Mechanics decisions

**Q1. Does "using" a card need educator approval?**
The brief says a use notifies the educator. If a card is a real perk ("skip one
homework"), a notification alone means the student marks it spent and hopes the
educator honours it.
→ *Default: approval required (`use_requires_approval = true`), with a per-room
switch to turn it into fire-and-forget.*

**Q2. Does a used card go back into the deck?**
→ *Default: no. Used copies are consumed, the deck depletes over the term, and
the educator restocks deliberately. Scarcity is the point.*

**Q3. What is on a card?**
The prototype's cards are bare images with no names. Without a name and effect
text, the activity log reads "student used a card" and inventory is an
unlabelled gallery.
→ *Cards need `name`, `description`, `effect_text`. Non-negotiable if you want a
usable log.*

**Q4. Keep the 3-for-1 trade?**
It is a good mechanic but it is a guaranteed path to a Legendary (27 Commons)
that pure drawing never gives.
→ *Keep it, per-room toggle, configurable ratio, default on.*

**Q5. Do tokens carry between rooms?**
→ *No. Balances are per enrollment. If a student changes class, an educator can
move tokens with an explicit adjustment pair.*

**Q6. What happens at term end?**
Archive, wipe, or roll over? Somebody's inventory has to have a defined fate.
→ *Archive the room read-only; clone the deck config into next term's room;
inventories stay attached to the archived room until the retention window
expires.*

**Q7. Can educators grant a card directly, without a draw?**
Not in the brief, but every teacher will want it within a week ("you earned
this one").
→ *Yes — `acquired_via = 'educator_grant'`, drawn from the room's remaining
stock so conservation holds.*

**Q8. Student-to-student trading?**
Not in the brief. It is the most-requested feature in every card game ever
built, and it is also where classroom coercion happens.
→ *Not in v1. If added later, make it educator-approved and per-room optional.*

**Q9. Should students see each other's activity?**
→ *No by default. Room-wide events yes, other students' draws no. Behind a room
setting if you want a social feed.*

**Q10. Duplicate-heavy draws.**
With 60 of 103 copies Common, a student's first several draws will be mostly
Commons, which reads as bad luck to a 13-year-old. Consider a per-room pity rule
("every 5th draw excludes Common") or simply lean on trades to absorb
duplicates.
→ *Default: no pity rule; make the live odds panel prominent so the maths is
visible. Revisit after one term of real use.*

## B. Things the brief does not mention

1. **Roster onboarding at scale.** Creating 30 students by hand is a
   non-starter. You need CSV import, auto-generated login IDs, generated
   per-student default passwords, and a printable credential slip. This is the
   single biggest determinant of whether a teacher adopts the tool.
2. **Password resets.** Students forget passwords constantly. Educator-initiated
   reset must be two clicks, and it must revoke existing sessions.
3. **Educator accounts themselves.** Who creates them? Self-signup with email
   verification, invite-only by a school admin, or manual? *Recommend:
   invite-only for v1 — it keeps a public app from filling with strangers.*
4. **Co-teachers and cover staff.** `room_educators` exists for this. A single
   `owner_id` on the room will hurt within a term.
5. **A school layer.** Even for one teacher, having `schools` from day one is
   what makes the card catalog shareable and the second customer possible.
6. **Card image hosting.** Google Drive hotlinks throttle and break — the
   prototype already ships an "Image Blocked by Drive" fallback, which tells you
   it happens in practice. Needs real object storage + CDN + upload UI.
7. **Anti-cheat.** All state and all randomness on the server. Also: no draw
   result in any response the client can request before committing, rate limits
   on draw, and audit fields (`roll_value`, `pool_snapshot`) so disputes are
   answerable.
8. **Idempotency.** Without it, a lost response on a flaky school wifi costs a
   student 20 tokens and produces a support ticket you cannot resolve.
9. **Copy conservation checks.** A nightly job asserting
   `deck + held + used = total`. Your only early warning for a transaction bug.
10. **Offline / poor connectivity.** School wifi is bad. Every mutation needs a
    clear pending state, a retry that is safe (see 8), and a legible error.
11. **Mobile and Chromebook.** The prototype is a three-column desktop layout.
    Students will be on phones and 1366×768 Chromebooks. Design mobile-first;
    the draw screen especially.
12. **Accessibility.** Rarity is currently communicated by colour alone. Add
    text labels and shape/badge cues; check contrast; make the draw flow
    keyboard-operable and the reveal screen-reader-announced. Offer a
    reduced-motion mode — the shake animation is a vestibular trigger and
    `prefers-reduced-motion` is a one-line fix.
13. **Notification volume.** A class of 30 drawing during one lesson floods the
    educator. Group notifications by type, collapse "6 cards drawn in the last
    10 minutes", and let educators mute categories per room.
14. **Empty and edge states.** Empty deck, zero tokens, no rooms assigned, room
    archived, student removed mid-session. Each needs a designed screen, not a
    crash.
15. **Child privacy and data handling.** FERPA/COPPA/GDPR-K/PDPA depending on
    where you deploy. Constrains what you collect and forces retention, export,
    and deletion features. See ARCHITECTURE.md §8.
16. **Backups and a tested restore.** Losing a term of student inventories is
    unrecoverable in a way that matters to real children.
17. **Reporting.** Educators will want per-student token totals and card counts
    exported to CSV for their own records.
18. **Time zones.** Log timestamps must render in the school's local time or the
    history is confusing.
19. **Terms of service, privacy policy, support contact.** Required before a
    school will let you near their students.
20. **Seed data + demo mode.** An educator evaluating the tool needs a room with
    the prototype's 103-card deck already in it.

## C. Deliberately out of scope for v1

Listed so they are decisions rather than oversights: student-to-student trading,
leaderboards, achievements/badges, card crafting beyond the 3-for-1 upgrade,
parent accounts, LMS/Google Classroom integration, native mobile apps,
multi-language support, and a card-art marketplace.
