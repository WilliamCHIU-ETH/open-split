import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertDevAuthAllowed,
  createDevGoogleProvider,
  createDevLineProvider,
  type AuthProviderId,
} from "@open-split/auth";
import {
  activityResultSchema,
  addMemberResultSchema,
  balancesResultSchema,
  claimPreviewSchema,
  claimResultSchema,
  createGroupResultSchema,
  currentSessionSchema,
  devSessionSchema,
  devUserListSchema,
  expenseInputSchema,
  expenseResultSchema,
  groupDetailSchema,
  groupSummarySchema,
  inviteResultSchema,
  joinResultSchema,
  parseSignedMinor,
  parseUnsignedMinor,
  paymentProfileClearResultSchema,
  paymentProfileUpdateResultSchema,
  paymentProfileWriteSchema,
  settlementPreviewSchema,
  settlementRecordResultSchema,
  settlementVoidResultSchema,
  settlementWriteSchema,
  voidExpenseResultSchema,
  type FxRateWire,
  type SettlementWrite,
  type SplitWire,
} from "@open-split/contracts";
import {
  allocateConvertedExpense,
  applyTransfers,
  balancesSum,
  computeBalances,
  formatMinor,
  LedgerError,
  minor,
  parseRateRatio,
  settledToZero,
  simplifyDebts,
  sumMinor,
  toMinorUnits,
  transferBound,
  type Minor,
  type NetBalance,
  type SplitSpec,
} from "@open-split/core";
import { apiBase, apiRequest, WorkerFailure } from "./api.ts";
import { rejectUnknown, requireOption, takeFlag, takeOption } from "./args.ts";
import { DriverFailure } from "./failure.ts";
import { emptyState, loadState, saveState, type DriverState, type ExpenseRecord, type GroupRecord, type Session } from "./state.ts";

export interface DriverIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const HELP = `open-split-driver 打本機 Worker（預設 http://127.0.0.1:8787，可用 OPEN_SPLIT_API_URL 換）。

  login --as <name> [--provider line|google] [--environment development]
  whoami
  create-group --name <name> [--currency TWD]
  add-member --group <id> --name <name> (--user <userId> | --virtual)
  add-expense --group <id> --payer <memberId> --amount <minor> --currency <ISO> [--fx-rate <decimal|num/den>] --participants <id,id> [--split equal|exact|percentage|shares] [--amounts id=minor,id=minor] [--basis-points id=bp,id=bp] [--weights id=n,id=n] [--category <text>] [--note <text>]
  update-expense --group <id> --expense <id> --payer <memberId> --amount <minor> --currency <ISO> [--fx-rate <decimal|num/den>] --participants <id,id> [--split equal|exact|percentage|shares] [--amounts id=minor,id=minor] [--basis-points id=bp,id=bp] [--weights id=n,id=n] [--category <text>] [--note <text>]
  void-expense --group <id> --expense <id>
  show-balances --group <id>
  settle --group <id> [--record]
  record-settlement --group <id> --from <memberId> --to <memberId> --amount <minor> --currency <ISO> [--note <text>]
  void-settlement --group <id> --settlement <id>
  set-payment-profile --group <id> --member <memberId> --label <text> --details <text>
  clear-payment-profile --group <id> --member <memberId>
  show-summary --group <id>
  share-link --group <id>
  claim --token <token>
  join --token <token>
  demo
  accept

金額一律是 ISO 4217 整數最小貨幣單位（例如 1 TWD = 100、1 USD = 100、1 JPY = 1）。外幣支出需傳 --fx-rate（1 外幣 = ratio 群組主幣別）。百分比用基點，100% 是 10000。
狀態檔只記工作階段與這次建立的 id，帳本在 D1。預設是 ./.open-split-driver/state.json。
accept 會跑：切片 1–3（分帳、虛擬認領、邀請、結清）→ 切片 4（多幣別換算與主幣別結清）→ 切片 5（MCP OAuth 2.1 + 白名單 + R2 收據上傳驗證）。`;

