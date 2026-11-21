import type { OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { insufficientScope } from "@cloudflare/workers-oauth-provider";
import {
  getMcpToolDefinitions,
  mcpToolContracts,
  type McpScope,
  type McpToolName,
} from "@open-split/contracts";
import { createDb, type LedgerDb } from "../db/client.ts";
import {
  createAttachmentUploadIntent,
  deleteAttachment,
  listGroupAttachments,
} from "../ledger/attachments.ts";
import { asServiceError, ServiceError } from "../ledger/errors.ts";
import { runIdempotent } from "../ledger/idempotency.ts";
import {
  addExpense,
  addMember,
  clearPaymentProfile,
  createGroup,
  createInvite,
  getBalances,
  getGroupDetail,
  getGroupSummary,
  getSettlementPlan,
  isUserMcpAuthorized,
  listActivity,
  listGroups,
  recordSettlement,
  updateExpense,
  updatePaymentProfile,
  voidExpense,
  voidSettlement,
  type AuditContext,
  type SessionUser,
} from "../ledger/service.ts";

export interface McpTokenProps {
  readonly userId: string;
  readonly displayName: string;
  readonly subject: string;
  readonly email: string;
}

interface JsonRpcRequest {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

const PROTOCOL_VERSION = "2025-03-26";
const MAX_MCP_BODY_BYTES = 131_072;

export async function handleMcpRequest(
  request: Request,
  env: Env,
  context: OAuthResourceContext<McpTokenProps>,
): Promise<Response> {
  if (request.method !== "POST") {
    return jsonResponse(
      { error: "method_not_allowed", detail: "MCP endpoint supports POST JSON-RPC 2.0 requests." },
      405,
      { Allow: "POST" },
    );
  }
  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return jsonResponse({ error: "unsupported_media_type", detail: "Content-Type must be application/json." }, 415);
  }

  const scopes = context.auth.scope;
  if (!scopes.includes("mcp:read") && !scopes.includes("mcp:write")) {
    return insufficientScope(context.auth, ["mcp:read"]);
  }

  const props = context.props;
  if (!props || typeof props.userId !== "string" || typeof props.email !== "string") {
    return jsonResponse({ error: "invalid_token", detail: "Token claims are incomplete." }, 401);
  }

  const db = createDb(env.DB);
  const authorized = await isUserMcpAuthorized(db, env.MCP_ALLOWED_EMAILS, props.userId, props.email);
  if (!authorized) {
    return jsonResponse({ error: "mcp_forbidden", detail: "這組帳號未列入 MCP 授權白名單。" }, 403);
  }

  let bodyText: string;
  try {
    const bytes = await readBoundedBytes(request, MAX_MCP_BODY_BYTES);
    bodyText = new TextDecoder().decode(bytes);
  } catch (error) {
    if (error instanceof ServiceError) {
      return jsonResponse({ error: error.code, detail: error.message }, error.status);
    }
    return jsonResponse({ error: "invalid_body", detail: "無法讀取請求內容。" }, 400);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    return rpcError(null, -32700, "Parse error: invalid JSON.", 400);
  }

  if (!isRecord(parsed)) {
    return rpcError(null, -32600, "Invalid Request: expected JSON-RPC object.", 400);
  }

  const rpc = parsed as JsonRpcRequest;
  const id = rpc.id === undefined ? undefined : (rpc.id as string | number | null);
  if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
    return rpcError(id ?? null, -32600, "Invalid Request: expected jsonrpc 2.0 and method.", 400);
  }

  // Notifications carry no id and receive 202 Accepted.
  if (id === undefined) {
    return new Response(null, { status: 202, headers: { "Cache-Control": "no-store" } });
  }

  if (rpc.method === "initialize") {
    const requestedVersion =
      isRecord(rpc.params) && typeof rpc.params.protocolVersion === "string"
        ? rpc.params.protocolVersion
        : PROTOCOL_VERSION;
    return rpcResult(id, {
      protocolVersion: requestedVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "open-split", version: "0.1.0" },
    });
  }

  if (rpc.method === "ping") {
    return rpcResult(id, {});
  }

  if (rpc.method === "tools/list") {
    const definitions = getMcpToolDefinitions()
      .filter((tool) => scopes.includes(tool.scope))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.readOnly },
      }));
    return rpcResult(id, { tools: definitions });
  }

  if (rpc.method === "tools/call") {
    const params = isRecord(rpc.params) ? rpc.params : null;
    const toolName = params && typeof params.name === "string" ? params.name : null;
    if (!toolName) {
      return rpcError(id, -32602, "Invalid params: missing tool name.", 400);
    }

    const contract = mcpToolContracts.find((item) => item.name === toolName);
    if (!contract) {
      return rpcError(id, -32601, `Unknown tool: ${toolName}.`, 404);
    }

    const requiredScope: McpScope = contract.scope;
    if (!scopes.includes(requiredScope)) {
      return insufficientScope(context.auth, [requiredScope]);
    }

    const rawArgs = params && params.arguments !== undefined ? params.arguments : {};
    const validated = contract.input.safeParse(rawArgs);
    if (!validated.success) {
      const detail = validated.error.issues.map((issue) => issue.message).join("; ");
      return rpcResult(id, {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: "invalid_input", detail }) }],
      });
    }

    const actor: SessionUser = {
      userId: props.userId,
      displayName: props.displayName,
      provider: "google",
      subject: props.subject,
      primaryEmail: props.email,
    };
    const audit: AuditContext = {
      via: "mcp",
      clientId: typeof context.auth.clientId === "string" ? context.auth.clientId : undefined,
    };

    try {
      const result = await executeMcpTool(
        db,
        env,
        actor,
        audit,
        contract.name,
        validated.data as Record<string, unknown>,
      );
      return rpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      });
    } catch (error) {
      const serviceError = asServiceError(error);
      if (serviceError) {
        return rpcResult(id, {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: serviceError.code, detail: serviceError.message }) }],
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ message: "mcp_tool_error", tool: toolName, error: message }));
      return rpcError(id, -32603, "Internal tool error.", 500);
    }
  }

  return rpcError(id, -32601, `Method not found: ${rpc.method}.`, 404);
}

