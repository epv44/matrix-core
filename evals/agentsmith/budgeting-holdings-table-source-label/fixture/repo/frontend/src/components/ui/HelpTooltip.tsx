"use client";

import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

const TOOLTIP_WIDTH = 288;
const VIEWPORT_PADDING = 12;
const TOOLTIP_GAP = 8;

type TooltipPosition = {
  left: number;
  top: number;
};

export default function HelpTooltip({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const tooltipId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<TooltipPosition | null>(null);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const triggerBox = trigger.getBoundingClientRect();
    const width = Math.min(TOOLTIP_WIDTH, window.innerWidth - VIEWPORT_PADDING * 2);
    const centeredLeft = triggerBox.left + triggerBox.width / 2 - width / 2;
    setPosition({
      left: Math.min(
        Math.max(centeredLeft, VIEWPORT_PADDING),
        window.innerWidth - width - VIEWPORT_PADDING,
      ),
      top: triggerBox.bottom + TOOLTIP_GAP,
    });
  }, []);

  const showTooltip = () => {
    updatePosition();
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;

    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  return (
    <span
      className="inline-flex"
      onMouseEnter={showTooltip}
      onMouseLeave={() => {
        if (document.activeElement !== triggerRef.current) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-describedby={open ? tooltipId : undefined}
        className="inline-flex size-4 shrink-0 items-center justify-center rounded-full border border-zinc-400 text-[10px] leading-none font-semibold text-zinc-500 transition-colors hover:border-zinc-600 hover:text-zinc-800 focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:ring-offset-1 focus-visible:outline-none"
        onFocus={showTooltip}
        onBlur={() => setOpen(false)}
        onClick={showTooltip}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
      >
        ?
      </button>
      {open &&
        position &&
        createPortal(
          <span
            id={tooltipId}
            role="tooltip"
            style={{ left: position.left, top: position.top }}
            className="fixed z-50 w-72 max-w-[calc(100vw-1.5rem)] rounded-lg bg-zinc-900 px-3 py-2 text-xs leading-5 font-normal text-white shadow-xl"
          >
            {children}
          </span>,
          document.body,
        )}
    </span>
  );
}
