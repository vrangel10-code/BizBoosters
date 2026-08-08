export interface RarityOddsView {
  code: string;
  label: string;
  color_hex: string;
  in_deck: number;
  held: number;
  total: number;
  chance: number;
}

export interface OddsView {
  rarities: RarityOddsView[];
  in_deck: number;
  held: number;
  total: number;
  is_empty: boolean;
  is_low: boolean;
  low_stock_threshold: number;
}

/**
 * The prototype's live drop-rate panel, with one addition: `held`.
 *
 * Because used cards return to the deck, a thin deck means students are
 * hoarding, not that cards were consumed. Without that number an empty deck
 * reads as a bug rather than as a class sitting on its collection.
 */
export default function OddsPanel({ odds, audience }: { odds: OddsView; audience: 'educator' | 'student' }) {
  return (
    <div className="panel">
      <h2 className="panel-title">Live drop rates</h2>

      <div className="odds-list">
        {odds.rarities.map((rarity) => (
          <div key={rarity.code} className="odds-row" style={{ borderLeftColor: rarity.color_hex }}>
            <div>
              <span className="odds-label" style={{ color: rarity.color_hex }}>
                {rarity.label}
              </span>
              <span className="odds-count">
                {rarity.in_deck} in deck
                {rarity.held > 0 ? ` · ${rarity.held} held` : ''}
              </span>
            </div>
            <span className="odds-chance">{(rarity.chance * 100).toFixed(1)}%</span>
          </div>
        ))}
      </div>

      <p className="odds-total">
        {odds.in_deck} / {odds.total} cards in the deck
        {odds.held > 0 ? ` · ${odds.held} held by students` : ''}
      </p>

      {odds.total === 0 ? (
        <p className="hint" style={{ marginBottom: 0 }}>
          {audience === 'educator'
            ? 'No cards in this deck yet. Build one below.'
            : 'Your teacher has not built the deck yet.'}
        </p>
      ) : null}

      {odds.is_empty && odds.total > 0 ? (
        <p className="alert error" style={{ marginTop: '1rem', marginBottom: 0 }} role="alert">
          {audience === 'educator'
            ? `The deck is empty — all ${odds.held} copies are held by students. Add copies, or wait for cards to be used.`
            : 'The deck is empty right now. Cards come back when people use them.'}
        </p>
      ) : null}

      {odds.is_low && !odds.is_empty ? (
        <p className="alert warn" style={{ marginTop: '1rem', marginBottom: 0 }} role="status">
          {audience === 'educator'
            ? `Only ${odds.in_deck} cards left in the deck (${odds.held} are held by students). Add more copies?`
            : `Only ${odds.in_deck} cards left in the deck.`}
        </p>
      ) : null}
    </div>
  );
}
