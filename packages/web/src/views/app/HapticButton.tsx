/**
 * A button that gives one haptic tick on a phone (#189 follow-up).
 *
 * On Android this is the ordinary button plus `navigator.vibrate()` inside the
 * click handler. On iOS it renders a transparent native `<input type="checkbox"
 * switch>` over the button: since iOS 26.5 a direct tap on that switch is the
 * only way a web page can reach the Taptic Engine, and a script-triggered click
 * no longer works. The overlay is portalled to the nearest dialog/popover (or
 * the body), positioned from the button's live rect, and calls the button's
 * action from the switch's change event.
 *
 * The overlay is intentionally only used for simple leaf controls. It must not
 * wrap a hold-to-delete gesture, a link, or a container with its own interactive
 * children: a tap there belongs to the real control, not to a hidden switch.
 */
import { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import type { ButtonHTMLAttributes, ForwardedRef, ReactNode } from "react";
import { createPortal } from "react-dom";
import { isAppleMobile, triggerHaptic, useHaptics } from "../../haptics";

/** Props for {@link HapticButton}. */
export interface HapticButtonProps extends Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "onClick"
> {
    /** The action. Called by the button on the web/Android and by the switch
     * overlay on iOS. */
    onClick?: () => void;
    /** The button's visible label/contents. */
    children?: ReactNode;
}

/** The native-switch attribute React's input typings do not know about. */
const NATIVE_SWITCH = { switch: "" } as Record<string, string>;

/** A positioned overlay's viewport coordinates and portal host. */
interface SwitchOverlay {
    host: Element;
    left: number;
    top: number;
    width: number;
    height: number;
}

/**
 * A normal button with a phone-only haptic overlay.
 *
 * The forwarded ref stays the real button, so focus management (the timer
 * ring's Stop button, for example) is unchanged.
 */
export const HapticButton = forwardRef(function HapticButton(
    {
        onClick,
        disabled,
        type = "button",
        children,
        ...rest
    }: HapticButtonProps,
    forwardedRef: ForwardedRef<HTMLButtonElement>,
) {
    const { enabled, supported } = useHaptics();
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    const [overlay, setOverlay] = useState<SwitchOverlay | null>(null);
    const [visible, setVisible] = useState(false);
    const apple = isAppleMobile();
    const overlayOn = enabled && supported && apple;

    const assignRef = useCallback(
        (node: HTMLButtonElement | null) => {
            buttonRef.current = node;
            if (typeof forwardedRef === "function") {
                forwardedRef(node);
            } else if (forwardedRef !== null) {
                forwardedRef.current = node;
            }
        },
        [forwardedRef],
    );

    /**
     * The path a normal click takes. On iOS this also covers keyboard
     * activation, which cannot reach the native switch; the tick is skipped
     * there because no web API can trigger it from script.
     */
    const activate = useCallback(() => {
        if (enabled && supported && !apple) {
            triggerHaptic();
        }
        onClick?.();
    }, [enabled, supported, apple, onClick]);

    /**
     * Only follow buttons that are actually on screen.
     *
     * Row-action menus exist in the DOM while their popover is closed, and the
     * chat sidebar stays mounted as a drawer. Without this, every one of those
     * would run a frame loop forever; the observer starts it when the control
     * becomes visible and stops it when it leaves.
     */
    useEffect(() => {
        if (!overlayOn) {
            setVisible(false);
            return;
        }
        const button = buttonRef.current;
        if (button === null || typeof IntersectionObserver === "undefined") {
            setVisible(true);
            return;
        }
        const observer = new IntersectionObserver(
            (entries) => {
                setVisible(entries[0]?.isIntersecting === true);
            },
            { threshold: 0 },
        );
        observer.observe(button);
        return () => observer.disconnect();
    }, [overlayOn]);

    /**
     * Follow the button's rect while the overlay is live.
     *
     * A frame loop rather than a set of scroll/resize listeners because every
     * way the button can move matters here: a drawer transition, a popover
     * opening, the composer growing as the textarea gains a line, or a dialog
     * appearing over the page. The comparison avoids a React update on frames
     * where nothing moved.
     */
    useEffect(() => {
        if (!overlayOn || !visible) {
            setOverlay(null);
            return;
        }

        let frame = 0;
        const update = (): void => {
            const button = buttonRef.current;
            if (button === null || !button.isConnected) {
                frame = requestAnimationFrame(update);
                return;
            }
            const rect = button.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) {
                setOverlay((current) => (current === null ? current : null));
                frame = requestAnimationFrame(update);
                return;
            }
            const host = button.closest("dialog, [popover]") ?? document.body;
            // The overlay is absolute inside its host rather than fixed: a
            // dialog with `backdrop-filter` (the timer ring) becomes the
            // containing block for fixed descendants, which would offset a
            // viewport-coordinate overlay. Host-relative coordinates work in
            // the top layer and in a scrolling host alike.
            const hostRect = host.getBoundingClientRect();
            const left =
                rect.left - hostRect.left - host.clientLeft + host.scrollLeft;
            const top =
                rect.top - hostRect.top - host.clientTop + host.scrollTop;
            setOverlay((current) => {
                if (
                    current !== null &&
                    current.host === host &&
                    current.left === left &&
                    current.top === top &&
                    current.width === rect.width &&
                    current.height === rect.height
                ) {
                    return current;
                }
                return {
                    host,
                    left,
                    top,
                    width: rect.width,
                    height: rect.height,
                };
            });
            frame = requestAnimationFrame(update);
        };
        frame = requestAnimationFrame(update);
        return () => {
            cancelAnimationFrame(frame);
        };
    }, [overlayOn, visible]);

    const switchOverlay =
        overlay === null
            ? null
            : createPortal(
                  <span
                      className="haptic-switch-hit"
                      style={{
                          left: overlay.left,
                          top: overlay.top,
                          width: overlay.width,
                          height: overlay.height,
                      }}
                  >
                      <input
                          {...NATIVE_SWITCH}
                          type="checkbox"
                          className="haptic-switch"
                          aria-hidden="true"
                          tabIndex={-1}
                          disabled={disabled}
                          onChange={() => onClick?.()}
                      />
                  </span>,
                  overlay.host,
              );

    return (
        <>
            <button
                {...rest}
                ref={assignRef}
                type={type}
                disabled={disabled}
                onClick={activate}
            >
                {children}
            </button>
            {switchOverlay}
        </>
    );
});
