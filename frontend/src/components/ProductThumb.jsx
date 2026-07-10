import { useState } from "react";

// Swiggy returns a photo for most, but not all, items. Render the real image
// when we have one and it loads; otherwise a clean placeholder tile — never a
// broken-image icon or a fake substitute (same policy as Feast Finder).
export function ProductThumb({ src, alt, className = "" }) {
  const [failed, setFailed] = useState(false);
  const showImage = src && !failed;

  return (
    <div className={`product-thumb ${className}`}>
      {showImage ? (
        <img src={src} alt={alt || ""} loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <span className="product-thumb-placeholder" aria-hidden="true">
          🛍️
        </span>
      )}
    </div>
  );
}
