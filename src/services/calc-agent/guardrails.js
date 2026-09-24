/**
 * Guardrail & Content Safety Filter for the Calculation Agent
 * Single Responsibility: Fences the agent to mathematical & quantitative calculations,
 * blocks prompt injection, malicious instructions, and non-computational essays.
 */

import { REJECTION_REASONS } from "./types.js";

// Prompt injection & jailbreak patterns
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior)\s+(instructions|directives|rules)/i,
  /disregard\s+(all\s+)?(previous|prior)\s+(instructions|rules)/i,
  /system\s+prompt/i,
  /you\s+are\s+now\s+(DAN|unrestricted|free)/i,
  /bypass\s+safety/i,
  /reveal\s+your\s+(internal|hidden|developer)\s+instructions/i,
  /override\s+(system|developer)\s+settings/i,
];

// Toxic, abusive, or illicit patterns
const HARMFUL_PATTERNS = [
  /\b(kill|murder|bomb|explosive|weapon|poison|suicide|terrorist)\b/i,
  /\b(hack|ddos|exploit|phishing|stolen\s+card|malware)\b/i,
];

// Keywords indicating calculation intent
const CALCULATION_KEYWORDS = [
  /\d/, // At least one number or digit
  /(\$|€|£|¥|₹|₩|฿)/, // Currency
  /(%|percent|percentage)/i,
  /(\+|\-|\*|\/|\^|=)/, // Operators
  /\b(split|rent|share|mortgage|loan|emi|tax|salary|interest|apr|roi|discount|margin|hourly|annual|monthly|trip|flight|hotel|expense|budget)\b/i,
  /\b(sq\s*ft|sqft|tsubo|pyeong|rai|dunum|acre|hectare|gaj|bigha|meter|inch|mm|cm|feet|kg|lbs|mile|km)\b/i,
  /\b(calculate|compute|solve|convert|how\s+much|what\s+is\s+my|total|balance|take-home|net|gross)\b/i,
  /\b(fraction|ratio|proportion|weighted|average|sum|product|difference|remainder)\b/i,
  /\b(mole|moles|molar|molarity|grams?|liters?|ml|mg|ph|stoichiometry|reaction|solution|density|enthalpy|volume|pressure|kelvin|celsius)\b/i,
];

// Recognized target currencies and the plain-English words people actually type
// for them. Used to read a currency change out of a free-text HITL adjustment
// note (e.g. "convert this to euros" or "show it in rupees instead") now that
// currency is no longer a separate dropdown — the person just asks for it.
// Word aliases only — currency symbols ($, €, £, ¥, ₹) are matched separately
// via symbolMap in detectCurrencyRequest, since a regex \b word-boundary
// around a symbol character is unreliable (e.g. it fails to match "$" at the
// very start of a string).
const CURRENCY_ALIASES = {
  USD: ["usd", "us dollar", "us dollars", "dollar", "dollars"],
  EUR: ["eur", "euro", "euros"],
  GBP: ["gbp", "pound", "pounds", "sterling"],
  CNY: ["cny", "rmb", "yuan", "chinese yuan"],
  JPY: ["jpy", "yen", "japanese yen"],
  INR: ["inr", "rupee", "rupees", "indian rupee", "indian rupees"],
  AUD: ["aud", "australian dollar", "australian dollars"],
  CAD: ["cad", "canadian dollar", "canadian dollars"],
  AED: ["aed", "dirham", "dirhams"],
};

/**
 * Looks for a request to change the output currency inside a free-text note
 * (e.g. a HITL "Request Adjustment" message). Returns a currency code like
 * "EUR", or null if no currency change is mentioned.
 *
 * A note like "convert USD to EUR" mentions TWO currencies — the source and
 * the destination — so we can't just return whichever one matches first.
 * We collect every currency mention with its position in the text and:
 *   1. If there's a connector word ("to"/"into"/"as"), prefer the currency
 *      mentioned right after it — that's the destination in "convert X to Y".
 *   2. Otherwise, prefer whichever currency is mentioned LAST, since that's
 *      almost always the target ("...to euros", "...into dollars").
 */
