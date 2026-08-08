# Seed data

`prototype-deck.json` is the prototype's deck — 20 distinct cards, 103 copies —
in a form the seeder can import into a room.

## Before it can be used: name the cards

Every card's `name` is currently empty. Names are required, because they are
what appears in:

- the room activity log — *"Aisha used Cashflow Boost (Rare)"*
- the educator's card-use notifications and their "perks I owe" list
- the student's inventory and draw reveal
- CSV exports

Positional refs (`C1`…`L3`) map to the prototype's image arrays in source order,
so `C1` is the first Common image in `prototype/lootbox-prototype.html`. Open the
image, read the power-up off the art, fill in `name`.

`effect_text` stays optional by design — the art states the effect and educators
know it from the name. Use it only where a clarifying note helps.

Names are not frozen at import: they are editable at any time from the educator
card page. Renaming affects future display only; past activity events keep the
name they recorded, so history never silently changes.

## Image import

`source_url` holds the original Google Drive link. It is import provenance, not
a runtime source — Drive throttles, blocks hotlinking unpredictably, and serves
no cache headers you control. The prototype already ships an "Image Blocked by
Drive" fallback, which is that failure mode in production.

The importer downloads each file once, validates it, generates the three
derivatives, uploads them to object storage and writes `image_key` on the card.
After that, `source_url` is never read again.

Each Drive URL needs to be readable by the importer at import time — either
publicly shared, or downloaded by hand into `seed/images/<ref>.png` and imported
from disk, which is the more reliable route for a one-off.
