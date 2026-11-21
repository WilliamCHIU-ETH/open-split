/**
 * Domain event contract for ledger mutations (ADR-0010).
 *
 * Cloudflare D1 supports atomic `db.batch([...])` rather than long interactive transactions.
 * When Slice 7 adds LINE push notifications, ledger use-cases will append outbox rows inside
 * the same `db.batch` as the mutation (Transactional Outbox), then best-effort dispatch via
 * `ctx.waitUntil` with Cron retry. Defining the event shapes at the service layer guarantees
 * HTTP and MCP writes emit identical notifications without transport-layer duplication.
 */
export type LedgerEventVia = "web" | "mcp";

export type LedgerDomainEvent =
  | {
      readonly type: "expense.created" | "expense.updated" | "expense.voided";
      readonly groupId: string;
      readonly expenseId: string;
      readonly actorUserId: string;
      readonly via: LedgerEventVia;
      readonly clientId?: string;
    }
  | {
      readonly type: "settlement.recorded" | "settlement.voided";
      readonly groupId: string;
      readonly settlementId: string;
      readonly actorUserId: string;
      readonly via: LedgerEventVia;
      readonly clientId?: string;
    }
  | {
      readonly type: "member.added" | "member.claimed" | "invite.accepted";
      readonly groupId: string;
      readonly memberId: string;
      readonly actorUserId: string;
      readonly via: LedgerEventVia;
      readonly clientId?: string;
    };

export interface LedgerEventSink {
  publish(event: LedgerDomainEvent): Promise<void>;
}

export const noopEventSink: LedgerEventSink = {
  async publish() {
    // No-op until Slice 7 attaches the D1 outbox + LINE push dispatcher.
  },
};
