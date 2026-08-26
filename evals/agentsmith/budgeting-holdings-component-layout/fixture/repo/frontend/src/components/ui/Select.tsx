import React from "react";

export default function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`rounded-lg border border-zinc-200 px-3 py-2 text-sm focus:border-transparent focus:ring-2 focus:ring-zinc-900 focus:outline-none ${props.className || ""}`}
    />
  );
}
