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

import type { CaseStage } from "@domain/case/stages.js";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: "bg-brand-600 text-white hover:bg-brand-500 disabled:bg-ink-300",
  secondary: "bg-white text-ink-900 ring-1 ring-ink-300 hover:bg-ink-50 disabled:text-ink-300",
  ghost: "text-ink-700 hover:bg-ink-100 disabled:text-ink-300",
  danger: "bg-red-600 text-white hover:bg-red-500 disabled:bg-ink-300",
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
        "inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5",
        "text-sm font-medium transition-colors disabled:cursor-not-allowed",
        BUTTON_STYLES[variant],
        className,
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export function Card({
  title,
  subtitle,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <section className={cx("rounded-lg bg-white ring-1 ring-ink-100", className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-ink-100 px-4 py-3">
          <div>
            {title && <h2 className="text-sm font-semibold text-ink-900">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-ink-500">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
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

export function StageBadge({ stage, label }: { stage: CaseStage; label: string }): ReactNode {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        STAGE_STYLES[stage],
      )}
    >
      {label}
    </span>
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
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}): ReactNode {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        TONE_STYLES[tone],
      )}
    >
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
        <span className="shrink-0 text-xs text-ink-400">—</span>
      </div>
    );
  }

  const tone = percent === 100 ? "bg-emerald-500" : percent >= 60 ? "bg-brand-500" : "bg-amber-500";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-100">
        <div className={cx("h-full rounded-full transition-all", tone)} style={{ width: `${percent}%` }} />
      </div>
      <span className="tnum shrink-0 text-xs font-medium text-ink-700">{percent}%</span>
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
  "w-full rounded-md bg-white px-2.5 py-1.5 text-sm ring-1 ring-ink-300 " +
  "focus:ring-2 focus:ring-brand-500 focus:outline-none";

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
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
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
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-900/30 p-4 pt-16">
      <div className="w-full max-w-lg rounded-lg bg-white shadow-xl ring-1 ring-ink-200">
        <header className="flex items-center justify-between border-b border-ink-100 px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
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
            "fixed bottom-4 left-1/2 z-50 max-w-lg -translate-x-1/2 rounded-lg px-4 py-2.5 text-sm shadow-lg",
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
