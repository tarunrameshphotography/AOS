/**
 * Interface primitives.
 *
 * Hand-written rather than pulled from shadcn/ui: the prototype needs eight
 * components, and the CLI plus its dependency tree is more machinery than that
 * earns. They are shaped like shadcn's so swapping later is mechanical.
 */

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";

import {
  CASE_STAGE_LABELS,
  CASE_STAGE_PROGRESSION,
  isTerminalStage,
  stageOrdinal,
  type CaseStage,
} from "@domain/case/stages.js";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: "bg-brand-600 text-white shadow-sm hover:bg-brand-700 disabled:bg-ink-300 disabled:shadow-none",
  secondary: "bg-white text-ink-900 ring-1 ring-ink-200 hover:bg-ink-50 hover:ring-ink-300 disabled:text-ink-300 disabled:hover:bg-white disabled:hover:ring-ink-200",
  ghost: "text-ink-700 hover:bg-ink-100 disabled:text-ink-300 disabled:hover:bg-transparent",
  danger: "bg-red-600 text-white shadow-sm hover:bg-red-700 disabled:bg-ink-300 disabled:shadow-none",
};

export function Button({
  variant = "secondary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }): ReactNode {
  return (
    <button
      {...props}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-md px-3.5 py-1.5",
        "text-sm font-medium transition-[background-color,box-shadow,transform] duration-150",
        "active:scale-[0.98] disabled:cursor-not-allowed disabled:active:scale-100",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-white",
        BUTTON_STYLES[variant],
        className,
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// NotConnectedBanner
// ---------------------------------------------------------------------------

/**
 * For the handful of screens (Products, Lenders, and the "simple" Master
 * Data vocabulary sections) that display `Frontend/src/fake/store.ts` — a
 * per-browser prototype dataset — rather than the office database. Real
 * cases pull loan products and document requirements from PostgreSQL
 * (`Backend/reference.ts`, `Backend/requirements.ts`), which this screen has
 * no path to. These screens do not offer a way to edit this data (Production
 * Readiness Phase 2, "Admin-screen honesty") — showing an editable-looking
 * screen next to data nobody could actually change was itself the trap: a
 * manager who could "save" a change here had every reason to believe it did
 * something.
 */
export function NotConnectedBanner(): ReactNode {
  return (
    <div className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200">
      <strong className="font-semibold">Not connected to the office database.</strong> What's shown
      here is a per-browser preview, not production configuration — it is not shared with any
      other PC and has no effect on real cases or document requirements. Read-only: there is no
      way to change this data from AOS yet.
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

/**
 * Two elevation steps, not a scale: `elevated` for the handful of surfaces on
 * a screen that are genuinely primary (the pipeline, the thing a founder
 * opened this screen to check) — everything else stays at the quiet default.
 * Reach for `elevated` sparingly; a screen where everything is elevated is a
 * screen where nothing is.
 */
export function Card({
  title,
  subtitle,
  actions,
  children,
  className,
  elevated = false,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  elevated?: boolean;
}): ReactNode {
  return (
    <section
      className={cx(
        "rounded-lg bg-white transition-shadow duration-200",
        elevated ? "shadow-elevated ring-1 ring-ink-150" : "ring-1 ring-ink-150",
        className,
      )}
    >
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-ink-100 px-4 py-3.5 sm:px-5">
          <div>
            {title && <h2 className="text-sm font-semibold text-ink-900">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-ink-500">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

/**
 * Stage colour carries meaning and nothing else on the screen competes with it:
 * grey is early, blue is in flight, amber needs a person, green is done, red is
 * over.
 */
const STAGE_STYLES: Record<CaseStage, string> = {
  new: "bg-ink-100 text-ink-700",
  contacted: "bg-ink-100 text-ink-700",
  appointment_fixed: "bg-violet-100 text-violet-800",
  documents_pending: "bg-amber-100 text-amber-900",
  ready_for_submission: "bg-sky-100 text-sky-900",
  submitted: "bg-blue-100 text-blue-900",
  sanctioned: "bg-emerald-100 text-emerald-900",
  disbursed: "bg-emerald-600 text-white",
  closed: "bg-ink-700 text-white",
  lost: "bg-red-100 text-red-900",
};

const BADGE_BASE =
  "inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap";

export function StageBadge({ stage, label }: { stage: CaseStage; label: string }): ReactNode {
  return <span className={cx(BADGE_BASE, STAGE_STYLES[stage])}>{label}</span>;
}

// ---------------------------------------------------------------------------
// StageRail — the case lifecycle, drawn as the progression it actually is
// ---------------------------------------------------------------------------

/**
 * The eight-step system progression (`CASE_STAGE_PROGRESSION`), filled up to
 * wherever this case currently sits. This is the one place the design system
 * spends its signature move: everywhere else colour and shape stay quiet, but
 * a case's position in its own lifecycle is the single fact this product
 * exists to track, so it gets a real visual, not just a coloured word.
 *
 * Terminal stages (`closed`, `lost`) have no ordinal (`stageOrdinal` returns
 * `null` for them by design, ADR-023) — asking "how far along" is not a
 * question with an answer for a case that is not in progress any more, so
 * they render as a plain outcome marker instead of a partially-filled rail.
 */
export function StageRail({ stage }: { stage: CaseStage }): ReactNode {
  if (isTerminalStage(stage)) {
    return (
      <div className="flex items-center gap-1.5">
        <span
          className={cx(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            stage === "closed" ? "bg-ink-700" : "bg-red-500",
          )}
        />
        <span className="text-xs font-medium text-ink-500">{CASE_STAGE_LABELS[stage]}</span>
      </div>
    );
  }

  const ordinal = stageOrdinal(stage) ?? 0;
  return (
    <div
      className="flex items-center gap-1"
      role="img"
      aria-label={`Stage ${ordinal + 1} of ${CASE_STAGE_PROGRESSION.length}: ${CASE_STAGE_LABELS[stage]}`}
    >
      {CASE_STAGE_PROGRESSION.map((step, index) => (
        <span
          key={step}
          title={CASE_STAGE_LABELS[step]}
          className={cx(
            "h-1.5 w-4 rounded-full transition-colors",
            index <= ordinal ? "bg-brand-600" : "bg-ink-150",
          )}
        />
      ))}
    </div>
  );
}

type Tone = "neutral" | "info" | "warn" | "good" | "bad";

const TONE_STYLES: Record<Tone, string> = {
  neutral: "bg-ink-100 text-ink-700",
  info: "bg-blue-100 text-blue-900",
  warn: "bg-amber-100 text-amber-900",
  good: "bg-emerald-100 text-emerald-900",
  bad: "bg-red-100 text-red-900",
};

export function Badge({
  tone = "neutral",
  title,
  children,
}: {
  tone?: Tone;
  /** What the badge means, in a sentence, on hover. */
  title?: string | undefined;
  children: ReactNode;
}): ReactNode {
  return (
    <span {...(title ? { title } : {})} className={cx(BADGE_BASE, TONE_STYLES[tone])}>
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export function ProgressBar({
  percent,
  applicable,
}: {
  percent: number;
  applicable: number;
}): ReactNode {
  // "Nothing applicable" and "everything verified" are both 100% arithmetically
  // (ADR-011), but they must not look the same. A full green bar on a case at
  // Contacted — where no requirement is due yet — reads as "documents done",
  // which is a lie the progress figure itself never tells.
  if (applicable === 0) {
    return (
      <div className="flex items-center gap-2">
        <div className="h-1.5 w-full rounded-full bg-ink-100" />
        {/* A bare "—" reads as an error or "N/A" at a glance; this case is
            neither — it just has nothing due yet (audit finding 7.2). */}
        <span className="shrink-0 text-xs text-ink-400">Not started</span>
      </div>
    );
  }

  const tone = percent === 100 ? "bg-emerald-500" : percent >= 60 ? "bg-brand-500" : "bg-amber-500";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-100">
        <div className={cx("h-full rounded-full transition-all", tone)} style={{ width: `${percent}%` }} />
      </div>
      {/* "Verified", spelled out — a bare percentage after real uploads still
          reads as "nothing happened" when what it actually means is "nothing
          has been checked yet" (ADR-011; Workflow Polish audit finding 4.2). */}
      <span className="tnum shrink-0 text-xs font-medium text-ink-700">{percent}% verified</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

export function Empty({ children }: { children: ReactNode }): ReactNode {
  return <p className="py-6 text-center text-sm text-ink-500">{children}</p>;
}

// ---------------------------------------------------------------------------
// Table — one shared treatment for CaseList, the Founders Dashboard's Team
// and Banks sections, and the admin user table, so a header, a row and a
// hover state look the same everywhere instead of each screen inventing its
// own. `Table` only owns the scroll container and base text size; real
// tables still write their own <thead>/<tbody> so columns can vary freely.
// ---------------------------------------------------------------------------

export function Table({ children, className }: { children: ReactNode; className?: string }): ReactNode {
  return (
    <div className="-mx-4 overflow-x-auto sm:-mx-5">
      <table className={cx("w-full text-sm", className)}>{children}</table>
    </div>
  );
}

export function Th({
  children,
  align = "left",
  className,
}: {
  children: ReactNode;
  align?: "left" | "right";
  className?: string;
}): ReactNode {
  return (
    <th
      className={cx(
        "px-4 py-2 text-xs font-medium text-ink-500 first:pl-4 last:pr-4 sm:first:pl-5 sm:last:pr-5",
        align === "right" && "text-right",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = "left",
  muted = false,
  className,
}: {
  children: ReactNode;
  align?: "left" | "right";
  muted?: boolean;
  className?: string;
}): ReactNode {
  return (
    <td
      className={cx(
        "px-4 py-2.5 first:pl-4 last:pr-4 sm:first:pl-5 sm:last:pr-5",
        align === "right" && "text-right",
        muted && "text-ink-500",
        className,
      )}
    >
      {children}
    </td>
  );
}

/** Applied to each `<tr>` in `<tbody>` — a hairline separator plus a quiet
 * hover wash, so a row reads as scannable without the grid lines a
 * spreadsheet needs. */
export const TABLE_ROW = "border-b border-ink-50 transition-colors duration-150 last:border-0 hover:bg-ink-50/60";

// ---------------------------------------------------------------------------
// Permission refusals
// ---------------------------------------------------------------------------

/**
 * The raw permission key behind a refusal, tucked behind a native disclosure
 * rather than printed inline. It stays available for support/training — "why
 * can't I see this?" is a real question a supervisor gets asked — without
 * being the first thing an ordinary telecaller or login-desk user reads
 * (Workflow Polish audit finding 8.1: `case.read`, `note.read` etc. are
 * developer vocabulary, not something end users recognise).
 */
export function PermissionCode({ code }: { code: string }): ReactNode {
  return (
    <details className="mt-1">
      <summary className="inline cursor-pointer text-xs text-ink-400 hover:text-ink-600">
        Technical detail
      </summary>
      <code className="ml-1 text-xs text-ink-400">{code}</code>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | undefined;
  children: ReactNode;
}): ReactNode {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-500">{hint}</span>}
    </label>
  );
}

const CONTROL =
  "w-full rounded-md bg-white px-2.5 py-2 text-sm ring-1 ring-ink-300 transition-shadow duration-150 " +
  "hover:ring-ink-400 focus:ring-2 focus:ring-brand-500 focus:outline-none disabled:bg-ink-50 disabled:text-ink-400 disabled:hover:ring-ink-300";

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>): ReactNode {
  return <input {...props} className={cx(CONTROL, props.className)} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>): ReactNode {
  return <select {...props} className={cx(CONTROL, props.className)} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>): ReactNode {
  return <textarea {...props} className={cx(CONTROL, "min-h-20", props.className)} />;
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export function Modal({
  open,
  title,
  onClose,
  size = "default",
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  /** `wide` for a dialog carrying a table — the document selection and the
   * batch review are lists of documents with a size and a status each, and
   * they are unreadable at the default width. Everything else stays narrow. */
  size?: "default" | "wide";
  children: ReactNode;
}): ReactNode {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="aos-animate-in fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-900/30 p-4 pt-16">
      {/* `role="dialog"` and `aria-modal` so a screen reader announces this as
          a dialog rather than as more of the page behind it, and so its title
          is what names it. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        className={cx(
          "aos-animate-pop w-full rounded-lg bg-white shadow-elevated ring-1 ring-ink-150",
          size === "wide" ? "max-w-3xl" : "max-w-lg",
        )}
      >
        <header className="flex items-center justify-between border-b border-ink-100 px-4 py-3">
          <h2 id="modal-title" className="text-sm font-semibold">
            {title}
          </h2>
          <Button variant="ghost" onClick={onClose} aria-label="Close">
            ✕
          </Button>
        </header>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toast — how a refused action explains itself
//
// A refusal a user cannot understand is a dead end, so the domain layer's reason
// string is shown verbatim rather than replaced with "something went wrong".
// ---------------------------------------------------------------------------

interface ToastValue {
  show: (message: string, tone?: "good" | "bad") => void;
}

const ToastContext = createContext<ToastValue>({ show: () => undefined });

export function ToastProvider({ children }: { children: ReactNode }): ReactNode {
  const [toast, setToast] = useState<{ message: string; tone: "good" | "bad" } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  return (
    <ToastContext.Provider
      value={{ show: (message, tone = "good") => setToast({ message, tone }) }}
    >
      {children}
      {toast && (
        <div
          role="status"
          className={cx(
            "aos-animate-pop fixed bottom-4 left-1/2 z-50 max-w-lg -translate-x-1/2 rounded-lg px-4 py-2.5 text-sm shadow-elevated",
            toast.tone === "bad" ? "bg-red-600 text-white" : "bg-ink-900 text-white",
          )}
        >
          {toast.message}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastValue {
  return useContext(ToastContext);
}
