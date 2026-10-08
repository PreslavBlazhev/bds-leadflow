import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { expect, type Page } from "@playwright/test";

export const owner = () => JSON.parse(fs.readFileSync("tests/.tmp/e2e-owner.json", "utf8")) as { username: string; password: string };

export async function login(page: Page) {
  const o = owner();
  await page.goto("/login");
  await page.getByLabel("Потребителско име").fill(o.username);
  await page.getByLabel("Парола").fill(o.password);
  await page.getByRole("button", { name: "Вход" }).click();
  await page.waitForURL(/\/today/);
}

/** Директен достъп до e2e базата за проверка на инварианти (само четене в тестовете). */
export function e2eDb() {
  const file = path.resolve("data/e2e-test.db").split(path.sep).join("/");
  return new PrismaClient({ datasourceUrl: `file:${file}?connection_limit=1` });
}

export async function noHorizontalOverflow(page: Page) {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth }));
  expect(r.sw, `хоризонтален overflow ${r.sw} > ${r.w}`).toBeLessThanOrEqual(r.w + 1);
}
