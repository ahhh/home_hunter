import { useMemo, useState, type Dispatch } from "react";
import type { Property } from "../domain/types";
import { shareUrl, type Action, type AppState, type SharePayload } from "../state/store";
import { Modal } from "./Modal";

type Scope = "visible" | "loved" | "all" | "none";

export function ShareDialog({
  state,
  visible,
  dispatch,
  onClose,
}: {
  state: AppState;
  visible: Property[];
  dispatch: Dispatch<Action>;
  onClose(): void;
}) {
  const [scope, setScope] = useState<Scope>("visible");
  const [name, setName] = useState(state.userName);
  const [copied, setCopied] = useState(false);

  const chosen: Property[] = useMemo(() => {
    if (scope === "visible") return visible;
    if (scope === "loved") return state.properties.filter((p) => p.rating === "love");
    if (scope === "all") return state.properties;
    return [];
  }, [scope, visible, state.properties]);

  const payload: SharePayload = { v: 1, from: name.trim() || undefined, search: state.search, properties: chosen };
  const url = shareUrl(payload);
  const loved = state.properties.filter((p) => p.rating === "love").length;

  async function copy() {
    if (name.trim() !== state.userName) dispatch({ type: "setUserName", name: name.trim() });
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      (document.getElementById("share-url") as HTMLTextAreaElement)?.select();
    }
  }

  return (
    <Modal title="Share with friends" onClose={onClose}>
      <div className="stack">
        <p>
          Your listings are saved in this browser only. Send a link and your friends can add them to their own map, with
          your notes and verdicts.
        </p>
        <fieldset className="radios">
          <legend>Include</legend>
          {(
            [
              ["visible", `The ${visible.length} listings shown now`],
              ["loved", `Only the ${loved} you love`],
              ["all", `All ${state.properties.length} listings`],
              ["none", "Just the search area and filters"],
            ] as const
          ).map(([v, label]) => (
            <label key={v} className="check">
              <input type="radio" name="scope" checked={scope === v} onChange={() => setScope(v)} />
              {label}
            </label>
          ))}
        </fieldset>
        <label className="field">
          <span>From</span>
          <input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <textarea id="share-url" className="share-url" readOnly rows={3} value={url} aria-label="Share link" />
        {url.length > 8000 && (
          <p className="hint">This link is long. If it gets cut off in a text message, send a file from Export instead.</p>
        )}
        <div className="row end">
          <button className="primary" onClick={copy}>
            {copied ? "Link copied" : "Copy link"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
