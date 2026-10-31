import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import {
  firstEnabled,
  keyAction,
  lastEnabled,
  NO_TYPEAHEAD,
  openingIndex,
  pageEnabled,
  placeList,
  stepEnabled,
  typeahead,
  TYPEAHEAD_RESET_MS,
} from "./select-logic";

export interface SelectOption<Value extends string = string> {
  value: Value;
  label: string;
  /** A quieter second line in the list. The trigger shows only the label. */
  hint?: string | undefined;
  disabled?: boolean | undefined;
}

/** Below this width the list opens as a sheet from the bottom of the window. */
const SHEET_QUERY = "(max-width: 640px)";

function Chevrons() {
  return (
    <svg className="select-chevrons" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M4.2 5.4 7 2.9l2.8 2.5M4.2 8.6 7 11.1l2.8-2.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Tick() {
  return (
    <svg className="select-tick" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * A dropdown, in place of a native select: a button that opens a list.
 *
 * Follows the WAI-ARIA select-only combobox. Focus stays on the trigger and
 * aria-activedescendant names the option in reach, so arrows, Home, End, Enter,
 * Escape, Tab and typeahead all work the same open or closed. The list is portalled
 * to the body, so a scrolling table cannot clip it.
 *
 * Give it a name with `label` (visible) or `aria-label`.
 */
export function Select<Value extends string = string>({
  value,
  onChange,
  options,
  label,
  inlineLabel = false,
  "aria-label": ariaLabel,
  id,
  disabled = false,
  placeholder = "Choose",
  quiet = false,
  className,
}: {
  value: Value;
  onChange: (value: Value) => void;
  options: readonly SelectOption<Value>[];
  /** A visible label. Clicking it focuses the trigger. */
  label?: string;
  /** Puts the visible label beside the trigger instead of above it. */
  inlineLabel?: boolean;
  "aria-label"?: string;
  /** Goes on the trigger, so a page can return focus to it. */
  id?: string;
  disabled?: boolean;
  /** Shown when no option has this value. */
  placeholder?: string;
  /** No resting border, for a trigger that sits in a toolbar or bar. */
  quiet?: boolean;
  className?: string;
}) {
  const baseId = useId();
  const labelId = `${baseId}-label`;
  const listId = `${baseId}-list`;
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const typed = useRef(NO_TYPEAHEAD);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [sheet, setSheet] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });

  const selected = options.findIndex((option) => option.value === value);
  const optionId = (index: number) => `${baseId}-option-${index}`;

  const close = useCallback(() => {
    setOpen(false);
    typed.current = NO_TYPEAHEAD;
  }, []);

  const show = (at: number) => {
    if (disabled) return;
    setSheet(window.matchMedia(SHEET_QUERY).matches);
    setPosition({ visibility: "hidden" });
    setActive(at);
    setOpen(true);
    // Safari does not focus a button on click, and the keys are heard here.
    trigger.current?.focus();
  };

  const commit = (index: number) => {
    const option = options[index];
    close();
    if (option !== undefined && !option.disabled && option.value !== value) onChange(option.value);
  };

  const place = useCallback(() => {
    const anchor = trigger.current;
    const element = pop.current;
    if (anchor === null || element === null) return;
    const box = anchor.getBoundingClientRect();
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    // A trigger scrolled out of the window has nothing to hang a list from.
    if (box.bottom < 0 || box.top > viewport.height) {
      close();
      return;
    }
    const placed = placeList(box, { width: element.scrollWidth, height: list.current?.scrollHeight ?? element.scrollHeight }, viewport);
    setPosition({
      top: placed.top,
      left: placed.left,
      minWidth: box.width,
      maxHeight: placed.maxHeight,
      transformOrigin: placed.side === "below" ? "top left" : "bottom left",
    });
  }, [close]);

  useLayoutEffect(() => {
    if (open && !sheet) place();
  }, [open, sheet, place, options.length]);

  // Keep the option in reach visible inside the scrolling list.
  useLayoutEffect(() => {
    if (!open || active < 0) return;
    const element = list.current;
    const item = element?.children[active] as HTMLElement | undefined;
    if (element === undefined || element === null || item === undefined) return;
    const pad = 4;
    if (item.offsetTop - pad < element.scrollTop) element.scrollTop = item.offsetTop - pad;
    else if (item.offsetTop + item.offsetHeight + pad > element.scrollTop + element.clientHeight) {
      element.scrollTop = item.offsetTop + item.offsetHeight + pad - element.clientHeight;
    }
  }, [open, active, position]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      // The scrim closes on its own click, so that click cannot land on the page under it.
      if (target === scrim.current) return;
      if (!trigger.current?.contains(target) && !pop.current?.contains(target)) close();
    };
    const follow = (event: Event) => {
      if (pop.current?.contains(event.target as Node)) return;
      if (!window.matchMedia(SHEET_QUERY).matches) place();
    };
    const sheetChange = () => setSheet(window.matchMedia(SHEET_QUERY).matches);
    document.addEventListener("pointerdown", closeOnOutside);
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    window.addEventListener("resize", sheetChange);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
      window.removeEventListener("resize", sheetChange);
    };
  }, [open, close, place]);

  useEffect(() => {
    if (disabled) close();
  }, [disabled, close]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const now = Date.now();
    const typing = typed.current.query !== "" && now - typed.current.at <= TYPEAHEAD_RESET_MS;
    const action = keyAction(event, open, typing);
    switch (action.type) {
      case "none":
        return;
      case "open":
        event.preventDefault();
        show(action.at === "first" ? firstEnabled(options) : action.at === "last" ? lastEnabled(options) : openingIndex(options, selected));
        return;
      case "move": {
        event.preventDefault();
        const from = active;
        const to = {
          next: () => stepEnabled(options, from, 1),
          previous: () => stepEnabled(options, from, -1),
          first: () => firstEnabled(options),
          last: () => lastEnabled(options),
          "page-next": () => pageEnabled(options, from, 1),
          "page-previous": () => pageEnabled(options, from, -1),
        }[action.to]();
        setActive(to);
        return;
      }
      case "commit":
        // Tab chooses and then moves on, so it keeps its default.
        if (!action.thenTab) event.preventDefault();
        commit(active);
        return;
      case "dismiss":
        // Only this list closes, not a menu it may be sitting in.
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      case "type": {
        event.preventDefault();
        const from = open ? active : openingIndex(options, selected);
        const { index, state } = typeahead(options, typed.current, action.char, now, from);
        typed.current = state;
        if (!open) show(index >= 0 ? index : from);
        else if (index >= 0) setActive(index);
      }
    }
  };

  const button = (
    <button
      ref={trigger}
      id={id}
      type="button"
      role="combobox"
      className={"select-trigger" + (quiet ? " select-trigger-quiet" : "") + (className ? ` ${className}` : "")}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? listId : undefined}
      aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
      aria-labelledby={label !== undefined ? labelId : undefined}
      aria-label={label === undefined ? ariaLabel : undefined}
      disabled={disabled}
      title={selected >= 0 ? options[selected]!.label : undefined}
      onClick={() => (open ? close() : show(openingIndex(options, selected)))}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        if (open && !pop.current?.contains(event.relatedTarget)) close();
      }}
    >
      <span className={selected >= 0 ? "select-value" : "select-value select-placeholder"}>
        {selected >= 0 ? options[selected]!.label : placeholder}
      </span>
      <Chevrons />
    </button>
  );

  const popup = open && createPortal(
    <>
      {sheet && <div ref={scrim} className="select-scrim" onClick={close} />}
      <div
        ref={pop}
        className={sheet ? "select-pop select-sheet" : "select-pop"}
        style={sheet ? undefined : position}
        // The list never takes focus; the trigger keeps it.
        onMouseDown={(event) => event.preventDefault()}
      >
        {sheet && label !== undefined && <div className="select-sheet-title" aria-hidden="true">{label}</div>}
        {sheet && label === undefined && ariaLabel !== undefined && <div className="select-sheet-title" aria-hidden="true">{ariaLabel}</div>}
        <ul
          ref={list}
          id={listId}
          role="listbox"
          className="select-list"
          aria-labelledby={label !== undefined ? labelId : undefined}
          aria-label={label === undefined ? ariaLabel : undefined}
        >
          {options.map((option, index) => (
            <li
              key={option.value}
              id={optionId(index)}
              role="option"
              className={"select-option" + (index === active ? " select-option-active" : "")}
              aria-selected={index === selected}
              aria-disabled={option.disabled || undefined}
              onPointerMove={() => {
                if (!option.disabled && index !== active) setActive(index);
              }}
              onClick={() => {
                if (!option.disabled) commit(index);
              }}
            >
              <span className="select-option-text">
                <span>{option.label}</span>
                {option.hint !== undefined && <span className="select-option-hint">{option.hint}</span>}
              </span>
              {index === selected && <Tick />}
            </li>
          ))}
        </ul>
      </div>
    </>,
    document.body,
  );

  if (label === undefined) {
    return <>{button}{popup}</>;
  }
  return (
    <div className={inlineLabel ? "select-field select-field-inline" : "select-field"}>
      <span className="select-label" id={labelId} onClick={() => trigger.current?.focus()}>{label}</span>
      {button}
      {popup}
    </div>
  );
}
