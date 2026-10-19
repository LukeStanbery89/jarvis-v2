/**
 * An in-app link: a real `<a href>` that swaps the view instead of reloading
 * (#90 phase 6b).
 *
 * A real anchor on purpose. The `href` is the page's own address, so the status
 * bar preview, "copy link address", middle click, and a browser that decides to
 * do a full navigation anyway all behave as they should — the component only
 * claims a plain left click ({@link interceptsNavigation}), and the server can
 * serve every path it points at.
 *
 * `current` marks the page being shown, which is what the top bar draws as the
 * active item. The comparison is the caller's to make (a view knows its own
 * route), so the prop is a boolean rather than something inferred here.
 */
import type { MouseEvent, ReactNode } from "react";
import {
    ROUTE_PATHS,
    interceptsNavigation,
    navigate,
    type AppRoute,
} from "./router";

/** Props for {@link AppLink}. */
export interface AppLinkProps {
    /** The page this link points at. */
    to: AppRoute;
    /** The link's text. */
    children: ReactNode;
    /** Extra classes for the caller's own styling. */
    className?: string;
    /** Whether this link points at the page the user is on. */
    current?: boolean;
    /** An accessible name, when the visible text alone does not say enough. */
    label?: string;
}

/**
 * Renders one in-app link.
 *
 * @param props - See {@link AppLinkProps}.
 */
export function AppLink({
    to,
    children,
    className,
    current,
    label,
}: AppLinkProps) {
    return (
        <a
            href={ROUTE_PATHS[to]}
            {...(className === undefined ? {} : { className })}
            {...(current === true ? { "aria-current": "page" as const } : {})}
            {...(label === undefined ? {} : { "aria-label": label })}
            onClick={(event: MouseEvent<HTMLAnchorElement>) => {
                if (!interceptsNavigation(event)) {
                    return;
                }
                event.preventDefault();
                navigate(to);
            }}
        >
            {children}
        </a>
    );
}
