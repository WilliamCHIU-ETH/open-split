const MONEY_NAME =
  /^(amount|amounts|amountMinor|balance|balances|minorUnits|netMinor|paidMinor|owedMinor|cents)$/;
const ARITHMETIC = new Set(["+", "-", "*", "/", "%"]);
const LEDGER_FUNCTIONS = new Set([
  "allocate",
  "computeBalances",
  "simplifyDebts",
  "applyTransfers",
  "settleUp",
  "splitEqual",
  "splitExact",
  "splitByShares",
  "splitByPercentage",
  "netBalances",
]);

function normalize(filename) {
  return String(filename ?? "").replaceAll("\\", "/");
}

function isCoreSrc(filename) {
  return normalize(filename).includes("/packages/core/src/");
}

function isContracts(filename) {
  return normalize(filename).includes("/packages/contracts/");
}

function containsNumberKeyword(typeNode) {
  if (!typeNode) return false;
  if (typeNode.type === "TSNumberKeyword") return true;
  if (typeNode.type === "TSUnionType" || typeNode.type === "TSIntersectionType") {
    return typeNode.types.some(containsNumberKeyword);
  }
  if (typeNode.type === "TSParenthesizedType") return containsNumberKeyword(typeNode.typeAnnotation);
  return false;
}

function identName(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") {
    return node.property.name;
  }
  return null;
}

function isFloatLiteral(node) {
  return (
    node.type === "Literal" &&
    typeof node.value === "number" &&
    typeof node.raw === "string" &&
    /[.eE]/.test(node.raw)
  );
}

function isMoneyContext(node) {
  let current = node.parent;
  let depth = 0;
  while (current && depth < 4) {
    if (current.type === "VariableDeclarator" && current.id.type === "Identifier" && MONEY_NAME.test(current.id.name)) {
      return true;
    }
    if (current.type === "BinaryExpression") {
      const left = identName(current.left);
      const right = identName(current.right);
      if ((left && MONEY_NAME.test(left)) || (right && MONEY_NAME.test(right))) return true;
    }
    if (
      current.type === "Property" &&
      !current.computed &&
      current.key.type === "Identifier" &&
      MONEY_NAME.test(current.key.name)
    ) {
      return true;
    }
    current = current.parent;
    depth += 1;
  }
  return false;
}

