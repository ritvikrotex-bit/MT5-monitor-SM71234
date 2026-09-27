import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Download, Plus, Upload, X } from "lucide-react";
import { Field, Tag, inputClass, type Tone } from "@/components/mt5/copier-parts";
import { cn } from "@/lib/utils";

/**
 * Symbol translation for one copy link.
 *
 * Kept as structured rows rather than a free-text box, because a mapping typed
 * into a textarea is only ever validated when a trade arrives — which is the
 * worst moment to discover a typo. The preview answers the same question up
 * front, against what the two brokers actually offer.
 */

export type Mapping = { source: string; destination: string };

export type TranslationForm = {
  autoMatch: boolean;
  symbolSuffix: string;
  mappings: Mapping[];
  /** ALL copies everything that matches; SELECTED copies only `allowed`. */
  copyMode: "ALL" | "SELECTED";
  allowed: string[];
  blocked: string[];
};

export type PreviewRow = {
  source: string;
  destination: string | null;
  status: "AUTO" | "MANUAL" | "BLOCKED" | "AMBIGUOUS" | "UNMATCHED";
  detail: string;
};

export type Preview = {
  counts: Partial<Record<PreviewRow["status"], number>>;
  matching: number;
  sourceTotal: number;
  destinationTotal: number;
  rows: PreviewRow[];
};

export function translationDefaults(rules?: {
  autoMatch?: boolean;
  symbolSuffix?: string;
  symbolMap?: Record<string, string>;
  allowSymbols?: string[];
  denySymbols?: string[];
}): TranslationForm {
  const allowed = rules?.allowSymbols ?? [];
  return {
    autoMatch: rules?.autoMatch ?? true,
    symbolSuffix: rules?.symbolSuffix ?? "",
    mappings: Object.entries(rules?.symbolMap ?? {}).map(([source, destination]) => ({
      source,
      destination,
    })),
    copyMode: allowed.length ? "SELECTED" : "ALL",
    allowed,
    blocked: rules?.denySymbols ?? [],
  };
}

/** The rule fields this section owns, in the shape the API expects. */
export function translationPayload(form: TranslationForm) {
  const symbolMap: Record<string, string> = {};
  for (const { source, destination } of form.mappings) {
    const from = source.trim();
    const to = destination.trim();
    if (from && to) symbolMap[from] = to;
  }
  return {
    autoMatch: form.autoMatch,
    symbolSuffix: form.symbolSuffix.trim(),
    symbolMap,
    // An empty allow list means "everything", so SELECTED with nothing chosen
    // would silently copy all of it. Guard it in the UI instead.
    allowSymbols: form.copyMode === "SELECTED" ? form.allowed.filter(Boolean) : [],
    denySymbols: form.blocked.filter(Boolean),
  };
}

export function translationProblem(form: TranslationForm): string | null {
  if (form.copyMode === "SELECTED" && form.allowed.filter(Boolean).length === 0) {
    return "Choose at least one symbol to copy, or switch back to copying all matched symbols.";
  }
  const half = form.mappings.find(
    (m) => Boolean(m.source.trim()) !== Boolean(m.destination.trim()),
  );
  if (half) return "Every mapping needs both a source and a destination symbol.";
  if (!form.autoMatch && Object.keys(translationPayload(form).symbolMap).length === 0) {
    return "With base-name matching off, nothing will copy until you add a mapping.";
  }
  return null;
}

const STATUS_TONE: Record<PreviewRow["status"], Tone> = {
  AUTO: "ok",
  MANUAL: "info",
  BLOCKED: "danger",
  AMBIGUOUS: "warn",
  UNMATCHED: "muted",
};

const STATUS_LABEL: Record<PreviewRow["status"], string> = {
  AUTO: "Auto",
  MANUAL: "Manual",
  BLOCKED: "Blocked",
  AMBIGUOUS: "Ambiguous",
  UNMATCHED: "No match",
};

