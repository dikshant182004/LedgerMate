/**
 * Types & Domain Constants for the High-Speed Calculation Agent
 * Follows LDD (Layered Domain-Driven Design) and SOLID principles.
 */

export const CALC_CATEGORIES = {
  RENT_SPLITS: "Splits & Shared Living",
  SALARY_TAX: "2026 Global Salary & Tax",
  MORTGAGE_LOANS: "Mortgage & Debt Amortization",
  METROLOGY_LAND: "Land & Architectural Metrology",
  FREELANCE_BUSINESS: "Freelance & Business Finance",
  SCIENCE_ENGINEERING: "Science & Engineering Math",
  GENERAL_MATH: "General Quantitative Analysis",
};

export const RATING_TYPES = {
  ACCURATE: "accurate",
  INACCURATE: "inaccurate",
  NEEDS_REVIEW: "needs_review",
};

export const REJECTION_REASONS = {
  NON_CALCULATION: "NON_CALCULATION_QUERY",
  INJECTION_DETECTED: "INJECTION_ATTEMPT_DETECTED",
  HARMFUL_CONTENT: "HARMFUL_OR_ILLICIT_REQUEST",
  TOO_AMBIGUOUS: "QUERY_LACKS_NUMERICAL_DATA",
};
