import { useState, type Dispatch } from "react";
import { readImportFile, type ImportOutcome } from "../state/importFile";
import type { Action, AppState } from "../state/store";
import { Modal } from "./Modal";

export function ImportDialog({
  state,
  dispatch,
  onClose,
  onUseSearch,
}: {
  state: AppState;
  dispatch: Dispatch<Action>;
  onClose(): void;
  onUseSearch(search: AppState["search"]): void;
}) {
  const [result, setResult] = useState<ImportOutcome>();

  async function onFile(file: File) {
    const outcome = await readImportFile(file, state);
    if (outcome.action) dispatch(outcome.action);
    setResult(outcome);
  }

  return (
    <Modal title="Import listings" onClose={onClose}>
      <div className="stack">
        <p>Bring in a whole search at once from Redfin:</p>
        <ol className="steps">
          <li>Search an area on Redfin and set your filters.</li>
          <li>Switch to the list view and scroll to the bottom of the results.</li>
          <li>
            Click <strong>Download All</strong> to save a CSV file, then choose it below.
          </li>
        </ol>
        <p className="hint">
          Also takes data bundles from the listings script, Home Hunter export files, and any CSV with url, price,
          latitude and longitude columns. You can drag any of these, or a listing link, straight onto the map.
          Importing again later refreshes prices and keeps your notes.
        </p>
        <label className="file">
          <span className="button primary">Choose a file</span>
          <input
            type="file"
            accept=".csv,.json,text/csv,application/json"
            onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
          />
        </label>
        {result && (
          <p className={`note ${result.ok ? "ok" : "warn"}`} role="status">
            {result.text}
          </p>
        )}
        {result?.search && (
          <button
            onClick={() => {
              onUseSearch(result.search!);
              onClose();
            }}
          >
            Use their search area
          </button>
        )}
        <div className="row end">
          <button onClick={onClose}>{result?.ok ? "Done" : "Cancel"}</button>
        </div>
      </div>
    </Modal>
  );
}
