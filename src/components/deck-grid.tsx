export interface DeckEntryView {
  card_id: string;
  name: string;
  rarity: string;
  image_url: string | null;
  copies_total: number;
  in_deck: number;
  held: number;
}

const RARITY_CLASS: Record<string, string> = {
  C: 'card-C',
  U: 'card-U',
  R: 'card-R',
  L: 'card-L',
};

const RARITY_LABEL: Record<string, string> = {
  C: 'Common',
  U: 'Uncommon',
  R: 'Rare',
  L: 'Legendary',
};

/**
 * The prototype's "View Full Deck List", grouped by rarity. Exhausted cards are
 * greyed rather than hidden — knowing a card exists but is all in hands is the
 * point of the screen.
 */
export default function DeckGrid({ deck }: { deck: DeckEntryView[] }) {
  const groups = ['C', 'U', 'R', 'L']
    .map((rarity) => ({ rarity, cards: deck.filter((entry) => entry.rarity === rarity) }))
    .filter((group) => group.cards.length > 0);

  if (deck.length === 0) {
    return (
      <div className="panel">
        <h2 className="panel-title">Deck list</h2>
        <p className="hint" style={{ margin: 0 }}>
          No cards in this deck yet.
        </p>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2 className="panel-title">Deck list</h2>
      {groups.map((group) => (
        <section key={group.rarity} className="deck-group">
          <h3 className={`deck-group-head rarity-${group.rarity}`}>
            {RARITY_LABEL[group.rarity]}
            <span className="deck-group-count">
              {group.cards.reduce((sum, card) => sum + card.in_deck, 0)} in deck
            </span>
          </h3>
          <ul className="deck-grid">
            {group.cards.map((entry) => (
              <li
                key={entry.card_id}
                className={`deck-card ${entry.in_deck === 0 ? 'exhausted' : ''}`}
              >
                <div className={`bb-card ${RARITY_CLASS[entry.rarity] ?? ''}`}>
                  {entry.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={entry.image_url} alt="" loading="lazy" />
                  ) : (
                    <span className="bb-card-initial" aria-hidden="true">
                      {entry.name.slice(0, 1)}
                    </span>
                  )}
                  <span className={`deck-badge ${entry.in_deck === 0 ? 'out' : ''}`}>
                    {entry.in_deck} left
                  </span>
                </div>
                <p className="deck-card-name">{entry.name}</p>
                <p className="deck-card-meta">
                  {entry.copies_total} total
                  {entry.held > 0 ? ` · ${entry.held} held` : ''}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
