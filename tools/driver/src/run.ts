import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertDevAuthAllowed,
  createDevGoogleProvider,
  createDevLineProvider,
  type AuthProviderId,
} from "@open-split/auth";
import { expenseInputSchema, parseUnsignedMinor, type SplitWire } from "@open-split/contracts";
import {
  applyTransfers,
  balancesSum,
  computeBalances,
  formatMinor,
  minor,
  settledToZero,
  simplifyDebts,
  toMinorUnits,
  transferBound,
  type Expense,
  type Minor,
  type SplitSpec,
} from "@open-split/core";
import { rejectUnknown, requireOption, takeFlag, takeOption } from "./args.ts";
import { DriverFailure } from "./failure.ts";
import { loadState, saveState, type DriverState, type GroupRecord, type Session } from "./state.ts";

export interface DriverIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const HELP = `open-split-driver 是驗收用的本機驅動，不是產品 API。

  login --as <name> [--provider line|google] [--environment development]
  whoami
  create-group --name <name> [--currency TWD]
  add-member --group <id> --name <name> [--virtual]
  add-expense --group <id> --payer <memberId> --amount <minor> --currency <ISO> --participants <id,id> [--split equal|exact|percentage|shares]
  show-balances --group <id>
  settle --group <id>
  share-link --group <id>
  demo
  accept

金額一律是整數最小貨幣單位。alice 與 bob 是穩定的假身份。
狀態檔預設是 ./.open-split-driver/state.json，可用 --state 換掉。
accept 會跑：登入 alice → 建群 → 加虛擬成員 bob → 平均分帳 → 印餘額與結清方案 → 邀請連結。`;

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
  await dispatch(["login", "--as", "alice"], state, io);
  await dispatch(["create-group", "--name", "京都週末", "--currency", "JPY"], state, io);
  const group = state.groups[0];
  if (!group) throw new DriverFailure(2, "accept 沒有建立群組。");
  const owner = group.members[0];
  if (!owner) throw new DriverFailure(2, "accept 沒有建立擁有者。");
  await dispatch(["add-member", "--group", group.id, "--name", "Bob", "--virtual"], state, io);
  const bob = group.members[1];
  if (!bob) throw new DriverFailure(2, "accept 沒有建立虛擬成員。");
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
      `${owner.id},${bob.id}`,
      "--split",
      "equal",
    ],
    state,
    io,
  );
  await dispatch(["show-balances", "--group", group.id], state, io);
  await dispatch(["settle", "--group", group.id], state, io);
  await dispatch(["share-link", "--group", group.id], state, io);
  await saveState(statePath, state);
  io.stdout(`state: ${statePath}`);
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
    case "show-balances":
      return showBalances(args, state, io);
    case "settle":
      return settle(args, state, io);
    case "share-link":
      return shareLink(args, state, io);
    default:
      throw new DriverFailure(1, `不認識的指令 ${command}。執行時加上 help 可看指令形狀。`);
  }
}

function login(args: readonly string[], state: DriverState, io: DriverIo): void {
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
  const identity = (provider === "line" ? createDevLineProvider() : createDevGoogleProvider()).signInAs(name);
  state.session = {
    provider: provider as AuthProviderId,
    name,
    subject: identity.subject,
    displayName: identity.displayName,
  };
  io.stdout(`login.provider: ${state.session.provider}`);
  io.stdout(`login.name: ${state.session.name}`);
  io.stdout(`login.subject: ${state.session.subject}`);
  io.stdout(`login.display_name: ${state.session.displayName}`);
  io.stdout(`login.environment: ${environment}`);
}

function whoami(state: DriverState, io: DriverIo): void {
  if (!state.session) {
    io.stdout("login.subject: (none)");
    return;
  }
  io.stdout(`login.provider: ${state.session.provider}`);
  io.stdout(`login.name: ${state.session.name}`);
  io.stdout(`login.subject: ${state.session.subject}`);
}