export async function run(argv: readonly string[], io: DriverIo): Promise<number> {
  try {
    const [command, ...rest] = argv;
    if (!command || command === "help" || command === "--help" || command === "-h") {
      io.stdout(HELP);
      return 0;
    }
    if (command === "demo") {
      rejectUnknown(rest);
      printDemo(io);
      return 0;
    }
    if (command === "accept") {
      const stateFlag = takeOption(rest, "state");
      rejectUnknown(stateFlag.rest);
      const statePath = stateFlag.value ?? join(tmpdir(), `open-split-accept-${randomUUID()}.json`);
      await runAccept(io, statePath);
      return 0;
    }
    const stateFlag = takeOption(rest, "state");
    const statePath = stateFlag.value ?? "./.open-split-driver/state.json";
    const state = await loadState(statePath);
    await dispatch(command, stateFlag.rest, state, io);
    await saveState(statePath, state);
    io.stdout(`state: ${statePath}`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(message);
    return error instanceof DriverFailure ? error.exitCode : 1;
  }
}

async function runAccept(io: DriverIo, statePath: string): Promise<void> {
  io.stdout("# open-split driver evidence");
  io.stdout("command: accept");
  const state = await loadState(statePath);
  await dispatch(["login", "--as", "bob", "--provider", "google"], state, io);
  const bob = state.session;
  if (!bob) throw new DriverFailure(2, "accept 沒有登入 bob。");
  await dispatch(["login", "--as", "alice"], state, io);
  const alice = requireSession(state);
  const groupsBefore = new Set(state.groups.map((group) => group.id));
  await dispatch(["create-group", "--name", "京都週末", "--currency", "JPY"], state, io);
  const group = state.groups.find((item) => !groupsBefore.has(item.id));
  if (!group) throw new DriverFailure(2, "accept 沒有建立群組。");
  const owner = group.members.find((member) => member.subject === state.session?.subject);
  if (!owner) throw new DriverFailure(2, "accept 沒有建立擁有者。");
  const beforeBob = new Set(group.members.map((member) => member.id));
  await dispatch(["add-member", "--group", group.id, "--name", "Bob", "--user", bob.userId], state, io);
  const bobMember = group.members.find((member) => !beforeBob.has(member.id));
  if (!bobMember) throw new DriverFailure(2, "accept 沒有加入 bob。");
  const participants = `${owner.id},${bobMember.id}`;
  await dispatch(
    [
      "add-expense",
      "--group",
      group.id,
      "--payer",
      owner.id,
      "--amount",
      "3000",
      "--currency",
      "JPY",
      "--participants",
      participants,
      "--split",
      "equal",
      "--category",
      "晚餐",
      "--note",
      "京都晚餐",
    ],
    state,
    io,
  );
  const dinner = group.expenses.at(-1);
  if (!dinner) throw new DriverFailure(2, "accept 沒有記到支出。");
  await dispatch(
    [
      "update-expense",
      "--group",
      group.id,
      "--expense",
      dinner.id,
      "--payer",
      owner.id,
      "--amount",
      "3600",
      "--currency",
      "JPY",
      "--participants",
      participants,
      "--split",
      "equal",
      "--category",
      "晚餐",
      "--note",
      "京都晚餐，改過金額",
    ],
    state,
    io,
  );
  await dispatch(
    [
      "add-expense",
      "--group",
      group.id,
      "--payer",
      bobMember.id,
      "--amount",
      "900",
      "--currency",
      "JPY",
      "--participants",
      participants,
      "--split",
      "equal",
      "--category",
      "交通",
    ],
    state,
    io,
  );
  const taxi = group.expenses.at(-1);
  if (!taxi || taxi.id === dinner.id) throw new DriverFailure(2, "accept 沒有記到要作廢的支出。");
  await dispatch(["void-expense", "--group", group.id, "--expense", taxi.id], state, io);
  await dispatch(["show-balances", "--group", group.id], state, io);
  await dispatch(["settle", "--group", group.id], state, io);
  await dispatch(["share-link", "--group", group.id], state, io);
  const beforeGuest = new Set(group.members.map((member) => member.id));
  await dispatch(["add-member", "--group", group.id, "--name", "店員", "--virtual"], state, io);
  const guest = group.members.find((member) => !beforeGuest.has(member.id));
  if (!guest?.claimToken) throw new DriverFailure(2, "accept 沒有建立虛擬成員的認領權杖。");
  const everyone = `${owner.id},${bobMember.id},${guest.id}`;
  const withoutGuest = `${owner.id},${bobMember.id}`;
  await dispatch(
    [
      "add-expense",
      "--group",
      group.id,
      "--payer",
      owner.id,
      "--amount",
      "600",
      "--currency",
      "JPY",
      "--participants",
      everyone,
      "--split",
      "exact",
      "--amounts",
      `${owner.id}=100,${bobMember.id}=200,${guest.id}=300`,
      "--category",
      "點心",
    ],
    state,
    io,
  );
  await dispatch(
    [
      "add-expense",
      "--group",
      group.id,
      "--payer",
      bobMember.id,
      "--amount",
      "1000",
      "--currency",
      "JPY",
      "--participants",
      everyone,
      "--split",
      "percentage",
      "--basis-points",
      `${owner.id}=5000,${bobMember.id}=3000,${guest.id}=2000`,
      "--category",
      "門票",
    ],
    state,
    io,
  );
  await dispatch(
    [
      "add-expense",
      "--group",
      group.id,
      "--payer",
      owner.id,
      "--amount",
      "1001",
      "--currency",
      "JPY",
      "--participants",
      everyone,
      "--split",
      "shares",
      "--weights",
      `${owner.id}=1,${bobMember.id}=1,${guest.id}=2`,
      "--category",
      "計程車",
    ],
    state,
    io,
  );
  await dispatch(
    [
      "add-expense",
      "--group",
      group.id,
      "--payer",
      owner.id,
      "--amount",
      "800",
      "--currency",
      "JPY",
      "--participants",
      withoutGuest,
      "--split",
      "equal",
      "--category",
      "甜點",
      "--note",
      "店員沒有吃",
    ],
    state,
    io,
  );
  const invite = group.invites.at(-1);
  if (!invite) throw new DriverFailure(2, "accept 沒有邀請連結。");
  await dispatch(["login", "--as", "kenji"], state, io);
  await dispatch(["claim", "--token", guest.claimToken], state, io);
  await dispatch(["login", "--as", "chao"], state, io);
  await dispatch(["join", "--token", invite.token], state, io);
  await dispatch(["show-balances", "--group", group.id], state, io);
  await dispatch(["settle", "--group", group.id], state, io);
  await acceptSettleUp(state, group.id, owner.id, alice, bob, io);
  await acceptFx(io);
  await acceptMcpOAuthAndReceipts(io);
  await saveState(statePath, state);
  io.stdout(`state: ${statePath}`);
}

async function acceptFx(io: DriverIo): Promise<void> {
  io.stdout("# slice 4");
  const fxState = emptyState();
  await dispatch(["login", "--as", "bob", "--provider", "google"], fxState, io);
  const bob = requireSession(fxState);
  await dispatch(["login", "--as", "alice", "--provider", "line"], fxState, io);
  const alice = requireSession(fxState);

  await dispatch(["create-group", "--name", "台北多幣別", "--currency", "TWD"], fxState, io);
  const fxGroup = fxState.groups.at(-1);
  if (!fxGroup) throw new DriverFailure(2, "slice 4 沒有建立群組。");
  const aliceMember = fxGroup.members.find((m) => m.subject === alice.subject);
  if (!aliceMember) throw new DriverFailure(2, "slice 4 找不到群主成員。");

  await dispatch(["add-member", "--group", fxGroup.id, "--name", "Bob", "--user", bob.userId], fxState, io);
  const bobMember = fxGroup.members.find((m) => m.subject === bob.subject);
  if (!bobMember) throw new DriverFailure(2, "slice 4 找不到 Bob 成員。");

  const participants = `${aliceMember.id},${bobMember.id}`;
  // 1001 JPY @ 0.21 -> 21021 minor TWD (NT$210.21)
  await dispatch(
    [
      "add-expense",
      "--group",
      fxGroup.id,
      "--payer",
      aliceMember.id,
      "--amount",
      "1001",
      "--currency",
      "JPY",
      "--fx-rate",
      "0.21",
      "--participants",
      participants,
      "--split",
      "equal",
      "--category",
      "餐飲",
    ],
    fxState,
    io,
  );
  // 12.50 USD (1250 minor) @ 31.5 -> 39375 minor TWD (exact split 500 + 750 -> 15750 + 23625)
  await dispatch(
    [
      "add-expense",
      "--group",
      fxGroup.id,
      "--payer",
      bobMember.id,
      "--amount",
      "1250",
      "--currency",
      "USD",
      "--fx-rate",
      "31.5",
      "--participants",
      participants,
      "--split",
      "exact",
      "--amounts",
      `${aliceMember.id}=500,${bobMember.id}=750`,
      "--category",
      "住宿",
    ],
    fxState,
    io,
  );

  const detail = parseResponse(
    groupDetailSchema,
    await apiRequest(alice.token, `/api/groups/${fxGroup.id}`),
    "FX 群組",
  );
  const jpyExpense = detail.expenses.find((exp) => exp.currency === "JPY");
  const usdExpense = detail.expenses.find((exp) => exp.currency === "USD");
  const conversionOk =
    jpyExpense?.convertedAmount === "21021" &&
    jpyExpense.convertedCurrency === "TWD" &&
    usdExpense?.convertedAmount === "39375" &&
    usdExpense.convertedCurrency === "TWD";
  assertCheck(io, "check.fx_conversion", conversionOk, "外幣折算主幣別金額不正確。");

  const fxBalances = await printInvariants(alice.token, fxGroup.id, io);
  assertCheck(
    io,
    "invariant.fx_balances_sum_to_zero",
    fxBalances.sum === "0",
    "多幣別群組餘額總和不是 0。",
  );

  // Same-currency expense with fxRate must be rejected (422)
  await expectWorkerStatus(io, "check.fx_same_currency_rate_rejected", 422, () =>
    apiRequest(alice.token, `/api/groups/${fxGroup.id}/expenses`, {
      method: "POST",
      body: {
        groupId: fxGroup.id,
        payerId: aliceMember.id,
        amount: "1000",
        currency: "TWD",
        fxRate: { numerator: 1, denominator: 1 },
        participantIds: [aliceMember.id, bobMember.id],
        split: { type: "equal" },
      },
    }),
  );

  // Settlement in non-default currency must be rejected (422)
  await expectWorkerStatus(io, "check.fx_settlement_currency_rejected", 422, () =>
    postSettlement(
      alice.token,
      fxGroup.id,
      {
        fromMemberId: aliceMember.id,
        toMemberId: bobMember.id,
        amount: "100",
        currency: "USD",
      },
      io,
    ),
  );

  await dispatch(["settle", "--group", fxGroup.id, "--record"], fxState, io);
  assertCheck(io, "check.fx_default_currency_settlement", true, "主幣別結清失敗。");

  const activity = parseResponse(
    activityResultSchema,
    await apiRequest(alice.token, `/api/groups/${fxGroup.id}/activity`),
    "FX 活動",
  );
  const actorAttributed = activity.entries.some(
    (entry) => entry.action === "settlement.recorded" && entry.summary.includes("Alice"),
  );
  assertCheck(
    io,
    "check.activity.actor_attribution",
    actorAttributed,
    "活動紀錄缺少結清記錄人名稱（P2-3）。",
  );
}

async function acceptMcpOAuthAndReceipts(io: DriverIo): Promise<void> {
  io.stdout("# slice 5");
  const base = apiBase();

  // 1. OAuth protected-resource & authorization-server metadata
  const prmRes = await fetch(`${base}/.well-known/oauth-protected-resource`);
  const prmJson = (await prmRes.json()) as { resource?: string; authorization_servers?: string[] };
  const asRes = await fetch(`${base}/.well-known/oauth-authorization-server`);
  const asJson = (await asRes.json()) as {
    authorization_endpoint?: string;
    token_endpoint?: string;
    registration_endpoint?: string;
    scopes_supported?: string[];
  };
  const metadataOk =
    prmRes.status === 200 &&
    prmJson.resource === `${base}/mcp` &&
    asRes.status === 200 &&
    asJson.authorization_endpoint === `${base}/authorize` &&
    asJson.token_endpoint === `${base}/oauth/token` &&
    Boolean(asJson.scopes_supported?.includes("mcp:read")) &&
    Boolean(asJson.scopes_supported?.includes("mcp:write"));
  assertCheck(io, "check.mcp_oauth_metadata", metadataOk, "OAuth discovery metadata 不符合規範。");

  // 2. Dynamic Client Registration + reject non-loopback HTTP redirect
  const badDcr = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Evil", redirect_uris: ["http://evil.example/cb"] }),
  });
  const redirectUri = "https://claude.ai/api/mcp/auth_callback";
  const dcrRes = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "AcceptDriver",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
    }),
  });
  const dcrJson = (await dcrRes.json()) as { client_id?: string };
  assertCheck(
    io,
    "check.mcp_dcr",
    badDcr.status === 400 && dcrRes.status === 201 && Boolean(dcrJson.client_id),
    "MCP Dynamic Client Registration 驗證失敗。",
  );
  const clientId = dcrJson.client_id;
  if (!clientId) throw new DriverFailure(2, "DCR 缺少 client_id。");

  const runDevOAuth = async (devEmail: string, scopes: string[], targetClientId: string) => {
    const verifier = `accept-verifier-${randomUUID()}-${randomUUID()}`;
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authUrl = new URL(`${base}/authorize`);
    authUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: targetClientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: `state-${randomUUID()}`,
      scope: scopes.join(" "),
      resource: `${base}/mcp`,
    }).toString();

    const consentGet = await fetch(authUrl.href);
    if (consentGet.status !== 200) {
      throw new DriverFailure(2, `GET /authorize 回傳 ${String(consentGet.status)}`);
    }
    const cookieHeader = consentGet.headers
      .getSetCookie()
      .map((item) => item.split(";")[0])
      .join("; ");
    const html = await consentGet.text();
    const handle = /name="handle"\s+value="([^"]+)"/.exec(html)?.[1];
    if (!handle) {
      throw new DriverFailure(2, "GET /authorize 找不到 consent handle（請確認 WORKER 非 Google OIDC 模式或檢查 dev 設定）。");
    }

    const form = new URLSearchParams({
      handle,
      decision: "approve",
      dev_email: devEmail,
    });
    for (const s of scopes) form.append("scope", s);

    const consentPost = await fetch(`${base}/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: {
        Origin: base,
        Cookie: cookieHeader,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    if (consentPost.status !== 302) {
      throw new DriverFailure(2, `POST /authorize 回傳 ${String(consentPost.status)}`);
    }
    const location = consentPost.headers.get("location");
    if (!location) throw new DriverFailure(2, "POST /authorize 缺少 Location 標頭。");
    return { redirect: new URL(location), verifier };
  };

  const allowedMcpEmail = process.env.OPEN_SPLIT_MCP_EMAIL?.trim().toLowerCase() || "owner@example.test";

  // 3. Whitelist denial for non-allowed email
  const denied = await runDevOAuth("stranger@example.com", ["mcp:read"], clientId);
  assertCheck(
    io,
    "check.mcp_whitelist_denied",
    denied.redirect.searchParams.get("error") === "access_denied",
    "非白名單 Email 應該被拒絕存取 MCP。",
  );

  // 4. Allowed email obtains code -> exchanges PKCE token
  const allowed = await runDevOAuth(allowedMcpEmail, ["mcp:read", "mcp:write"], clientId);
  const authCode = allowed.redirect.searchParams.get("code");
  if (!authCode) throw new DriverFailure(2, "白名單帳號授權沒有收到 code。");
  const tokenRes = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code: authCode,
      code_verifier: allowed.verifier,
      redirect_uri: redirectUri,
      resource: `${base}/mcp`,
    }).toString(),
  });
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  assertCheck(
    io,
    "check.mcp_oauth_token",
    tokenRes.status === 200 && Boolean(tokenJson.access_token),
    "MCP OAuth token exchange 失敗。",
  );
  const mcpToken = tokenJson.access_token;
  if (!mcpToken) throw new DriverFailure(2, "MCP token 缺少 access_token。");

  // 5. MCP token isolated from web REST endpoints
  const webAttempt = await fetch(`${base}/api/groups`, {
    headers: { authorization: `Bearer ${mcpToken}` },
  });
  assertCheck(io, "check.mcp_token_web_isolated", webAttempt.status === 401, "MCP token 不該存取一般 Web API。");

  const mcpCall = async (method: string, params?: Record<string, unknown>, bearer = mcpToken) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "1", method, ...(params ? { params } : {}) }),
    });
    const json = (await res.json()) as { result?: { structuredContent?: Record<string, unknown>; isError?: boolean } };
    return { status: res.status, json };
  };

  // 6. Initialize + create group + member + upload intent + PNG magic check
  const initRes = await mcpCall("initialize");
  if (initRes.status !== 200) throw new DriverFailure(2, "MCP initialize 失敗。");

  const grpRes = await mcpCall("tools/call", {
    name: "create_group",
    arguments: { name: "MCP 收據群", defaultCurrency: "TWD", idempotencyKey: `mcp-grp-${randomUUID()}` },
  });
  const grpData = grpRes.json.result?.structuredContent as { id?: string; ownerMemberId?: string } | undefined;
  const mcpGroupId = grpData?.id;
  const ownerMemberId = grpData?.ownerMemberId;
  if (!mcpGroupId || !ownerMemberId) throw new DriverFailure(2, "MCP create_group 失敗。");

  const friendRes = await mcpCall("tools/call", {
    name: "add_member",
    arguments: { groupId: mcpGroupId, displayName: "小華", virtual: true, idempotencyKey: `mcp-mem-${randomUUID()}` },
  });
  const friendId = (friendRes.json.result?.structuredContent as { id?: string } | undefined)?.id;
  if (!friendId) throw new DriverFailure(2, "MCP add_member 失敗。");

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  const sha256 = createHash("sha256").update(png).digest("hex");
  const intentRes = await mcpCall("tools/call", {
    name: "create_attachment_upload",
    arguments: {
      groupId: mcpGroupId,
      filename: "receipt.png",
      mimeType: "image/png",
      byteSize: png.byteLength,
      sha256,
      idempotencyKey: `mcp-att-${randomUUID()}`,
    },
  });
  const intentData = intentRes.json.result?.structuredContent as
    | { attachment?: { id?: string }; uploadPath?: string; uploadHeaders?: Record<string, string> }
    | undefined;
  const attachmentId = intentData?.attachment?.id;
  const uploadPath = intentData?.uploadPath;
  const uploadHeaders = intentData?.uploadHeaders;
  if (!attachmentId || !uploadPath || !uploadHeaders) throw new DriverFailure(2, "MCP create_attachment_upload 失敗。");

  // Disguised SVG payload must fail magic-bytes validation with 415
  const fakeSvg = new TextEncoder().encode("<svg></svg>!");
  const badPut = await fetch(`${base}${uploadPath}`, {
    method: "PUT",
    headers: uploadHeaders,
    body: fakeSvg,
  });
  assertCheck(io, "check.r2_magic_bytes_rejected", badPut.status === 415, "偽造 PNG 檔頭應該被 415 拒絕。");

  // Valid PNG succeeds
  const goodPut = await fetch(`${base}${uploadPath}`, {
    method: "PUT",
    headers: uploadHeaders,
    body: png,
  });
  assertCheck(io, "check.r2_receipt_uploaded", goodPut.status === 200, "合法 PNG 收據上傳失敗。");

  // 7. Idempotent MCP add_expense with attachment & FX rate
  const expIdemKey = `mcp-exp-${randomUUID()}`;
  const expArgs = {
    groupId: mcpGroupId,
    payerId: ownerMemberId,
    amount: "1000",
    currency: "JPY",
    fxRate: { numerator: 21, denominator: 100 },
    participantIds: [ownerMemberId, friendId],
    split: { type: "equal" },
    attachmentIds: [attachmentId],
    idempotencyKey: expIdemKey,
  };
  const exp1 = await mcpCall("tools/call", { name: "add_expense", arguments: expArgs });
  const exp2 = await mcpCall("tools/call", { name: "add_expense", arguments: expArgs });
  const exp1Id = (exp1.json.result?.structuredContent as { id?: string } | undefined)?.id;
  const exp2Id = (exp2.json.result?.structuredContent as { id?: string } | undefined)?.id;
  assertCheck(
    io,
    "check.mcp_idempotent_add_expense",
    Boolean(exp1Id) && exp1Id === exp2Id,
    "MCP add_expense 冪等重試沒有回傳同一筆 id。",
  );

  // 8. Private R2 download via invite-joined Web member + security headers + non-member 403 + delete
  const inviteRes = await mcpCall("tools/call", {
    name: "create_invite",
    arguments: { groupId: mcpGroupId, idempotencyKey: `mcp-inv-${randomUUID()}` },
  });
  const inviteToken = (inviteRes.json.result?.structuredContent as { token?: string } | undefined)?.token;
  if (!inviteToken) throw new DriverFailure(2, "MCP create_invite 失敗。");

  const webState = emptyState();
  await login(["--as", "alice"], webState, io);
  const aliceSession = requireSession(webState);
  await apiRequest(aliceSession.token, `/api/invites/${inviteToken}/accept`, { method: "POST" });

  const dlRes = await fetch(`${base}/api/groups/${mcpGroupId}/attachments/${attachmentId}`, {
    headers: { authorization: `Bearer ${aliceSession.token}` },
  });
  const dlBytes = new Uint8Array(await dlRes.arrayBuffer());
  const headersOk =
    dlRes.status === 200 &&
    (dlRes.headers.get("content-disposition") ?? "").includes("attachment") &&
    dlRes.headers.get("x-content-type-options") === "nosniff" &&
    dlRes.headers.get("content-security-policy") === "sandbox" &&
    dlRes.headers.get("cache-control") === "private, no-store" &&
    dlBytes.byteLength === png.byteLength &&
    dlBytes.every((b, idx) => b === png[idx]);
  assertCheck(io, "check.r2_receipt_download_headers", headersOk, "收據私人下載缺少安全標頭或位元組不一致。");

  const outsiderState = emptyState();
  await login(["--as", "outsider"], outsiderState, io);
  const outsiderSession = requireSession(outsiderState);
  const outsiderDl = await fetch(`${base}/api/groups/${mcpGroupId}/attachments/${attachmentId}`, {
    headers: { authorization: `Bearer ${outsiderSession.token}` },
  });
  assertCheck(io, "check.r2_non_member_download_forbidden", outsiderDl.status === 403, "非群組成員不該下載收據。");

  await mcpCall("tools/call", {
    name: "delete_attachment",
    arguments: { groupId: mcpGroupId, attachmentId, idempotencyKey: `mcp-del-${randomUUID()}` },
  });
  const afterDelDl = await fetch(`${base}/api/groups/${mcpGroupId}/attachments/${attachmentId}`, {
    headers: { authorization: `Bearer ${aliceSession.token}` },
  });
  assertCheck(io, "check.r2_receipt_deleted", afterDelDl.status === 404, "刪除收據後應回傳 404。");

  // 9. Scope isolation: mcp:read token cannot call write tools
  const roDcr = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "ReadOnlyAccept",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
    }),
  });
  const { client_id: roClientId } = (await roDcr.json()) as { client_id: string };
  const roAuth = await runDevOAuth(allowedMcpEmail, ["mcp:read"], roClientId);
  const roCode = roAuth.redirect.searchParams.get("code");
  if (!roCode) throw new DriverFailure(2, "只讀 MCP client 授權失敗。");
  const roTokenRes = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: roClientId,
      code: roCode,
      code_verifier: roAuth.verifier,
      redirect_uri: redirectUri,
      resource: `${base}/mcp`,
    }).toString(),
  });
  const { access_token: roToken } = (await roTokenRes.json()) as { access_token: string };
  const roRead = await mcpCall("tools/call", { name: "list_groups", arguments: {} }, roToken);
  const roWrite = await mcpCall(
    "tools/call",
    { name: "void_expense", arguments: { groupId: mcpGroupId, expenseId: exp1Id } },
    roToken,
  );
  assertCheck(
    io,
    "check.mcp_read_only_scope_enforced",
    roRead.status === 200 && roWrite.status === 403,
    "mcp:read 權杖應該允許讀取並拒絕寫入工具（403）。",
  );
}

async function acceptSettleUp(
  state: DriverState, groupId: string, payeeId: string, payee: Session, bob: Session, io: DriverIo,
): Promise<void> {
  io.stdout("# slice 3");
  const groupArgs = ["--group", groupId];
  const profileArgs = [...groupArgs, "--member", payeeId, "--label", "銀行轉帳", "--details", "請私訊詢問帳號"];
  await paymentProfile(profileArgs, { ...state, session: payee }, io, "PUT");
  const detail = parseResponse(
    groupDetailSchema, await apiRequest(bob.token, `/api/groups/${groupId}`), "群組",
  );
  const profile = detail.members.find(({ id }) => id === payeeId)?.paymentProfile;
  assertCheck(io, "check.payment_profile_set",
    profile?.label === "銀行轉帳" && profile.details === "請私訊詢問帳號", "群組成員看不到收款方式。");
  await expectWorkerStatus(io, "check.other_payment_profile_forbidden", 403,
    () => paymentProfile(profileArgs, { ...state, session: bob }, io, "PUT"));

  await settle(groupArgs, state, io);
  const { token } = requireSession(state);
  const plan = await fetchSettlementPlan(token, groupId);
  const suggested = plan.transfers.find(({ toId, amount }) => toId === payeeId && parseUnsignedMinor(amount) > 1n);
  assertCheck(io, "check.partial_settlement_available", suggested !== undefined, "找不到可部分結清的轉帳。");
  const before = await fetchBalances(token, groupId);
  const partial = {
    fromMemberId: suggested.fromId,
    toMemberId: suggested.toId,
    amount: "1",
    currency: plan.currency,
    note: "部分結清",
  };
  const settlementId = await postSettlement(token, groupId, partial, io);
  const afterPartial = await fetchBalances(token, groupId);
  assertCheck(io, "invariant.partial_balances_sum_to_zero",
    afterPartial.sum === "0" && balancesSum(wireBalances(afterPartial.balances)) === 0n,
    "部分結清後的餘額總和不是 0。");
  const beforeNets = new Map(before.balances.map(({ participantId, net }) => [participantId, net]));
  assertCheck(io, "check.partial_settlement_changes_balances",
    afterPartial.balances.some(({ participantId, net }) => beforeNets.get(participantId) !== net) &&
    afterPartial.balances.some(({ net }) => net !== "0"), "部分結清應改變餘額且仍有未結清的金額。");

  await voidSettlement([...groupArgs, "--settlement", settlementId], state, io);
  const afterVoid = await fetchBalances(token, groupId);
  assertCheck(io, "invariant.void_restores_balances",
    afterVoid.sum === before.sum && afterVoid.balances.length === beforeNets.size &&
    afterVoid.balances.every(({ participantId, net }) => beforeNets.get(participantId) === net),
    "作廢結清後的餘額和結清前不一致。");
  const activity = parseResponse(
    activityResultSchema, await apiRequest(token, `/api/groups/${groupId}/activity`), "活動",
  );
  for (const action of ["settlement.recorded", "settlement.voided"]) {
    const exists = activity.entries.some((entry) => entry.entityId === settlementId && entry.action === action);
    if (exists) io.stdout(`activity: ${action}`);
    assertCheck(io, `check.activity.${action}`, exists, `活動紀錄找不到 ${action}。`);
  }

  const outsider = emptyState();
  await login(["--as", "outsider"], outsider, io);
  await expectWorkerStatus(io, "check.non_member_settlement_forbidden", 403,
    () => postSettlement(requireSession(outsider).token, groupId, partial, io));
  await expectWorkerStatus(io, "check.settlement_currency_mismatch", 422,
    () => postSettlement(token, groupId, { ...partial, currency: "TWD" }, io));

  await settle([...groupArgs, "--record"], state, io);
  await showSummary(groupArgs, state, io);
}

function printCheck(io: DriverIo, key: string, passed: boolean): void {
  io.stdout(`${key}: ${passed ? "pass" : "fail"}`);
}

function assertCheck(io: DriverIo, key: string, passed: boolean, message: string): asserts passed {
  printCheck(io, key, passed);
  if (!passed) throw new DriverFailure(2, message);
}

async function expectWorkerStatus(
  io: DriverIo, key: string, expected: number, request: () => Promise<unknown>,
): Promise<void> {
  try {
    await request();
  } catch (error) {
    if (error instanceof WorkerFailure) {
      io.stdout(`${key}.status: ${String(error.status)}`);
      assertCheck(io, key, error.status === expected, error.message);
      return;
    }
    printCheck(io, key, false);
    throw error;
  }
  assertCheck(io, key, false, `Worker 應回傳 ${String(expected)}，但請求成功。`);
}

async function dispatch(
  commandOrArgv: string | readonly string[],
  stateOrArgs: DriverState | readonly string[],
  ioOrState: DriverIo | DriverState,
  maybeIo?: DriverIo,
): Promise<void> {
  const command = typeof commandOrArgv === "string" ? commandOrArgv : commandOrArgv[0];
  const args = typeof commandOrArgv === "string" ? (stateOrArgs as readonly string[]) : commandOrArgv.slice(1);
  const state = typeof commandOrArgv === "string" ? (ioOrState as DriverState) : (stateOrArgs as DriverState);
  const io = typeof commandOrArgv === "string" ? maybeIo : (ioOrState as DriverIo);
  if (!command || !io) throw new DriverFailure(1, "缺少指令。");

  switch (command) {
    case "login":
      return login(args, state, io);
    case "whoami":
      rejectUnknown(args);
      return whoami(state, io);
    case "create-group":
      return createGroup(args, state, io);
    case "add-member":
      return addMember(args, state, io);
    case "add-expense":
      return addExpense(args, state, io);
    case "update-expense":
      return updateExpense(args, state, io);
    case "void-expense":
      return voidExpense(args, state, io);
    case "show-balances":
      return showBalances(args, state, io);
    case "settle":
      return settle(args, state, io);
    case "record-settlement":
      return recordSettlement(args, state, io);
    case "void-settlement":
      return voidSettlement(args, state, io);
    case "set-payment-profile":
      return paymentProfile(args, state, io, "PUT");
    case "clear-payment-profile":
      return paymentProfile(args, state, io, "DELETE");
    case "show-summary":
      return showSummary(args, state, io);
    case "share-link":
      return shareLink(args, state, io);
    case "claim":
      return claimMember(args, state, io);
    case "join":
      return joinGroup(args, state, io);
    default:
      throw new DriverFailure(1, `不認識的指令 ${command}。執行時加上 help 可看指令形狀。`);
  }
}

async function login(args: readonly string[], state: DriverState, io: DriverIo): Promise<void> {
  const nameFlag = takeOption(args, "as");
  const providerFlag = takeOption(nameFlag.rest, "provider");
  const environmentFlag = takeOption(providerFlag.rest, "environment");
  rejectUnknown(environmentFlag.rest);
  const name = requireOption(nameFlag.value, "as");
  const provider = providerFlag.value ?? "line";
  if (provider !== "line" && provider !== "google") {
    throw new DriverFailure(1, "--provider 只能是 line 或 google。LINE 是主要登入，Google 是次要登入。");
  }
  const environment = environmentFlag.value ?? process.env.OPEN_SPLIT_ENVIRONMENT ?? "development";
  assertDevAuthAllowed({ environment, authDevIdentities: true });
  (provider === "line" ? createDevLineProvider() : createDevGoogleProvider()).signInAs(name);
  const session = parseResponse(
    devSessionSchema,
    await apiRequest(null, "/api/dev/session", { method: "POST", body: { name, provider } }),
    "登入",
  );
  state.session = {
    provider: provider as AuthProviderId,
    name,
    subject: session.subject,
    displayName: session.displayName,
    userId: session.userId,
    token: session.token,
  };
  io.stdout(`login.provider: ${state.session.provider}`);
  io.stdout(`login.name: ${state.session.name}`);
  io.stdout(`login.subject: ${state.session.subject}`);
  io.stdout(`login.display_name: ${state.session.displayName}`);
  io.stdout(`login.user_id: ${state.session.userId}`);
  io.stdout(`login.environment: ${environment}`);
}

async function whoami(state: DriverState, io: DriverIo): Promise<void> {
  if (!state.session) {
    io.stdout("login.subject: (none)");
    return;
  }
  const session = parseResponse(currentSessionSchema, await apiRequest(state.session.token, "/api/session"), "whoami");
  io.stdout(`login.provider: ${session.provider}`);
  io.stdout(`login.name: ${state.session.name}`);
  io.stdout(`login.subject: ${session.subject}`);
}

async function createGroup(args: readonly string[], state: DriverState, io: DriverIo): Promise<void> {
  const session = requireSession(state);
  const nameFlag = takeOption(args, "name");
  const currencyFlag = takeOption(nameFlag.rest, "currency");
  rejectUnknown(currencyFlag.rest);
  const name = requireOption(nameFlag.value, "name");
  const currency = currencyFlag.value ?? "TWD";
  const created = parseResponse(
    createGroupResultSchema,
    await apiRequest(session.token, "/api/groups", {
      method: "POST",
      body: { name, defaultCurrency: currency },
    }),
    "建立群組",
  );
  const detail = parseResponse(groupDetailSchema, await apiRequest(session.token, `/api/groups/${created.id}`), "群組");
  state.groups.push({
    id: created.id,
    name: created.name,
    currency: created.defaultCurrency,
    createdBySubject: session.subject,
    members: detail.members.map((member) => ({
      id: member.id,
      name: member.displayName,
      virtual: member.virtual,
      subject: member.userId === session.userId ? session.subject : null,
      claimToken: null,
    })),
    expenses: [],
    invites: [],
  });
  io.stdout(`group_id: ${created.id}`);
  io.stdout(`group_name: ${created.name}`);
  io.stdout(`owner_member_id: ${created.ownerMemberId}`);
  io.stdout(`currency: ${created.defaultCurrency}`);
}

async function addMember(args: readonly string[], state: DriverState, io: DriverIo): Promise<void> {
  const session = requireSession(state);
  const groupFlag = takeOption(args, "group");
  const nameFlag = takeOption(groupFlag.rest, "name");
  const virtualFlag = takeFlag(nameFlag.rest, "virtual");
  const userFlag = takeOption(virtualFlag.rest, "user");
  rejectUnknown(userFlag.rest);
  const group = requireGroup(state, requireOption(groupFlag.value, "group"));
  const name = requireOption(nameFlag.value, "name");
  if (virtualFlag.present && userFlag.value) throw new DriverFailure(1, "虛擬成員不能同時給 --user。");
  if (!virtualFlag.present && !userFlag.value) {
    throw new DriverFailure(1, "請用 --user 連結已登入的人，或加 --virtual 先記一個還沒註冊的朋友。");
  }
  const member = parseResponse(
    addMemberResultSchema,
    await apiRequest(session.token, `/api/groups/${group.id}/members`, {
      method: "POST",
      body: {
        displayName: name,
        virtual: virtualFlag.present,
        ...(userFlag.value ? { userId: userFlag.value } : {}),
      },
    }),
    "成員",
  );
  let subject: string | null = null;
  if (userFlag.value) {
    const directory = parseResponse(devUserListSchema, await apiRequest(session.token, "/api/dev/users"), "使用者");
    subject = directory.users.find((user) => user.userId === userFlag.value)?.subject ?? null;
  }
  group.members.push({
    id: member.id,
    name: member.displayName,
    virtual: member.virtual,
    subject,
    claimToken: member.claim?.token ?? null,
  });
  io.stdout(`member_id: ${member.id}`);
  io.stdout(`member_name: ${member.displayName}`);
  io.stdout(`member_virtual: ${member.virtual ? "true" : "false"}`);
  if (member.claim) {
    io.stdout(`claim_path: ${member.claim.claimPath}`);
    io.stdout("activity: member.virtual_created");
  }
}

async function addExpense(args: readonly string[], state: DriverState, io: DriverIo): Promise<void> {
  const session = requireSession(state);
  const parsed = readExpenseFlags(args);
  const group = requireGroup(state, parsed.groupId);
  const result = parseResponse(
    expenseResultSchema,
    await apiRequest(session.token, `/api/groups/${group.id}/expenses`, { method: "POST", body: parsed.body }),
    "支出",
  );
  group.expenses.push({
    id: result.id,
    payerId: parsed.body.payerId,
    amount: parsed.body.amount,
    currency: parsed.body.currency,
    participantIds: parsed.body.participantIds,
    split: parsed.body.split,
    voided: false,
  });
  io.stdout(`expense_id: ${result.id}`);
  io.stdout(`expense_amount_minor: ${parsed.body.amount}`);
  io.stdout(`expense_currency: ${parsed.body.currency}`);
  if (parsed.body.currency !== result.convertedCurrency) {
    io.stdout(`expense_converted_minor: ${result.convertedAmount}`);
    io.stdout(`expense_converted_currency: ${result.convertedCurrency}`);
  }
  io.stdout(`expense_split: ${parsed.body.split.type}`);
  io.stdout(`expense_participants: ${String(parsed.body.participantIds.length)}`);
  printShares(result.shares, result.convertedAmount, io);
  await printInvariants(session.token, group.id, io);
}

async function updateExpense(args: readonly string[], state: DriverState, io: DriverIo): Promise<void> {
  const session = requireSession(state);
  const expenseFlag = takeOption(args, "expense");
  const parsed = readExpenseFlags(expenseFlag.rest);
  const group = requireGroup(state, parsed.groupId);
  const expenseId = requireOption(expenseFlag.value, "expense");
  const result = parseResponse(
    expenseResultSchema,
    await apiRequest(session.token, `/api/groups/${group.id}/expenses/${expenseId}`, {
      method: "PATCH",
      body: parsed.body,
    }),
    "修改支出",
  );
  const next: ExpenseRecord = {
    id: result.id,
    payerId: parsed.body.payerId,
    amount: parsed.body.amount,
    currency: parsed.body.currency,
    participantIds: parsed.body.participantIds,
    split: parsed.body.split,
    voided: false,
  };
  const index = group.expenses.findIndex((expense) => expense.id === expenseId);
  if (index >= 0) group.expenses[index] = next;
  io.stdout(`expense_updated: ${result.id}`);
  io.stdout(`expense_amount_minor: ${parsed.body.amount}`);
  io.stdout(`expense_currency: ${parsed.body.currency}`);
  if (parsed.body.currency !== result.convertedCurrency) {
    io.stdout(`expense_converted_minor: ${result.convertedAmount}`);
    io.stdout(`expense_converted_currency: ${result.convertedCurrency}`);
  }
  io.stdout(`expense_split: ${parsed.body.split.type}`);
  io.stdout(`expense_participants: ${String(parsed.body.participantIds.length)}`);
  printShares(result.shares, result.convertedAmount, io);
  await printInvariants(session.token, group.id, io);
}

async function voidExpense(args: readonly string[], state: DriverState, io: DriverIo): Promise<void> {
  const session = requireSession(state);
  const groupFlag = takeOption(args, "group");
  const expenseFlag = takeOption(groupFlag.rest, "expense");
  rejectUnknown(expenseFlag.rest);
  const group = requireGroup(state, requireOption(groupFlag.value, "group"));
  const expenseId = requireOption(expenseFlag.value, "expense");
  const result = parseResponse(
    voidExpenseResultSchema,
    await apiRequest(session.token, `/api/groups/${group.id}/expenses/${expenseId}/void`, { method: "POST" }),
    "作廢",
  );
  if (result.id !== expenseId) throw new DriverFailure(2, "作廢結果的 id 與請求不一致。");
  const existing = group.expenses.find((expense) => expense.id === expenseId);
  if (existing) existing.voided = true;
  io.stdout(`expense_voided: ${expenseId}`);
  io.stdout("voided: true");
  await printInvariants(session.token, group.id, io);
}

async function showBalances(args: readonly string[], state: DriverState, io: DriverIo): Promise<void> {
  const session = requireSession(state);
  const groupFlag = takeOption(args, "group");
  rejectUnknown(groupFlag.rest);
  const group = requireGroup(state, requireOption(groupFlag.value, "group"));
  await printInvariants(session.token, group.id, io);
}

async function settle(args: readonly string[], state: DriverState, io: DriverIo): Promise<void> {
  const { token } = requireSession(state);
  const groupFlag = takeOption(args, "group");
  const recordFlag = takeFlag(groupFlag.rest, "record");
  rejectUnknown(recordFlag.rest);
  const groupId = requireOption(groupFlag.value, "group");
  const balances = await printInvariants(token, groupId, io);
  const plan = await fetchSettlementPlan(token, groupId);
  const nets = wireBalances(balances.balances);
  const bound = transferBound(nets.length);
  io.stdout(`transfer.count: ${String(plan.transfers.length)}`);
  io.stdout(`transfer.bound: ${String(plan.transferBound)}`);
  assertCheck(io, "invariant.transfer_bound",
    plan.transfers.length <= bound && plan.transferBound === bound && plan.participantCount === nets.length,
    "轉帳數或參與人數不符合餘額。");
  for (const transfer of plan.transfers) {
    io.stdout(`transfer: ${transfer.fromId} -> ${transfer.toId} ${transfer.amount}`);
  }

  const preview = plan.transfers.map((transfer) => ({ ...transfer, amount: parseUnsignedMinor(transfer.amount) }));
  assertCheck(io, recordFlag.present ? "invariant.preview_settled_to_zero" : "invariant.settled_to_zero",
    settledToZero(applyTransfers(nets, preview)), "結清方案沒有讓所有人歸零。");
  if (recordFlag.present) {
    for (const { fromId, toId, amount } of plan.transfers) {
      await postSettlement(token, groupId, {
        fromMemberId: fromId, toMemberId: toId, amount, currency: plan.currency,
      }, io);
    }
    const after = await fetchBalances(token, groupId);
    assertCheck(io, "invariant.settled_to_zero",
      after.sum === "0" && after.balances.length === nets.length &&
      after.balances.every(({ net }) => net === "0"),
      "寫入結清後，伺服器的餘額還沒歸零。");
  } else {
    io.stdout("note: 加上 --record 可把方案寫入帳本。");
  }
}

async function fetchSettlementPlan(token: string, groupId: string) {
  return parseResponse(
    settlementPreviewSchema,
    await apiRequest(token, `/api/groups/${groupId}/settlement-plan`),
    "結清方案",
  );
}

async function recordSettlement(args: readonly string[], state: DriverState, io: DriverIo): Promise<void> {
  const { token } = requireSession(state);
  const groupFlag = takeOption(args, "group");
  const fromFlag = takeOption(groupFlag.rest, "from");
  const toFlag = takeOption(fromFlag.rest, "to");
  const amountFlag = takeOption(toFlag.rest, "amount");
  const currencyFlag = takeOption(amountFlag.rest, "currency");
  const noteFlag = takeOption(currencyFlag.rest, "note");
  rejectUnknown(noteFlag.rest);
  const groupId = requireOption(groupFlag.value, "group");
  const body = settlementWriteSchema.parse({
    fromMemberId: requireOption(fromFlag.value, "from"),
    toMemberId: requireOption(toFlag.value, "to"),
    amount: requireOption(amountFlag.value, "amount"),
    currency: requireOption(currencyFlag.value, "currency"),
    note: noteFlag.value,
  });
  await postSettlement(token, groupId, body, io);
}

async function postSettlement(token: string, groupId: string, body: SettlementWrite, io: DriverIo) {
  const result = parseResponse(
    settlementRecordResultSchema,
    await apiRequest(token, `/api/groups/${groupId}/settlements`, { method: "POST", body }),
    "記錄結清",
  );
  io.stdout(`settlement_id: ${result.id}`);
  return result.id;
}

async function voidSettlement(args: readonly string[], state: DriverState, io: DriverIo): Promise<void> {
  const { token } = requireSession(state);
  const groupFlag = takeOption(args, "group");
  const settlementFlag = takeOption(groupFlag.rest, "settlement");
  rejectUnknown(settlementFlag.rest);
  const groupId = requireOption(groupFlag.value, "group");
  const settlementId = requireOption(settlementFlag.value, "settlement");
  const result = parseResponse(
    settlementVoidResultSchema,
    await apiRequest(token, `/api/groups/${groupId}/settlements/${settlementId}/void`, { method: "POST" }),
    "作廢結清",
  );
  if (result.id !== settlementId) throw new DriverFailure(2, "作廢結果的 id 與請求不一致。");
  io.stdout(`settlement_voided: ${result.id}`);
}

async function paymentProfile(
  args: readonly string[], state: DriverState, io: DriverIo, method: "PUT" | "DELETE",
): Promise<void> {
  const { token } = requireSession(state);
  const groupFlag = takeOption(args, "group");
  const memberFlag = takeOption(groupFlag.rest, "member");
  const groupId = requireOption(groupFlag.value, "group");
  const memberId = requireOption(memberFlag.value, "member");
  const path = `/api/groups/${groupId}/members/${memberId}/payment-profile`;
  if (method === "DELETE") {
    rejectUnknown(memberFlag.rest);
    parseResponse(paymentProfileClearResultSchema, await apiRequest(token, path, { method }), "清除收款方式");
    io.stdout(`payment_profile_cleared: ${memberId}`);
    return;
  }
  const labelFlag = takeOption(memberFlag.rest, "label");
  const detailsFlag = takeOption(labelFlag.rest, "details");
  rejectUnknown(detailsFlag.rest);
  const body = paymentProfileWriteSchema.parse({
    label: requireOption(labelFlag.value, "label"),
    details: requireOption(detailsFlag.value, "details"),
  });
  const result = parseResponse(
    paymentProfileUpdateResultSchema, await apiRequest(token, path, { method, body }), "設定收款方式",
  );
  io.stdout(`payment_profile_id: ${result.id}`);
}

async function showSummary(args: readonly string[], state: DriverState, io: DriverIo): Promise<void> {
  const { token } = requireSession(state);
  const groupFlag = takeOption(args, "group");
  rejectUnknown(groupFlag.rest);
  const groupId = requireOption(groupFlag.value, "group");
  const summary = parseResponse(
    groupSummarySchema, await apiRequest(token, `/api/groups/${groupId}/summary`), "摘要",
  );
  const balances = await fetchBalances(token, groupId);
  io.stdout(`summary.currency: ${summary.currency}`);
  for (const { memberId, paid, share, settledPaid, settledReceived, net } of summary.members) {
    io.stdout(`summary.member.${memberId}: paid=${paid} share=${share} settled_paid=${settledPaid} settled_received=${settledReceived} net=${net}`);
  }
  for (const { category, total } of summary.categories) {
    io.stdout(`summary.category: ${JSON.stringify(category)} ${total}`);
  }
  io.stdout(`summary.total_spent: ${summary.totalSpent}`);

  const nets = new Map(balances.balances.map(({ participantId, net }) => [participantId, net]));
  const summaryNets = new Map(summary.members.map(({ memberId, net }) => [memberId, net]));
  const matches = summary.members.every(({ memberId, net }) => net === (nets.get(memberId) ?? "0")) &&
    balances.balances.every(({ participantId, net }) => summaryNets.get(participantId) === net);
  const total = sumMinor(summary.categories.map(({ total }) => parseUnsignedMinor(total)));
  const categoriesMatch = total === parseUnsignedMinor(summary.totalSpent);
  printCheck(io, "invariant.summary_matches_balances", matches);
  printCheck(io, "invariant.categories_sum_to_total", categoriesMatch);
  if (!matches || !categoriesMatch) throw new DriverFailure(2, "摘要與餘額或分類合計不一致。");
}

async function shareLink(args: readonly string[], state: DriverState, io: DriverIo): Promise<void> {
  const session = requireSession(state);
  const groupFlag = takeOption(args, "group");
  rejectUnknown(groupFlag.rest);
  const group = requireGroup(state, requireOption(groupFlag.value, "group"));
  const invite = parseResponse(
    inviteResultSchema,
    await apiRequest(session.token, `/api/groups/${group.id}/invites`, { method: "POST" }),
    "邀請",
  );
  group.invites.push({ id: newId("inv"), token: invite.token, path: invite.invitePath, createdBySubject: session.subject });
  io.stdout(`invite_path: ${invite.invitePath}`);
  io.stdout("share_surface: link");
  io.stdout("note: LIFF shareTargetPicker 與 Flex Message 屬於後續切片。這條指令只建立邀請連結，不送進 LINE 聊天。");
}

async function claimMember(args: readonly string[], state: DriverState, io: DriverIo): Promise<void> {
  const session = requireSession(state);
  const tokenFlag = takeOption(args, "token");
  rejectUnknown(tokenFlag.rest);
  const token = requireOption(tokenFlag.value, "token");
  const before = parseResponse(
    claimPreviewSchema,
    await apiRequest(session.token, `/api/claims/${token}`),
    "認領預覽",
  );
  const result = parseResponse(
    claimResultSchema,
    await apiRequest(session.token, `/api/claims/${token}`, { method: "POST" }),
    "認領",
  );
  const detail = parseResponse(
    groupDetailSchema,
    await apiRequest(session.token, `/api/groups/${result.groupId}`),
    "群組",
  );
  const seated = detail.members.find((member) => member.id === before.memberId);
  const samePerson =
    before.memberId === result.member.id &&
    seated?.id === result.member.id &&
    seated.userId === session.userId &&
    seated.virtual === false &&
    result.member.virtual === false;
  const sharesStay = detail.expenses.every((expense) =>
    expense.shares.every((share) => share.participantId !== before.memberId || share.participantId === result.member.id),
  );
  const activity = parseResponse(
    activityResultSchema,
    await apiRequest(session.token, `/api/groups/${result.groupId}/activity`),
    "活動",
  );
  const claimed = activity.entries.find(
    (entry) => entry.action === "member.claimed" && entry.entityId === result.member.id,
  );
  const group = state.groups.find((item) => item.id === result.groupId);
  const index = group?.members.findIndex((member) => member.id === result.member.id) ?? -1;
  if (group && index >= 0) {
    group.members[index] = {
      id: result.member.id,
      name: result.member.displayName,
      virtual: result.member.virtual,
      subject: session.subject,
      claimToken: null,
    };
  }
  io.stdout(`claim.previous_member_id: ${before.memberId}`);
  io.stdout(`claim.member_id: ${result.member.id}`);
  io.stdout(`claim.group_id: ${result.groupId}`);
  io.stdout(`claim.user_id: ${result.member.userId ?? ""}`);
  io.stdout(`member_virtual: ${result.member.virtual ? "true" : "false"}`);
  io.stdout(`activity: ${claimed?.action ?? "missing"}`);
  io.stdout(`activity.claim: ${claimed?.summary ?? "missing"}`);
  io.stdout(`invariant.claim_keeps_member_id: ${samePerson ? "pass" : "fail"}`);
  io.stdout(`invariant.claim_keeps_shares: ${sharesStay ? "pass" : "fail"}`);
  if (!samePerson) throw new DriverFailure(2, "認領改掛到別的成員。");
  if (!sharesStay) throw new DriverFailure(2, "認領之後找不到原本的份額。");
  if (!claimed) throw new DriverFailure(2, "活動紀錄沒有把認領和建立虛擬成員分開。");
}

async function joinGroup(args: readonly string[], state: DriverState, io: DriverIo): Promise<void> {
  const session = requireSession(state);
  const tokenFlag = takeOption(args, "token");
  rejectUnknown(tokenFlag.rest);
  const token = requireOption(tokenFlag.value, "token");
  const result = parseResponse(
    joinResultSchema,
    await apiRequest(session.token, `/api/invites/${token}/accept`, { method: "POST" }),
    "加入",
  );
  const group = state.groups.find((item) => item.id === result.groupId);
  if (group && !group.members.some((member) => member.id === result.member.id)) {
    group.members.push({
      id: result.member.id,
      name: result.member.displayName,
      virtual: result.member.virtual,
      subject: session.subject,
      claimToken: null,
    });
  }
  io.stdout(`join.member_id: ${result.member.id}`);
  io.stdout(`join.group_id: ${result.groupId}`);
  io.stdout(`join.already_member: ${result.alreadyMember ? "true" : "false"}`);
  io.stdout(`member_virtual: ${result.member.virtual ? "true" : "false"}`);
  io.stdout("activity: member.joined");
}

async function fetchBalances(token: string, groupId: string) {
  return parseResponse(
    balancesResultSchema,
    await apiRequest(token, `/api/groups/${groupId}/balances`),
    "餘額",
  );
}

async function printInvariants(token: string, groupId: string, io: DriverIo) {
  const balances = await fetchBalances(token, groupId);
  io.stdout(`group_id: ${balances.groupId}`);
  for (const row of balances.balances) io.stdout(`balance.${row.participantId}: ${row.net}`);
  io.stdout(`balances_sum_minor: ${balances.sum}`);
  io.stdout(`invariant.balances_sum_to_zero: ${balances.sum === "0" ? "pass" : "fail"}`);
  if (balances.sum !== "0") throw new DriverFailure(2, "餘額總和不是 0。");
  const detail = parseResponse(groupDetailSchema, await apiRequest(token, `/api/groups/${groupId}`), "群組");
  const expected = computeBalances(
    detail.expenses
      .filter((expense) => !expense.voided)
      .map((expense) => {
        const converted = allocateConvertedExpense({
          amount: parseUnsignedMinor(expense.amount),
          fromCurrency: expense.currency,
          toCurrency: detail.group.defaultCurrency,
          fxNumerator: expense.fxRate?.numerator ?? null,
          fxDenominator: expense.fxRate?.denominator ?? null,
          participantIds: expense.participantIds,
          split: wireSplit(expense.split),
        });
        return {
          payerId: expense.payerId,
          amount: converted.convertedAmount,
          participantIds: converted.convertedShares.map((share) => share.participantId),
          split: {
            type: "exact" as const,
            amounts: Object.fromEntries(converted.convertedShares.map((share) => [share.participantId, share.amount])),
          },
        };
      }),
    detail.settlements.filter((row) => !row.voided).map((row) => ({
      fromId: row.fromMemberId,
      toId: row.toMemberId,
      amount: parseUnsignedMinor(row.amount),
    })),
  );
  const actual = new Map(balances.balances.map((row) => [row.participantId, row.net]));
  const same =
    expected.length === actual.size &&
    expected.every((row) => actual.get(row.participantId) === formatMinor(row.net));
  io.stdout(`invariant.balances_match_splits: ${same ? "pass" : "fail"}`);
  if (!same) throw new DriverFailure(2, "餘額和這幾筆帳的分法不一致。");
  return balances;
}

function printShares(shares: readonly { participantId: string; amount: string }[], amount: string, io: DriverIo): void {
  for (const share of shares) io.stdout(`share.${share.participantId}: ${share.amount}`);
  const total = sumMinor(shares.map((share) => parseUnsignedMinor(share.amount)));
  const same = toMinorUnits(total) === toMinorUnits(parseUnsignedMinor(amount));
  io.stdout(`invariant.shares_sum_to_amount: ${same ? "pass" : "fail"}`);
  if (!same) throw new DriverFailure(2, "份額合計不等於支出金額。");
}

function wireBalances(rows: readonly { participantId: string; net: string }[]): NetBalance[] {
  return rows.map((row) => ({ participantId: row.participantId, net: parseSignedMinor(row.net) }));
}

function readExpenseFlags(args: readonly string[]) {
  const groupFlag = takeOption(args, "group");
  const payerFlag = takeOption(groupFlag.rest, "payer");
  const amountFlag = takeOption(payerFlag.rest, "amount");
  const currencyFlag = takeOption(amountFlag.rest, "currency");
  const fxRateFlag = takeOption(currencyFlag.rest, "fx-rate");
  const participantsFlag = takeOption(fxRateFlag.rest, "participants");
  const splitFlag = takeOption(participantsFlag.rest, "split");
  const amountsFlag = takeOption(splitFlag.rest, "amounts");
  const pointsFlag = takeOption(amountsFlag.rest, "basis-points");
  const weightsFlag = takeOption(pointsFlag.rest, "weights");
  const categoryFlag = takeOption(weightsFlag.rest, "category");
  const noteFlag = takeOption(categoryFlag.rest, "note");
  rejectUnknown(noteFlag.rest);
  const groupId = requireOption(groupFlag.value, "group");
  const participantIds = requireOption(participantsFlag.value, "participants")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  const split = buildSplit(splitFlag.value ?? "equal", participantIds, amountsFlag.value, pointsFlag.value, weightsFlag.value);
  let fxRate: FxRateWire | undefined;
  if (fxRateFlag.value !== undefined) {
    try {
      fxRate = parseRateRatio(fxRateFlag.value);
    } catch (error) {
      if (error instanceof LedgerError) throw new DriverFailure(1, error.message);
      throw error;
    }
  }
  const body = {
    groupId,
    payerId: requireOption(payerFlag.value, "payer"),
    amount: requireOption(amountFlag.value, "amount"),
    currency: requireOption(currencyFlag.value, "currency"),
    ...(fxRate ? { fxRate } : {}),
    participantIds,
    split,
    ...(categoryFlag.value ? { category: categoryFlag.value } : {}),
    ...(noteFlag.value ? { note: noteFlag.value } : {}),
  };
  const parsed = expenseInputSchema.safeParse(body);
  if (!parsed.success) {
    throw new DriverFailure(1, `支出不符合契約：${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return { groupId, body: parsed.data };
}

function printDemo(io: DriverIo): void {
  const eaters = ["a2", "a3", "a4", "a5", "me"];
  const balances = computeBalances([
    { payerId: "me", amount: minor(3000n), participantIds: eaters, split: { type: "equal" } },
  ]);
  const transfers = simplifyDebts(balances);
  io.stdout("# 範例：10 人的群組裡只有 5 人吃飯，我付了 3000 JPY，平均分");
  io.stdout("command: demo");
  io.stdout("member_count: 10");
  io.stdout("ate: 5");
  io.stdout("amount_minor: 3000");
  io.stdout("currency: JPY");
  for (const row of balances) io.stdout(`balance.${row.participantId}: ${formatMinor(row.net)}`);
  const total = toMinorUnits(balancesSum(balances));
  io.stdout(`invariant.balances_sum_to_zero: ${total === 0n ? "pass" : "fail"}`);
  io.stdout(`transfer.count: ${String(transfers.length)}`);
  io.stdout(`transfer.bound: ${String(transferBound(balances.length))}`);
  io.stdout(`invariant.settled_to_zero: ${settledToZero(applyTransfers(balances, transfers)) ? "pass" : "fail"}`);
  io.stdout("note: 沒出現在餘額向量裡的成員視為 0。driver demo 不寫入 D1，也不代表切片 1 已完成。");
  if (total !== 0n) throw new DriverFailure(2, "demo 的餘額總和不是 0。");
}

function requireSession(state: DriverState): Session {
  if (!state.session?.token) throw new DriverFailure(1, "還沒登入。請先 login --as alice。");
  return state.session;
}

function requireGroup(state: DriverState, groupId: string): GroupRecord {
  const group = state.groups.find((item) => item.id === groupId);
  if (!group) throw new DriverFailure(1, `找不到群組 ${groupId}。`);
  return group;
}

function parseResponse<T>(
  schema: {
    safeParse: (
      value: unknown,
    ) => { success: true; data: T } | { success: false; error: { issues: readonly { message: string }[] } };
  },
  value: unknown,
  label: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new DriverFailure(2, `${label} 不符合契約：${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return parsed.data;
}

function wireSplit(split: SplitWire): SplitSpec {
  if (split.type === "equal") return { type: "equal" };
  if (split.type === "percentage") return { type: "percentage", basisPoints: split.basisPoints };
  if (split.type === "shares") return { type: "shares", weights: split.weights };
  const amounts: Record<string, Minor> = {};
  for (const [id, value] of Object.entries(split.amounts)) amounts[id] = parseUnsignedMinor(value);
  return { type: "exact", amounts };
}

function buildSplit(
  type: string,
  participantIds: readonly string[],
  amounts: string | undefined,
  basisPoints: string | undefined,
  weights: string | undefined,
): SplitWire {
  if (type === "equal") return { type: "equal" };
  if (type === "exact") {
    return { type: "exact", amounts: parsePairs(requireOption(amounts, "amounts"), participantIds) };
  }
  if (type === "percentage") {
    return {
      type: "percentage",
      basisPoints: parseIntPairs(requireOption(basisPoints, "basis-points"), participantIds),
    };
  }
  if (type === "shares") {
    return { type: "shares", weights: parseIntPairs(requireOption(weights, "weights"), participantIds) };
  }
  throw new DriverFailure(1, "--split 只能是 equal、exact、percentage 或 shares。");
}

function parsePairs(raw: string, participantIds: readonly string[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const [id, value] = part.split("=");
    if (!id || !value) throw new DriverFailure(1, `配對「${part}」必須是 id=值。`);
    if (!participantIds.includes(id)) throw new DriverFailure(1, `${id} 不在參與者裡。`);
    record[id] = value;
  }
  return record;
}

function parseIntPairs(raw: string, participantIds: readonly string[]): Record<string, number> {
  const pairs = parsePairs(raw, participantIds);
  const record: Record<string, number> = {};
  for (const [id, value] of Object.entries(pairs)) {
    if (!/^[1-9][0-9]*$/.test(value)) throw new DriverFailure(1, `${id} 的權重必須是正整數。`);
    record[id] = Number(value);
  }
  return record;
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
