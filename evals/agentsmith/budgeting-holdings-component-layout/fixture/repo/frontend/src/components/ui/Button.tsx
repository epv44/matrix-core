import React from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const VARIANT_STYLES: Record<ButtonVariant, string> = {
  primary: "bg-zinc-900 text-white hover:bg-black",
  secondary: "border border-zinc-200 bg-white text-zinc-800 hover:bg-zinc-50",
  ghost: "text-zinc-500 hover:text-zinc-900",
  danger: "bg-red-600 text-white hover:bg-red-700",
};

function buttonClasses(variant: ButtonVariant, className: string): string {
  return `rounded-lg px-4 py-2 text-sm font-medium transition-colors ${VARIANT_STYLES[variant]} ${className}`;
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
};

export default function Button({ variant = "primary", className = "", ...props }: ButtonProps) {
  return (
    <button className={`${buttonClasses(variant, className)} disabled:opacity-60`} {...props} />
  );
}

type ButtonLinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  variant?: ButtonVariant;
};

export function ButtonLink({ variant = "secondary", className = "", ...props }: ButtonLinkProps) {
  return <a className={buttonClasses(variant, className)} {...props} />;
}
