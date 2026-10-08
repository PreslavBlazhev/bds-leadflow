import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [
  ...nextVitals,
  ...nextTs,
  { ignores: [".verify/**", ".tools/**", "tests/.tmp/**", ".next/**", "node_modules/**", "data/**", "backups/**", "public/sw.js", "test-results/**", "playwright-report/**", "next-env.d.ts"] },
];
export default config;
