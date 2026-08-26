"use client";

import { KeyboardEvent, useRef } from "react";

export interface TabOption<Value extends string> {
  value: Value;
  label: string;
}

interface TabsProps<Value extends string> {
  ariaLabel: string;
  groupId: string;
  options: readonly TabOption<Value>[];
  value: Value;
  onChange: (value: Value) => void;
}

export function tabId(groupId: string, value: string): string {
  return `${groupId}-${value}-tab`;
}

export function tabPanelId(groupId: string, value: string): string {
  return `${groupId}-${value}-panel`;
}

export default function Tabs<Value extends string>({
  ariaLabel,
  groupId,
  options,
  value,
  onChange,
}: TabsProps<Value>) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  const selectAt = (index: number) => {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    buttons.current[index]?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % options.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + options.length) % options.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = options.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    selectAt(nextIndex);
  };

  return (
    <div className="mb-4 flex gap-2 border-b border-zinc-200" role="tablist" aria-label={ariaLabel}>
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={(element) => {
            buttons.current[index] = element;
          }}
          id={tabId(groupId, option.value)}
          type="button"
          role="tab"
          aria-controls={tabPanelId(groupId, option.value)}
          aria-selected={value === option.value}
          tabIndex={value === option.value ? 0 : -1}
          className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
            value === option.value
              ? "border-zinc-900 text-zinc-900"
              : "border-transparent text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
          }`}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => handleKeyDown(event, index)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
