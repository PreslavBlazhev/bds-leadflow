import type { Business, WebsiteAudit } from "@prisma/client";

/**
 * „Предложение по шаблон“ — без AI, на естествен български. Използва само проверени факти:
 *  - „няма открит сайт“ само при проверка с доказателство (NOT_FOUND_AFTER_CHECK);
 *  - „без защитена връзка“ само ако проверката е видяла http адрес;
 *  - „не видях телефон/бутон“ само ако проверката на началната страница го е отбелязала.
 * Липсващ viewport таг НЕ се споменава като факт — сам по себе си не доказва лош вид на телефон.
 * Никога: „Нямате сайт“ от празно поле, измислени имена, бюджет, оборот или гарантирани резултати.
 */
export interface PitchFacts {
  https: boolean | null;
  contactVisible: boolean | null;
}

function auditFacts(audit: Pick<WebsiteAudit, "issues"> & Partial<Pick<WebsiteAudit, "https" | "contactVisible">> | null): PitchFacts {
  if (!audit) return { https: null, contactVisible: null };
  const issues: string[] = JSON.parse(audit.issues);
  return {
    https: audit.https ?? (issues.some((i) => /HTTPS/i.test(i)) ? false : null),
    contactVisible: audit.contactVisible ?? (issues.some((i) => /телефон|CTA/i.test(i)) ? false : null),
  };
}

const QUESTIONS: Record<string, string[]> = {
  restaurant: ["Как приемате поръчки и резервации в момента — по телефона или онлайн?", "Лесно ли ви е да обновявате менюто и цените?"],
  auto: ["Как си записват час клиентите — само по телефона?", "Често ли ви звънят само за да питат за цени?"],
  beauty: ["Как става записването на час при вас?", "Къде показвате снимки на работата си?"],
  home: ["Откъде идват повечето ви запитвания?", "Имате ли място, където да покажете завършени обекти?"],
};

export function templatePitch(
  b: Pick<Business, "name" | "websiteStatus" | "category" | "city" | "openingLine" | "questions">,
  audit: (Pick<WebsiteAudit, "issues"> & Partial<Pick<WebsiteAudit, "https" | "contactVisible">>) | null,
) {
  const hello = "Здравейте, обаждам се от Bulgaria Digital Services.";
  const f = auditFacts(audit);
  let opening: string;
  switch (b.websiteStatus) {
    case "NOT_FOUND_AFTER_CHECK":
      opening = `${hello} Потърсих „${b.name}“ онлайн, но не открих ваш сайт. Имате ли такъв, или клиентите ви намират основно по телефона и в социалните мрежи?`;
      break;
    case "FOUND":
      if (f.https === false) {
        opening = `${hello} Разгледах сайта ви и видях, че се отваря без защитена връзка — браузърите го показват като „незащитен“. Имате ли минута да ви кажа как се оправя?`;
      } else if (f.contactVisible === false) {
        opening = `${hello} Разгледах началната страница на сайта ви и не видях телефон или бутон за връзка на видно място. Как ви търсят клиентите в момента?`;
      } else {
        opening = `${hello} Видях, че имате сайт. Доволни ли сте от запитванията, които идват през него?`;
      }
      break;
    case "UNREACHABLE":
      opening = `${hello} Опитах да отворя сайта ви, но не се зареди. Знаете ли дали работи в момента?`;
      break;
    default:
      opening = `${hello} Помагаме на бизнеси в ${b.city} да получават повече запитвания онлайн. Как ви намират клиентите в момента?`;
  }
  return {
    opening: b.openingLine?.trim() || opening,
    questions: b.questions?.trim() || (QUESTIONS[b.category] ?? ["Какво би ви помогнало да получавате повече запитвания?"]).join("\n"),
    isTemplate: !b.openingLine?.trim(),
  };
}