function createGroup(args: readonly string[], state: DriverState, io: DriverIo): void {
  const session = requireSession(state);
  const nameFlag = takeOption(args, "name");
  const currencyFlag = takeOption(nameFlag.rest, "currency");
  rejectUnknown(currencyFlag.rest);
  const name = requireOption(nameFlag.value, "name");
  const currency = currencyFlag.value ?? "TWD";
  if (!/^[A-Z]{3}$/.test(currency)) throw new DriverFailure(1, "幣別必須是三個大寫字母。");
  const groupId = newId("grp");
  const memberId = newId("mem");
  state.groups.push({
    id: groupId,
    name,
    currency,
    createdBySubject: session.subject,
    members: [{ id: memberId, name: session.displayName, virtual: false, subject: session.subject }],
    expenses: [],
    invites: [],
  });
  io.stdout(`group_id: ${groupId}`);
  io.stdout(`group_name: ${name}`);
  io.stdout(`owner_member_id: ${memberId}`);
  io.stdout(`currency: ${currency}`);
}

function addMember(args: readonly string[], state: DriverState, io: DriverIo): void {
  requireSession(state);
  const groupFlag = takeOption(args, "group");
  const nameFlag = takeOption(groupFlag.rest, "name");
  const virtualFlag = takeFlag(nameFlag.rest, "virtual");
  rejectUnknown(virtualFlag.rest);
  const group = requireGroup(state, requireOption(groupFlag.value, "group"));
  const name = requireOption(nameFlag.value, "name");
  const memberId = newId("mem");
  group.members.push({ id: memberId, name, virtual: virtualFlag.present, subject: null });
  io.stdout(`member_id: ${memberId}`);
  io.stdout(`member_name: ${name}`);
  io.stdout(`member_virtual: ${virtualFlag.present ? "true" : "false"}`);
}