export function detectCurrencyRequest(text) {
  if (!text || typeof text !== "string") return null;
  const lower = text.toLowerCase();
  const found = [];
  const symbolMap = { "$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "₹": "INR" };
  for (const [sym, code] of Object.entries(symbolMap)) {
    let idx = lower.indexOf(sym);
    while (idx !== -1) {
      found.push({ code, index: idx });
      idx = lower.indexOf(sym, idx + 1);
    }
  }
  for (const [code, aliases] of Object.entries(CURRENCY_ALIASES)) {
    for (const alias of aliases) {
      const re = new RegExp(`\\b${alias}\\b`, "gi");
      let m;
      while ((m = re.exec(lower)) !== null) {
        found.push({ code, index: m.index });
      }
    }
  }
  if (found.length === 0) return null;
  found.sort((a, b) => a.index - b.index);

  const connectorMatch = lower.match(/\b(to|into|as)\b/);
  if (connectorMatch) {
    const after = found.filter((f) => f.index > connectorMatch.index);
    if (after.length > 0) return after[0].code;
  }
  return found[found.length - 1].code;
}

export function screenCalculationQuery(rawQuery) {
  if (!rawQuery || typeof rawQuery !== "string") {
    return {
      safe: false,
      reason: REJECTION_REASONS.TOO_AMBIGUOUS,
      message: "Please enter a quantitative, financial, or unit calculation query.",
      suggestions: [
        "Split $3,600 rent between 3 roommates by room square footage (400, 250, 200 sq ft)",
        "Calculate 2026 take-home pay on €85,000 salary in Germany (Tax Class 1)",
        "Mortgage payment on $480k loan at 6.75% for 30 years with $300/mo extra prepayment",
      ],
    };
  }

  const query = rawQuery.trim();

  // Length check (prevent DOS token flooding)
  if (query.length > 500) {
    return {
      safe: false,
      reason: REJECTION_REASONS.TOO_AMBIGUOUS,
      message: "Query exceeds the 500-character limit. Please summarize your calculation parameters.",
      suggestions: [
        "Focus on key variables: Total amount, participants, rates, and duration.",
      ],
    };
  }

  // 1. Check for prompt injection
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(query)) {
      return {
        safe: false,
        reason: REJECTION_REASONS.INJECTION_DETECTED,
        message: "Request blocked by calculation security guardrail. System commands and roleplay prompts are not permitted.",
        suggestions: [
          "Ask a direct financial or mathematical question instead.",
        ],
      };
    }
  }

  // 2. Check for harmful/illicit content
  for (const pattern of HARMFUL_PATTERNS) {
    if (pattern.test(query)) {
      return {
        safe: false,
        reason: REJECTION_REASONS.HARMFUL_CONTENT,
        message: "Request contains restricted terminology. LedgerMate only processes lawful financial and mathematical queries.",
        suggestions: [],
      };
    }
  }

  // 3. Check for calculation intent (must match at least two calculation indicators or contain a digit + calc word)
  let keywordMatches = 0;
  for (const pattern of CALCULATION_KEYWORDS) {
    if (pattern.test(query)) {
      keywordMatches++;
    }
  }

  const hasDigit = /\d/.test(query);
  const isCalcQuery = (hasDigit && keywordMatches >= 2) || (keywordMatches >= 3);

  if (!isCalcQuery) {
    return {
      safe: false,
      reason: REJECTION_REASONS.NON_CALCULATION,
      message: "LedgerMate Agent is strictly dedicated to mathematical, financial, payroll, and unit calculations.",
      suggestions: [
        "Split a $3,450 apartment with 2 couples and 1 single",
        "Convert 120 Gaj to Square Meters and Acres",
        "Compare 15-year vs 30-year fixed mortgage on $500,000",
        "Calculate freelance hourly rate for $130k net target with 4 weeks PTO",
      ],
    };
  }

  return { safe: true, sanitizedQuery: query };
}
