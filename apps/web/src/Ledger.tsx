import { useEffect, useId, useState } from "react";
import type {
  ActivityResult, BalancesResult, CurrentSession, DevUser, ExpenseView, GroupDetail, GroupSummary, SettlementPreview,
} from "@open-split/contracts";
import { ApiError, api, type ExpenseDraft } from "./api.ts";
import { CopyLink } from "./copy-link.tsx";
import { Dialog } from "./Dialog.tsx";
import { ExpenseForm, type ExpenseFormState } from "./ExpenseForm.tsx";
import { formatBytes, formatDecimalInput, formatMoney, formatRateDisplay, formatWhen, memberStatus, netLabel, netTone, splitLabel } from "./format.ts";
import { LedgerSummary } from "./LedgerSummary.tsx";
import { MemberDialog } from "./MemberDialog.tsx";
import { SettlementSection, activitySummary } from "./SettlementSection.tsx";
import { SettleUpDialog, type SettleUpAction } from "./SettleUpDialog.tsx";

interface PanelErrors {
  readonly plan?: string;
  readonly summary?: string;
  readonly activity?: string;
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
  const claimTitleId = useId();
  const [detail, setDetail] = useState<GroupDetail | null>(null);
  const [balances, setBalances] = useState<BalancesResult | null>(null);
  const [activity, setActivity] = useState<ActivityResult | null>(null);
  const [plan, setPlan] = useState<SettlementPreview | null>(null);
  const [summary, setSummary] = useState<GroupSummary | null>(null);
  const [panelErrors, setPanelErrors] = useState<PanelErrors>({});
  const [settleUpAction, setSettleUpAction] = useState<SettleUpAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [loadedRevision, setLoadedRevision] = useState(-1);
  const [expenseForm, setExpenseForm] = useState<ExpenseFormState | null>(null);
  const [memberOpen, setMemberOpen] = useState(false);
  const [voidTarget, setVoidTarget] = useState<ExpenseView | null>(null);
  const [claimLink, setClaimLink] = useState<{ name: string; url: string } | null>(null);
  const [directory, setDirectory] = useState<DevUser[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setPanelErrors({});
    void Promise.allSettled([
      api.group(groupId),
      api.balances(groupId),
      api.activity(groupId),
      api.settlementPlan(groupId),
      api.summary(groupId),
    ]).then(([groupRes, balancesRes, activityRes, planRes, summaryRes]) => {
      if (cancelled) return;
      const results = [groupRes, balancesRes, activityRes, planRes, summaryRes];
      for (const res of results) {
        if (res.status === "rejected" && res.reason instanceof ApiError && res.reason.status === 401) {
          onUnauthorized();
          return;
        }
      }
      if (groupRes.status === "rejected" || balancesRes.status === "rejected") {
        const failed = groupRes.status === "rejected" ? groupRes.reason : (balancesRes as PromiseRejectedResult).reason;
        setError(failed instanceof Error ? failed.message : "讀不到這個群組。");
        return;
      }
      setDetail(groupRes.value);
      setBalances(balancesRes.value);
      const nextPanelErrors: { plan?: string; summary?: string; activity?: string } = {};
      if (activityRes.status === "fulfilled") {
        setActivity(activityRes.value);
      } else {
        setActivity(null);
        nextPanelErrors.activity = activityRes.reason instanceof Error ? activityRes.reason.message : "讀不到活動紀錄。";
      }
      if (planRes.status === "fulfilled") {
        setPlan(planRes.value);
      } else {
        setPlan(null);
        nextPanelErrors.plan = planRes.reason instanceof Error ? planRes.reason.message : "讀不到結清建議。";
      }
      if (summaryRes.status === "fulfilled") {
        setSummary(summaryRes.value);
      } else {
        setSummary(null);
        nextPanelErrors.summary = summaryRes.reason instanceof Error ? summaryRes.reason.message : "讀不到統計。";
      }
      setPanelErrors(nextPanelErrors);
      setLoadedRevision(revision);
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
  const settlements = new Map(detail?.settlements.map((settlement) => [settlement.id, settlement]) ?? []);
  const currency = detail?.group.defaultCurrency ?? balances?.currency ?? "";
  const refreshing = loadedRevision !== revision;

  function openSettleUp(action: SettleUpAction) {
    setStatus(null);
    setSettleUpAction(action);
  }

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
      currency: detail.group.defaultCurrency,
      fxRateText: "",
      payerId: self?.id ?? detail.members[0]?.id ?? "",
      participantIds: detail.members.map((member) => member.id),
      category: "",
      note: "",
      split: { type: "equal" },
      attachments: [],
    });
  }

