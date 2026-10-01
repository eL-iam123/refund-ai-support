/**
 * The deterministic floor under "the customer has not said anything is wrong".
 *
 * The messenger's one job is to learn what went wrong, and R-12's escalation is
 * for a person who is actually waiting on a judgement - not for a customer who
 * just said hello. A greeting with nothing else in it is not a claim: funnelling
 * it into the claim path hands the policy a reason of "other" with nothing
 * grounded, which escalates a $0 non-complaint to a person. So a no-complaint
 * message is answered with a warm question instead, and this module is the
 * floor that makes that hold for *every* analyzer - the local matcher, a test
 * double, or a live model that ignored the prompt.
 *
 * Two deliberate limits. First, "no complaint" means the whole message is social
 * filler: "hello, my lamp is cracked" is a complaint and goes to the engine
 * like any other. Second, a genuinely vague complaint - "it's just not right,
 * can you sort it out?" - is *not* intercepted, because R-12's whole point is
 * that a vague complaint escalates rather than being decided on a guess.
 */

const GREETING =
  /^(?:(?:hi|hello|hey|hiya|howdy|yo+|greetings)(?:\s+there)?|good\s+(?:morning|afternoon|evening|day)|how\s+(?:are|'?re|'s)\s+(?:you(?:s?\s+doing)?|it\s+going)|what'?s\s+up|hola|buenos\s+d[ií]as|buenas\s+(?:tardes|noches)|bonjour|bonsoir|salut|hallo|guten\s+(?:morgen|tag|abend))\b/i;
const THANKS_ALONE = /^(?:thanks|thank\s+(?:you|u)|thanx|\bty\b|\bthx\b)\b/i;
/** After the greeting/thanks is removed, only punctuation and emoji may remain. */
const ONLY_FILLER = /^[\s.,!?~:;()\-"'…\p{Extended_Pictographic}]*$/u;

export const NO_COMPLAINT_MODEL = 'deterministic-no-complaint-v1';

export function isNoComplaint(message: string): boolean {
  const rest = message
    .trim()
    .replace(GREETING, '')
    .replace(THANKS_ALONE, '')
    .trim();
  return rest.length === 0 || ONLY_FILLER.test(rest);
}

interface OpenerLines {
  readonly resolved: string;
  readonly unresolved: string;
}

interface OpenerCatalog {
  readonly en: OpenerLines;
  readonly es: OpenerLines;
  readonly fr: OpenerLines;
  readonly de: OpenerLines;
}

/**
 * The warm question, written carefully enough to pass the messenger's own
 * guard: it never asks for an order number the pipeline has resolved, and it is
 * not a call-centre line.
 */
const OPENERS: OpenerCatalog = {
  en: {
    resolved: "Hi! What's going on with your order? Tell me a little about what happened and I'll take a look.",
    unresolved:
      "It sounds like something went wrong, but I haven't found the order yet - can you tell me the product name or the date you ordered, and what happened?",
  },
  es: {
    resolved: "¡Hola! ¿Qué ha pasado con tu pedido? Cuéntame un poco y lo reviso.",
    unresolved:
      "Parece que algo no ha ido bien, pero aún no encuentro el pedido. ¿Podrías decirme el nombre del producto o la fecha en que lo pediste, y qué ha pasado?",
  },
  fr: {
    resolved: "Bonjour ! Que s'est-il passé avec votre commande ? Racontez-moi un peu et je vais regarder.",
    unresolved:
      "On dirait que quelque chose s'est mal passé, mais je n'ai pas encore trouvé la commande. Pourriez-vous me dire le nom du produit ou la date de la commande, et ce qui s'est passé ?",
  },
  de: {
    resolved: "Hallo! Was ist mit Ihrer Bestellung passiert? Erzählen Sie mir kurz davon, dann schaue ich es mir an.",
    unresolved:
      "Es klingt, als wäre etwas schiefgelaufen, aber ich habe die Bestellung noch nicht gefunden. Können Sie mir den Produktnamen oder das Bestelldatum nennen und was passiert ist?",
  },
};

/** In the customer's own language, when the greeting makes it obvious. */
const OPENER_LANGUAGE: readonly { readonly code: 'es' | 'fr' | 'de'; readonly token: RegExp }[] = [
  { code: 'es', token: /hola|buenos|buenas/i },
  { code: 'fr', token: /bonjour|bonsoir|salut/i },
  { code: 'de', token: /hallo|guten\s+tag/i },
];

export function noComplaintQuestion(message: string, orderResolved: boolean): string {
  const language = OPENER_LANGUAGE.find((row) => row.token.test(message))?.code ?? 'en';
  const lines = linesFor(language);
  return orderResolved ? lines.resolved : lines.unresolved;
}

function linesFor(language: 'es' | 'fr' | 'de' | 'en'): OpenerLines {
  if (language === 'es') {
    return OPENERS.es;
  }
  if (language === 'fr') {
    return OPENERS.fr;
  }
  if (language === 'de') {
    return OPENERS.de;
  }
  return OPENERS.en;
}