function Section({
  step,
  title,
  children,
}: {
  step: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="space-y-3 rounded-lg border border-border/70 p-3">
      <legend className="px-1 text-xs font-semibold">
        <span className="num mr-1.5 text-muted-foreground">{step}.</span>
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

function RowList({
  items,
  onRemove,
  onAdd,
  addLabel,
  empty,
  children,
}: {
  items: unknown[];
  onRemove: (index: number) => void;
  onAdd: () => void;
  addLabel: string;
  empty: string;
  children: (index: number) => React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      {items.length === 0 && <p className="text-[11px] text-muted-foreground">{empty}</p>}
      {items.map((_, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2">
          {children(index)}
          <button
            type="button"
            onClick={() => onRemove(index)}
            className="grid size-7 shrink-0 place-items-center rounded-lg border border-destructive/40 text-destructive hover:bg-destructive/10"
            aria-label="Remove"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={onAdd}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium whitespace-nowrap hover:bg-secondary"
      >
        <Plus className="size-3.5" /> {addLabel}
      </button>
    </div>
  );
}

export function SymbolTranslation({
  form,
  onChange,
  linkId,
  destinationSymbols,
}: {
  form: TranslationForm;
  onChange: (next: TranslationForm) => void;
  /** Preview needs a saved link; a link being created has none yet. */
  linkId: string | undefined;
  destinationSymbols: string[];
}) {
  const set = <K extends keyof TranslationForm>(key: K, value: TranslationForm[K]) =>
    onChange({ ...form, [key]: value });

  const problem = translationProblem(form);

  return (
    <div className="space-y-3">
      <Section step={1} title="Automatic matching">
        <label className="flex items-start gap-2.5 text-xs">
          <input
            type="checkbox"
            checked={form.autoMatch}
            onChange={(e) => set("autoMatch", e.target.checked)}
            className="mt-0.5 size-4 shrink-0"
          />
          <span className="min-w-0">
            <span className="font-medium">Match symbols by base name</span>
            <span className="block text-[11px] break-words text-muted-foreground">
              Strips each broker&apos;s decoration and matches what is left, so{" "}
              <code>XAUUSD.c</code> finds <code>XAUUSD.s</code> on its own. Turn it off to copy only
              what you map by hand.
            </span>
          </span>
        </label>
        {form.autoMatch && (
          <Field
            label="Destination suffix"
            hint="Only needed when one base name matches several destination symbols, e.g. .s"
          >
            <input
              className={inputClass}
              value={form.symbolSuffix}
              onChange={(e) => set("symbolSuffix", e.target.value)}
              placeholder=".s"
            />
          </Field>
        )}
      </Section>

      <Section step={2} title="Manual mappings">
        <p className="text-[11px] break-words text-muted-foreground">
          Takes priority over automatic matching. Use it when the two brokers name the same
          instrument differently.
        </p>
        <RowList
          items={form.mappings}
          empty="No manual mappings. Automatic matching handles the rest."
          addLabel="Add mapping"
          onAdd={() => set("mappings", [...form.mappings, { source: "", destination: "" }])}
          onRemove={(i) =>
            set(
              "mappings",
              form.mappings.filter((_, x) => x !== i),
            )
          }
        >
          {(index) => (
            <>
              <input
                className={cn(inputClass, "min-w-0 flex-1 basis-36")}
                value={form.mappings[index]!.source}
                onChange={(e) =>
                  set(
                    "mappings",
                    form.mappings.map((m, x) =>
                      x === index ? { ...m, source: e.target.value } : m,
                    ),
                  )
                }
                placeholder="BTCUSD.c"
                aria-label="Source symbol"
              />
              <span className="shrink-0 text-muted-foreground">→</span>
              <input
                list="copier-destination-symbols"
                className={cn(inputClass, "min-w-0 flex-1 basis-36")}
                value={form.mappings[index]!.destination}
                onChange={(e) =>
                  set(
                    "mappings",
                    form.mappings.map((m, x) =>
                      x === index ? { ...m, destination: e.target.value } : m,
                    ),
                  )
                }
                placeholder="BTCUSD.s"
                aria-label="Destination symbol"
              />
            </>
          )}
        </RowList>
        <datalist id="copier-destination-symbols">
          {destinationSymbols.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </Section>

      <Section step={3} title="Symbol filter">
        <div className="space-y-2">
          {(
            [
              ["ALL", "All matched symbols", "Copy anything that translates."],
              ["SELECTED", "Only selected symbols", "Copy nothing except the base names you list."],
            ] as const
          ).map(([value, label, hint]) => (
            <label key={value} className="flex items-start gap-2.5 text-xs">
              <input
                type="radio"
                name="copy-mode"
                checked={form.copyMode === value}
                onChange={() => set("copyMode", value)}
                className="mt-0.5 size-4 shrink-0"
              />
              <span className="min-w-0">
                <span className="font-medium">{label}</span>
                <span className="block text-[11px] break-words text-muted-foreground">{hint}</span>
              </span>
            </label>
          ))}
        </div>
        {form.copyMode === "SELECTED" && (
          <RowList
            items={form.allowed}
            empty="Nothing selected, so nothing would copy."
            addLabel="Add symbol"
            onAdd={() => set("allowed", [...form.allowed, ""])}
            onRemove={(i) =>
              set(
                "allowed",
                form.allowed.filter((_, x) => x !== i),
              )
            }
          >
            {(index) => (
              <input
                className={cn(inputClass, "min-w-0 flex-1 basis-40")}
                value={form.allowed[index]}
                onChange={(e) =>
                  set(
                    "allowed",
                    form.allowed.map((v, x) => (x === index ? e.target.value : v)),
                  )
                }
                placeholder="XAUUSD"
                aria-label="Symbol to copy"
              />
            )}
          </RowList>
        )}
      </Section>

      <Section step={4} title="Blocked symbols">
        <p className="text-[11px] break-words text-muted-foreground">
          Never copied, whatever else matches. Base names, so <code>BTCUSD</code> blocks{" "}
          <code>BTCUSD.c</code>.
        </p>
        <RowList
          items={form.blocked}
          empty="Nothing blocked."
          addLabel="Add blocked symbol"
          onAdd={() => set("blocked", [...form.blocked, ""])}
          onRemove={(i) =>
            set(
              "blocked",
              form.blocked.filter((_, x) => x !== i),
            )
          }
        >
          {(index) => (
            <input
              className={cn(inputClass, "min-w-0 flex-1 basis-40")}
              value={form.blocked[index]}
              onChange={(e) =>
                set(
                  "blocked",
                  form.blocked.map((v, x) => (x === index ? e.target.value : v)),
                )
              }
              placeholder="BTCUSD"
              aria-label="Blocked symbol"
            />
          )}
        </RowList>
      </Section>

      <Section step={5} title="Translation preview">
        <TranslationPreview linkId={linkId} />
      </Section>

      <MappingTransfer form={form} onChange={onChange} />

      {problem && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] break-words text-amber-600 dark:text-amber-400">
          {problem}
        </p>
      )}
    </div>
  );
}

/**
 * CSV rather than .xlsx: it opens in Excel, round-trips through it, and needs
 * no spreadsheet library on either side.
 */
function MappingTransfer({
  form,
  onChange,
}: {
  form: TranslationForm;
  onChange: (next: TranslationForm) => void;
}) {
  const [error, setError] = useState<string | null>(null);

  const download = (name: string, body: string) => {
    const url = URL.createObjectURL(new Blob([body], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportCsv = () => {
    const lines = ["source,destination,blocked"];
    for (const m of form.mappings) lines.push(`${m.source},${m.destination},`);
    for (const b of form.blocked) lines.push(`,,${b}`);
    download("symbol-mappings.csv", lines.join("\n"));
  };

  const template = () =>
    download(
      "symbol-mappings-template.csv",
      ["source,destination,blocked", "BTCUSD.c,BTCUSD.s,", "XAUUSD.c,XAUUSD.s,", ",,BTCUSD"].join(
        "\n",
      ),
    );

  const importCsv = (file: File) => {
    setError(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result ?? "");
        const rows = text
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        if (!rows.length) throw new Error("The file is empty.");
        const header = rows[0]!.toLowerCase();
        const start = header.includes("source") ? 1 : 0;
        const mappings: Mapping[] = [];
        const blocked: string[] = [];
        for (const row of rows.slice(start)) {
          const [source = "", destination = "", block = ""] = row.split(",").map((c) => c.trim());
          if (block) blocked.push(block);
          else if (source && destination) mappings.push({ source, destination });
          else if (source || destination) {
            throw new Error(`"${row}" needs both a source and a destination.`);
          }
        }
        if (!mappings.length && !blocked.length) {
          throw new Error("No mappings or blocked symbols found.");
        }
        onChange({ ...form, mappings, blocked });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not read that file.");
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="space-y-2 rounded-lg border border-border/70 p-3">
      <p className="text-[11px] break-words text-muted-foreground">
        Mappings and blocked symbols as CSV, which opens and saves straight from Excel. Importing
        replaces both lists.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium whitespace-nowrap hover:bg-secondary">
          <Upload className="size-3.5" /> Import CSV
          <input
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) importCsv(file);
              e.target.value = "";
            }}
          />
        </label>
        <button
          type="button"
          onClick={exportCsv}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium whitespace-nowrap hover:bg-secondary"
        >
          <Download className="size-3.5" /> Export CSV
        </button>
        <button
          type="button"
          onClick={template}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium whitespace-nowrap hover:bg-secondary"
        >
          <Download className="size-3.5" /> Template
        </button>
      </div>
      {error && <p className="text-[11px] break-words text-destructive">{error}</p>}
    </div>
  );
}

function TranslationPreview({ linkId }: { linkId: string | undefined }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [data, setData] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!linkId) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filter) params.set("q", filter);
      const res = await fetch(`/api/copier/links/${linkId}/preview?${params}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || "Could not build the preview.");
      setData(body as Preview);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not build the preview.");
    } finally {
      setLoading(false);
    }
  }, [linkId, filter]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  if (!linkId) {
    return (
      <p className="text-[11px] break-words text-muted-foreground">
        Available once the link is saved — it compares what the master&apos;s server offers with
        what the destination trades.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 text-[11px] font-medium"
      >
        <span>Show how each symbol would be translated</span>
        <ChevronDown
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")}
        />
      </button>

      {open && (
        <div className="space-y-2">
          <p className="text-[11px] break-words text-muted-foreground">
            Reflects the rules as last saved, not unsaved edits above.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter, e.g. BTC"
              className={cn(inputClass, "min-w-0 flex-1 basis-40")}
            />
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium whitespace-nowrap hover:bg-secondary disabled:opacity-50"
            >
              {loading ? "Checking..." : "Refresh"}
            </button>
          </div>

          {error && <p className="text-[11px] break-words text-destructive">{error}</p>}

          {data && (
            <>
              <div className="flex flex-wrap gap-1.5">
                {(["AUTO", "MANUAL", "BLOCKED", "AMBIGUOUS", "UNMATCHED"] as const).map(
                  (status) => (
                    <Tag
                      key={status}
                      tone={STATUS_TONE[status]}
                      text={`${data.counts[status] ?? 0} ${STATUS_LABEL[status].toLowerCase()}`}
                    />
                  ),
                )}
              </div>
              <p className="text-[11px] break-words text-muted-foreground">
                {data.sourceTotal} symbols on the master&apos;s server · {data.destinationTotal} on
                the destination
                {filter ? ` · ${data.matching} match "${filter}"` : ""}
                {data.matching > data.rows.length ? `, showing ${data.rows.length}` : ""}
              </p>
              <div className="max-h-72 space-y-1 overflow-y-auto">
                {data.rows.length === 0 && (
                  <p className="text-[11px] text-muted-foreground">Nothing matches that filter.</p>
                )}
                {data.rows.map((row) => (
                  <div
                    key={row.source}
                    className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-lg bg-secondary/40 px-2 py-1.5 text-[11px]"
                  >
                    <span className="num shrink-0 font-medium">{row.source}</span>
                    <span className="shrink-0 text-muted-foreground">→</span>
                    <span className="num shrink-0">{row.destination ?? "—"}</span>
                    <Tag tone={STATUS_TONE[row.status]} text={STATUS_LABEL[row.status]} />
                    <span className="min-w-0 flex-1 break-words text-muted-foreground">
                      {row.detail}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