const noNumberMoney = {
  meta: {
    type: "problem",
    docs: { description: "Money is integer minor units, never a JS number." },
    schema: [],
    messages: {
      numberMoney:
        "金額「{{name}}」不能標成 number。WHY: IEEE-754 二進位浮點數無法精確表示十進位貨幣，用 number 做分帳會憑空多出或吃掉分錢。請改用 @open-split/core 的 Minor（bigint）。唯一允許的 number 邊界是 minorFromSafeInteger()，而且呼叫後不可再把金額留在 number。",
      floatLiteral:
        "金額運算出現浮點字面值 {{raw}}。WHY: 0.1 這類十進位在二進位浮點裡不是精確值，餘數會對不起來。請用整數最小貨幣單位，除法留在 @open-split/core 的整數配置。",
      moneyArithmetic:
        "在 packages/core 之外對「{{name}}」做了算術。WHY: 分帳與餘額的守恆只在 core 的性質測試裡被鎖住。應用層自己加減乘除會走出第二套帳。請呼叫 allocate、computeBalances 或 simplifyDebts。",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();

    function reportNumberMoney(name, typeNode, node) {
      if (!name || !MONEY_NAME.test(name) || !containsNumberKeyword(typeNode)) return;
      context.report({ node, messageId: "numberMoney", data: { name } });
    }

    return {
      Identifier(node) {
        if (!node.typeAnnotation) return;
        reportNumberMoney(node.name, node.typeAnnotation.typeAnnotation, node);
      },
      TSPropertySignature(node) {
        if (node.key.type !== "Identifier" || !node.typeAnnotation) return;
        reportNumberMoney(node.key.name, node.typeAnnotation.typeAnnotation, node.key);
      },
      BinaryExpression(node) {
        if (!ARITHMETIC.has(node.operator) || isCoreSrc(filename)) return;
        const left = identName(node.left);
        const right = identName(node.right);
        const name = left && MONEY_NAME.test(left) ? left : right && MONEY_NAME.test(right) ? right : null;
        if (!name) return;
        context.report({ node, messageId: "moneyArithmetic", data: { name } });
      },
      Literal(node) {
        if (!isFloatLiteral(node)) return;
        if (!isCoreSrc(filename) && !isMoneyContext(node)) return;
        context.report({ node, messageId: "floatLiteral", data: { raw: node.raw } });
      },
    };
  },
};

const noLedgerMathOutsideCore = {
  meta: {
    type: "problem",
    docs: { description: "Ledger math is only defined in @open-split/core." },
    schema: [],
    messages: {
      localLedger:
        "「{{name}}」在 @open-split/core 之外實作了帳本數學。WHY: 分帳、餘額與債務簡化的不變量只在 packages/core 做性質測試。apps 或 driver 再寫一份就會和網頁、MCP 分叉，而且可能多出或吃掉分錢。請改呼叫 @open-split/core 的公開函式。",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (isCoreSrc(filename)) return {};

    function check(name, node) {
      if (!name || !LEDGER_FUNCTIONS.has(name)) return;
      context.report({ node, messageId: "localLedger", data: { name } });
    }

    return {
      FunctionDeclaration(node) {
        check(node.id?.name, node.id ?? node);
      },
      VariableDeclarator(node) {
        if (node.id.type !== "Identifier") return;
        const init = node.init;
        if (!init) return;
        if (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression") {
          check(node.id.name, node.id);
        }
      },
      MethodDefinition(node) {
        if (node.key.type === "Identifier") check(node.key.name, node.key);
      },
    };
  },
};

const noZodOutsideContracts = {
  meta: {
    type: "problem",
    docs: { description: "Zod schemas live only in @open-split/contracts." },
    schema: [],
    messages: {
      zodImport:
        "只有 packages/contracts 可以匯入 zod。WHY: 網頁 API 與 MCP 工具必須共用同一套輸入輸出，否則外部代理人與網頁會寫進兩套不同的帳。請從 @open-split/contracts 匯入既有 schema，不要在這裡再定義一份。",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (isContracts(filename)) return {};

    function checkSource(source, node) {
      if (source === "zod" || source.startsWith("zod/")) {
        context.report({ node, messageId: "zodImport" });
      }
    }

    return {
      ImportDeclaration(node) {
        if (typeof node.source.value === "string") checkSource(node.source.value, node.source);
      },
      ImportExpression(node) {
        if (node.source.type === "Literal" && typeof node.source.value === "string") {
          checkSource(node.source.value, node.source);
        }
      },
    };
  },
};

const BANNED_CORE_IMPORT =
  /^(node:|cloudflare:|fs|path|net|http|https|crypto|child_process|hono|drizzle-orm|zod|@cloudflare\/)/;

const coreNoIo = {
  meta: {
    type: "problem",
    docs: { description: "packages/core cannot import I/O, Workers, the database, or the network." },
    schema: [],
    messages: {
      ioImport:
        "packages/core 不能匯入「{{source}}」。WHY: 帳本數學必須是純函式，同一組輸入永遠得到同一組餘額，性質測試才有意義。Workers、D1、檔案與網路會讓結果跟著環境變。請把 I/O 留在 apps/worker，schema 留在 @open-split/contracts。",
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (!isCoreSrc(filename)) return {};

    function check(source, node) {
      if (typeof source !== "string" || source.startsWith(".")) return;
      if (BANNED_CORE_IMPORT.test(source) || source.startsWith("drizzle-orm/") || source.startsWith("@cloudflare/")) {
        context.report({ node, messageId: "ioImport", data: { source } });
      }
    }

    return {
      ImportDeclaration(node) {
        check(node.source.value, node.source);
      },
      ImportExpression(node) {
        if (node.source.type === "Literal") check(node.source.value, node.source);
      },
      ExportAllDeclaration(node) {
        check(node.source.value, node.source);
      },
      ExportNamedDeclaration(node) {
        if (node.source) check(node.source.value, node.source);
      },
    };
  },
};

const plugin = {
  meta: { name: "@open-split/eslint-plugin", version: "0.0.0" },
  rules: {
    "no-number-money": noNumberMoney,
    "no-ledger-math-outside-core": noLedgerMathOutsideCore,
    "no-zod-outside-contracts": noZodOutsideContracts,
    "core-no-io": coreNoIo,
  },
};

export default plugin;
