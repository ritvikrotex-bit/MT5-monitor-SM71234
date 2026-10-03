import { cn } from "@/lib/utils";

/** Shared presentation pieces for the Trade Copier dashboard. */

export type Tone = "ok" | "warn" | "danger" | "muted" | "info";

export function Tag({ tone, text }: { tone: Tone; text: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
        tone === "ok" && "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
        tone === "warn" && "bg-amber-500/15 text-amber-600 dark:text-amber-400",
        tone === "danger" && "bg-destructive/15 text-destructive",
        tone === "info" && "bg-sky-500/15 text-sky-600 dark:text-sky-400",
        tone === "muted" && "bg-secondary text-muted-foreground",
      )}
    >
      {text}
    </span>
  );
}

export function Card({
  title,
  description,
  action,
  children,
  className,
}: {
  title?: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-2xl border border-border bg-card p-4 sm:p-5", className)}>
      {(title || action) && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold">{title}</h2>}
            {description && (
              <p className="text-xs break-words text-muted-foreground">{description}</p>
            )}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: Tone;
}) {
  return (
    <div className="rounded-xl border border-border bg-secondary/40 p-3">
      <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
      <p
        className={cn(
          "num mt-0.5 text-lg font-semibold break-words",
          tone === "danger" && "text-destructive",
          tone === "ok" && "text-emerald-600 dark:text-emerald-400",
          tone === "warn" && "text-amber-600 dark:text-amber-400",
        )}
      >
        {value}
      </p>
      {hint && <p className="text-[11px] break-words text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-foreground">{label}</span>
      {children}
      {hint && <span className="block text-[11px] break-words text-muted-foreground">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary";

export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex items-start gap-2.5 text-xs">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 shrink-0"
      />
      <span className="min-w-0">
        <span className="font-medium">{label}</span>
        <span className="block text-[11px] break-words text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}

export const money = (value: number, currency = "USD") =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(value);

export function eventTone(kind: string): Tone {
  if (kind === "opened" || kind === "open") return "ok";
  if (kind === "error" || kind === "halted") return "danger";
  if (kind === "skipped" || kind === "duplicate") return "warn";
  if (kind === "close" || kind === "reduce" || kind === "modify" || kind === "refreshed")
    return "info";
  return "muted";
}
