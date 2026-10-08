/** Изпълнява се веднъж при старт на Next.js сървъра (не при build). Node-специфичният код е в instrumentation-node.ts. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") await import("./instrumentation-node");
}
