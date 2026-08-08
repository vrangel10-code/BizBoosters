# Card art goes here

Drop the 20 card images into this folder and commit them. This is the source
art — the importer reads it, generates the three sizes the app serves, and
records the result against each card in the database.

## Naming

A file matches a card if its name — ignoring case, spaces, punctuation and
extension — equals **either** the card's `name` **or** its `ref` from
`../prototype-deck.json`. All of these work for the same card:

```
DJ for the Day.png
dj-for-the-day.jpg
DJForTheDay.webp
C1.png
```

PNG, JPEG, WebP and AVIF are accepted, up to 5 MB each. Anything that is not a
decodable image is rejected — the importer checks by decoding, not by trusting
the file extension.

## The full list

| ref | card | ref | card |
| --- | --- | --- | --- |
| C1 | DJ for the Day | R1 | Magic Box |
| C2 | Consultant Advice | R2 | Big Gambler |
| C3 | Snack Rush | R3 | Magic Shield |
| C4 | Express Shipping | R4 | Board of Directors |
| C5 | Executioner | R5 | Golden Spy |
| C6 | Time Extension | L1 | Fortune Teller |
| U1 | Open Book Start | L2 | Time Skip |
| U2 | Market Insider | L3 | Big Haul |
| U3 | Hacker | | |
| U4 | Mana Regeneration | | |
| U5 | Invisibility Cloak | | |
| U6 | Profit Sharing | | |

## Then run the importer

**Committing the files is not enough on its own.** The app serves art from
object storage, keyed by `cards.image_key` in the database, so the files have to
be processed once:

```bash
pnpm deck:import --school <school-id>
```

Re-running is safe. Cards that already have art are skipped, so you can add a
few images at a time and re-run after each batch. To replace art that has
already been imported, use the card catalog page in the app.

Aspect ratio: images are cropped to the prototype's 160×220 card shape, centred
on the most detailed part of the picture. Art already at roughly that ratio
crops cleanly; a square or landscape image will lose its edges.
