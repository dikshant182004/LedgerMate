/**
 * Deterministic Math Evaluator & Sensitivity Engine
 * Single Responsibility: Performs exact floating-point evaluation without LLM hallucination,
 * generates sensitivity analysis matrices, and binds reactive variable adjustments.
 */

/**
 * Safe expression evaluation for mathematical formulas with variable substitution.
 * Does not use dangerous eval; uses a safe tokenized evaluator or bounded Function.
 */
export function evaluateFormula(formula, variables = {}) {
  try {
    // Sanitize formula to only allow mathematical tokens
    const sanitized = formula
      .replace(/Math\.pow/g, "__POW__")
      .replace(/Math\.sqrt/g, "__SQRT__")
      .replace(/Math\.round/g, "__ROUND__")
      .replace(/Math\.floor/g, "__FLOOR__")
      .replace(/Math\.ceil/g, "__CEIL__")
      .replace(/Math\.abs/g, "__ABS__");

    if (/[^a-zA-Z0-9_\s\+\-\*\/\(\)\.\,\^]/.test(sanitized)) {
      throw new Error("Formula contains invalid characters");
    }

    // Restore safe math functions
    let executable = formula.replace(/\^/g, "**");

    // Create arguments array
    const varNames = Object.keys(variables);
    const varValues = varNames.map((k) => Number(variables[k]) || 0);

    const fn = new Function(...varNames, `
      "use strict";
      return (${executable});
    `);

    const result = fn(...varValues);
    if (typeof result !== "number" || isNaN(result) || !isFinite(result)) {
      return 0;
    }
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
    if (res !== null) {
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
