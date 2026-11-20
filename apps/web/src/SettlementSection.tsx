import type { ActivityResult, GroupDetail, SettlementPreview, SettlementView } from "@open-split/contracts";
import { CopyLink } from "./copy-link.tsx";
import { formatMoney, formatWhen } from "./format.ts";
import type { SettleUpAction } from "./SettleUpDialog.tsx";

export function SettlementSection({
  detail,
  plan,
  userId,
  names,
  refreshing,
  onAction,
}: {
  detail: GroupDetail;
  plan: SettlementPreview;
  userId: string;
  names: ReadonlyMap<string, string>;
  refreshing: boolean;
  onAction: (action: SettleUpAction) => void;
}) {
  return (
    <section aria-labelledby="settlements-title" className="mt-8">
      <h2 id="settlements-title">結清</h2>
      {plan.transfers.length > 0 ? (
        <>
          <p>依照建議，轉帳 {plan.transfers.length} 筆就能結清。</p>
          <ul className="stack mt-3">
            {plan.transfers.map((transfer) => {
              const { fromId, toId, amount } = transfer;
              const payee = memberName(toId, names);
              const route = `${memberName(fromId, names)} → ${payee}`;
              const profile = detail.members.find((member) => member.id === toId)?.paymentProfile;
              return (
                <li key={`${fromId}:${toId}`} className="card settle-card">
                  <p className="settle-line font-semibold">
                    <span>{route}</span>
                    <span className="money text-xl">{formatMoney(amount, plan.currency)}</span>
                  </p>
                  {profile ? (
                    <>
                      <p className="mt-2 text-sm">收款方式：{profile.label}</p>
                      <CopyLink value={profile.details} label={`${payee} 的收款資訊`} plainText />
                    </>
                  ) : <p className="mt-2 text-sm text-muted">{payee} 還沒留收款方式</p>}
                  <button type="button" className="settle-record mt-3" disabled={refreshing} onClick={() => {
                    onAction({ kind: "record", fromMemberId: fromId, toMemberId: toId, amount });
                  }}>
                    記錄這筆結清<span className="visually-hidden">，{route}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : <p>大家都結清了</p>}
      {detail.members.length > 1 ? (
        <button type="button" className="secondary mt-3" disabled={refreshing} onClick={() => {
          const payer = detail.members.find((member) => member.userId === userId) ?? detail.members[0];
          if (payer) onAction({ kind: "record", fromMemberId: payer.id, toMemberId: "", amount: "" });
        }}>
          手動記一筆
        </button>
      ) : null}
      <h3 className="mt-6">結清紀錄</h3>
      {detail.settlements.length > 0 ? (
        <ul className="stack mt-3">
          {detail.settlements.map((settlement) => (
            <li key={settlement.id} className="card settle-card">
              <p>
                <span className="font-semibold">{settlementLabel(settlement, names)}</span>
                {settlement.voided ? <span className="badge">已作廢</span> : null}
              </p>
              <p className="text-sm text-muted">
                <time dateTime={settlement.createdAt}>{formatWhen(settlement.createdAt)}</time>
              </p>
              {settlement.note ? <p>{settlement.note}</p> : null}
              {settlement.voided ? null : (
                <button
                  type="button"
                  className="danger mt-3"
                  disabled={refreshing}
                  onClick={() => onAction({ kind: "void", settlement })}
                >
                  作廢<span className="visually-hidden">，{settlementLabel(settlement, names)}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : <p>還沒有結清紀錄。</p>}
    </section>
  );
}

export function activitySummary(
  entry: ActivityResult["entries"][number],
  names: ReadonlyMap<string, string>,
  settlements: ReadonlyMap<string, SettlementView>,
): string {
  switch (entry.action) {
    case "settlement.recorded":
    case "settlement.voided": {
      const settlement = entry.entityId ? settlements.get(entry.entityId) : undefined;
      if (!settlement) return entry.summary;
      const action = entry.action === "settlement.recorded" ? "記錄結清" : "作廢結清";
      return `${action}：${settlementLabel(settlement, names)}`;
    }
    case "payment_profile.updated":
    case "payment_profile.cleared": {
      const action = entry.action === "payment_profile.updated" ? "更新" : "清除";
      return `${action} ${memberName(entry.entityId ?? "", names)} 的收款方式`;
    }
    default:
      return entry.summary;
  }
}

function settlementLabel(settlement: SettlementView, names: ReadonlyMap<string, string>): string {
  const { fromMemberId, toMemberId, amount, currency } = settlement;
  return `${memberName(fromMemberId, names)} 付給 ${memberName(toMemberId, names)} ${formatMoney(amount, currency)}`;
}

function memberName(id: string, names: ReadonlyMap<string, string>): string {
  return names.get(id) ?? "成員";
}
