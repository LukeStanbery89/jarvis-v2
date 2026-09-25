/**
 * Small presentational UI primitives shared by the management views.
 *
 * Deliberately framework-free: plain components over `styles.css` class names.
 * Forms follow the native submit pattern (`onSubmit` + `required` fields), and
 * destructive actions use the browser's own confirmation dialog.
 */
import type { FormEvent, ReactNode } from "react";
import { ApiError } from "../api";

/** Formats an unknown thrown value into a user-safe message. */
export function errorMessage(err: unknown): string {
    if (err instanceof ApiError) {
        return err.message;
    }
    if (err instanceof Error) {
        return err.message;
    }
    return "unexpected error";
}

/** Inline error banner (red), rendered above a form or table. */
export function ErrorBanner({ children }: { children: ReactNode }) {
    if (!children) {
        return null;
    }
    return <div className="banner error">{children}</div>;
}

/** Inline success/info banner, e.g. after a provisioning step. */
export function InfoBanner({ children }: { children: ReactNode }) {
    return <div className="banner info">{children}</div>;
}

interface FieldProps {
    label: string;
    type?: string;
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    autoComplete?: string;
    required?: boolean;
    minLength?: number;
}

/** Labeled text/password field wired to form state. */
export function Field({
    label,
    type = "text",
    value,
    onChange,
    placeholder,
    autoComplete,
    required,
    minLength,
}: FieldProps) {
    return (
        <label className="field">
            <span>{label}</span>
            <input
                type={type}
                value={value}
                placeholder={placeholder}
                autoComplete={autoComplete}
                required={required}
                minLength={minLength}
                onChange={(e) => onChange(e.target.value)}
            />
        </label>
    );
}

interface ButtonProps {
    onClick?: () => void;
    variant?: "primary" | "danger" | "ghost";
    disabled?: boolean;
    children: ReactNode;
}

/** Styled action button. */
export function Button({
    onClick,
    variant = "primary",
    disabled,
    children,
}: ButtonProps) {
    return (
        <button
            type="button"
            className={`btn ${variant}`}
            onClick={onClick}
            disabled={disabled}
        >
            {children}
        </button>
    );
}

/** Submit button for forms (type=submit so Enter submits). */
export function SubmitButton({
    variant = "primary",
    disabled,
    children,
}: Omit<ButtonProps, "onClick">) {
    return (
        <button type="submit" className={`btn ${variant}`} disabled={disabled}>
            {children}
        </button>
    );
}

/** Minimal form wrapper: runs `onSubmit` for the browser submit event. */
export function Form({
    onSubmit,
    children,
}: {
    onSubmit: () => void;
    children: ReactNode;
}) {
    const handleSubmit = (event: FormEvent) => {
        event.preventDefault();
        onSubmit();
    };
    return <form onSubmit={handleSubmit}>{children}</form>;
}

/** Confirmation dialog for destructive single-row actions. */
export function confirm(message: string): boolean {
    return window.confirm(message);
}

/** Mono-spaced token/id display with a copy button. */
export function Copyable({ text }: { text: string }) {
    return (
        <code className="copyable" title={text}>
            <span>{text}</span>
            <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText(text)}
            >
                copy
            </button>
        </code>
    );
}
