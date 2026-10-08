import { z } from "zod";

export const STAGES = ["NEW", "CONTACTED", "QUALIFIED", "PROPOSAL", "WON", "LOST"] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_LABELS: Record<Stage, string> = {
  NEW: "Нов",
  CONTACTED: "Контактуван",
  QUALIFIED: "Квалифициран",
  PROPOSAL: "Оферта",
  WON: "Спечелен",
  LOST: "Загубен",
};
/** Ранг за "само напред" преходите от резултати на разговор. WON/LOST са крайни. */
export const STAGE_RANK: Record<Stage, number> = { NEW: 0, CONTACTED: 1, QUALIFIED: 2, PROPOSAL: 3, WON: 4, LOST: 4 };

export const OUTCOMES = [
  "NO_ANSWER",
  "SPOKE",
  "CALL_BACK",
  "INTERESTED",
  "SEND_OFFER",
  "WON",
  "DECLINED",
  "INVALID_NUMBER",
  "DO_NOT_CONTACT",
] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const OUTCOME_LABELS: Record<Outcome, string> = {
  NO_ANSWER: "Не отговори",
  SPOKE: "Говорихме",
  CALL_BACK: "Да се обадя отново",
  INTERESTED: "Заинтересован",
  SEND_OFFER: "Изпрати оферта",
  WON: "Спечелен клиент",
  DECLINED: "Отказ",
  INVALID_NUMBER: "Невалиден номер",
  DO_NOT_CONTACT: "Не се свързвай повече",
};
export const OUTCOME_HINTS: Record<Outcome, string> = {
  NO_ANSWER: "Опит без разговор. Може да насрочиш повторен опит.",
  SPOKE: "Проведен разговор. Етап „Контактуван“, ако няма по-напреднал.",
  CALL_BACK: "Изисква дата и час. Създава последващо обаждане.",
  INTERESTED: "Разговор с интерес → „Квалифициран“.",
  SEND_OFFER: "Създава чернова на оферта и задача. НЕ е изпратена.",
  WON: "Изисква данни за сделката. Създава клиент, без получено плащане.",
  DECLINED: "„Загубен“ с причина, без автоматични напомняния.",
  INVALID_NUMBER: "Блокира телефона и маркира записа за проверка.",
  DO_NOT_CONTACT: "Глобално потискане, отменя всички предстоящи действия.",
};

export const ACTIVITY_TYPES = ["CALL", "CONTACT_OTHER", "NOTE", "MEETING", "STATUS_CHANGE", "DIAL_INTENT", "IMPORTED_HISTORY", "OFFER", "SYSTEM"] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];
export const ACTIVITY_LABELS: Record<ActivityType, string> = {
  CALL: "Обаждане",
  CONTACT_OTHER: "Контакт извън телефона",
  NOTE: "Бележка",
  MEETING: "Среща",
  STATUS_CHANGE: "Смяна на етап",
  DIAL_INTENT: "Отворено набиране (не е доказан разговор)",
  IMPORTED_HISTORY: "Импортирана история",
  OFFER: "Оферта",
  SYSTEM: "Системно",
};
/** Дейности, които означават реален контакт с бизнеса (блокират „нов“ завинаги). DIAL_INTENT и NOTE не са контакт. */
export const CONTACT_ACTIVITY_TYPES: ActivityType[] = ["CALL", "CONTACT_OTHER", "MEETING", "IMPORTED_HISTORY"];

export const WEBSITE_STATUS_LABELS: Record<string, string> = {
  UNCHECKED: "Непроверен",
  FOUND: "Открит сайт",
  NOT_FOUND_AFTER_CHECK: "Не е открит след проверка",
  UNREACHABLE: "Технически недостъпен",
};

/** История преди импорта, потвърдена от собственика. Не е от деветте резултата на разговор. */
export const PRIOR_CONTACT_LABELS: Record<string, string> = {
  CALLED_BEFORE_IMPORT: "Прозвънен преди импорта — резултатът е неизвестен",
  NOT_CALLED: "Още не е звъняно (потвърдено от собственика)",
};
export const PRIOR_CONTACT_SOURCE_LABELS: Record<string, string> = { OWNER_CONFIRMATION: "потвърждение от собственика" };

export const SOURCE_LABELS: Record<string, string> = {
  DEMO: "Демо (синтетичен)",
  CSV: "CSV импорт",
  XLSX: "Excel импорт",
  MANUAL: "Ръчно",
  GOOGLE_PLACES: "Google Places",
  B2B: "B2B доставчик",
};

export const HISTORY_LABELS: Record<string, string> = {
  NONE_CONFIRMED: "Потвърдено без контакт",
  HAS_HISTORY: "Има история на контакт",
  UNKNOWN: "Неизвестна история",
};

export const OFFER_STATUSES = ["DRAFT", "SENT", "ACCEPTED", "REJECTED", "EXPIRED"] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];
export const OFFER_STATUS_LABELS: Record<OfferStatus, string> = {
  DRAFT: "Чернова",
  SENT: "Изпратена (ръчно)",
  ACCEPTED: "Приета",
  REJECTED: "Отказана",
  EXPIRED: "Изтекла",
};

export const CATEGORIES = [
  { key: "restaurant", label: "Ресторанти/пицарии" },
  { key: "auto", label: "Автосервизи/автоуслуги" },
  { key: "beauty", label: "Салони за красота" },
  { key: "home", label: "Строителни/домашни услуги" },
  // Добавени за импорта от Excel проучването (основните категории във файла).
  { key: "repair", label: "Ремонт и битови услуги" },
  { key: "shops", label: "Магазини" },
  { key: "pets", label: "Грижа за животни" },
  { key: "lodging", label: "Настаняване и туризъм" },
  { key: "professional", label: "Професионални услуги" },
  { key: "sport", label: "Спорт и движение" },
  { key: "health", label: "Здраве и частни кабинети" },
  { key: "education", label: "Обучение и детски услуги" },
  { key: "transport", label: "Транспортни услуги" },
] as const;
export const CATEGORY_LABELS: Record<string, string> = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label]));

export const FOLLOWUP_KIND_LABELS: Record<string, string> = {
  RETRY: "Повторен опит",
  CALL_BACK: "Обратно обаждане",
  OFFER: "Оферта",
  NEXT_STEP: "Следваща стъпка",
  GENERAL: "Общо",
};

export const idemKey = z.string().min(8).max(100);
export const cents = z.number().int().min(0).max(100_000_000);
