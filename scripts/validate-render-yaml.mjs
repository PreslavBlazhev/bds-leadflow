// Локална проверка на render.yaml срещу официалната JSON schema на Render (без акаунт, без създаване на ресурси).
//   node scripts/validate-render-yaml.mjs [път до schema.json] [--file друг.yaml]   (--file: за отрицателни проби)
// Нужни инструменти (извън зависимостите на проекта): npm install --prefix .tools/validate ajv@8 ajv-formats@3 js-yaml@4
// Schema: https://render.com/schema/render.yaml.json (свали в .tools/render-schema.json или подай път).
// Допълнително: съгласуваност на имената между услугите, базата, env групата и package.json скриптовете.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const req = createRequire(path.join(root, ".tools", "validate", "noop.js"));
let Ajv2020, addFormats, yaml;
try {
  Ajv2020 = req("ajv/dist/2020").default;
  addFormats = req("ajv-formats").default;
  yaml = req("js-yaml");
} catch {
  console.error("Липсват инструментите: npm install --prefix .tools/validate ajv@8 ajv-formats@3 js-yaml@4");
  process.exit(2);
}
const args = process.argv.slice(2);
const fileIdx = args.indexOf("--file");
const yamlPath = fileIdx >= 0 ? path.resolve(args.splice(fileIdx, 2)[1]) : path.join(root, "render.yaml");
const schemaPath = args[0] ?? path.join(root, ".tools", "render-schema.json");
const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
const doc = yaml.load(fs.readFileSync(yamlPath, "utf8"));

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const ok = ajv.validate(schema, doc);
if (!ok) {
  console.error("[render.yaml] НЕ отговаря на schema:");
  for (const e of ajv.errors ?? []) console.error(`  ${e.instancePath || "/"} ${e.message}`);
}

// Съгласуваност, която schema не проверява.
function consistency(doc) {
  const problems = [];
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const dbNames = new Set((doc.databases ?? []).map((d) => d.name));
  const groups = new Set((doc.envVarGroups ?? []).map((g) => g.name));
  for (const s of doc.services ?? []) {
    for (const cmd of [s.buildCommand, s.startCommand, s.preDeployCommand].filter(Boolean)) {
      for (const m of cmd.matchAll(/npm run ([\w:.-]+)/g)) if (!pkg.scripts[m[1]]) problems.push(`${s.name}: липсва npm скрипт "${m[1]}"`);
      if (/next dev|dev:all/.test(cmd)) problems.push(`${s.name}: dev команда в production`);
    }
    for (const v of s.envVars ?? []) {
      if (v.fromDatabase && !dbNames.has(v.fromDatabase.name)) problems.push(`${s.name}: непозната база ${v.fromDatabase.name}`);
      if (v.fromGroup && !groups.has(v.fromGroup)) problems.push(`${s.name}: непозната env група ${v.fromGroup}`);
      if (v.fromDatabase && v.fromDatabase.property !== "connectionString") problems.push(`${s.name}: DATABASE_URL трябва да е вътрешният connectionString`);
      if (v.generateValue) problems.push(`${s.name}: generateValue за ${v.key} дава различна стойност на всяка услуга`);
      if (/PASS|PRIVATE|SECRET|KEY/.test(v.key ?? "") && v.value !== undefined && !/^NEXT_PUBLIC_/.test(v.key)) problems.push(`${s.name}: ${v.key} има стойност в render.yaml (тайните са само sync:false)`);
    }
    if (s.region !== doc.databases?.[0]?.region) problems.push(`${s.name}: различна region от базата (вътрешният URL изисква същата region)`);
  }
  for (const g of doc.envVarGroups ?? []) {
    for (const v of g.envVars ?? []) {
      if (/PASS|PRIVATE|SECRET/.test(v.key) && v.value !== undefined) problems.push(`група ${g.name}: ${v.key} има стойност`);
      // Render: в envVarGroups `sync: false` се игнорира (стойността никога не се пита), а fromDatabase/fromService/fromGroup
      // не се поддържат. Групата трябва да съдържа само фиксирани value; стойностите от създаването — sync:false в услугите.
      if ("sync" in v) problems.push(`група ${g.name}: ${v.key} има sync:${v.sync} — не се поддържа в envVarGroups (Render го игнорира); декларирай го в услугите`);
      for (const k of ["fromDatabase", "fromService", "fromGroup", "generateValue"]) if (k in v) problems.push(`група ${g.name}: ${v.key} използва ${k} — в групата са разрешени само фиксирани value`);
      if (v.value === undefined && !("sync" in v)) problems.push(`група ${g.name}: ${v.key} няма value`);
    }
  }
  // Стойности, които трябва да са ЕДНАКВИ в web и worker, но се въвеждат при създаването → sync:false в ДВЕТЕ услуги.
  for (const key of ["APP_BASE_URL", "NEXT_PUBLIC_VAPID_PUBLIC_KEY"]) {
    for (const svc of ["bds-leadflow-web", "bds-leadflow-worker"]) {
      const v = (doc.services ?? []).find((s) => s.name === svc)?.envVars?.find((x) => x.key === key);
      if (!v || v.sync !== false) problems.push(`${svc}: ${key} трябва да е декларирана със sync:false на ниво услуга (еднаква стойност в web и worker)`);
    }
  }
  const gateOff = (svc, key) => {
    const all = [...(doc.services.find((s) => s.name === svc)?.envVars ?? []), ...(doc.envVarGroups ?? []).flatMap((g) => g.envVars)];
    const v = all.find((x) => x.key === key);
    if (!v || v.value !== "false") problems.push(`${key} трябва да е "false" в шаблона за първи deployment`);
  };
  gateOff("bds-leadflow-worker", "SCHEDULER_ENABLED");
  gateOff("bds-leadflow-worker", "DELIVERIES_ENABLED");
  // Ключ и в групата, и в услугата → стойността на услугата печели тихо; не допускаме двусмислие.
  const groupKeys = new Set((doc.envVarGroups ?? []).flatMap((g) => (g.envVars ?? []).map((v) => v.key)));
  for (const s of doc.services ?? []) for (const v of s.envVars ?? []) if (v.key && groupKeys.has(v.key)) problems.push(`${s.name}: ${v.key} е и в env групата, и в услугата`);
  return problems;
}
const problems = consistency(doc);

// Самопроверка при всяко пускане: sync:false в група трябва да бъде отказан (иначе проверката е безполезна).
{
  const probe = structuredClone(doc);
  probe.envVarGroups[0].envVars.push({ key: "LF_SELF_TEST", sync: false });
  if (!consistency(probe).some((x) => x.includes("LF_SELF_TEST има sync:false"))) problems.push("самопроверка: sync:false в envVarGroups НЕ беше отказан");
}
for (const p of problems) console.error(`[render.yaml] ${p}`);
if (!ok || problems.length) process.exit(1);
console.log(`[render.yaml] OK — отговаря на schema (${path.basename(schemaPath)}) и е съгласуван: ${doc.services.length} услуги, ${doc.databases.length} база, ${doc.envVarGroups.length} env група.`);
