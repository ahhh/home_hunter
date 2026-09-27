import { useState, type Dispatch } from "react";
import type { Property } from "../domain/types";
import { buildExport, downloadJson, exportFileName, pickProperties, SCOPE_LABEL, type ExportScope } from "../state/exportFile";
import type { Action, AppState } from "../state/store";
import { Modal } from "./Modal";

const SCOPES: ExportScope[] = ["loved", "rated", "visible", "all"];

export function ExportDialog({
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
  const loved = state.properties.filter((p) => p.rating === "love").length;
  const [scope, setScope] = useState<ExportScope>(loved ? "loved" : "all");
  const [includeSearch, setIncludeSearch] = useState(true);
  const [name, setName] = useState(state.userName);
  const [done, setDone] = useState<string>();
  const count = pickProperties(scope, state.properties, visible).length;

  function download() {
    if (name.trim() !== state.userName) dispatch({ type: "setUserName", name: name.trim() });
    const file = buildExport(state, scope, visible, { includeSearch, from: name.trim() });
    const fileName = exportFileName(scope);
    downloadJson(file, fileName);
    setDone(`Saved ${fileName}.`);
  }

  return (
    <Modal title="Export listings" onClose={onClose}>
      <div className="stack">
        <p>
          Save your mapped listings, with pins, notes and verdicts, to a file. Drop it onto Home Hunter on another device
          or send it to a friend to add to their map.
        </p>
        <fieldset className="radios">
          <legend>Which listings</legend>
          {SCOPES.map((s) => {
            const n = pickProperties(s, state.properties, visible).length;
            return (
              <label key={s} className="check">
                <input type="radio" name="export-scope" checked={scope === s} onChange={() => setScope(s)} />
                {SCOPE_LABEL[s]} ({n})
              </label>
            );
          })}
        </fieldset>
        <label className="check">
          <input type="checkbox" checked={includeSearch} onChange={(e) => setIncludeSearch(e.target.checked)} />
          Include my search area and filters
        </label>
        <label className="field">
          <span>From</span>
          <input placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {done && (
          <p className="note ok" role="status">
            {done}
          </p>
        )}
        <div className="row end">
          <button onClick={onClose}>{done ? "Done" : "Cancel"}</button>
          <button className="primary" onClick={download} disabled={count === 0}>
            Download {count} {count === 1 ? "listing" : "listings"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
