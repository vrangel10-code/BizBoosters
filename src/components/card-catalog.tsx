'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiRequestError } from '@/components/api';

interface CatalogCard {
  id: string;
  name: string;
  rarity: string;
  effect_text: string | null;
  image_url: string | null;
  rooms_using: number;
}

const RARITIES = [
  { code: 'C', label: 'Common' },
  { code: 'U', label: 'Uncommon' },
  { code: 'R', label: 'Rare' },
  { code: 'L', label: 'Legendary' },
];

export default function CardCatalog({ cards }: { cards: CatalogCard[] }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [rarity, setRarity] = useState('C');
  const [effect, setEffect] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/cards', {
        method: 'POST',
        body: JSON.stringify({
          name,
          rarity,
          effect_text: effect.trim() || undefined,
        }),
      });
      setName('');
      setEffect('');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not add the card.');
    } finally {
      setBusy(false);
    }
  };

  const upload = async (cardId: string, file: File) => {
    setUploadingId(cardId);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      // No content-type header: the browser sets the multipart boundary.
      const response = await fetch(`/api/v1/cards/${cardId}/image`, {
        method: 'POST',
        body: form,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: { message?: string } }
          | null;
        throw new ApiRequestError('upload_failed', body?.error?.message ?? 'Upload failed.');
      }
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not upload that image.');
    } finally {
      setUploadingId(null);
    }
  };

  const rename = async (cardId: string, current: string) => {
    const next = window.prompt('Card name', current);
    if (!next || next === current) return;
    setError(null);
    try {
      await api(`/cards/${cardId}`, { method: 'PATCH', body: JSON.stringify({ name: next }) });
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'Could not rename the card.');
    }
  };

  return (
    <>
      {error ? (
        <p className="alert error" role="alert">
          {error}
        </p>
      ) : null}

      <form className="panel" onSubmit={create}>
        <h2 className="panel-title">Add a card</h2>

        <label htmlFor="card-name">Power-up name</label>
        <input
          id="card-name"
          required
          placeholder="Cashflow Boost"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <p className="hint">
          This is what appears in the activity log and in student inventories, so make it the name
          on the card.
        </p>

        <label htmlFor="card-rarity">Rarity</label>
        <select id="card-rarity" value={rarity} onChange={(event) => setRarity(event.target.value)}>
          {RARITIES.map((option) => (
            <option key={option.code} value={option.code}>
              {option.label}
            </option>
          ))}
        </select>
        <p className="hint">
          Rarity locks once the card is in a deck — changing it later would shift everyone&apos;s
          odds mid-term.
        </p>

        <label htmlFor="card-effect">What it does (optional)</label>
        <input
          id="card-effect"
          placeholder="Skip one homework"
          value={effect}
          onChange={(event) => setEffect(event.target.value)}
        />

        <button type="submit" disabled={busy || !name.trim()}>
          {busy ? 'Adding…' : 'Add card'}
        </button>
      </form>

      <div className="panel" style={{ marginTop: '1.5rem' }}>
        <h2 className="panel-title">Cards ({cards.length})</h2>
        {cards.length === 0 ? (
          <p className="hint" style={{ margin: 0 }}>
            No cards yet.
          </p>
        ) : (
          <ul className="deck-grid">
            {cards.map((card) => (
              <li key={card.id} className="deck-card">
                <div className={`bb-card card-${card.rarity}`}>
                  {card.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={card.image_url} alt="" loading="lazy" />
                  ) : (
                    <span className="bb-card-initial" aria-hidden="true">
                      {card.name.slice(0, 1)}
                    </span>
                  )}
                </div>
                <p className="deck-card-name">{card.name}</p>
                <p className="deck-card-meta">
                  {card.rooms_using > 0
                    ? `in ${card.rooms_using} deck${card.rooms_using === 1 ? '' : 's'}`
                    : 'not in a deck'}
                </p>
                <div className="card-actions">
                  <button className="link" onClick={() => rename(card.id, card.name)}>
                    Rename
                  </button>
                  <button
                    className="link"
                    disabled={uploadingId === card.id}
                    onClick={() => fileInputs.current[card.id]?.click()}
                  >
                    {uploadingId === card.id ? 'Uploading…' : card.image_url ? 'Replace art' : 'Add art'}
                  </button>
                  <input
                    ref={(element) => {
                      fileInputs.current[card.id] = element;
                    }}
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void upload(card.id, file);
                      event.target.value = '';
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
