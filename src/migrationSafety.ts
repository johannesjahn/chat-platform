// Flags migration statements that break the code still running during a
// rolling deploy. With DATABASE_URL set, migrations run once (the chart's
// pre-upgrade Job, compose's db-migrate) and old replicas keep serving
// against the migrated schema until they're replaced, so every migration has
// to be expand-only: old code must still read and write everything it did.
// A contract step (dropping what no deployed release uses any more) is a
// separate migration in a later release, and says so per statement:
//
//   -- migration-safety: allow drop-column (unused since 0.42.0, #123)
//   ALTER TABLE "posts" DROP COLUMN "legacy";--> statement-breakpoint
//
// This is a guard over drizzle-kit's output and hand-written SQL, not a SQL
// parser: it matches statements textually after removing comments, string
// literals and dollar-quoted bodies, so a function body can't trip it.

export type MigrationRule =
  | "drop-table"
  | "drop-column"
  | "rename"
  | "column-type"
  | "set-not-null"
  | "drop-default"
  | "not-null-without-default"
  | "new-constraint";

export const MIGRATION_RULES: Record<MigrationRule, string> = {
  "drop-table": "drops a table old replicas still query",
  "drop-column": "drops a column old replicas still read or write",
  rename: "renames a table or column out from under old replicas",
  "column-type":
    "changes a column's type, which old replicas may read or write in the old one",
  "set-not-null":
    "makes a column NOT NULL, rejecting old replicas' inserts that leave it out",
  "drop-default":
    "drops a default that old replicas' inserts may rely on (allow it if the column is nullable)",
  "not-null-without-default":
    "adds a NOT NULL column without a default, rejecting old replicas' inserts",
  "new-constraint":
    "adds a CHECK or UNIQUE constraint to an existing table, which can reject old replicas' writes",
};

export interface MigrationViolation {
  readonly rule: MigrationRule;
  readonly statement: string;
}

const ALLOW_DIRECTIVE =
  /--[ \t]*migration-safety:[ \t]*allow[ \t]+([a-z-]+)[ \t]*(\S.*)?$/gm;

const BREAKPOINT = "--> statement-breakpoint";

// What's left of a statement to match on: no comments, no literal text.
// Uppercased, with whitespace collapsed.
const normalize = (statement: string): string =>
  statement
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "$$")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();

// `"name"` or name, as it appears after TABLE.
const IDENT = String.raw`(?:"[^"]+"|[A-Z_][A-Z0-9_$]*)`;
const QUALIFIED = String.raw`(?:${IDENT}\.)?(${IDENT})`;
const ALTER_TABLE = new RegExp(
  String.raw`^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?${QUALIFIED}`,
);
const CREATE_TABLE = new RegExp(
  String.raw`^CREATE (?:UNLOGGED )?TABLE (?:IF NOT EXISTS )?${QUALIFIED}`,
);
const CREATE_UNIQUE_INDEX = new RegExp(
  String.raw`^CREATE UNIQUE INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?(?:${IDENT} )?ON (?:ONLY )?${QUALIFIED}`,
);

const unquote = (name: string) => name.replace(/^"|"$/g, "");

function rulesBroken(
  sql: string,
  createdHere: ReadonlySet<string>,
): MigrationRule[] {
  const broken: MigrationRule[] = [];
  if (/^DROP TABLE\b/.test(sql)) broken.push("drop-table");

  const altered = ALTER_TABLE.exec(sql);
  if (altered) {
    const isNew = createdHere.has(unquote(altered[1]!));
    if (/\bDROP COLUMN\b/.test(sql)) broken.push("drop-column");
    if (/\bRENAME\b/.test(sql)) broken.push("rename");
    if (/\bALTER (?:COLUMN )?\S+ (?:SET DATA )?TYPE\b/.test(sql)) {
      broken.push("column-type");
    }
    if (/\bALTER (?:COLUMN )?\S+ SET NOT NULL\b/.test(sql)) {
      broken.push("set-not-null");
    }
    if (/\bALTER (?:COLUMN )?\S+ DROP DEFAULT\b/.test(sql)) {
      broken.push("drop-default");
    }
    const added = sql.split(/\bADD COLUMN\b/).slice(1);
    if (
      added.some(
        (column) =>
          /\bNOT NULL\b/.test(column) &&
          !/\bDEFAULT\b/.test(column) &&
          !/\bGENERATED\b/.test(column),
      )
    ) {
      broken.push("not-null-without-default");
    }
    if (
      !isNew &&
      /\bADD CONSTRAINT \S+ (?:CHECK|UNIQUE|PRIMARY KEY)\b/.test(sql)
    ) {
      broken.push("new-constraint");
    }
  }

  const unique = CREATE_UNIQUE_INDEX.exec(sql);
  if (unique && !createdHere.has(unquote(unique[1]!))) {
    broken.push("new-constraint");
  }
  return broken;
}

// Every statement in one migration file that breaks a rule it doesn't
// allow. An allow directive covers only the statement it sits in (between
// the previous breakpoint and the next), and needs a reason after the rule.
export function checkMigration(source: string): MigrationViolation[] {
  const statements = source.split(BREAKPOINT);
  const normalized = statements.map(normalize);
  // Constraints and unique indexes on a table this migration creates can't
  // reject anything an old replica wrote: it has never seen the table.
  const createdHere = new Set(
    normalized.flatMap((sql) => {
      return sql.split(";").flatMap((one) => {
        const created = CREATE_TABLE.exec(one.trim());
        return created ? [unquote(created[1]!)] : [];
      });
    }),
  );

  const violations: MigrationViolation[] = [];
  statements.forEach((statement, i) => {
    const allowed = new Set<string>();
    for (const [, rule, reason] of statement.matchAll(ALLOW_DIRECTIVE)) {
      if (reason) allowed.add(rule!);
    }
    // Hand-written SQL can hold several statements between breakpoints;
    // with literals and bodies gone, `;` only ends one.
    const broken = new Set(
      normalized[i]!.split(";").flatMap((sql) =>
        rulesBroken(sql.trim(), createdHere),
      ),
    );
    for (const rule of broken) {
      if (!allowed.has(rule)) {
        violations.push({ rule, statement: statement.trim() });
      }
    }
  });
  return violations;
}

// Directives naming a rule that doesn't exist, or giving no reason — either
// would otherwise silently allow nothing.
export function invalidAllowDirectives(source: string): string[] {
  const invalid: string[] = [];
  for (const [line, rule, reason] of source.matchAll(ALLOW_DIRECTIVE)) {
    if (!(rule! in MIGRATION_RULES) || !reason) invalid.push(line.trim());
  }
  return invalid;
}