async function executeMcpTool(
  db: LedgerDb,
  env: Env,
  actor: SessionUser,
  audit: AuditContext,
  name: McpToolName,
  args: Record<string, unknown>,
): Promise<unknown> {
  const idempotencyKey = typeof args.idempotencyKey === "string" ? args.idempotencyKey : undefined;
  const payload = stripIdempotencyKey(args);

  switch (name) {
    case "list_groups":
      return { groups: await listGroups(db, actor) };
    case "get_group":
      return getGroupDetail(db, actor, String(args.groupId));
    case "get_balances":
      return getBalances(db, actor, String(args.groupId));
    case "preview_settlement":
      return getSettlementPlan(db, actor, String(args.groupId));
    case "get_summary":
      return getGroupSummary(db, actor, String(args.groupId));
    case "list_activity":
      return listActivity(db, actor, String(args.groupId));
    case "list_attachments":
      return listGroupAttachments(
        db,
        env.RECEIPTS_BUCKET,
        actor,
        String(args.groupId),
        typeof args.expenseId === "string" ? args.expenseId : undefined,
      );
    case "create_group":
      return runIdempotent(db, actor.userId, `mcp:${name}`, idempotencyKey, payload, () =>
        createGroup(db, actor, payload as Parameters<typeof createGroup>[2], audit),
      );
    case "add_member":
      return runIdempotent(
        db,
        actor.userId,
        `mcp:${name}`,
        idempotencyKey,
        payload,
        () => addMember(db, actor, payload as Parameters<typeof addMember>[2], audit),
        { redactResult: (member) => member.claim !== null },
      );
    case "create_invite":
      return runIdempotent(
        db,
        actor.userId,
        `mcp:${name}`,
        idempotencyKey,
        payload,
        () => createInvite(db, actor, String(args.groupId), audit),
        { redactResult: () => true },
      );
    case "add_expense":
      return runIdempotent(db, actor.userId, `mcp:${name}`, idempotencyKey, payload, () =>
        addExpense(db, actor, payload as Parameters<typeof addExpense>[2], audit),
      );
    case "update_expense": {
      const expenseId = String(args.expenseId);
      const { expenseId: _discard, ...expenseInput } = payload;
      return runIdempotent(db, actor.userId, `mcp:${name}`, idempotencyKey, payload, () =>
        updateExpense(db, actor, expenseId, expenseInput as Parameters<typeof updateExpense>[3], audit),
      );
    }
    case "void_expense":
      return runIdempotent(db, actor.userId, `mcp:${name}`, idempotencyKey, payload, () =>
        voidExpense(db, actor, String(args.groupId), String(args.expenseId), audit),
      );
    case "record_settlement": {
      const groupId = String(args.groupId);
      const { groupId: _discard, ...settlementInput } = payload;
      return runIdempotent(db, actor.userId, `mcp:${name}`, idempotencyKey, payload, () =>
        recordSettlement(db, actor, groupId, settlementInput as Parameters<typeof recordSettlement>[3], audit),
      );
    }
    case "void_settlement":
      return runIdempotent(db, actor.userId, `mcp:${name}`, idempotencyKey, payload, () =>
        voidSettlement(db, actor, String(args.groupId), String(args.settlementId), audit),
      );
    case "set_payment_profile": {
      const groupId = String(args.groupId);
      const memberId = String(args.memberId);
      const { groupId: _g, memberId: _m, ...profile } = payload;
      return runIdempotent(db, actor.userId, `mcp:${name}`, idempotencyKey, payload, () =>
        updatePaymentProfile(db, actor, groupId, memberId, profile as Parameters<typeof updatePaymentProfile>[4], audit),
      );
    }
    case "clear_payment_profile":
      return runIdempotent(db, actor.userId, `mcp:${name}`, idempotencyKey, payload, () =>
        clearPaymentProfile(db, actor, String(args.groupId), String(args.memberId), audit),
      );
    case "create_attachment_upload":
      return runIdempotent(
        db,
        actor.userId,
        `mcp:${name}`,
        idempotencyKey,
        payload,
        () =>
          createAttachmentUploadIntent(
            db,
            env.RECEIPTS_BUCKET,
            actor,
            payload as Parameters<typeof createAttachmentUploadIntent>[3],
          ),
        { redactResult: () => true },
      );
    case "delete_attachment":
      return runIdempotent(db, actor.userId, `mcp:${name}`, idempotencyKey, payload, () =>
        deleteAttachment(db, env.RECEIPTS_BUCKET, actor, String(args.groupId), String(args.attachmentId), audit),
      );
  }
}

function stripIdempotencyKey(args: Record<string, unknown>): Record<string, unknown> {
  const { idempotencyKey: _discard, ...rest } = args;
  return rest;
}

export async function readBoundedBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader !== null) {
    if (!/^\d+$/.test(lengthHeader) || Number(lengthHeader) > maxBytes) {
      throw new ServiceError(413, "payload_too_large", "請求內容超過大小限制。");
    }
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ServiceError(413, "payload_too_large", "請求內容超過大小限制。");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function rpcResult(id: string | number | null, result: unknown): Response {
  return jsonResponse({ jsonrpc: "2.0", id, result }, 200);
}

function rpcError(id: string | number | null, code: number, message: string, status: number): Response {
  return jsonResponse({ jsonrpc: "2.0", id, error: { code, message } }, status);
}

function jsonResponse(body: unknown, status: number, extra: HeadersInit = {}): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
