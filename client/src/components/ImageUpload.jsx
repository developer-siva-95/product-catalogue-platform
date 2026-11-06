import { useEffect, useRef, useState } from 'react';
import { LIMITS } from '../utils/constants.js';

/**
 * Image picker with client-side pre-validation.
 *
 * The server re-validates everything (magic bytes, pixel count, decoding), but
 * checking size/type here gives instant feedback and avoids a doomed upload.
 */
export function ImageUpload({ file, onChange, existingUrl, error }) {
  const inputRef = useRef(null);
  const [localError, setLocalError] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return undefined;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const handleSelect = (event) => {
    const selected = event.target.files?.[0];
    setLocalError(null);
    if (!selected) return;

    if (!LIMITS.ALLOWED_IMAGE_TYPES.includes(selected.type)) {
      setLocalError('Choose a JPEG, PNG or WEBP image.');
      event.target.value = '';
      return;
    }
    if (selected.size > LIMITS.IMAGE_MAX_BYTES) {
      setLocalError('Image must be 5MB or smaller.');
      event.target.value = '';
      return;
    }
    onChange(selected);
  };

  const preview = previewUrl ?? (existingUrl || null);

  return (
    <div className="field">
      <span className="field__label" id="image-upload-label">
        Product image
      </span>
      <div className="upload-preview">
        {preview ? (
          <img src={preview} alt="Selected product" width={96} height={96} />
        ) : (
          <div
            aria-hidden="true"
            style={{
              width: 96,
              height: 96,
              borderRadius: 10,
              background: 'var(--color-surface-alt)',
              display: 'grid',
              placeItems: 'center',
              color: 'var(--color-text-subtle)',
              fontSize: 22,
            }}
          >
            ⌾
          </div>
        )}
        <div className="stack" style={{ gap: 8 }}>
          <input
            ref={inputRef}
            id="image-upload-input"
            type="file"
            accept={LIMITS.ALLOWED_IMAGE_TYPES.join(',')}
            onChange={handleSelect}
            className="visually-hidden"
            aria-labelledby="image-upload-label"
          />
          <div className="row">
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => inputRef.current?.click()}
            >
              {preview ? 'Replace image' : 'Choose image'}
            </button>
            {file ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  onChange(null);
                  if (inputRef.current) inputRef.current.value = '';
                }}
              >
                Clear selection
              </button>
            ) : null}
          </div>
          <span className="field__hint">
            JPEG, PNG or WEBP · max 5MB · resized to 1200px automatically
          </span>
        </div>
      </div>
      {localError || error ? (
        <span className="field__error" role="alert">
          <span aria-hidden="true">⚠</span> {localError ?? error}
        </span>
      ) : null}
    </div>
  );
}

export default ImageUpload;