  function openEdit(expense: ExpenseView) {
    setExpenseForm({
      expenseId: expense.id,
      amount: formatDecimalInput(expense.amount, expense.currency),
      currency: expense.currency,
      fxRateText: formatRateDisplay(expense.fxRate),
      payerId: expense.payerId,
      participantIds: expense.participantIds,
      category: expense.category ?? "",
      note: expense.note ?? "",
      split: expense.split,
      attachments: expense.attachments,
    });
  }

  async function saveExpense(draft: ExpenseDraft, expenseId: string | null) {
    if (expenseId) await api.updateExpense(expenseId, draft);
    else await api.addExpense(draft);
    setExpenseForm(null);
    refresh(expenseId ? "已改好這筆帳。" : "已記上一筆。");
  }

  async function removeSavedAttachment(attachmentId: string) {
    setError(null);
    try {
      await api.deleteAttachment(groupId, attachmentId);
      refresh("已刪除收據附檔。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "刪除附檔失敗。");
    }
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

  async function rotateClaim(memberId: string, name: string) {
    setError(null);
    try {
      const grant = await api.rotateClaim(groupId, memberId);
      setClaimLink({ name, url: new URL(grant.claimPath, window.location.origin).href });
      setRevision((value) => value + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "沒有產生認領連結。");
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
      <p className="text-muted">
        {currency ? `預設幣別 ${currency}。外幣支出會依匯率折算後計入餘額。` : "正在讀取帳本。"}
      </p>
      {error ? (
        <>
          <p role="alert" tabIndex={-1}>{error}</p>
          <button type="button" className="secondary mt-2" onClick={() => setRevision((value) => value + 1)}>
            重新讀取帳本
          </button>
        </>
      ) : null}
      <p role="status">{status}</p>
      {!detail && !error ? <progress aria-label="正在讀取帳本" /> : null}

      {detail && balances ? (
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
                      <span className="badge">{memberStatus(member)}</span>
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

          {plan ? (
            <SettlementSection
              detail={detail}
              plan={plan}
              userId={session.userId}
              names={names}
              refreshing={refreshing}
              onAction={openSettleUp}
            />
          ) : panelErrors.plan ? (
            <section aria-labelledby="settlements-title" className="mt-8">
              <h2 id="settlements-title">結清</h2>
              <p role="alert">{panelErrors.plan}</p>
            </section>
          ) : null}

          <section aria-labelledby="expenses-title" className="mt-8">
            <h2 id="expenses-title">支出</h2>
            {detail.expenses.length === 0 ? <p>還沒有支出。可以平均，也可以指定金額、百分比或份數。</p> : null}
            <ul className="stack mt-3">
              {detail.expenses.map((expense) => {
                const excluded = detail.members.filter((member) => !expense.participantIds.includes(member.id));
                const isForeign = expense.currency !== expense.convertedCurrency;
                const origShareMap = new Map(expense.originalShares.map((item) => [item.participantId, item.amount]));
                return (
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
                      {isForeign ? (
                        <p className="text-sm text-muted">
                          折合 <span className="money">{formatMoney(expense.convertedAmount, expense.convertedCurrency)}</span>
                          {expense.fxRate ? `（匯率 1 ${expense.currency} = ${formatRateDisplay(expense.fxRate)} ${expense.convertedCurrency}）` : ""}
                        </p>
                      ) : null}
                      <p>
                        {names.get(expense.payerId) ?? "成員"} 先付，{splitLabel(expense.split.type)}，
                        {String(expense.participantIds.length)} 人
                      </p>
                      {excluded.length > 0 ? <p>{excluded.map((member) => member.displayName).join("、")}沒有分攤</p> : null}
                      {expense.note ? <p>{expense.note}</p> : null}
                      <ul className="stack mt-2 text-sm text-muted">
                        {expense.shares.map((share) => {
                          const orig = origShareMap.get(share.participantId);
                          return (
                            <li key={share.participantId} className="share-line">
                              <span>{names.get(share.participantId) ?? share.participantId}</span>
                              <span className="money">
                                {formatMoney(share.amount, expense.convertedCurrency)}
                                {isForeign && orig ? `（原幣 ${formatMoney(orig, expense.currency)}）` : ""}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                      {expense.attachments.length > 0 ? (
                        <ul className="attachment-list mt-2">
                          {expense.attachments.map((att) => (
                            <li key={att.id} className="attachment-item">
                              <a href={att.downloadPath} target="_blank" rel="noopener noreferrer">
                                {att.filename}
                              </a>
                              <span className="text-sm text-muted">{formatBytes(att.byteSize)}</span>
                              {expense.voided ? null : (
                                <button
                                  type="button"
                                  className="secondary attachment-remove"
                                  onClick={() => void removeSavedAttachment(att.id)}
                                >
                                  刪除<span className="visually-hidden"> {att.filename}</span>
                                </button>
                              )}
                            </li>
                          ))}
                        </ul>
                      ) : null}
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
                );
              })}
            </ul>
          </section>

          <section aria-labelledby="members-title" className="mt-8">
            <h2 id="members-title">成員</h2>
            <ul className="stack mt-3">
              {detail.members.map((member) => (
                <li key={member.id} className="card">
                  <p>
                    <span className="font-semibold">{member.displayName}</span>
                    <span className="badge">{memberStatus(member)}</span>
                  </p>
                  {member.paymentProfile ? (
                    <div className="mt-2 payment-details">
                      <p>收款方式：{member.paymentProfile.label}</p>
                      <p>{member.paymentProfile.details}</p>
                    </div>
                  ) : null}
                  {member.userId === session.userId || member.virtual ? (
                    <button
                      type="button"
                      className="secondary mt-3"
                      disabled={refreshing}
                      onClick={() => openSettleUp({ kind: "profile", member })}
                    >
                      {member.paymentProfile ? "編輯收款方式" : "設定收款方式"}
                      <span className="visually-hidden">，{member.displayName}</span>
                    </button>
                  ) : null}
                  {member.virtual ? (
                    <button
                      type="button"
                      className="secondary mt-3"
                      onClick={() => void rotateClaim(member.id, member.displayName)}
                    >
                      再給一次認領連結
                      <span className="visually-hidden">，給{member.displayName}</span>
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
            <button type="button" className="mt-3" onClick={() => setMemberOpen(true)}>
              加人
            </button>
          </section>

          {summary ? (
            <LedgerSummary summary={summary} names={names} />
          ) : panelErrors.summary ? (
            <section aria-labelledby="ledger-summary-title" className="mt-8">
              <h2 id="ledger-summary-title">統計</h2>
              <p role="alert">{panelErrors.summary}</p>
            </section>
          ) : null}

          {activity ? (
            <section aria-labelledby="activity-title" className="mt-8">
              <h2 id="activity-title">活動紀錄</h2>
              <ol className="stack mt-3">
                {activity.entries.map((entry) => (
                  <li key={entry.id} className="card">
                    <p>{activitySummary(entry, names, settlements)}</p>
                    <p className="text-sm text-muted">
                      <time dateTime={entry.createdAt}>{formatWhen(entry.createdAt)}</time>
                      {entry.via === "mcp" ? ` · 經由 MCP${entry.clientId ? ` (${entry.clientId})` : ""}` : ""}
                    </p>
                  </li>
                ))}
              </ol>
            </section>
          ) : panelErrors.activity ? (
            <section aria-labelledby="activity-title" className="mt-8">
              <h2 id="activity-title">活動紀錄</h2>
              <p role="alert">{panelErrors.activity}</p>
            </section>
          ) : null}
        </>
      ) : null}

      <div className="action-bar">
        <button type="button" onClick={openCreate} disabled={!detail}>
          記一筆
        </button>
      </div>

      <ExpenseForm form={expenseForm} detail={detail} onClose={() => setExpenseForm(null)} onSave={saveExpense} />
      {detail ? (
        <SettleUpDialog
          action={settleUpAction}
          detail={detail}
          onClose={() => setSettleUpAction(null)}
          onChanged={(message) => {
            setSettleUpAction(null);
            refresh(message);
          }}
        />
      ) : null}
      <MemberDialog
        open={memberOpen}
        groupId={groupId}
        members={detail?.members ?? []}
        directory={directory}
        onClose={() => setMemberOpen(false)}
        onChanged={(message) => {
          setMemberOpen(false);
          refresh(message);
        }}
      />
      <Dialog open={claimLink !== null} labelledBy={claimTitleId} onClose={() => setClaimLink(null)}>
        {claimLink ? (
          <div className="dialog-body">
            <h2 id={claimTitleId}>給{claimLink.name}的認領連結</h2>
            <p>舊的連結已經失效。他認領的仍是同一個位置。</p>
            <CopyLink value={claimLink.url} label="認領連結" />
            <div className="dialog-actions">
              <button type="button" onClick={() => setClaimLink(null)}>
                完成
              </button>
            </div>
          </div>
        ) : (
          <h2 id={claimTitleId}>認領連結</h2>
        )}
      </Dialog>
      <Dialog open={voidTarget !== null} labelledBy="void-title" onClose={(value) => void confirmVoid(value)}>
        <form method="dialog">
          <h2 id="void-title">作廢這筆帳？</h2>
          <p>
            {voidTarget
              ? `${voidTarget.category ?? "這筆支出"} ${formatMoney(voidTarget.amount, voidTarget.currency)}`
              : ""}
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
