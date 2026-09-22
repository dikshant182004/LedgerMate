/**
 * Deterministic Math Evaluator & Sensitivity Engine
 * Single Responsibility: Performs exact floating-point evaluation without LLM hallucination,
 * generates sensitivity analysis matrices, and binds reactive variable adjustments.
 */

/**
 * Safe expression evaluation for mathematical formulas with variable substitution.
 * Avoids eval/new Function because Cloudflare Workers blocks runtime code generation.
 * Handles scientific notation, percentages, and standard Math functions.
 */
export function evaluateFormula(formula, variables = {}) {
  try {
    if (!formula || typeof formula !== "string") return null;

    // Convert percentage like 15% to (15/100) or normalize % token
    let normalized = formula
      .replace(/(\d+(?:\.\d+)?)\s*%/g, "($1/100)")
      .replace(/\s+/g, "");

    // Allow digits, dots, variable names, math identifiers, operators, commas, parentheses
    const tokens = normalized.match(/(?:\d*\.\d+(?:e[+-]?\d+)?|\d+\.?\d*(?:e[+-]?\d+)?|[A-Za-z_][A-Za-z0-9_\.]*|\*\*|[()+\-*/^,])/gi) || [];
    if (!tokens.length || tokens.join("") !== normalized) {
      throw new Error("Formula contains invalid characters or unbalanced tokens");
    }

    const safeFunctions = {
      "Math.abs": Math.abs,
      "Math.ceil": Math.ceil,
      "Math.floor": Math.floor,
      "Math.pow": Math.pow,
      "Math.round": Math.round,
      "Math.sqrt": Math.sqrt,
      "Math.log": Math.log,
      "Math.exp": Math.exp,
      "abs": Math.abs,
      "sqrt": Math.sqrt,
      "round": Math.round,
      "ceil": Math.ceil,
      "floor": Math.floor,
      "pow": Math.pow,
    };

    let index = 0;
    const peek = () => tokens[index];
    const take = () => tokens[index++];

    const expression = () => {
      let value = term();
      while (peek() === "+" || peek() === "-") {
        value = take() === "+" ? value + term() : value - term();
      }
      return value;
    };

    const term = () => {
      let value = power();
      while (peek() === "*" || peek() === "/") {
        const op = take();
        const nextVal = power();
        value = op === "*" ? value * nextVal : (nextVal !== 0 ? value / nextVal : 0);
      }
      return value;
    };

    const power = () => {
      let value = unary();
      if (peek() === "^" || peek() === "**") {
        take();
        value = Math.pow(value, power());
      }
      return value;
    };

    const unary = () => {
      if (peek() === "+") {
        take();
        return unary();
      }
      if (peek() === "-") {
        take();
        return -unary();
      }
      return primary();
    };

    const primary = () => {
      const token = take();
      if (!token) throw new Error("Unexpected end of formula");

      if (token === "(") {
        const value = expression();
        if (take() !== ")") throw new Error("Unclosed parenthesis");
        return value;
      }

      if (/^\d/.test(token)) {
        return Number(token);
      }

      if (Object.hasOwn(variables, token)) {
        return Number(variables[token]) || 0;
      }

      // Check lowercase variable matching as fallback
      const matchKey = Object.keys(variables).find((k) => k.toLowerCase() === token.toLowerCase());
      if (matchKey) {
        return Number(variables[matchKey]) || 0;
      }

      if (safeFunctions[token] && peek() === "(") {
        take(); // (
        const args = [expression()];
        while (peek() === ",") {
          take();
          args.push(expression());
        }
        if (take() !== ")") throw new Error("Unclosed function call");
        return safeFunctions[token](...args);
      }

      // If token is an unrecognized constant or variable, return 0 instead of crashing
      return 0;
    };

    const result = expression();
    if (index !== tokens.length) throw new Error("Unexpected formula token remaining");
    if (!Number.isFinite(result)) return null;
    return Math.round(result * 10000) / 10000;
  } catch (err) {
    console.warn("Formula evaluation error:", err.message, "Formula:", formula);
    return null;
  }
}

/**
 * Generates a dynamic 5-point sensitivity matrix (-20%, -10%, Base, +10%, +20%)
 * for the primary adjustable variable in the calculation.
 */
export function generateSensitivityMatrix(formula, baseVariables, primaryKey, unit = "") {
  if (!formula || !baseVariables || !primaryKey || !(primaryKey in baseVariables)) {
    return [];
  }

  const baseVal = Number(baseVariables[primaryKey]) || 1;
  const deltas = [
    { label: "-20%", factor: 0.80 },
    { label: "-10%", factor: 0.90 },
    { label: "Current (Base)", factor: 1.00 },
    { label: "+10%", factor: 1.10 },
    { label: "+20%", factor: 1.20 },
  ];

  const baseResult = evaluateFormula(formula, baseVariables) || 1;
  const matrix = [];

  for (const delta of deltas) {
    const testVars = { ...baseVariables, [primaryKey]: baseVal * delta.factor };
    const res = evaluateFormula(formula, testVars);
    if (res !== null && Number.isFinite(res)) {
      const diffPercent = baseResult !== 0 ? ((res - baseResult) / baseResult) * 100 : 0;
      matrix.push({
        scenario: delta.label,
        variableValue: Math.round(baseVal * delta.factor * 100) / 100,
        resultValue: Math.round(res * 100) / 100,
        deltaPercent: Math.round(diffPercent * 10) / 10,
        unit: unit,
      });
    }
  }

  return matrix;
}
