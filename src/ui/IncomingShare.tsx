import type { Property } from "../domain/types";
import { mergeProperties } from "../listings/collection";
import type { SharePayload } from "../state/store";

export function IncomingShare({
  payload,
  existing,
  onAccept,
  onDismiss,
}: {
  payload: SharePayload;
  existing: Property[];
  onAccept(withSearch: boolean): void;
  onDismiss(): void;
}) {
  const count = payload.properties?.length ?? 0;
  const { added } = mergeProperties(existing, payload.properties ?? []);
  const who = payload.from ?? "A friend";
  return (
    <div className="share-banner" role="region" aria-label="Shared link">
      <p>
        <strong>{who}</strong> shared {count ? `${count} ${count === 1 ? "listing" : "listings"}` : "a search area"}
        {count > 0 && (added === count ? "" : `, ${added} new to you`)}.
      </p>
      <div className="row">
        <button className="primary" onClick={() => onAccept(true)}>
          {count ? "Add and use their search area" : "Use their search area"}
        </button>
        {count > 0 && <button onClick={() => onAccept(false)}>Add listings only</button>}
        <button className="link" onClick={onDismiss}>
          Ignore
        </button>
      </div>
    </div>
  );
}
