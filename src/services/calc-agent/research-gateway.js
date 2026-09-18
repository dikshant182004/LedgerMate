/**
 * Intelligent Research Gateway & Search Orchestrator
 * Single Responsibility: Determines whether a query requires live statutory / dynamic web research,
 * generates concise targeted search queries without wasting tokens, and handles search grounding.
 */

// Patterns indicating self-contained math (no research needed, bypass < 1ms)
const PURE_MATH_PATTERNS = [
  /^\s*(\d+(?:\.\d+)?)\s*%\s*(?:of)\s*[\$€£₹¥]?\s*(\d+(?:\.\d+)?)\s*$/i, // X% of Y
  /^\s*[\$€£₹¥]?\s*(\d+(?:\.\d+)?)\s*[\+\-\*\/]\s*[\$€£₹¥]?\s*(\d+(?:\.\d+)?)\s*$/i, // Basic arithmetic
  /\b(split|divide)\s+[\$€£₹¥]?\s*\d+.*(?:between|among)\s+\d+\s+(?:people|roommates|friends)\s*(?:equally)?\b/i,
  /\b(compound\s+interest|simple\s+interest|future\s+value)\b.*(?=.*\bprincipal\b|\b\$\d+|\b\d+\s*years).*(?=.*\b\d+%\b)/i,
  /\b(convert)\s+\d+(?:\.\d+)?\s*(?:km|miles|kg|lbs|gaj|sq\s*ft|feet|meters|inches|cm|celsius|fahrenheit)\s*(?:to|in)\b/i,
  /\b(loan|mortgage|emi)\b.*(?=.*\b\$\d+|\b\d+k|\b\d+,\d+).*(?=.*\b\d+(?:\.\d+)?%\b).*(?=.*\b\d+\s*(?:years|months)\b)/i,
];

// Patterns indicating dynamic, statutory, or empirical data (requires live research)
const DYNAMIC_RESEARCH_PATTERNS = [
  /\b(tax\s*bracket|tax\s*slab|income\s*tax|payroll\s*tax|capital\s*gains|vat|gst)\b/i,
  /\b(new\s*regime|old\s*regime|115bac|standard\s*deduction|section\s*87a|cess)\b/i,
  /\b(irs|fica|oasdi|medicare|w-2|1099|401k\s*limit|ira\s*contribution)\b/i,
  /\b(grundfreibetrag|steuerklasse|krankenkasse|soli|rentenversicherung|estg)\b/i,
  /\b(resident\s*tax|juminzei|kyokai\s*kenpo|nenkin|shakai\s*hoken)\b/i,
  /\b(budget\s*202|amendment|gazette|statutory|reform|guideline\s*change|new\s*law|current\s*rate)\b/i,
  /\b(inflation\s*rate|exchange\s*rate|current\s*price|molar\s*mass|molecular\s*weight|stoichiometry|enthalpy|specific\s*heat)\b/i,
  /\b(germany|uk|united\s*kingdom|france|canada|australia|india|japan|korea|singapore|uae|dubai|california|new\s*york|texas)\b.*(?=\b(tax|salary|deduction|rule|stamp\s*duty|registration)\b)/i,
];

/**
 * Assesses whether a calculation query requires external research grounding.
 * Returns a decision with token-efficient targeted search prompts if needed.
 */
export function assessResearchNeed(query) {
  const q = (query || "").trim();
  if (!q) {
    return { needsResearch: false, reason: "Empty query", queries: [] };
  }

  // 1. Check if it's explicitly a self-contained formula/math
  for (const pattern of PURE_MATH_PATTERNS) {
    if (pattern.test(q)) {
      return {
        needsResearch: false,
        reason: "Self-contained mathematical calculation. Formula and parameters are complete; live web search bypassed to optimize speed and token usage.",
        queries: [],
      };
    }
  }

  // 2. Check if dynamic research is warranted
  let dynamicMatch = false;
  for (const pattern of DYNAMIC_RESEARCH_PATTERNS) {
    if (pattern.test(q)) {
      dynamicMatch = true;
      break;
    }
  }

  if (dynamicMatch) {
    const targetedQueries = generateTargetedSearchQueries(q);
    return {
      needsResearch: true,
      reason: "Dynamic statutory, legal, or empirical constants detected. Invoking live research grounding.",
      queries: targetedQueries,
    };
  }

  // 3. Fallback: If query mentions specific countries or legal authorities, flag for research
  const hasJurisdiction = /\b(us|usa|india|germany|japan|korea|uk|canada|australia|california|ny)\b/i.test(q);
  const hasStatute = /\b(tax|salary|deduction|limit|allowance|rate|rule|law|bracket)\b/i.test(q);

  if (hasJurisdiction && hasStatute) {
    const targetedQueries = generateTargetedSearchQueries(q);
    return {
      needsResearch: true,
      reason: "Jurisdictional financial criteria detected. Grounding via live web research.",
      queries: targetedQueries,
    };
  }

  return {
    needsResearch: false,
    reason: "Standard mathematical / ratio / split calculation. Executing directly via reasoning model.",
    queries: [],
  };
}

/**
 * Generates 1-2 ultra-compact, high-yield search queries without conversational fluff.
 */
function generateTargetedSearchQueries(query) {
  const clean = query
    .replace(/[^\w\s\$\€\£\₹\%\.\-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Extract primary entities (countries, tax, chemistry, etc.)
  const queries = [];

  if (/india|115bac|inr|₹|lakh|crore/i.test(clean) && /tax|salary|deduction/i.test(clean)) {
    queries.push("India income tax slabs new tax regime current financial year");
  } else if (/germany|steuerklasse|brutto|netto|krankenkasse/i.test(clean)) {
    queries.push("Germany income tax rates Grundfreibetrag social security current year");
  } else if (/us|united states|irs|fica|federal/i.test(clean) && /tax|deduction|bracket/i.test(clean)) {
    queries.push("IRS standard deduction federal tax brackets current tax year");
  } else if (/japan|tsubo|juminzei|kenpo/i.test(clean)) {
    queries.push("Japan income tax resident tax rates social insurance current");
  } else if (/molar|mole|reaction|grams|stoichiometry|acid|ph/i.test(clean)) {
    // Chemistry extract formula or molecule
    const molMatch = clean.match(/\b([A-Z][a-z]?\d*)+\b/);
    if (molMatch) {
      queries.push(`molar mass ${molMatch[0]}`);
    } else {
      queries.push(`${clean.slice(0, 80)}`);
    }
  } else {
    // General high-yield query limited to 60 characters
    queries.push(clean.slice(0, 70));
  }

  return queries;
}
