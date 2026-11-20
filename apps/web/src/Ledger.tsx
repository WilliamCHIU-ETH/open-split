import { useEffect, useId, useState, type FormEvent } from "react";
import type {
  ActivityResult,
  BalancesResult,
  CurrentSession,
  DevUser,
  ExpenseView,
  GroupDetail,
  SettlementPreview,
} from "@open-split/contracts";
import { ApiError, api, type ExpenseDraft } from "./api.ts";
import { Dialog } from "./Dialog.tsx";
import { formatMoney, formatWhen, netLabel, netTone } from "./format.ts";

interface ExpenseForm {
  readonly expenseId: string | null;
  readonly amount: string;
  readonly payerId: string;
  readonly participantIds: readonly string[];
  readonly category: string;
  readonly note: string;
}

export function Ledger({
  groupId,
  session,
  onUnauthorized,
}: {
  groupId: string;
  session: CurrentSession;
  onUnauthorized: () => void;
}) {
  const [detail, setDetail] = useState<GroupDetail | null>(null);
  const [balances, setBalances] = useState<BalancesResult | null>(null);
  const [preview, setPreview] = useState<SettlementPreview | null>(null);
  const [activity, setActivity] = useState<ActivityResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [expenseForm, setExpenseForm] = useState<ExpenseForm | null>(null);
  const [memberOpen, setMemberOpen] = useState(false);
  const [voidTarget, setVoidTarget] = useState<ExpenseView | null>(null);
  const [directory, setDirectory] = useState<DevUser[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void Promise.all([api.group(groupId), api.balances(groupId), api.preview(groupId), api.activity(groupId)])
      .then(([nextDetail, nextBalances, nextPreview, nextActivity]) => {
        if (cancelled) return;
        setDetail(nextDetail);
        setBalances(nextBalances);
        setPreview(nextPreview);
        setActivity(nextActivity);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        if (caught instanceof ApiError && caught.status === 401) onUnauthorized();
        else setError(caught instanceof Error ? caught.message : "讀不到這個群組。");
      });
    return () => {
      cancelled = true;
    };
  }, [groupId, revision, onUnauthorized]);

  useEffect(() => {
    let cancelled = false;
    void api
      .devUsers()
      .then((body) => {
        if (!cancelled) setDirectory(body.users);
      })
      .catch(() => {
        if (!cancelled) setDirectory(null);
      });
    return () => {
      cancelled = true;
    };
  }, [revision]);

  const names = new Map(detail?.members.map((member) => [member.id, member.displayName]) ?? []);
  const currency = detail?.group.defaultCurrency ?? balances?.currency ?? "";

  function refresh(message: string) {
    setStatus(message);
    setRevision((value) => value + 1);
  }

  function openCreate() {
    if (!detail) return;
    const self = detail.members.find((member) => member.userId === session.userId);
    setExpenseForm({
      expenseId: null,
      amount: "",
      payerId: self?.id ?? detail.members[0]?.id ?? "",
      participantIds: detail.members.map((member) => member.id),
      category: "",
      note: "",
    });
  }

  function openEdit(expense: ExpenseView) {
    setExpenseForm({
      expenseId: expense.id,
      amount: expense.amount,
      payerId: expense.payerId,
      participantIds: expense.participantIds,
      category: expense.category ?? "",
      note: expense.note ?? "",
    });
  }

  async function saveExpense(draft: ExpenseDraft, expenseId: string | null) {
    if (expenseId) await api.updateExpense(expenseId, draft);
    else await api.addExpense(draft);
    setExpenseForm(null);
    refresh(expenseId ? "已改好這筆帳。" : "已記上一筆。");
  }

  async function confirmVoid(value: string) {
    const target = voidTarget;
    setVoidTarget(null);
    if (value !== "void" || !target) return;
    try {
      await api.voidExpense(groupId, target.id);
      refresh("已作廢這筆帳。餘額已重算。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "沒有作廢。");
    }
  }

  return (
    <div className="ledger">
      <p>
        <a href="/">所有群組</a>
      </p>
      <h1 id="page-title" tabIndex={-1}>
        {detail?.group.name ?? "群組"}
      </h1>
      <p className="text-muted">{currency ? `幣別 ${currency}。金額是最小貨幣單位。` : "正在讀取帳本。"}</p>
      {error ? (
        <p role="alert" tabIndex={-1}>
          {error}
        </p>
      ) : null}
      {status ? <p role="status">{status}</p> : null}
      {!detail && !error ? <progress aria-label="正在讀取帳本" /> : null}

      {detail && balances && preview && activity ? (
        <>
          <section aria-labelledby="balances-title" className="mt-6">
            <h2 id="balances-title">餘額</h2>
            <p className="text-sm text-muted">應收是群組欠這個人，應付是這個人還欠群組。合計應為 0。</p>
            <ul className="stack mt-3">
              {detail.members.map((member) => {
                const net = balances.balances.find((row) => row.participantId === member.id)?.net ?? "0";
                const tone = netTone(net);
                return (
                  <li key={member.id} className={`card tone-${tone}`}>
                    <p className="font-semibold">
                      {member.displayName}
                      {member.virtual ? <span className="ms-2 text-sm">虛擬成員</span> : null}
                    </p>
                    <p>
                      <span className="text-sm">{netLabel(tone)}</span>{" "}
                      <span className="money balance-figure text-2xl">{formatMoney(net, balances.currency)}</span>
                    </p>
                  </li>
                );
              })}
            </ul>
            <p className="mt-3">
              合計 <span className="money">{formatMoney(balances.sum, balances.currency)}</span>
              {balances.sum === "0" ? "，帳是平的。" : "，帳不平。"}
            </p>
          </section>

          <section aria-labelledby="settle-title" className="mt-8">
            <h2 id="settle-title">建議轉帳</h2>
            <p className="text-sm text-muted">這只是建議，還沒寫進帳本。做完這些轉帳，每個人都會歸零。</p>
            {preview.transfers.length === 0 ? (
              <p>目前沒有人需要轉帳。</p>
            ) : (
              <ol className="stack mt-3">
                {preview.transfers.map((transfer) => (
                  <li key={`${transfer.fromId}-${transfer.toId}-${transfer.amount}`} className="card">
                    {names.get(transfer.fromId) ?? transfer.fromId} 轉給 {names.get(transfer.toId) ?? transfer.toId}{" "}
                    <span className="money">{formatMoney(transfer.amount, balances.currency)}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section aria-labelledby="expenses-title" className="mt-8">
            <h2 id="expenses-title">支出</h2>
            {detail.expenses.length === 0 ? <p>還沒有支出。記一筆平均分帳。</p> : null}
            <ul className="stack mt-3">
              {detail.expenses.map((expense) => (
                <li key={expense.id} className="card">
                  <article aria-labelledby={`expense-${expense.id}`}>
                    <div className="flex items-start justify-between gap-3">
                      <h3 id={`expense-${expense.id}`} className={expense.voided ? "line-through" : undefined}>
                        {expense.category ?? "支出"}
                        {expense.voided ? "，已作廢" : ""}
                      </h3>
                      <p className={`money text-xl ${expense.voided ? "line-through" : ""}`}>
                        {formatMoney(expense.amount, expense.currency)}
                      </p>
                    </div>
                    <p>
                      {names.get(expense.payerId) ?? "成員"} 先付，平均分給 {String(expense.participantIds.length)} 人
                    </p>
                    {expense.note ? <p>{expense.note}</p> : null}
                    <ul className="stack mt-2 text-sm text-muted">
                      {expense.shares.map((share) => (
                        <li key={share.participantId}>
                          {names.get(share.participantId) ?? share.participantId}{" "}
                          {formatMoney(share.amount, expense.currency)}
                        </li>
                      ))}
                    </ul>
                    {expense.voided ? null : (
                      <div className="mt-3 flex gap-2">
                        <button type="button" className="secondary" onClick={() => openEdit(expense)}>
                          修改
                          <span className="visually-hidden"> {expense.category ?? "這筆支出"}</span>
                        </button>
                        <button type="button" className="danger" onClick={() => setVoidTarget(expense)}>
                          作廢
                          <span className="visually-hidden"> {expense.category ?? "這筆支出"}</span>
                        </button>
                      </div>
                    )}
                  </article>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="members-title" className="mt-8">
            <h2 id="members-title">成員</h2>
            <ul className="stack mt-3">
              {detail.members.map((member) => (
                <li key={member.id} className="card">
                  <span className="font-semibold">{member.displayName}</span>
                  <span className="ms-2 text-sm text-muted">
                    {member.role === "owner" ? "擁有者" : "成員"}
                    {member.virtual ? " · 虛擬成員" : " · 已登入"}
                  </span>
                </li>
              ))}
            </ul>
            <button type="button" className="secondary mt-3" onClick={() => setMemberOpen(true)}>
              加入成員
            </button>
          </section>

          <section aria-labelledby="activity-title" className="mt-8">
            <h2 id="activity-title">活動紀錄</h2>
            <ol className="stack mt-3">
              {activity.entries.map((entry) => (
                <li key={entry.id} className="card">
                  <p>{entry.summary}</p>
                  <p className="text-sm text-muted">
                    <time dateTime={entry.createdAt}>{formatWhen(entry.createdAt)}</time>
                  </p>
                </li>
              ))}
            </ol>
          </section>
        </>
      ) : null}

      <div className="action-bar">
        <button type="button" onClick={openCreate} disabled={!detail}>
          記一筆
        </button>
      </div>

      <ExpenseDialog
        form={expenseForm}
        detail={detail}
        onClose={() => setExpenseForm(null)}
        onSave={saveExpense}
      />
      <MemberDialog
        open={memberOpen}
        groupId={groupId}
        members={detail?.members ?? []}
        directory={directory}
        onClose={() => setMemberOpen(false)}
        onAdded={() => {
          setMemberOpen(false);
          refresh("已加入成員。");
        }}
      />
      <Dialog open={voidTarget !== null} labelledBy="void-title" onClose={(value) => void confirmVoid(value)}>
        <form method="dialog">
          <h2 id="void-title">作廢這筆帳？</h2>
          <p>
            {voidTarget ? `${voidTarget.category ?? "這筆支出"} ${formatMoney(voidTarget.amount, voidTarget.currency)}` : ""}
            。作廢後不再計入餘額，活動紀錄會留下。
          </p>
          <div className="dialog-actions">
            {/* Dialog guidance puts the first focus on the safe action. */}
            {/* eslint-disable-next-line jsx-a11y/no-autofocus -- native dialog initial focus, not page load */}
            <button type="submit" className="secondary" value="cancel" autoFocus>
              保留
            </button>
            <button type="submit" className="danger" value="void">
              作廢
            </button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

function ExpenseDialog({
  form,
  detail,
  onClose,
  onSave,
}: {
  form: ExpenseForm | null;
  detail: GroupDetail | null;
  onClose: () => void;
  onSave: (draft: ExpenseDraft, expenseId: string | null) => Promise<void>;
}) {
  const headingId = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = form?.expenseId !== null && form?.expenseId !== undefined;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!form || !detail) return;
    const data = new FormData(event.currentTarget);
    const participantIds = data.getAll("participant").map(String);
    const first = event.currentTarget.querySelector<HTMLInputElement>('input[name="participant"]');
    if (participantIds.length === 0) {
      first?.setCustomValidity("至少要有一個人分攤。");
      first?.reportValidity();
      return;
    }
    first?.setCustomValidity("");
    const category = String(data.get("category") ?? "").trim();
    const note = String(data.get("note") ?? "").trim();
    const draft: ExpenseDraft = {
      groupId: detail.group.id,
      payerId: String(data.get("payer") ?? ""),
      amount: String(data.get("amount") ?? ""),
      currency: detail.group.defaultCurrency,
      participantIds,
      ...(category ? { category } : {}),
      ...(note ? { note } : {}),
    };
    setPending(true);
    setError(null);
    try {
      await onSave(draft, form.expenseId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "沒有存成。");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={form !== null} labelledBy={headingId} onClose={onClose}>
      {form && detail ? (
        <form key={form.expenseId ?? "new"} aria-labelledby={headingId} onSubmit={(event) => void onSubmit(event)}>
          <h2 id={headingId}>{editing ? "修改支出" : "記一筆"}</h2>
          <p className="text-sm text-muted">平均分。幣別是 {detail.group.defaultCurrency}，填整數最小單位。</p>
          <div className="field">
            <label htmlFor="expense-amount">
              金額 <span aria-hidden="true">*</span>
            </label>
            <input
              id="expense-amount"
              name="amount"
              inputMode="numeric"
              autoComplete="off"
              required
              pattern="^(0|[1-9][0-9]*)$"
              defaultValue={form.amount}
              enterKeyHint="next"
              onInput={(event) => event.currentTarget.setCustomValidity("")}
              onInvalid={(event) => {
                const input = event.currentTarget;
                input.setCustomValidity(
                  input.validity.valueMissing ? "請填金額。" : "金額要是整數，不能有小數點或前導零。",
                );
              }}
            />
          </div>
          <div className="field">
            <label htmlFor="expense-payer">誰先付</label>
            <select id="expense-payer" name="payer" defaultValue={form.payerId} required>
              {detail.members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.displayName}
                </option>
              ))}
            </select>
          </div>
          <fieldset className="field">
            <legend>
              誰要分攤 <span aria-hidden="true">*</span>
            </legend>
            {detail.members.map((member) => (
              <label key={member.id} className="choice" htmlFor={`part-${member.id}`}>
                <input
                  id={`part-${member.id}`}
                  type="checkbox"
                  name="participant"
                  value={member.id}
                  defaultChecked={form.participantIds.includes(member.id)}
                  onChange={(event) => event.currentTarget.setCustomValidity("")}
                />
                {member.displayName}
              </label>
            ))}
          </fieldset>
          <div className="field">
            <label htmlFor="expense-category">分類</label>
            <input id="expense-category" name="category" maxLength={40} defaultValue={form.category} enterKeyHint="next" />
          </div>
          <div className="field">
            <label htmlFor="expense-note">備註</label>
            <textarea id="expense-note" name="note" maxLength={500} defaultValue={form.note} />
          </div>
          {error ? (
            <p role="alert" tabIndex={-1}>
              {error}
            </p>
          ) : null}
          <div className="dialog-actions">
            <button type="button" className="secondary" onClick={onClose}>
              取消
            </button>
            <button type="submit" disabled={pending}>
              {pending ? "儲存中" : editing ? "儲存修改" : "記帳"}
            </button>
          </div>
        </form>
      ) : (
        <h2 id={headingId}>記一筆</h2>
      )}
    </Dialog>
  );
}

function MemberDialog({
  open,
  groupId,
  members,
  directory,
  onClose,
  onAdded,
}: {
  open: boolean;
  groupId: string;
  members: GroupDetail["members"];
  directory: DevUser[] | null;
  onClose: () => void;
  onAdded: () => void;
}) {
  const headingId = useId();
  const [virtual, setVirtual] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taken = new Set(members.map((member) => member.userId).filter((id): id is string => id !== null));
  const available = (directory ?? []).filter((user) => !taken.has(user.userId));

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    try {
      if (virtual) {
        await api.addMember(groupId, { displayName: String(data.get("displayName") ?? "").trim(), virtual: true });
      } else {
        const userId = String(data.get("userId") ?? "");
        const user = available.find((item) => item.userId === userId);
        await api.addMember(groupId, {
          displayName: user?.displayName ?? "成員",
          virtual: false,
          userId,
        });
      }
      setVirtual(true);
      onAdded();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "沒有加入。");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      labelledBy={headingId}
      onClose={() => {
        setError(null);
        onClose();
      }}
    >
      <form aria-labelledby={headingId} onSubmit={(event) => void onSubmit(event)}>
        <h2 id={headingId}>加入成員</h2>
        <fieldset className="field">
          <legend>哪一種</legend>
          <label className="choice" htmlFor="member-virtual">
            <input
              id="member-virtual"
              type="radio"
              name="kind"
              value="virtual"
              checked={virtual}
              onChange={() => setVirtual(true)}
            />
            還沒有帳號
          </label>
          <label className="choice" htmlFor="member-real">
            <input
              id="member-real"
              type="radio"
              name="kind"
              value="real"
              checked={!virtual}
              onChange={() => setVirtual(false)}
            />
            已在這台機器登入過
          </label>
        </fieldset>
        {virtual ? (
          <div className="field">
            <label htmlFor="member-name">
              顯示名稱 <span aria-hidden="true">*</span>
            </label>
            <input id="member-name" name="displayName" required={virtual} maxLength={80} autoComplete="name" />
          </div>
        ) : (
          <div className="field">
            <label htmlFor="member-user">選擇的人</label>
            {available.length === 0 ? (
              <p id="member-user-help">還沒有其他人登入過。請先用另一個名稱登入，再回來加入。</p>
            ) : null}
            <select id="member-user" name="userId" required={!virtual} aria-describedby={available.length === 0 ? "member-user-help" : undefined}>
              {available.map((user) => (
                <option key={user.userId} value={user.userId}>
                  {user.displayName}（{user.provider === "line" ? "LINE" : "Google"}）
                </option>
              ))}
            </select>
          </div>
        )}
        {error ? (
          <p role="alert" tabIndex={-1}>
            {error}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button type="submit" disabled={pending}>
            {pending ? "加入中" : "加入"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
