'use client';

import { useId, useState } from 'react';

/**
 * A password box with a show/hide toggle.
 *
 * Not decoration: the people typing these are children on shared Chromebooks
 * and phone keyboards, entering a password a teacher read out or printed on a
 * slip. Without a way to see what they typed, a mistyped character is
 * indistinguishable from a wrong password, and the account locks after ten
 * tries.
 *
 * The toggle is a real `<button>` inside the field's own label association, so
 * it is reachable by keyboard and announced. `aria-pressed` carries the state;
 * the label text changes too, because "Show"/"Hide" alone is ambiguous when
 * read out of context.
 */
export default function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  hint,
  required = true,
  autoFocus = false,
}: {
  id?: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: 'current-password' | 'new-password';
  hint?: string;
  required?: boolean;
  autoFocus?: boolean;
}) {
  const generated = useId();
  const fieldId = id ?? generated;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  const [revealed, setRevealed] = useState(false);

  return (
    <>
      <label htmlFor={fieldId}>{label}</label>
      <div className="password-field">
        <input
          id={fieldId}
          type={revealed ? 'text' : 'password'}
          autoComplete={autoComplete}
          // Reading a password aloud from a slip is the normal case here, and
          // autocapitalising the first letter of it is a guaranteed mismatch.
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required={required}
          autoFocus={autoFocus}
          aria-describedby={hintId}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          className="password-reveal"
          onClick={() => setRevealed((current) => !current)}
          aria-pressed={revealed}
          aria-label={revealed ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          title={revealed ? 'Hide' : 'Show'}
        >
          {revealed ? (
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
              <path
                d="M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8M9.4 5.2A9.5 9.5 0 0112 5c5 0 9 4.5 9 7 0 1-.7 2.3-1.9 3.5M6.5 6.9C4.4 8.3 3 10.3 3 12c0 2.5 4 7 9 7 1.4 0 2.7-.3 3.8-.9"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
              <path
                d="M3 12s3.5-7 9-7 9 7 9 7-3.5 7-9 7-9-7-9-7z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              />
              <circle cx="12" cy="12" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
            </svg>
          )}
        </button>
      </div>
      {hint ? (
        <p className="hint" id={hintId}>
          {hint}
        </p>
      ) : null}
    </>
  );
}
