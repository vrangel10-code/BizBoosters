# Open questions and gaps

Everything here is either (a) a decision only you can make, or (b) something the
brief does not cover that a deployed classroom app will need. Each has a
recommended default so nothing blocks the build.

## A. Mechanics decisions

**Q1. Does "using" a card need educator approval? — DECIDED: no.**
A student spends a card unilaterally; the educator is notified after the fact.
No `use_pending` state, no approval queue, no reject path. The educator's
outstanding-perk tracking is a passive tick-box (`card_use_acknowledgements`)
that gates nothing. *Consequence: the trust model is social, not enforced — the
system records what was spent and when, and the classroom handles the rest.*

**Q2. Does a used card go back into the deck? — DECIDED: yes, immediately.**
The deck is a circulating population of copies, not a depleting consumable.
Total copies are constant unless an educator adds or removes some. This has the
widest blast radius of any decision so far — see
[MECHANICS.md §3.1](MECHANICS.md). The two things it changes that are easy to
miss:
- **"Refill the deck to max" must not exist.** With copies out in hands, a
  refill mints cards from nothing and silently breaks conservation forever. The
  prototype's "Reset Deck" splits into *add copies* and *recall all*.
- **An empty deck now means hoarding, not exhaustion.** The educator UI has to
  show "N of M copies held by students" or the empty state looks like a bug.

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

**Q11. Should held cards expire? (raised by Q2)**
Now that the deck circulates, the only way it runs dry is students hoarding. A
class that collects and never spends starves itself, and the effect compounds at
the rare end — one student sitting on the only Legendary blocks twenty-nine
others indefinitely.
→ *Ship without expiry. Instrument it: put "copies held" on the room dashboard
and watch one term. Expiry is a punitive mechanic and it is much easier to add
once you can see whether hoarding actually happens.*
Options if it does: a soft nudge notification after N days, a per-student hold
cap, or an end-of-week auto-return. A cap is the gentlest — it limits hoarding
without ever taking something away.

**Q12. Can a student use a card they just drew, in the same lesson? (raised by Q2)**
Nothing stops it, and the copy immediately re-enters the deck.
→ *Allow it. If drawing and instantly spending turns out to be a token-laundering
pattern you dislike, a per-room cooldown is a small addition later.*

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

Listed so they are decisions rather than oversights: **educator approval of card
use** (removed by Q1 — if a school ever needs it, it reappears as a
`use_pending` state plus a queue, and nothing else in the model has to change),
held-card expiry (Q11), student-to-student trading,
leaderboards, achievements/badges, card crafting beyond the 3-for-1 upgrade,
parent accounts, LMS/Google Classroom integration, native mobile apps,
multi-language support, and a card-art marketplace.
