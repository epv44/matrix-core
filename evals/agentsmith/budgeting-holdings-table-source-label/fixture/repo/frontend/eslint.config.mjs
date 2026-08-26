import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import tailwind from "eslint-plugin-tailwindcss";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    plugins: { tailwindcss: tailwind },
    settings: {
      tailwindcss: { cssConfigPath: "src/app/globals.css" },
    },
    rules: {
      "tailwindcss/classnames-order": "error",
      "tailwindcss/no-contradicting-classname": "error",
      "tailwindcss/enforces-shorthand": "error",
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"]),
]);

export default eslintConfig;
