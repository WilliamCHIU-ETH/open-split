import type { GroupSummary } from "@open-split/contracts";
import { formatMoney, netLabel, netTone } from "./format.ts";

export function LedgerSummary({ summary, names }: { summary: GroupSummary; names: ReadonlyMap<string, string> }) {
  const { currency, totalSpent } = summary;

  return (
    <section aria-labelledby="ledger-summary-title" className="mt-8">
      <h2 id="ledger-summary-title">統計</h2>
      <p>總支出 <span className="money text-xl">{formatMoney(totalSpent, currency)}</span></p>
      <h3 className="mt-6">成員</h3>
      <ul className="stack mt-3">
        {summary.members.map((member) => {
          const tone = netTone(member.net);
          return (
            <li key={member.memberId} className="card settle-card">
              <h4 className="font-semibold">{names.get(member.memberId) ?? "成員"}</h4>
              <dl className="ledger-totals mt-2">
                <div>
                  <dt>已付</dt>
                  <dd className="money">{formatMoney(member.paid, currency)}</dd>
                </div>
                <div>
                  <dt>分到</dt>
                  <dd className="money">{formatMoney(member.share, currency)}</dd>
                </div>
                {member.settledPaid !== "0" ? (
                  <div>
                    <dt>結清付出</dt>
                    <dd className="money">{formatMoney(member.settledPaid, currency)}</dd>
                  </div>
                ) : null}
                {member.settledReceived !== "0" ? (
                  <div>
                    <dt>結清收款</dt>
                    <dd className="money">{formatMoney(member.settledReceived, currency)}</dd>
                  </div>
                ) : null}
                <div className={`ledger-net settle-line tone-${tone}`}>
                  <dt>淨額 <span className="text-sm">{netLabel(tone)}</span></dt>
                  <dd className="money font-semibold">{formatMoney(member.net, currency)}</dd>
                </div>
              </dl>
            </li>
          );
        })}
      </ul>
      <h3 className="mt-6">支出分類</h3>
      {summary.categories.length > 0 ? (
        <ul className="stack mt-3">
          {summary.categories.map(({ category, total }) => {
            const label = category ?? "未分類";
            const percent = totalSpent === "0" ? 0n : (BigInt(total) * 100n) / BigInt(totalSpent);
            const share = percent === 0n && total !== "0" ? "不到 1%" : `${percent}%`;
            return (
              <li key={category === null ? "uncategorized" : `category:${category}`} className="card settle-card">
                <p className="settle-line">
                  <span>{label}</span>
                  <span className="money">{formatMoney(total, currency)}</span>
                </p>
                <p className="text-sm text-muted" aria-hidden="true">{share}</p>
                <meter
                  className="category-meter"
                  max={totalSpent === "0" ? "1" : totalSpent}
                  value={total}
                  aria-label={`${label}占總支出的比例`}
                  aria-valuetext={share}
                />
              </li>
            );
          })}
        </ul>
      ) : <p>還沒有支出。</p>}
    </section>
  );
}
