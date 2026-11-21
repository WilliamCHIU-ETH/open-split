import { SUPPORTED_CURRENCIES } from "@open-split/core";
import { useEffect, useState, type FormEvent } from "react";
import type { CurrentSession, Group } from "@open-split/contracts";
import { ApiError, api } from "./api.ts";
import { Dialog } from "./Dialog.tsx";

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
      <p className="text-muted">平均、指定金額、百分比或份數。支援多幣別匯率換算與收據附檔。</p>
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
          <div className="field">
            <label htmlFor="group-currency">預設幣別</label>
            <select id="group-currency" name="currency" defaultValue="TWD" aria-describedby="currency-help">
              {SUPPORTED_CURRENCIES.map((currency) => (
                <option key={currency} value={currency}>
                  {currency}
                </option>
              ))}
            </select>
            <p id="currency-help" className="text-sm text-muted">
              餘額與統計會統一換算成預設幣別；記帳時可選其他幣別並填入匯率。
            </p>
          </div>
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