function addExpense(args: readonly string[], state: DriverState, io: DriverIo): void {
  requireSession(state);
  const groupFlag = takeOption(args, "group");
  const payerFlag = takeOption(groupFlag.rest, "payer");
  const amountFlag = takeOption(payerFlag.rest, "amount");
  const currencyFlag = takeOption(amountFlag.rest, "currency");
  const participantsFlag = takeOption(currencyFlag.rest, "participants");
  const splitFlag = takeOption(participantsFlag.rest, "split");
  const amountsFlag = takeOption(splitFlag.rest, "amounts");
  const pointsFlag = takeOption(amountsFlag.rest, "basis-points");
  const weightsFlag = takeOption(pointsFlag.rest, "weights");
  rejectUnknown(weightsFlag.rest);

  const group = requireGroup(state, requireOption(groupFlag.value, "group"));
  const payerId = requireOption(payerFlag.value, "payer");
  const amount = requireOption(amountFlag.value, "amount");
  const currency = requireOption(currencyFlag.value, "currency");
  const participantIds = requireOption(participantsFlag.value, "participants")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  const splitType = splitFlag.value ?? "equal";
  if (currency !== group.currency) {
    throw new DriverFailure(1, "多幣別換算屬於切片 4。driver 目前只接受與群組相同的幣別。");
  }
  for (const id of [payerId, ...participantIds]) {
    if (!group.members.some((member) => member.id === id)) {
      throw new DriverFailure(1, `${id} 不是這個群組的成員。`);
    }
  }
  const split = buildSplit(splitType, participantIds, amountsFlag.value, pointsFlag.value, weightsFlag.value);
  const parsed = expenseInputSchema.safeParse({
    groupId: group.id,
    payerId,
    amount,
    currency,
    participantIds,
    split,
  });
  if (!parsed.success) {
    throw new DriverFailure(1, `支出不符合契約：${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  const expenseId = newId("exp");
  group.expenses.push({
    id: expenseId,
    payerId: parsed.data.payerId,
    amount: parsed.data.amount,
    currency: parsed.data.currency,
    participantIds: parsed.data.participantIds,
    split: parsed.data.split,
  });
  io.stdout(`expense_id: ${expenseId}`);
  io.stdout(`expense_amount_minor: ${parsed.data.amount}`);
  io.stdout(`expense_currency: ${parsed.data.currency}`);
  io.stdout(`expense_split: ${parsed.data.split.type}`);
  printInvariants(group, io);
}

function showBalances(args: readonly string[], state: DriverState, io: DriverIo): void {
  const groupFlag = takeOption(args, "group");
  rejectUnknown(groupFlag.rest);
  const group = requireGroup(state, requireOption(groupFlag.value, "group"));
  printInvariants(group, io);
}

function settle(args: readonly string[], state: DriverState, io: DriverIo): void {
  const groupFlag = takeOption(args, "group");
  rejectUnknown(groupFlag.rest);
  const group = requireGroup(state, requireOption(groupFlag.value, "group"));
  const balances = projectBalances(group);
  const transfers = simplifyDebts(balances);
  const bound = transferBound(balances.length);
  io.stdout(`transfer.count: ${String(transfers.length)}`);
  io.stdout(`transfer.bound: ${String(bound)}`);
  io.stdout(`invariant.transfer_bound: ${transfers.length <= bound ? "pass" : "fail"}`);
  if (transfers.length > bound) throw new DriverFailure(2, "轉帳數超過參與者 − 1。");
  for (const transfer of transfers) {
    io.stdout(`transfer: ${transfer.fromId} -> ${transfer.toId} ${formatMinor(transfer.amount)}`);
  }
  const cleared = settledToZero(applyTransfers(balances, transfers));
  io.stdout(`invariant.settled_to_zero: ${cleared ? "pass" : "fail"}`);
  if (!cleared) throw new DriverFailure(2, "結清方案沒有讓所有人歸零。");
  io.stdout("note: 這只印出結清方案。把結清寫入帳本是切片 3。");
}

function shareLink(args: readonly string[], state: DriverState, io: DriverIo): void {
  const session = requireSession(state);
  const groupFlag = takeOption(args, "group");
  rejectUnknown(groupFlag.rest);
  const group = requireGroup(state, requireOption(groupFlag.value, "group"));
  const token = randomUUID();
  const path = `/invite/${token}`;
  group.invites.push({ id: newId("inv"), token, path, createdBySubject: session.subject });
  io.stdout(`invite_path: ${path}`);
  io.stdout("share_surface: link");
  io.stdout("note: LIFF shareTargetPicker 與 Flex Message 屬於後續切片。這條指令只建立邀請連結，不送進 LINE 聊天。");
}

function printInvariants(group: GroupRecord, io: DriverIo): void {
  const balances = projectBalances(group);
  io.stdout(`group_id: ${group.id}`);
  for (const row of balances) {
    io.stdout(`balance.${row.participantId}: ${formatMinor(row.net)}`);
  }
  const sum = toMinorUnits(balancesSum(balances));
  io.stdout(`balances_sum_minor: ${sum.toString(10)}`);
  io.stdout(`invariant.balances_sum_to_zero: ${sum === 0n ? "pass" : "fail"}`);
  if (sum !== 0n) throw new DriverFailure(2, "餘額總和不是 0。");
}

function projectBalances(group: GroupRecord) {
  const expenses: Expense[] = group.expenses.map((expense) => ({
    payerId: expense.payerId,
    amount: parseUnsignedMinor(expense.amount),
    participantIds: expense.participantIds,
    split: toCoreSplit(expense.split),
  }));
  return computeBalances(expenses);
}

function toCoreSplit(split: SplitWire): SplitSpec {
  switch (split.type) {
    case "equal":
      return { type: "equal" };
    case "exact": {
      const amounts: Record<string, Minor> = {};
      for (const [id, value] of Object.entries(split.amounts)) amounts[id] = parseUnsignedMinor(value);
      return { type: "exact", amounts };
    }
    case "percentage":
      return { type: "percentage", basisPoints: split.basisPoints };
    case "shares":
      return { type: "shares", weights: split.weights };
    default: {
      const unexpected: never = split;
      throw new DriverFailure(1, `不認識的分帳 ${String(unexpected)}。`);
    }
  }
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
  const sum = toMinorUnits(balancesSum(balances));
  io.stdout(`invariant.balances_sum_to_zero: ${sum === 0n ? "pass" : "fail"}`);
  io.stdout(`transfer.count: ${String(transfers.length)}`);
  io.stdout(`transfer.bound: ${String(transferBound(balances.length))}`);
  io.stdout(`invariant.settled_to_zero: ${settledToZero(applyTransfers(balances, transfers)) ? "pass" : "fail"}`);
  io.stdout("note: 沒出現在餘額向量裡的成員視為 0。driver demo 不寫入 D1，也不代表切片 1 已完成。");
  if (sum !== 0n) throw new DriverFailure(2, "demo 的餘額總和不是 0。");
}

function requireSession(state: DriverState): Session {
  if (!state.session) throw new DriverFailure(1, "還沒登入。請先 login --as alice。");
  return state.session;
}

function requireGroup(state: DriverState, groupId: string): GroupRecord {
  const group = state.groups.find((item) => item.id === groupId);
  if (!group) throw new DriverFailure(1, `找不到群組 ${groupId}。`);
  return group;
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
