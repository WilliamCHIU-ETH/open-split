import { useEffect, useState, type FormEvent } from "react";
import type { CurrentSession, Group } from "@open-split/contracts";
import { ApiError, api } from "./api.ts";
import { Dialog } from "./Dialog.tsx";

const CURRENCIES = ["TWD", "JPY", "USD"] as const;

export function Home({ session }: { session: CurrentSession }) {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .groups()
      .then((body) => {
        if (!cancelled) setGroups(body.groups);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "讀不到群組。");
      });
    return () => {
      cancelled = true;
    };
  }, [session.userId]);

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    const currency = String(data.get("currency") ?? "TWD");
    setPending(true);
    setFormError(null);
    try {
      const created = await api.createGroup(name, currency);
      setGroups((current) => [created, ...(current ?? [])]);
      setCreating(false);
      window.history.pushState({}, "", `/groups/${created.id}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    } catch (caught) {
      setFormError(caught instanceof ApiError ? caught.message : "沒有建立群組。");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <h1 id="page-title" tabIndex={-1}>
        你的群組
      </h1>
      <p className="text-muted">平均分一筆帳，看每個人的餘額。</p>
      {error ? <p role="alert">{error}</p> : null}
      {groups === null && !error ? <progress aria-label="正在讀取群組" /> : null}
      {groups?.length === 0 ? <p>還沒有群組。建立第一個，就可以開始記帳。</p> : null}
      <ul className="stack mt-4">
        {groups?.map((group) => (
          <li key={group.id}>
            <a href={`/groups/${group.id}`} className="card flex items-center gap-3 text-ink no-underline">
              <span className="seal" aria-hidden="true">
                {group.name.slice(0, 1)}
              </span>
              <span>
                <span className="block font-semibold">{group.name}</span>
                <span className="text-sm text-muted">{group.defaultCurrency}</span>
              </span>
            </a>
          </li>
        ))}
      </ul>
      <div className="action-bar">
        <button type="button" onClick={() => setCreating(true)}>
          建立群組
        </button>
      </div>
      <Dialog open={creating} labelledBy="create-group-title" onClose={() => setCreating(false)}>
        <form aria-labelledby="create-group-title" onSubmit={(event) => void onCreate(event)}>
          <h2 id="create-group-title">建立群組</h2>
          <div className="field">
            <label htmlFor="group-name">
              名稱 <span aria-hidden="true">*</span>
            </label>
            <input id="group-name" name="name" required maxLength={80} autoComplete="off" enterKeyHint="next" />
          </div>
          <fieldset className="field">
            <legend>預設幣別</legend>
            {CURRENCIES.map((currency) => (
              <label key={currency} className="choice" htmlFor={`currency-${currency}`}>
                <input
                  id={`currency-${currency}`}
                  type="radio"
                  name="currency"
                  value={currency}
                  defaultChecked={currency === "TWD"}
                />
                {currency}
              </label>
            ))}
            <p id="currency-help" className="text-sm text-muted">
              這次的支出用同一個幣別。換匯之後才做。
            </p>
          </fieldset>
          {formError ? (
            <p role="alert" tabIndex={-1}>
              {formError}
            </p>
          ) : null}
          <div className="dialog-actions">
            <button type="button" className="secondary" onClick={() => setCreating(false)}>
              取消
            </button>
            <button type="submit" disabled={pending}>
              {pending ? "建立中" : "建立"}
            </button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
