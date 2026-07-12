import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Wright's small hand-built component kit: inline SVG icons and a custom
 * dropdown. No native <select>/<input type=checkbox> — everything themed
 * with VS Code variables and consistent radii/transitions.
 */

const ICON_PATHS: Record<string, ReactNode> = {
  send: <path d="M8 13V3m0 0L3.5 7.5M8 3l4.5 4.5" />,
  stop: <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none" />,
  attach: <path d="M13 7.5 8.7 11.8a3.1 3.1 0 0 1-4.4-4.4l4.6-4.6a2.1 2.1 0 0 1 3 3l-4.6 4.6a1.1 1.1 0 0 1-1.6-1.6L9.9 4.6" />,
  chevron: <path d="M4.5 6.5 8 10l3.5-3.5" />,
  file: <path d="M9.5 2H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.5L9.5 2Zm0 0v2.5H12" />,
  folder: <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.4 1.5h4.8A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7Z" />,
  search: <path d="M11 11l3 3m-1.6-6.3a4.7 4.7 0 1 1-9.4 0 4.7 4.7 0 0 1 9.4 0Z" />,
  terminal: <path d="M4 5.5 7 8l-3 2.5M8.5 11H12M2.5 2.5h11a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z" />,
  pencil: <path d="m9.7 3.3 3 3L6 13H3v-3l6.7-6.7Zm1.2-1.2 1.2-1.2 3 3-1.2 1.2" transform="scale(0.9) translate(1,1)" />,
  globe: <path d="M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12Zm0 0c1.7 0 3-2.7 3-6S9.7 2 8 2 5 4.7 5 8s1.3 6 3 6Zm-5.7-8h11.4M2.3 10h11.4" />,
  check: <path d="m3.5 8.5 3 3 6-7" />,
  x: <path d="M4 4l8 8m0-8-8 8" />,
  spinner: <path d="M8 2a6 6 0 0 1 6 6" />,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  undo: <path d="M6.5 3.5 3 7l3.5 3.5M3 7h6a4 4 0 0 1 0 8H7" transform="translate(0,-1)" />,
  diff: <path d="M5 2.5v11M5 5.5 2.5 8 5 10.5M11 2.5v11m0-8L13.5 8 11 5.5" />,
  robot: <path d="M8 2v2M5 6h6a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Zm1.2 3.5h.01m3.6 0h.01" />,
  infinity: (
    <path d="M4.7 10.6a2.6 2.6 0 1 1 0-5.2c1.3 0 2.3.9 3.3 2.6 1-1.7 2-2.6 3.3-2.6a2.6 2.6 0 1 1 0 5.2c-1.3 0-2.3-.9-3.3-2.6-1 1.7-2 2.6-3.3 2.6Z" />
  ),
  notebook: (
    <path d="M4.5 2.5h7A1.5 1.5 0 0 1 13 4v8a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 12V4a1.5 1.5 0 0 1 1.5-1.5ZM5.6 5.5h4.8M5.6 8h4.8M5.6 10.5h2.8" />
  ),
  bug2: (
    <>
      <path d="M8 13.2a3.4 3.4 0 0 0 3.4-3.4V7.6a3.4 3.4 0 1 0-6.8 0v2.2A3.4 3.4 0 0 0 8 13.2Zm0 0V9.8" />
      <path d="M6.1 4.6a2 2 0 0 1 3.8 0M4.6 6.4 2.9 5.3m8.5 1.1 1.7-1.1M4.6 9H2.6m10.8 0h-2M5 11.4l-1.6 1.1m9.2-1.1 1.6 1.1" />
    </>
  ),
  chat: (
    <>
      <path d="M3 5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H8.3L5.2 13.4V11H5a2 2 0 0 1-2-2V5Z" />
      <path d="M6.8 6.1c.1-.8 2.3-.9 2.3 0 0 .7-1.1.7-1.1 1.6M8 9.3h.01" />
    </>
  ),
  checklist: (
    <path d="m3.1 4.3 1 1 1.8-2M3.1 8.3l1 1 1.8-2M3.1 12.3l1 1 1.8-2M8.6 4.5H13M8.6 8.5H13M8.6 12.5H13" />
  ),
  book: <path d="M3 3.5A1.5 1.5 0 0 1 4.5 2H13v10.5H4.75A1.75 1.75 0 0 0 3 14.25V3.5ZM3 12.5A1.5 1.5 0 0 1 4.5 11H13" />,
  bug: <path d="M8 4a2.5 2.5 0 0 1 2.5 2.5v3a2.5 2.5 0 0 1-5 0v-3A2.5 2.5 0 0 1 8 4Zm0 0V2.5M5.5 7H3m10 0h-2.5M5.5 10H3.5m9 0h-2M6 4.5 4.5 3m7 0L10 4.5" />,
  layers: <path d="m8 2 6 3-6 3-6-3 6-3Zm-6 6 6 3 6-3M2 11l6 3 6-3" />,
  question: <path d="M6 6a2 2 0 1 1 2.9 1.8c-.6.3-.9.7-.9 1.2v.5m0 2.5h.01M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12Z" />,
  sparkle: <path d="M8 2.5 9.3 6 13 7.3 9.3 8.7 8 12.5 6.7 8.7 3 7.3 6.7 6 8 2.5Z" />,
  cloud: <path d="M12.5 11.5H4.2A2.7 2.7 0 0 1 4 6.2a3.5 3.5 0 0 1 6.7-1.4A3 3 0 0 1 13.5 8a2.5 2.5 0 0 1-1 4.5Z" />,
  image: <path d="M3.5 2.5h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Zm2.5 4a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm-3.5 5 3-3 2 2 3-3 3 3" />,
  gear: (
    <path
      fill="currentColor"
      stroke="none"
      fillRule="evenodd"
      d="M9.1 4.4 8.6 2H7.4l-.5 2.4-.7.3-2-1.3-.9.8 1.3 2-.3.7-2.3.5v1.2l2.4.5.3.8-1.3 2 .8.8 2-1.3.8.3.4 2.3h1.2l.5-2.4.8-.3 2 1.3.8-.8-1.3-2 .3-.8 2.3-.4V7.4l-2.4-.5-.3-.8 1.3-2-.8-.8-2 1.3-.7-.2ZM9.4 1l.5 2.4L12 2.1l2 2-1.4 2.1 2.4.4v2.8l-2.4.5L14 12l-2 2-2.1-1.4-.5 2.4H6.6l-.5-2.4L4 13.9l-2-2 1.4-2.1L1 9.4V6.6l2.4-.5L2.1 4l2-2 2.1 1.4.4-2.4h2.8Zm.6 7a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm-1 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"
    />
  ),
  history: (
    <>
      <path d="M2.5 8a5.5 5.5 0 1 1 1.6 3.9M2.5 8H1m1.5 0 .9-2.4" />
      <path d="M8 5v3l2.2 1.3" />
    </>
  ),
  trash: <path d="M3 4.5h10M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4.8 4.5l.5 8a1.5 1.5 0 0 0 1.5 1.4h2.4a1.5 1.5 0 0 0 1.5-1.4l.5-8" />,
  copy: <path d="M6 6a1.5 1.5 0 0 1 1.5-1.5h4A1.5 1.5 0 0 1 13 6v6a1.5 1.5 0 0 1-1.5 1.5h-4A1.5 1.5 0 0 1 6 12V6ZM4 11h-.5A1.5 1.5 0 0 1 2 9.5v-6A1.5 1.5 0 0 1 3.5 2h4A1.5 1.5 0 0 1 9 3.5V4" />,
  compass: <path d="M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12Zm2.6-8.6L9.2 9.2 5.4 10.6l1.4-3.8 3.8-1.4Z" />,
  telescope: <path d="m2.5 10.5 8-6 2 3-8 6-2-3Zm7-6.5 1.2-.7 1.6 2.6-1.2.7M6 9l2 4M5 13h3M10.5 4.2l1-1.5" />,
  slash: <path d="M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12Zm-4-2 8-8" />,
  more: (
    <>
      <circle cx="3.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
};

export function Icon({ name, size = 14, spin = false }: { name: string; size?: number; spin?: boolean }) {
  return (
    <svg
      className={spin ? "icon spin" : "icon"}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {ICON_PATHS[name] ?? ICON_PATHS.file}
    </svg>
  );
}

export const TOOL_ICON: Record<string, string> = {
  read_file: "book",
  write_file: "pencil",
  edit_file: "pencil",
  list_dir: "folder",
  search: "search",
  codebase_search: "layers",
  web_search: "globe",
  run_command: "terminal",
};

export function toolIcon(name: string): string {
  if (name.startsWith("mcp_")) return "sparkle";
  return TOOL_ICON[name] ?? "robot";
}

export interface SelectOption {
  value: string;
  label: string;
  icon?: string;
  hint?: string;
}

/** Custom dropdown: trigger pill + floating menu, opens upward (composer sits at the bottom). */
export function Select(props: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  icon?: string;
  title?: string;
  minWidth?: number;
  triggerClassName?: string;
  iconSize?: number;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = props.options.find((o) => o.value === props.value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="select" ref={rootRef} title={props.title}>
      <button
        className={`select-trigger${props.triggerClassName ? ` ${props.triggerClassName}` : ""}`}
        onClick={() => setOpen((o) => !o)}
      >
        {(selected?.icon ?? props.icon) && <Icon name={selected?.icon ?? props.icon!} size={props.iconSize ?? 12} />}
        <span className="select-label">{selected?.label ?? props.value}</span>
        <Icon name="chevron" size={11} />
      </button>
      {open && (
        <div className="select-menu" style={{ minWidth: props.minWidth }}>
          {props.options.map((option) => (
            <button
              key={option.value}
              className={`select-item${option.value === props.value ? " selected" : ""}`}
              onClick={() => {
                props.onChange(option.value);
                setOpen(false);
              }}
            >
              {option.icon && <Icon name={option.icon} size={props.iconSize ?? 12} />}
              <span className="select-item-label">{option.label}</span>
              {option.hint && <span className="select-item-hint">{option.hint}</span>}
              {option.value === props.value && <Icon name="check" size={12} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function IconButton(props: { icon: string; title: string; onClick?: () => void; danger?: boolean; size?: number }) {
  return (
    <button className={`icon-button${props.danger ? " danger" : ""}`} title={props.title} onClick={props.onClick}>
      <Icon name={props.icon} size={props.size ?? 14} />
    </button>
  );
}
